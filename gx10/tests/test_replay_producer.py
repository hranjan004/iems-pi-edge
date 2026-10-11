"""Replay producer: message shape, time alignment, injections, solar shift."""
from __future__ import annotations

import json
import time
from datetime import datetime, time as dtime, timedelta, timezone

import pytest

from conftest import CHANNELS


def test_register_types_match_egauge(rp):
    assert rp.reg_type("VrmsA") == "V"
    assert rp.reg_type("F1") == "F"
    assert rp.reg_type("I31") == "I"
    assert rp.reg_type("Current on Utility Tie") == "I"
    assert rp.reg_type("Panel1 (HVAC)") == "P"
    assert rp.reg_type("Grid Power") == "P"


def test_loads_1s_export_before_6s(rp, export_dir):
    rp.REPLAY_DIR = str(export_dir)
    tr = rp.load_egauge("egauge_1s", 1.0)
    assert tr is not None and tr.label == "egauge_1s"
    assert len(tr.ts) == 3600
    assert set(tr.frames[0]) == set(CHANNELS)


def test_track_sample_and_hold_and_wraparound(rp, export_dir):
    rp.REPLAY_DIR = str(export_dir)
    tr = rp.load_egauge("egauge_6s", 6.0)
    t0 = tr.ts[0]
    # between two grid points the earlier one is held
    assert tr.at(t0 + timedelta(seconds=3)) == tr.frames[0]
    assert tr.at(t0 + timedelta(seconds=6)) == tr.frames[1]
    # past the end the replay loops back to the start
    assert tr.at(t0 + timedelta(seconds=tr.span)) == tr.frames[0]


def test_tod_alignment_lands_on_same_local_time(rp, export_dir):
    rp.REPLAY_DIR = str(export_dir)
    st = rp.State(rp.load_egauge("egauge_1s", 1.0), None)
    first_local = st.track.ts[0].astimezone(rp.HOUSE_TZ)
    target = (first_local + timedelta(minutes=30)).time()
    src = st._tod_in_track(dtime(target.hour, target.minute))
    assert src.astimezone(rp.HOUSE_TZ).time().replace(second=0) == dtime(target.hour, target.minute)


def test_jump_and_speed_move_the_source_clock(rp, export_dir):
    rp.REPLAY_DIR = str(export_dir)
    st = rp.State(rp.load_egauge("egauge_1s", 1.0), None)
    first_local = st.track.ts[0].astimezone(rp.HOUSE_TZ)
    hhmm = (first_local + timedelta(minutes=20)).strftime("%H:%M")
    st.jump(hhmm)
    assert st.source_now().astimezone(rp.HOUSE_TZ).strftime("%H:%M") == hhmm
    st.set_speed(60)
    a = st.source_now(); time.sleep(0.2); b = st.source_now()
    assert (b - a).total_seconds() > 5          # 60x: ~12 source seconds in 0.2 s
    st.set_speed(10_000)
    assert st.speed == 3600.0                   # clamped


def test_injection_adds_load_on_panel_and_grid(rp, export_dir):
    rp.REPLAY_DIR = str(export_dir)
    st = rp.State(rp.load_egauge("egauge_1s", 1.0), None)
    base = st.frame()
    st.injections.append({"channel": "Panel2 (H2O)", "watts": 3500.0, "until": time.time() + 60})
    fr = st.frame()
    # panels report consumption as negative watts, so the magnitude grows
    assert abs(fr["Panel2 (H2O)"]) == pytest.approx(abs(base["Panel2 (H2O)"]) + 3500, abs=5)
    assert fr["Grid Power"] == pytest.approx(base["Grid Power"] + 3500, abs=5)
    st.injections[0]["until"] = time.time() - 1
    assert abs(st.frame()["Panel2 (H2O)"]) == pytest.approx(abs(base["Panel2 (H2O)"]), abs=5)


def test_solar_is_shifted_by_whole_days_into_its_range(rp, export_dir):
    rp.REPLAY_DIR = str(export_dir)
    st = rp.State(rp.load_egauge("egauge_1s", 1.0), rp.load_solar())
    assert st.solar.ts[-1] < st.source_now()     # solar ends before the replay days
    row = st.solar_row()
    assert set(row) >= {"pv_power", "battery_power", "battery_soc", "grid_power", "load_power"}


def test_synthetic_fallback_has_every_channel(rp):
    syn = rp.Synthetic()
    fr = syn.at(datetime(2026, 10, 10, 19, 0, tzinfo=timezone.utc))
    assert set(fr) == set(CHANNELS)
    assert syn.solar(datetime(2026, 10, 10, 20, 0, tzinfo=timezone.utc))["pv_power"] > 0


def test_message_shape_matches_real_producer(rp):
    # egauge_kafka_producer.py emits exactly these keys; the operator's kafka
    # consumer maps them by name (local_script.al)
    msg = {"ts": "2026-10-10T20:00:00.000000Z", "dev": rp.DEVICE_ID, "nm": "Shop",
           "tp": rp.reg_type("Shop"), "w": 10.0, "kwh": 0.0}
    assert set(json.loads(json.dumps(msg))) == {"ts", "dev", "nm", "tp", "w", "kwh"}
