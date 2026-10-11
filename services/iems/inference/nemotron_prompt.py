"""Window -> prompt -> answer contract for the Nemotron NILM engine.

One module, imported by both sides, so the text the model was fine-tuned on is
byte for byte the text it sees at inference:

  training   gx10/nemotron/build_sft.py      (windows from the training archive)
  inference  services/iems/inference/nemotron_engine.py  (the live window)

Input is the same un-normalised 100 x 18 feature window the BiLSTM consumes
(feature_builder.build_panel_window de-normalised, or the train_rolling.py
feature frame before z-scoring): each panel's own channel first, then the
shared tail, all .abs()-ed watts/volts/amps, tod_sin/tod_cos, sun_elev,
csky_ghi, pv_power, pv_valid.

The answer is one line per appliance head, `name=ON` or `name=OFF`, in the
order the panel's heads are listed. Reasoning is disabled (enable_thinking
False) both in training and at inference, so the answer is the whole reply.
"""
from __future__ import annotations

import math
import re
from typing import Iterable, Sequence

import numpy as np

PANEL_NAME = {1: "Panel1 (HVAC)", 2: "Panel2 (H2O)", 3: "Panel3 (Kitchen)"}
PANEL_OF = {v: k for k, v in PANEL_NAME.items()}
PANEL_DESC = {
    1: "HVAC panel: heat pump (1.5-4 kW, ~550 W fan-only), solar thermal circulation pump "
       "(~150 W, only with sun), jacuzzi pump, strip heater",
    2: "H2O panel: electric water heater (2-4 kW bursts), hair dryer, sprinklers, bath lights",
    3: "Kitchen panel: refrigerator, garage fridge, garage freezer, dishwasher, microwave, "
       "cooktop, oven, washer, dryer, pressure pump, computers, TV/stereo, counter "
       "appliances, garage opener",
}

SYSTEM = ("You are a non-intrusive load monitoring model for one house. From ten "
          "minutes of sub-panel power you decide which appliances are running at "
          "the middle of the window. Reply only with one line per appliance, "
          "name=ON or name=OFF, in the order given.")

OWN_STRIDE = 2          # 100 samples -> 50 values of the panel's own channel
STEP_W = 100.0          # a jump larger than this counts as an on/off edge


def _col(X: np.ndarray, names: Sequence[str], name: str) -> np.ndarray | None:
    try:
        return X[:, list(names).index(name)]
    except ValueError:
        return None


def _hhmm(X: np.ndarray, names: Sequence[str]) -> str:
    s, c = _col(X, names, "tod_sin"), _col(X, names, "tod_cos")
    if s is None or c is None:
        return "unknown"
    h = (math.degrees(math.atan2(float(s[-1]), float(c[-1]))) / 15.0) % 24
    return f"{int(h):02d}:00"


def build_messages(panel: int, X: np.ndarray, names: Sequence[str],
                   heads: Sequence[str]) -> list[dict]:
    """System + user messages for one panel window (X: window x features, raw)."""
    X = np.asarray(X, dtype="float64")
    own = X[:, 0]
    mid = len(own) // 2
    d = np.diff(own)
    edges = int((np.abs(d) > STEP_W).sum())
    others = [n for n in PANEL_NAME.values() if n != PANEL_NAME[panel]]

    def stat(name):
        v = _col(X, names, name)
        return "n/a" if v is None else f"mean {v.mean():.0f} max {v.max():.0f}"

    sun = _col(X, names, "sun_elev")
    ghi = _col(X, names, "csky_ghi")
    pv = _col(X, names, "pv_power")
    pv_ok = _col(X, names, "pv_valid")
    pv_txt = (f"{pv[-1]:.0f} W measured" if pv is not None and pv_ok is not None
              and pv_ok[-1] > 0.5 else "not measured")

    lines = [
        f"Panel: {PANEL_NAME[panel]}. {PANEL_DESC[panel]}.",
        f"Window: {len(own)} samples every 6 s, local hour {_hhmm(X, names)}. "
        f"Decide the state at sample {mid}.",
        "Own panel watts, every 2nd sample: "
        + " ".join(str(int(round(v))) for v in own[::OWN_STRIDE]),
        f"Own panel: mean {own.mean():.0f} W, median {np.median(own):.0f}, min {own.min():.0f}, "
        f"max {own.max():.0f}, at middle {own[mid]:.0f}, edges over {int(STEP_W)} W {edges}, "
        f"largest step {np.abs(d).max() if len(d) else 0:.0f} W.",
        f"{others[0]}: {stat(others[0])} W. {others[1]}: {stat(others[1])} W.",
        f"Grid Power: {stat('Grid Power')} W. Shop: {stat('Shop')} W.",
        f"Leg currents I31 {stat('I31')} A, I32 {stat('I32')} A, I11 {stat('I11')} A, "
        f"I21 {stat('I21')} A. VrmsA {stat('VrmsA')} V.",
        f"Sun elevation {sun[-1]:.1f} deg, clear-sky irradiance {ghi[-1]:.0f} W/m2, PV {pv_txt}."
        if sun is not None and ghi is not None else f"PV {pv_txt}.",
        "Appliances: " + ", ".join(heads) + ".",
    ]
    return [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": "\n".join(lines)}]


def format_answer(states: dict, heads: Sequence[str]) -> str:
    return "\n".join(f"{h}={'ON' if int(states[h]) == 1 else 'OFF'}" for h in heads)


# One pair per line is what the model is trained to write, but a reply that
# puts them on one line separated by commas or semicolons is read the same way.
_LINE = re.compile(r"(?:^|[\s,;])([a-z_0-9]+)\s*[=:]\s*(ON|OFF|1|0)\b", re.I | re.M)


def parse_answer(text: str, heads: Iterable[str]) -> dict:
    """{head: 1 | 0 | None}. None means the model did not answer for that head."""
    heads = list(heads)
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    got = {}
    for name, val in _LINE.findall(text):
        name = name.lower()
        if name in heads and name not in got:
            got[name] = 1 if val.upper() in ("ON", "1") else 0
    return {h: got.get(h) for h in heads}
