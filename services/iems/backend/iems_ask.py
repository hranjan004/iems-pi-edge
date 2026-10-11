"""
/iems/ask — grounded question answering over the microgrid, answered by
NVIDIA Nemotron 3.5 Lightning (served by Ollama on the GX10). Every question
goes to Nemotron; there is no small-model or cloud fallback.

The AnyLog MCP server already gives a model SQL access to the tables. What it
cannot reach is the part of this system that lives in code and YAML rather than
in the ledger: the post-inference rules, the breaker/leg mapping, the canonical
appliance spec, and the live disaggregation state. This endpoint assembles all
of that into one context bundle and asks the model against it, so answers are
grounded in what the site actually is rather than in what the model remembers.

Nothing here calls out to the internet. The model runs in the local Ollama
container on this host.
"""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List, Dict

ask_router = APIRouter(prefix="/iems", tags=["IEMS"])

# Reasoning on/off for Nemotron. Off is fast; on is slower but does its own
# arithmetic correctly. Exact sums are pre-computed either way (_derived).
_THINK = os.environ.get("IEMS_ASK_THINK", "0").strip().lower() in ("1", "true", "yes", "on")

OLLAMA = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434").rstrip("/")
MODEL = os.environ.get("IEMS_ASK_MODEL", "nemotron-3.5-lightning")
DASH = os.environ.get("IEMS_DASH_URL", "http://host.docker.internal:47821").rstrip("/")
REPO = os.environ.get("IEMS_REPO", "/app/services")

# Static site knowledge. Loaded once per process; these files change rarely and
# a stale read is worse than a slightly slow first request.
_STATIC = {}


def _read(path, limit=6000):
    try:
        with open(path) as fh:
            return fh.read()[:limit]
    except Exception:
        return ""


def _breaker_summary():
    """The leg map and ratings only. The file is mostly a comment block
    explaining why the ratings are still null, which the model does not need."""
    raw = _read(os.path.join(REPO, "iems", "detect", "breaker_ratings.yaml"), 20000)
    body = raw.split("groups:", 1)
    head = [l for l in body[0].splitlines() if l.strip().startswith(("margin_frac",
            "clear_frac", "sustain_seconds"))]
    tail = [l for l in (body[1].splitlines() if len(body) > 1 else [])
            if l.strip() and not l.strip().startswith("#")]
    note = ("amps_rating is null for every group, so the breaker-margin "
            "detector is skipping them; ratings must be read off the handles.")
    return "\n".join(head + tail)[:1200] + "\nNOTE: " + note


def _static():
    if _STATIC:
        return _STATIC
    _STATIC["appliance_spec"] = _read(os.path.join(REPO, "..", "appliance_data_updated.txt"), 1800)
    _STATIC["breaker_ratings"] = _breaker_summary()
    try:
        from iems.config import APPLIANCES
        # Drop the long prose fields; keep the numbers a question might turn on.
        keep = ("panel", "laxity", "shed_priority", "on_threshold_w",
                "power_range_w", "avg_on_duration_min", "typical_cycle_min",
                "deferrable", "critical", "weather_coupled", "anomaly_target")
        slim = {k: {f: v[f] for f in keep if f in v}
                for k, v in APPLIANCES.items() if isinstance(v, dict)}
        _STATIC["appliance_catalogue"] = json.dumps(slim)[:4500]
    except Exception as exc:
        _STATIC["appliance_catalogue"] = "unavailable: %s" % exc
    _STATIC["rules"] = _rules_summary()
    return _STATIC


def _rules_summary():
    """Read the tunable constants straight out of the rules module rather than
    restating them here, so the summary cannot drift from the running rules."""
    try:
        from iems.inference import rules_additive as r
        out = {}
        for name in ("BATTERY_WINDOW", "PROTECT_CONF", "SOLAR_MIN_IRRADIANCE",
                     "SOLAR_MAX_CLOUD_PCT", "SOLAR_DAYLIGHT_HOURS", "PV_MIN_W",
                     "BATTERY_CHARGE_MIN_W", "PROTECTED_RULES", "MUTEX_GROUPS"):
            if hasattr(r, name):
                v = getattr(r, name)
                out[name] = list(v) if isinstance(v, (set, tuple)) else v
        out["_applied_in_order"] = [
            "apply_mutual_exclusion  keep only the highest-confidence ON member of a mutex group",
            "apply_power_gate        force OFF any appliance whose on-threshold exceeds the panel's measured watts",
            "apply_panel1_rules      weather-gate the solar pump, reconcile the heat pump against live wattage",
            "apply_panel2_rules      solar-thermal fallback and power-based water-heater gating",
        ]
        return json.dumps(out)[:4000]
    except Exception as exc:
        return "unavailable: %s" % exc


