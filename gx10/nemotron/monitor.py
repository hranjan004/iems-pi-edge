#!/usr/bin/env python3
"""Round-by-round training monitor.

After every recurrent round the driver hands the monitor the metric history
and the money spent, and gets back a decision:

  {"action": "continue" | "stop", "reason": str,
   "boost": {"<panel>": {"<head>": factor}}, "steps": int}

Monitors sharing this contract (the agent command is AGENT_CMD, or
NEMOCLAW_CMD; AGENT_NAME labels it in decision.json):

  local     Nemotron 3.5 Lightning in the GX10's Ollama, through
            gx10/nemotron/local_agent_monitor.sh (free, used on the GX10)

  nemoclaw  the NemoClaw agent on Brev (instance nemoclaw-345c71). The
            summary is sent with NEMOCLAW_CMD (a shell command that reads the
            prompt on stdin and prints the agent's reply), and the first JSON
            object in the reply is the decision. The agent is told its own
            budget and manages it, as requested.
  rules     a deterministic fallback, used when NemoClaw is unreachable or
            replies with something that is not a valid decision.

Rules: stop when validation agreement with the teacher reaches TARGET_AGREE,
when the last round improved it by less than MIN_GAIN, or when the GPU budget
left would not cover another round plus the export. Otherwise continue and
boost the heads whose teacher F1 is lowest.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

TARGET_AGREE = float(os.environ.get("TARGET_AGREE", "0.985"))
MIN_GAIN = float(os.environ.get("MIN_GAIN", "0.002"))
WEAK_F1 = float(os.environ.get("WEAK_F1", "0.80"))


def summarise(history: list[dict], spent: float, budget: float, round_cost: float) -> str:
    lines = [f"GPU spend ${spent:.2f} of ${budget:.2f}; one more round costs about ${round_cost:.2f}."]
    for h in history:
        lines.append(f"round {h['round']}: agreement {h['metrics']['agreement']:.4f}, "
                     f"probe misses {h.get('mine', {}).get('missed')}")
    last = history[-1]["metrics"]["panels"]
    for panel, heads in last.items():
        weak = {k: v["teacher"].get("F1") for k, v in heads.items()
                if v["teacher"].get("F1") is not None}
        lines.append(f"panel {panel} teacher F1: " +
                     ", ".join(f"{k} {v:.2f}" for k, v in sorted(weak.items(), key=lambda x: x[1])))
    return "\n".join(lines)


def rules(history: list[dict], spent: float, budget: float, round_cost: float,
          reserve: float, default_steps: int) -> dict:
    agree = history[-1]["metrics"]["agreement"]
    if agree >= TARGET_AGREE:
        return {"action": "stop", "reason": f"agreement {agree:.4f} reached target {TARGET_AGREE}"}
    if len(history) > 1:
        gain = agree - history[-2]["metrics"]["agreement"]
        if gain < MIN_GAIN:
            return {"action": "stop", "reason": f"gain {gain:+.4f} below {MIN_GAIN}, converged"}
    if spent + round_cost + reserve > budget:
        return {"action": "stop", "reason": f"budget: ${spent:.2f} spent, a round plus export "
                                            f"(${round_cost + reserve:.2f}) would pass ${budget:.2f}"}
    boost = {}
    for panel, heads in history[-1]["metrics"]["panels"].items():
        for h, v in heads.items():
            f1 = v["teacher"].get("F1")
            if f1 is not None and f1 < WEAK_F1:
                boost.setdefault(str(panel), {})[h] = round(1.0 + 3.0 * (WEAK_F1 - f1) / WEAK_F1, 2)
    return {"action": "continue", "reason": f"agreement {agree:.4f}, boosting weak heads",
            "boost": boost, "steps": default_steps}


def ask_nemoclaw(prompt: str, timeout: int = 300) -> dict | None:
    cmd = os.environ.get("AGENT_CMD") or os.environ.get("NEMOCLAW_CMD")
    if not cmd:
        return None
    try:
        out = subprocess.run(cmd, shell=True, input=prompt, capture_output=True, text=True,
                             timeout=timeout).stdout
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return d if d.get("action") in ("continue", "stop") else None


def decide(history: list[dict], spent: float, budget: float, round_cost: float,
           reserve: float, default_steps: int, out: Path) -> dict:
    summary = summarise(history, spent, budget, round_cost)
    prompt = ("You are monitoring LoRA fine-tuning of Nemotron 3.5 Lightning to copy a "
              "BiLSTM appliance classifier. You manage your own running cost (the NemoClaw "
              "VM has a $2.00 cap). Decide whether training should do "
              "another round. Reply with one JSON object: {\"action\": \"continue\" or "
              "\"stop\", \"reason\": \"...\", \"boost\": {\"panel\": {\"head\": factor}}, "
              "\"steps\": N}.\n\n" + summary)
    d = ask_nemoclaw(prompt)
    source = os.environ.get("AGENT_NAME", "nemoclaw")
    if d is None:
        d, source = rules(history, spent, budget, round_cost, reserve, default_steps), "rules"
    elif d["action"] == "continue":
        # keep the agent's call, but only real panel/head boosts survive; an
        # echoed template ({"panel": {"head": ...}}) falls back to the rules'
        heads = {str(p): set(h) for p, h in history[-1]["metrics"]["panels"].items()}
        boost = {str(p): {h: float(f) for h, f in (v or {}).items() if h in heads.get(str(p), ())}
                 for p, v in (d.get("boost") or {}).items() if str(p) in heads}
        boost = {p: v for p, v in boost.items() if v}
        d["boost"] = boost or rules(history, spent, budget, round_cost, reserve,
                                    default_steps).get("boost", {})
    # money is never the agent's call: the GPU budget guard always applies
    if d["action"] == "continue" and spent + round_cost + reserve > budget:
        d = {"action": "stop", "reason": "GPU budget guard", "agent_said": d}
    d["source"] = source
    d.setdefault("steps", default_steps)
    out.write_text(json.dumps({"summary": summary, "decision": d}, indent=2))
    return d
