#!/usr/bin/env python3
"""Recurrent LoRA rounds for the Nemotron NILM model (runs on the GPU box host).

Each round
  1. rebuilds train_round.jsonl = base training set + a fixed-size replay
     buffer of the previous rounds' hard examples (misses on a training probe),
     weighted toward the heads the monitor asked to boost. The length never
     changes, so AutoModel's resume of model, optimizer and dataloader state
     stays valid between rounds.
  2. continues the same AutoModel LoRA run for `steps` more optimizer steps
     (it auto-resumes from the newest checkpoint in checkpoint_dir).
  3. merges the newest adapter into the BF16 base (tools/merge_lora.py with
     --automodel-native-export), serves the merged model with vLLM, scores
     the validation split and mines a fresh training probe.
  4. asks the monitor (NemoClaw, else the rules in monitor.py) whether to go
     on, and stops on its say-so or when the GPU budget guard trips.

State lives in /workspace/rounds/state.json, so a crash or a credit pause is
resumed by simply running this again.

Env: RATE_PER_HR (2.63), BUDGET_USD (24), RESERVE_USD (2.5, export + copy),
     ROUND_STEPS (300), MAX_ROUNDS (5), REPLAY_SLOTS (3000), STARTED_AT file.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import monitor  # noqa: E402

WS = Path(os.environ.get("WORKSPACE", "/workspace"))
REPO_IN = "/workspace/repo"                      # repo path inside the containers
SFT = WS / "data/sft"
ROUNDS = WS / "rounds"
CKPT = WS / "ckpt/nilm_lora"
MERGED = WS / "merged"
BASE = WS / "hf/Nemotron-3.5-Lightning-BF16"
RATE = float(os.environ.get("RATE_PER_HR", "2.63"))
BUDGET = float(os.environ.get("BUDGET_USD", "24"))
RESERVE = float(os.environ.get("RESERVE_USD", "2.5"))
ROUND_STEPS = int(os.environ.get("ROUND_STEPS", "300"))
MAX_ROUNDS = int(os.environ.get("MAX_ROUNDS", "5"))
SLOTS = int(os.environ.get("REPLAY_SLOTS", "3000"))
STARTED = Path(os.environ.get("STARTED_AT", str(WS / "state/gpu_started_at")))
AM = os.environ.get("AUTOMODEL_CONTAINER", "nilm")
VLLM_IMAGE = os.environ.get("VLLM_IMAGE", "vllm/vllm-openai:v0.27.1")
VLLM_UTIL = os.environ.get("VLLM_GPU_UTIL", "0.90")    # 0.55 on the GX10 (shared memory)
EVAL_LIMIT = int(os.environ.get("EVAL_LIMIT", "0"))     # per panel, 0 = all validation
MINE_N = int(os.environ.get("MINE_N", "1500"))
MAX_HOURS = float(os.environ.get("MAX_HOURS", "0"))     # wall-clock cap, 0 = none
WS_IN = os.environ.get("WORKSPACE_IN", "/workspace")    # WS as mounted in the containers
VPORT = os.environ.get("VLLM_PORT", "8020")            # 8000 is the Remote GUI API on the GX10


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ} [rounds] {msg}"
    print(line, flush=True)
    with open(ROUNDS / "rounds.log", "a") as f:
        f.write(line + "\n")


def sh(cmd: str, logfile: Path | None = None, check: bool = True) -> int:
    log(f"$ {cmd[:200]}")
    with (open(logfile, "a") if logfile else open(os.devnull, "w")) as f:
        rc = subprocess.run(cmd, shell=True, stdout=f if logfile else None,
                            stderr=subprocess.STDOUT if logfile else None).returncode
    if check and rc:
        raise SystemExit(f"command failed rc={rc}: {cmd[:200]} (see {logfile})")
    return rc


def hours() -> float:
    t0 = datetime.fromisoformat(STARTED.read_text().strip().replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - t0).total_seconds() / 3600


def spent() -> float:
    t0 = datetime.fromisoformat(STARTED.read_text().strip().replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - t0).total_seconds() / 3600 * RATE


def state() -> dict:
    p = ROUNDS / "state.json"
    return json.loads(p.read_text()) if p.exists() else {"round": 0, "steps": 0, "history": [],
                                                         "boost": {}, "done": False}


def save(st: dict) -> None:
    (ROUNDS / "state.json").write_text(json.dumps(st, indent=2))


def build_round_set(st: dict) -> None:
    base = (SFT / "train.jsonl").read_text().splitlines()
    hard = []
    for r in range(1, st["round"] + 1):
        p = ROUNDS / f"r{r}" / "hard_examples.jsonl"
        if p.exists():
            hard += [json.loads(l) for l in p.read_text().splitlines()]
    rng = random.Random(st["round"])
    boost = st.get("boost", {})
    def w(ex):
        panel = next((str(k) for k, v in {1: "Panel1", 2: "Panel2", 3: "Panel3"}.items()
                      if v in ex["messages"][1]["content"]), "0")
        return 1.0 + sum(float(boost.get(panel, {}).get(h, 1.0)) - 1.0 for h in ex.get("_wrong", []))
    buf = []
    if hard:
        buf = rng.choices(hard, weights=[w(e) for e in hard], k=SLOTS)
        buf = [json.dumps({k: v for k, v in e.items() if not k.startswith("_")}) for e in buf]
    buf += rng.sample(base, SLOTS - len(buf)) if len(buf) < SLOTS else []
    rows = base + buf
    rng.shuffle(rows)
    (SFT / "train_round.jsonl").write_text("\n".join(rows) + "\n")
    log(f"round set: {len(base)} base + {SLOTS} replay ({len(hard)} hard examples available)")


def latest_ckpt() -> Path:
    cands = sorted(CKPT.glob("epoch_*_step_*"), key=lambda p: int(p.name.split("_")[-1]))
    if not cands:
        raise SystemExit(f"no checkpoint under {CKPT}")
    return cands[-1]


def merge(ck: Path, logf: Path) -> None:
    """Fold the newest LoRA adapter into the BF16 base.

    The merge must come from the same AutoModel that trained the adapter. Its
    adapter_config.json says which kind it is: standard Hugging Face PEFT
    module names (what the 26.08 image saves: Mamba in_proj, attention, shared
    experts, lm_head) merge with the plain PEFT path; routed grouped experts
    (what AutoModel main saves when it trains them) need main's
    --automodel-native-export path."""
    adapter = ck / "model"
    tm = json.loads((adapter / "adapter_config.json").read_text()).get("target_modules") or []
    native = any(".experts." in m and "shared_experts" not in m for m in tm)
    tmp = WS / "merged_tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    a_in = str(adapter).replace(str(WS), WS_IN)
    b_in = str(BASE).replace(str(WS), WS_IN)
    if native:
        cmd = (f"cd /workspace/Automodel && PYTHONPATH=/workspace/Automodel python tools/merge_lora.py "
               f"--base-model {b_in} --adapter-path {a_in} --output-dir /workspace/merged_tmp "
               f"--automodel-native-export")
    else:
        cmd = (f"cd \\$(python -c \\\"import nemo_automodel,os;print(os.path.dirname(os.path.dirname(nemo_automodel.__file__)))\\\") && "
               f"python tools/merge_lora.py --base-model {b_in} --adapter-path {a_in} "
               f"--output-dir /workspace/merged_tmp")
    log(f"merge: {'native grouped-expert' if native else 'standard PEFT'} adapter, {len(tm)} target modules")
    sh(f"docker exec {AM} bash -lc \"{cmd}\"", logf)
    # the merge writes as root inside the container, so replace the previous
    # merged model there too (from the host, rmtree cannot delete root files)
    sh(f"docker exec {AM} bash -c 'rm -rf {WS_IN}/merged && mv {WS_IN}/merged_tmp {WS_IN}/merged "
       f"&& chown -R {os.getuid()}:{os.getgid()} {WS_IN}/merged'", logf)


def serve_and_eval(rdir: Path, logf: Path) -> None:
    sh("docker rm -f nilm-vllm >/dev/null 2>&1 || true", check=False)
    sh(f"docker run -d --name nilm-vllm --gpus all --ipc=host -p {VPORT}:8000 -v {WS}:/workspace "
       f"{VLLM_IMAGE} --model /workspace/merged --served-model-name nilm --max-model-len 4096 "
       f"--gpu-memory-utilization {VLLM_UTIL} --max-num-seqs 64 --enable-prefix-caching "
       f"--trust-remote-code", logf)
    for _ in range(180):
        if subprocess.run(f"curl -sf localhost:{VPORT}/v1/models >/dev/null", shell=True).returncode == 0:
            break
        time.sleep(10)
    else:
        sh(f"docker logs --tail 80 nilm-vllm >> {logf} 2>&1", check=False)
        raise SystemExit("vLLM did not come up, see " + str(logf))
    # the AutoModel container runs with --network host, so vLLM is on localhost
    sh(f"docker exec {AM} bash -lc 'cd {REPO_IN} && PYTHONPATH=/workspace/pylibs python3 "
       f"gx10/nemotron/eval_nemotron.py --url http://127.0.0.1:{VPORT}/v1 --model nilm "
       f"--sft /workspace/data/sft --out /workspace/rounds/{rdir.name} --mine {MINE_N} "
       f"--limit {EVAL_LIMIT}'", logf)
    sh("docker rm -f nilm-vllm >/dev/null 2>&1 || true", check=False)


def main() -> None:
    ROUNDS.mkdir(parents=True, exist_ok=True)
    st = state()
    if st.get("done"):
        log("already done"); return
    round_cost = None
    while st["round"] < MAX_ROUNDS:
        r = st["round"] + 1
        rdir = ROUNDS / f"r{r}"; rdir.mkdir(exist_ok=True)
        logf = rdir / "round.log"
        t0 = time.time()
        if not (rdir / "trained").exists():
            build_round_set(st)
            target = st["steps"] + int(st.get("next_steps", ROUND_STEPS))
            sh(f"docker exec -e CUDA_VISIBLE_DEVICES=0 -e OMP_NUM_THREADS=8 {AM} bash -lc "
               f"'cd {REPO_IN} && automodel gx10/nemotron/lora_nilm.yaml --nproc-per-node 1 "
               f"--step_scheduler.max_steps {target}'", logf)
            st["steps"] = target; save(st)
            (rdir / "trained").write_text(str(target))
        if not (rdir / "metrics.json").exists():
            merge(latest_ckpt(), logf)
            serve_and_eval(rdir, logf)
        m = json.loads((rdir / "metrics.json").read_text())
        mine = json.loads((rdir / "mine.json").read_text()) if (rdir / "mine.json").exists() else {}
        st["history"].append({"round": r, "steps": st["steps"], "metrics": m, "mine": mine,
                              "spent": round(spent(), 2)})
        st["round"] = r; save(st)
        round_cost = (time.time() - t0) / 3600 * RATE if round_cost is None else round_cost
        log(f"round {r}: agreement {m['agreement']:.4f}, spent ${spent():.2f}, "
            f"round cost ~${round_cost:.2f}")
        d = monitor.decide(st["history"], spent(), BUDGET, round_cost, RESERVE, ROUND_STEPS,
                           rdir / "decision.json")
        log(f"monitor ({d['source']}): {d['action']} - {d.get('reason')}")
        if d["action"] == "stop":
            break
        if MAX_HOURS and hours() + (time.time() - t0) / 3600 > MAX_HOURS:
            log(f"time cap: {hours():.1f} h elapsed, another round would pass {MAX_HOURS} h")
            break
        st["boost"] = d.get("boost", {}); st["next_steps"] = int(d.get("steps", ROUND_STEPS))
        save(st)
    st["done"] = True; save(st)
    best = max(st["history"], key=lambda h: h["metrics"]["agreement"])
    log(f"done after {st['round']} rounds; best round {best['round']} agreement "
        f"{best['metrics']['agreement']:.4f}; merged model of the last round is in {MERGED}")


if __name__ == "__main__":
    main()
