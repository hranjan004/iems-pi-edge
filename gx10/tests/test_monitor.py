"""Round monitor: rules, agent replies, and the guards around them."""
from __future__ import annotations

import json
import os

from conftest import GX10, load_module

mon = load_module("monitor", GX10 / "nemotron" / "monitor.py")


def hist(*agreements, weak_f1=0.3):
    out = []
    for i, a in enumerate(agreements, 1):
        out.append({"round": i, "metrics": {"agreement": a, "panels": {
            "3": {"refrigerator": {"teacher": {"F1": weak_f1}}, "microwave": {"teacher": {"F1": 0.9}}}}}})
    return out


def test_rules_stop_on_target_and_on_convergence():
    assert mon.rules(hist(0.99), 0, 10, 1, 1, 100)["action"] == "stop"
    assert mon.rules(hist(0.80, 0.801), 0, 10, 1, 1, 100)["action"] == "stop"


def test_rules_continue_and_boost_weak_heads():
    d = mon.rules(hist(0.70, 0.80), 0, 10, 1, 1, 100)
    assert d["action"] == "continue"
    assert "refrigerator" in d["boost"]["3"] and "microwave" not in d["boost"]["3"]


def test_budget_guard_overrides_the_agent(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_CMD", "echo '{\"action\": \"continue\", \"steps\": 50}'")
    d = mon.decide(hist(0.7), spent=9.5, budget=10, round_cost=1, reserve=1,
                   default_steps=100, out=tmp_path / "d.json")
    assert d["action"] == "stop" and d["reason"] == "GPU budget guard"


def test_echoed_template_boost_falls_back_to_rules(tmp_path, monkeypatch):
    reply = {"action": "continue", "reason": "x", "boost": {"panel": {"head": 1.05}}, "steps": 200}
    monkeypatch.setenv("AGENT_CMD", "echo '" + json.dumps(reply) + "'")
    d = mon.decide(hist(0.70), spent=0, budget=100, round_cost=1, reserve=1,
                   default_steps=100, out=tmp_path / "d.json")
    assert d["action"] == "continue" and d["steps"] == 200
    assert d["boost"] == {"3": d["boost"]["3"]} and "refrigerator" in d["boost"]["3"]


def test_unreachable_agent_uses_rules(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_CMD", "false")
    d = mon.decide(hist(0.70), spent=0, budget=100, round_cost=1, reserve=1,
                   default_steps=100, out=tmp_path / "d.json")
    assert d["source"] == "rules"
