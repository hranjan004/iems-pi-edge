"""Nemotron NILM engine: the fine-tuned Nemotron 3.5 Lightning decides the
appliance states, in place of the BiLSTM.

Enabled with NILM_ENGINE=nemotron (the GX10 compose sets it). For each panel
window the inference loop already builds the normalised (1, 100, 18) tensor
the BiLSTM reads. This module de-normalises it back to the raw feature window,
renders it with nemotron_prompt.build_messages (the exact text the model was
fine-tuned on), asks the model, and returns one probability per head:
ON -> NEMOTRON_P_ON, OFF -> 1 - NEMOTRON_P_ON.

Everything after that is unchanged: the same postprocess gates, mutual
exclusion, power gate and panel rules run on Nemotron's answer exactly as they
ran on the BiLSTM's. If the model is unreachable, times out, or leaves a head
unanswered, that head falls back to the BiLSTM probability for this tick and
the result is tagged so the dashboard and the logs show it.

Env
  NILM_ENGINE        bilstm (default) | nemotron
  NEMOTRON_URL       OpenAI-compatible base URL, default http://host.docker.internal:8011/v1
  NEMOTRON_MODEL     served model name, default nilm
  NEMOTRON_TIMEOUT   seconds per panel request, default 20
  NEMOTRON_P_ON      probability assigned to an ON answer, default 0.95
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.request

import numpy as np

from iems.inference.nemotron_prompt import PANEL_OF, build_messages, parse_answer

logger = logging.getLogger(__name__)

ENGINE = os.environ.get("NILM_ENGINE", "bilstm").lower()
URL = os.environ.get("NEMOTRON_URL", "http://host.docker.internal:8011/v1").rstrip("/")
MODEL = os.environ.get("NEMOTRON_MODEL", "nilm")
TIMEOUT = float(os.environ.get("NEMOTRON_TIMEOUT", "20"))
P_ON = float(os.environ.get("NEMOTRON_P_ON", "0.95"))

_last_error_log = [0.0]


def enabled() -> bool:
    return ENGINE == "nemotron"


def raw_window(tensor: np.ndarray, norm: dict) -> np.ndarray:
    """(1, W, F) normalised -> (W, F) raw, inverting feature_builder's z-score."""
    x = np.asarray(tensor, dtype="float64")[0]
    return x * np.asarray(norm["std"], "float64") + np.asarray(norm["mean"], "float64")


def predict(panel: str, tensor: np.ndarray, norm: dict) -> tuple[dict, str]:
    """Return ({head: prob or None}, raw_answer). None = no usable answer."""
    heads = list(norm["heads"])
    msgs = build_messages(PANEL_OF[panel], raw_window(tensor, norm), norm["features"], heads)
    body = {"model": MODEL, "messages": msgs, "temperature": 0.0, "max_tokens": 256,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(URL + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            text = json.loads(r.read())["choices"][0]["message"].get("content") or ""
    except Exception as exc:  # noqa: BLE001
        if time.monotonic() - _last_error_log[0] > 60:
            logger.warning("[nemotron] %s unreachable (%s), BiLSTM fallback this tick", URL, exc)
            _last_error_log[0] = time.monotonic()
        return {h: None for h in heads}, ""
    parsed = parse_answer(text, heads)
    logger.debug("[nemotron] %s %.0f ms %s", panel, (time.monotonic() - t0) * 1000, parsed)
    return {h: (None if v is None else (P_ON if v == 1 else 1.0 - P_ON))
            for h, v in parsed.items()}, text
