"""Static checks: every shell script parses, compose validates, the trainer
and exporter carry the GX10 changes, and no secret is committed."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import GX10, REPO

SCRIPTS = (sorted((GX10 / "scripts").glob("*.sh")) + sorted((GX10 / "nemotron").glob("*.sh"))
           + [GX10 / "training" / "train_all.sh", GX10 / "anylog-init" / "init.sh"])


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda p: p.name)
def test_shell_scripts_parse(script):
    subprocess.run(["bash", "-n", str(script)], check=True)


@pytest.mark.skipif(not shutil.which("docker"), reason="docker CLI not installed")
def test_compose_validates_with_every_profile(tmp_path):
    env = tmp_path / "env"
    env.write_text((GX10 / ".env.example").read_text().replace("ANYLOG_LICENSE=", "ANYLOG_LICENSE=test"))
    r = subprocess.run(["docker", "compose", "-f", str(GX10 / "docker-compose.gx10.yaml"),
                        "--env-file", str(env), "--profile", "ollama", "--profile", "bridge",
                        "--profile", "live", "--profile", "grafana", "config", "--format", "json"],
                       capture_output=True, text=True)
    if "Cannot connect" in r.stderr or r.returncode and "unknown" in r.stderr:
        pytest.skip(r.stderr[:200])
    assert r.returncode == 0, r.stderr
    services = json.loads(r.stdout)["services"]
    for s in ("replay-producer", "kafka", "operator1", "iems-inference", "iems-backend",
              "iems-app", "iems-dashboard", "ollama", "llm-bridge"):
        assert s in services
    # backend must build FROM the inference image this file tags
    assert services["iems-backend"]["build"]["args"]["BASE_IMAGE"] == services["iems-inference"]["image"]


def test_models_in_repo_are_the_18_feature_set():
    for p in (1, 2, 3):
        d = json.loads((REPO / f"services/iems/models/panel{p}_norm_bilstm.json").read_text())
        assert len(d["features"]) == 18
        assert d["features"][-4:] == ["sun_elev", "csky_ghi", "pv_power", "pv_valid"]
    heads = sum(len(json.loads((REPO / f"services/iems/models/panel{p}_norm_bilstm.json")
                               .read_text())["heads"]) for p in (1, 2, 3))
    assert heads == 22


def test_trainer_and_exporter_carry_gx10_changes():
    tr = (REPO / "services/iems/training/train_rolling.py").read_text()
    assert "torch.cuda.is_available()" in tr and ".to(DEVICE" in tr
    assert ".detach().cpu().numpy()" in tr
    ex = (REPO / "services/iems/training/export_physical.py").read_text()
    assert "_inline_external_data(onnx_path)" in ex
    # gen_norm_physical.py would overwrite the 18 feature norm; never invoked
    sh = (GX10 / "training/train_all.sh").read_text()
    assert not re.search(r"^\s*python3 .*gen_norm_physical\.py", sh, re.M)


SECRET_PATTERNS = [
    re.compile(r"\b[0-9a-f]{120,}\{"),                     # AnyLog license: long hex + JSON
    re.compile(r"(?m)^(EGAUGE_PASS|SA_PASS|ANYLOG_LICENSE|UPSTREAM_KEY)=\S+"),
    re.compile(r"BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY"),
    re.compile(r"eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}"),  # JWT, e.g. a Home Assistant token
]


def _committable_gx10_files():
    """Files git would commit: tracked plus untracked-not-ignored. gx10/.env is
    gitignored and holds the real AnyLog license on a configured box, so a
    plain rglob would flag the one place the license is supposed to live."""
    r = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "gx10"],
                       cwd=REPO, capture_output=True, text=True)
    if r.returncode == 0:
        return [REPO / line for line in r.stdout.splitlines() if (REPO / line).is_file()]
    return [f for f in GX10.rglob("*") if f.is_file() and f.name != ".env"]


def test_no_secrets_in_gx10_files():
    for f in _committable_gx10_files():
        if "data" not in f.parts and f.suffix != ".pyc":
            text = f.read_text(errors="ignore")
            for pat in SECRET_PATTERNS:
                assert not pat.search(text), f"{f.relative_to(REPO)} matches {pat.pattern}"


def test_env_file_is_gitignored():
    if not (REPO / ".git").exists():
        pytest.skip("not a git checkout")
    for path in ("gx10/.env", "gx10/data/export/x.csv.gz", "AnyLog-latest-arm.tar"):
        r = subprocess.run(["git", "check-ignore", "-q", path], cwd=REPO)
        assert r.returncode == 0, f"{path} is not gitignored"