def _get(url, timeout=30, tries=3):
    """Retry: the dashboard's AnyLog queries intermittently come back empty
    because its partition-name cache goes stale, and an omitted feed made the
    model answer "I cannot see the live state" while looking authoritative."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                data = json.loads(resp.read())
            if data not in ({}, [], None):
                return data
        except Exception:
            pass
        if attempt < tries - 1:
            time.sleep(1.5)
    return None


# --- live feeds --------------------------------------------------------------
# Each context key comes from exactly one dashboard feed. Fetching all seven
# serially cost 26 s of a 42 s question, and `include` was applied only after
# the fetch, so a battery question still paid for loads and snapshot before
# throwing them away. Now only the feeds a question needs are fetched, in
# parallel, behind a short TTL cache. The meter publishes every 6 s and the
# NILM loop every 30 s, so a 30 s cache is honest about freshness rather than
# a shortcut.
_FEED_FOR = {
    "panel_draw_w":       "snapshot",
    "grid_meter_w":       "snapshot",
    "reading_time":       "snapshot",
    "solar_now":          "solar-assistant",
    "battery":            "solar-assistant",
    "thermostat":         "relay",
    "relay":              "relay",
    "hvac_last_24h":      "hvac-24h",
    "panel_loads_amps":   "loads",
    "appliances_on_now":  "nilm",
    "appliances_tracked": "nilm",
    "appliances_ts":      "nilm",
}
_ALL_FEEDS = sorted(set(_FEED_FOR.values()))
_LIVE_TTL = float(os.environ.get("IEMS_ASK_LIVE_TTL", "30"))

# Per-feed TTL, set by what each feed costs and by how fast the quantity it
# reports actually moves. snapshot, nilm, relay and solar-assistant answer in
# well under a second and carry the fast-moving numbers, so they stay short.
# storage and loads are AnyLog queries costing 7-10 s each, and battery state of
# charge and panel amps do not move meaningfully inside a minute. hvac-24h is a
# 24-hour aggregate. Caching by cost is also what keeps this endpoint from
# holding the operator's six REST threads the way /api/sources used to.
_FEED_TTL = {
    "snapshot":        15,
    "nilm":            15,
    "relay":           15,
    "solar-assistant": 15,
    "storage":         60,
    "loads":           60,
    "hvac-24h":       300,
}
_feed_cache = {}
_feed_lock = threading.Lock()


def _feed(name):
    """One dashboard feed, memoised for its own TTL."""
    ttl = _FEED_TTL.get(name, _LIVE_TTL)
    now = time.time()
    with _feed_lock:
        hit = _feed_cache.get(name)
        if hit and now - hit[0] < ttl:
            return hit[1]
    data = _get(DASH + "/api/" + name)
    with _feed_lock:
        _feed_cache[name] = (time.time(), data)
    return data


CAPACITY_KWH = float(os.environ.get("IEMS_BATTERY_KWH", "13.5"))
SUB_PANELS = ("Panel1 (HVAC)", "Panel2 (H2O)", "Panel3 (Kitchen)", "Shop")


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _live(want=None):
    """A compact, physically consistent summary, not raw feeds.

    Rules this follows, each one fixing a wrong answer seen in testing:
      * The eGauge sub-panel registers read NEGATIVE while they consume (CT
        orientation). Panel draws are reported here as positive watts, and only
        the grid keeps a sign (+ import, - export). Signed panel watts made the
        model add -5286 W where the draw was 6290 W.
      * Battery comes from Solar Assistant (measured), never from the virtual
        SOC model behind /api/storage, which sat at ~53% while the pack read
        99%; the model quoted the simulated figure.
      * Appliance watts from the disaggregator are estimates (with the Nemotron
        NILM engine they are the nominal ratings), so they are labelled est_w
        and checked against the measured panel power in _derived().
      * The readiness payload (24 h weather arrays, outage rows) is dropped;
        only the decision and its reasons are kept.
    """
    feeds = sorted({_FEED_FOR[k] for k in (want or []) if k in _FEED_FOR}) or _ALL_FEEDS
    with ThreadPoolExecutor(max_workers=len(feeds)) as ex:
        got = dict(zip(feeds, ex.map(_feed, feeds)))

    out = {}

    snap = got.get("snapshot") or {}
    if snap:
        raw = {k: _num(v.get("w")) for k, v in snap.items() if isinstance(v, dict)}
        out["panel_draw_w"] = {k: (None if raw.get(k) is None else round(abs(raw[k])))
                               for k in SUB_PANELS if k in raw}
        if raw.get("Grid Power") is not None:
            out["grid_meter_w"] = round(raw["Grid Power"])
        out["reading_time"] = max((v.get("ts") for v in snap.values()
                                   if isinstance(v, dict) and v.get("ts")), default=None)

    solar = got.get("solar-assistant")
    if solar and solar.get("connected", True):
        out["solar_now"] = {k: _num(solar.get(k)) for k in
                            ("pv_power_w", "load_power_w", "grid_power_w", "battery_power_w")}
        out["solar_now"]["age_s"] = solar.get("age_s")
        out["solar_now"]["ts"] = solar.get("ts")
        soc = _num(solar.get("battery_soc_pct"))
        if soc is not None:
            out["battery"] = {
                "soc_pct": soc,
                "capacity_kwh": CAPACITY_KWH,
                "stored_kwh": round(CAPACITY_KWH * soc / 100.0, 2),
                "to_full_kwh": round(CAPACITY_KWH * (100.0 - soc) / 100.0, 2),
                "power_w": _num(solar.get("battery_power_w")),
                "source": "Solar Assistant (measured)",
            }

    relay = got.get("relay") or {}
    if relay:
        t = relay.get("thermostat") or {}
        if any(t.get(k) is not None for k in ("hvac_mode", "hvac_action", "current_f", "target_f")):
            out["thermostat"] = {k: t.get(k) for k in
                                 ("hvac_mode", "hvac_action", "current_f", "target_f")}
        d = relay.get("dss") or {}
        out["relay"] = {"engaged": relay.get("relay_engaged"),
                        "shed_level": d.get("level"), "action": d.get("action"),
                        "urgency": d.get("urgency"), "reasons": d.get("reasons")}

    hvac = got.get("hvac-24h")
    if hvac:
        out["hvac_last_24h"] = {k: hvac.get(k) for k in ("kwh_24h", "avg_w", "samples")}

    loads = got.get("loads") or {}
    if loads.get("loads"):
        out["panel_loads_amps"] = {l.get("panel"): l.get("amps")
                                   for l in loads["loads"] if l.get("amps") is not None}

    nilm = got.get("nilm")
    if isinstance(nilm, list):
        latest = {}
        for r in nilm:
            key = (r.get("circuit"), r.get("appliance"))
            if key not in latest or str(r.get("ts", "")) > str(latest[key].get("ts", "")):
                latest[key] = r
        on = []
        for (circuit, appliance), r in latest.items():
            if str(r.get("state", "")).strip().upper() == "ON":
                on.append({"appliance": appliance, "circuit": circuit,
                           "confidence": _num(r.get("confidence")),
                           "est_w": _num(r.get("avg_w"))})
        out["appliances_on_now"] = sorted(on, key=lambda x: (str(x["circuit"]), str(x["appliance"])))
        out["appliances_tracked"] = len(latest)
        out["appliances_ts"] = max((str(r.get("ts")) for r in latest.values()), default=None)

    expected = [k for k in ("panel_draw_w", "solar_now", "battery", "relay",
                            "hvac_last_24h", "panel_loads_amps", "appliances_on_now")
                if _FEED_FOR[k] in feeds]
    missing = [k for k in expected if k not in out]
    if missing:
        out["_unavailable"] = missing
    return out


def _derived(live):
    """Every sum, difference and ratio a question is likely to need, computed
    here exactly. Nemotron with reasoning off adds a list of ten numbers wrong
    (12650 for 13150), so the arithmetic is done in Python and handed over."""
    d = {}
    on = live.get("appliances_on_now")
    pdw = live.get("panel_draw_w") or {}
    if on is not None:
        d["appliances_on_count"] = len(on)
        d["appliances_on_est_total_w"] = round(sum(a.get("est_w") or 0 for a in on))
        checks = {}
        for p in SUB_PANELS:
            claimed = [a for a in on if a.get("circuit") == p]
            if not claimed:
                continue
            est = round(sum(a.get("est_w") or 0 for a in claimed))
            meas = pdw.get(p)
            row = {"appliances_on": len(claimed), "est_total_w": est, "measured_w": meas}
            if meas is not None:
                row["measured_minus_est_w"] = round(meas - est)
                # 25% + 150 W of slack for meter/NILM timing and standby loads.
                row["consistent"] = est <= meas * 1.25 + 150
            checks[p] = row
        d["appliance_check"] = checks
    if pdw:
        three = [pdw.get(p) for p in SUB_PANELS[:3] if pdw.get(p) is not None]
        d["panels_1_2_3_total_w"] = round(sum(three))
        d["all_sub_panels_total_w"] = round(sum(v for v in pdw.values() if v is not None))
    s = live.get("solar_now") or {}
    pv, load, grid = s.get("pv_power_w"), s.get("load_power_w"), s.get("grid_power_w")
    if None not in (pv, load):
        d["solar_minus_load_w"] = round(pv - load)
        d["solar_share_of_load_pct"] = round(100.0 * min(pv, load) / load, 1) if load else None
    if grid is not None:
        d["grid_export_w"] = round(max(0.0, -grid))
        d["grid_import_w"] = round(max(0.0, grid))
        if pv:
            d["export_pct_of_solar"] = round(100.0 * max(0.0, -grid) / pv, 1)
    h = live.get("hvac_last_24h") or {}
    if h.get("avg_w") is not None:
        d["hvac_avg_kw_24h"] = round(float(h["avg_w"]) / 1000.0, 3)
    return d


def _headline(live, derived=None):
    """Short declarative sentences first, then the pre-computed figures. A
    model given nested JSON first answered from the constants instead."""
    derived = derived if derived is not None else _derived(live)
    L = []
    s = live.get("solar_now") or {}
    if s:
        L.append("Solar Assistant (age %s s): solar producing %s W, house load %s W, grid %s W "
                 "(+ import, - export), battery power %s W (+ charging)."
                 % (s.get("age_s"), _fmt(s.get("pv_power_w")), _fmt(s.get("load_power_w")),
                    _fmt(s.get("grid_power_w")), _fmt(s.get("battery_power_w"))))
    b = live.get("battery") or {}
    if b:
        L.append("Battery (measured): %s%% state of charge = %s kWh stored of %s kWh; "
                 "%s kWh more would fill it." % (_fmt(b.get("soc_pct")), b.get("stored_kwh"),
                                                 b.get("capacity_kwh"), b.get("to_full_kwh")))
    pdw = live.get("panel_draw_w")
    if pdw:
        L.append("Measured sub-panel draw (eGauge, positive = consuming): "
                 + ", ".join("%s %s W" % (k, v) for k, v in pdw.items()) + ".")
    on = live.get("appliances_on_now")
    if on is not None:
        if on:
            L.append("Appliances the disaggregator reports ON (est_w is an ESTIMATE, usually the "
                     "nominal rating, not a measurement): "
                     + "; ".join("%s on %s, est %s W, confidence %s"
                                 % (a["appliance"], a["circuit"], _fmt(a.get("est_w")),
                                    a.get("confidence")) for a in on)
                     + ". Every other tracked appliance is OFF (%s tracked)."
                     % live.get("appliances_tracked"))
        else:
            L.append("The disaggregator reports NO appliances ON (%s tracked)."
                     % live.get("appliances_tracked"))
        bad = [(p, c) for p, c in (derived.get("appliance_check") or {}).items()
               if c.get("consistent") is False]
        for p, c in bad:
            L.append("APPLIANCE CHECK FAILED on %s: the %s appliances reported ON add up to %s W "
                     "but the panel measures only %s W. The ON list for this panel is NOT "
                     "reliable; say so and do not present it as fact."
                     % (p, c["appliances_on"], c["est_total_w"], c["measured_w"]))
    t = live.get("thermostat") or {}
    if t:
        L.append("Thermostat: indoor %s F, setpoint %s F, mode %s, action %s."
                 % (t.get("current_f"), t.get("target_f"), t.get("hvac_mode"), t.get("hvac_action")))
    h = live.get("hvac_last_24h") or {}
    if h.get("kwh_24h") is not None:
        L.append("HVAC used %s kWh in the last 24 hours (average %s W)."
                 % (h.get("kwh_24h"), h.get("avg_w")))
    r = live.get("relay") or {}
    if r:
        L.append("Load-shed relay engaged: %s; shed level %s, action %s."
                 % (r.get("engaged"), r.get("shed_level"), r.get("action")))
    if live.get("_unavailable"):
        L.append("UNAVAILABLE right now, do not guess these: %s."
                 % ", ".join(live["_unavailable"]))
    if derived:
        L.append("")
        L.append("PRE-COMPUTED FIGURES (exact; use these instead of doing the arithmetic yourself):")
        for k, v in derived.items():
            if k == "appliance_check":
                for p, c in v.items():
                    L.append("  appliance_check[%s] = %s" % (p, json.dumps(c)))
            elif v is not None:
                L.append("  %s = %s" % (k, v))
    return "\n".join(L) if L else "No live readings came back on this attempt."


def _fmt(v):
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


SYSTEM = """You are the analyst for a residential microgrid in Los Gatos, California.
You run on NVIDIA Nemotron 3.5 Lightning on the site's GX10.

