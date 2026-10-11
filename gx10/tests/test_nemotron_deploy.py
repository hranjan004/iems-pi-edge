"""Round-to-production tooling: the round comparison, the deploy and agent
scripts, and the LR schedule that has to span every recurrent round."""
from __future__ import annotations

import json
import subprocess

import pytest

from conftest import GX10, load_module

cmp = load_module("compare_rounds", GX10 / "nemotron" / "compare_rounds.py")
NEM = GX10 / "nemotron"


def report(agreement, heads):
    return {"agreement": agreement,
            "panels": {"1": {h: {"agree": a} for h, a in heads.items()}}}


def test_compare_flags_a_better_new_round():
    prev = report(0.80, {"heat_pump": 1.0, "solar_pump": 0.6})
    new = report(0.85, {"heat_pump": 1.0, "solar_pump": 0.7})
    res = cmp.compare(prev, new)
    assert res["new_not_worse"] is True
    assert res["panels"]["1"]["prev"] == 0.8 and res["panels"]["1"]["new"] == 0.85
    assert res["panels"]["1"]["heads"]["solar_pump"] == {"prev": 0.6, "new": 0.7}


def test_compare_flags_a_worse_new_round():
    res = cmp.compare(report(0.82, {"a": 0.9}), report(0.81, {"a": 0.8}))
    assert res["new_not_worse"] is False


def test_compare_cli_writes_gate_json(tmp_path):
    p, n = tmp_path / "p.json", tmp_path / "n.json"
    p.write_text(json.dumps(report(0.8, {"a": 0.8})))
    n.write_text(json.dumps(report(0.8, {"a": 0.8})))
    out = subprocess.run(["python3", str(NEM / "compare_rounds.py"), str(p), str(n),
                          "--out", str(tmp_path / "g.json")], capture_output=True, text=True, check=True)
    assert "new model not worse: True" in out.stdout
    assert json.loads((tmp_path / "g.json").read_text())["new_not_worse"] is True


@pytest.mark.parametrize("script", ["deploy_round.sh", "agent_with_ollama.sh",
                                    "run_on_gx10.sh", "box_pipeline.sh"])
def test_shell_scripts_parse(script):
    subprocess.run(["bash", "-n", str(NEM / script)], check=True)


def test_deploy_round_usage_lists_every_stage():
    text = (NEM / "deploy_round.sh").read_text()
    for stage in ("merge)", "convert)", "swap)", "score)", "all)"):
        assert stage in text


def test_lr_schedule_spans_all_rounds_and_wins_over_checkpoint():
    yaml = pytest.importorskip("yaml")
    cfg = yaml.safe_load((NEM / "lora_nilm.yaml").read_text())["lr_scheduler"]
    assert cfg["lr_decay_steps"] >= 2000
    assert cfg["override_opt_param_scheduler"] is True
    assert cfg["use_checkpoint_opt_param_scheduler"] is False