Answer from the CONTEXT below and nothing else. If the context does not contain
what is needed, say exactly what is missing rather than estimating.

Numbers:
- Every figure you give must appear in the CONTEXT or be computed from it.
- For sums, differences, totals and percentages, use the PRE-COMPUTED FIGURES.
  They are exact. Do not redo that arithmetic yourself.
- If you must calculate something that is not pre-computed, write the
  calculation out on one line (for example 4961 - 6942 = -1981 W).
- Keep signs straight: grid + is import and - is export; panel draws are
  positive consumption. If solar is LESS than the load, say so plainly.
- Measured values (eGauge panels, Solar Assistant) outrank estimates. Appliance
  wattages from the disaggregator are estimates. When an APPLIANCE CHECK
  FAILED line is present, tell the user the appliance list for that panel does
  not match the meter, and lead with the measured panel power.

The site: an eGauge meters three sub-panels (Panel1 HVAC, Panel2 H2O, Panel3
Kitchen), a Shop feed, the utility tie and a Generac. Solar with a 13.5 kWh
battery reports through Solar Assistant. Models disaggregate panel power into
22 appliances and a rules layer corrects them. PG&E E6 time-of-use applies.

Format the answer for a chat window: lead with a one-sentence direct answer,
then short bullet points or a small markdown table when listing several items.
Use **bold** for the key number. No preamble, no repeating the question."""


class AskRequest(BaseModel):
    question: str
    model: Optional[str] = None
    include: Optional[List[str]] = None      # subset of context keys
    include_knowledge: Optional[bool] = None # None = decide from the question
    history: Optional[List[Dict[str, str]]] = None
    temperature: Optional[float] = 0.0
    timeout_seconds: Optional[float] = 600.0


# site_knowledge is 84% of the prompt (appliance_spec 4.0 KB, catalogue 3.4 KB)
# and contributes nothing to "what is the battery doing". It is now opt-in: sent
# when the caller asks for it, or when the question is about the specifications
# and rules rather than the live state.
_KNOWLEDGE_HINT = re.compile(
    r"rule|spec|breaker|\bleg\b|rating|catalog|catalogue|threshold|constant|"
    r"capacit|wiring|panel map|which appliances (exist|are tracked)", re.I)


def _keep_alive():
    """Ollama wants a number of seconds or a duration string; the bare string
    "-1" is rejected with `missing unit in duration`. -1 means never unload,
    which is the point: without it the weights are dropped after five minutes
    and the next question pays the disk load again."""
    raw = os.environ.get("IEMS_ASK_KEEP_ALIVE", "-1")
    try:
        val = float(raw)
        return int(val) if val.is_integer() else val
    except ValueError:
        return raw


def _build_context(include=None, question=None, want_knowledge=None):
    live = _live(include)
    if include:
        keep = set(include)
        live = {k: v for k, v in live.items() if k in keep or k.startswith("_")}
    if want_knowledge is None:
        want_knowledge = bool(question and _KNOWLEDGE_HINT.search(question))
    knowledge = _static() if want_knowledge else {}
    if include and knowledge:
        # include names live feeds ("battery"), knowledge sections
        # ("appliance_spec"), or both. Only narrow the knowledge when the
        # caller actually named a knowledge section -- otherwise
        # include=battery&knowledge=1 silently returned nothing.
        keep = set(include) & set(knowledge)
        if keep:
            knowledge = {k: v for k, v in knowledge.items() if k in keep}
    return {"live": live, "site_knowledge": knowledge}


@ask_router.get("/ask/context")
def ask_context(include: str = "", knowledge: int = 0, question: str = ""):
    """The exact bundle the model is given. Useful on its own, and the first
    thing to look at when an answer is wrong."""
    ctx = _build_context([s for s in include.split(",") if s] or None,
                         question or None,
                         True if knowledge else (None if question else False))
    return {"model": MODEL, "ollama": OLLAMA,
            "context_chars": len(json.dumps(ctx)),
            "derived": _derived(ctx.get("live", {})),
            "headline": _headline(ctx.get("live", {})),
            "live_keys": sorted(ctx.get("live", {})),
            "knowledge_keys": sorted(ctx.get("site_knowledge", {})),
            "context": ctx}


@ask_router.get("/ask/health")
def ask_health():
    tags = _get(OLLAMA + "/api/tags", timeout=20) or {}
    models = [m.get("name") for m in tags.get("models", [])]
    return {"ollama": OLLAMA, "reachable": bool(tags), "models": models,
            "configured_model": MODEL,
            "model_present": MODEL in models or (MODEL + ":latest") in models,
            "dashboard": DASH,
            "provider": "ollama"}


@ask_router.post("/ask")
def ask(req: AskRequest):
    # Always Nemotron 3.5 Lightning. req.model is ignored on purpose so no
    # caller can route the Ask tab to a different (smaller) model.
    model = MODEL
    ctx = _build_context(req.include, req.question, req.include_knowledge)

    messages = [{"role": "system", "content": SYSTEM}]
    for turn in (req.history or [])[-6:]:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": turn["content"]})
    live = ctx.get("live", {})
    derived = _derived(live)
    messages.append({"role": "user", "content":
        "RIGHT NOW AT THE SITE\n%s\n\n"
        "SITE KNOWLEDGE (specifications and rules, not live readings)\n%s\n\n"
        "SUPPORTING DETAIL (json)\n%s\n\n"
        "QUESTION\n%s\n\n"
        "Answer from RIGHT NOW first. The site knowledge is background only; do "
        "not present a rule constant as a live reading."
        % (_headline(live, derived),
           json.dumps(ctx.get("site_knowledge", {}), default=str),
           json.dumps(live, default=str),
           req.question)})

    cloud_error = None

    # keep_alive -1 pins the weights: without it Ollama drops the model after
    # five minutes and the next question pays ~45 s of disk again. num_ctx 2048
    # is safe now that site_knowledge is off the default path, and halves the KV
    # cache. num_predict caps the tail, which is the one cost that scales with
    # the answer -- at a few tokens a second a 200-token reply is most of a
    # minute of pure output.
    payload = json.dumps({
        "model": model, "messages": messages, "stream": False,
        # Nemotron is a reasoning model. With thinking on, the whole token
        # budget went to the hidden reasoning and the answer came back empty.
        "think": _THINK,
        "keep_alive": _keep_alive(),
        "options": {"temperature": (0.0 if req.temperature is None
                                   else float(req.temperature)),
                    "num_ctx": int(os.environ.get("IEMS_ASK_NUM_CTX", "8192")),
                    "num_predict": int(os.environ.get("IEMS_ASK_MAX_TOKENS",
                                                      "4096" if _THINK else "700"))},
    }).encode()

    request = urllib.request.Request(
        OLLAMA + "/api/chat", data=payload,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=req.timeout_seconds or 600) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": "ollama %s" % exc.code,
                "detail": exc.read().decode("utf-8", "replace")[:400], "model": model}
    except Exception as exc:
        return {"ok": False, "error": "ollama unreachable", "detail": str(exc),
                "model": model, "ollama": OLLAMA}

    return {
        "ok": True,
        "answer": (body.get("message") or {}).get("content", ""),
        "think": _THINK,
        "model": model,
        "provider": "ollama",
        "cloud_error": cloud_error,
        "context_chars": len(json.dumps(ctx, default=str)),
        "live_keys": sorted(ctx.get("live", {})),
        "knowledge_keys": sorted(ctx.get("site_knowledge", {})),
        "eval_count": body.get("eval_count"),
        "eval_duration_ms": round((body.get("eval_duration") or 0) / 1e6),
        "total_duration_ms": round((body.get("total_duration") or 0) / 1e6),
    }
