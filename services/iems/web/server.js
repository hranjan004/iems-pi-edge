/**
 * IEMS Live Dashboard  —  zero npm, single file
 * Run:   node services/iems/web/server.js
 * Open:  http://localhost:47821
 *
 * Data sources:
 *   AnyLog REST   → 127.0.0.1:32149   (raw energy_readings + nilm_disaggregated +
 *                                      solar_data measured PV/battery/grid/load)
 *   IEMS FastAPI  → 127.0.0.1:8000    (cycle, models, health, weather/TOU)
 *
 * UI: cream-paper aesthetic, abstract SVG glyphs (no emoji), 14-appliance
 * NILM grid, raw power line graph, TOU rate + load-forecast graph, DSS.
 */

const readiness = require('./readiness')
readiness.start()
const http  = require('http')
const fs    = require('fs')
const pathm = require('path')
const PORT         = parseInt(process.env.PORT || '47821')
const ANYLOG_HOST  = process.env.ANYLOG_HOST  || '127.0.0.1'
const ANYLOG_PORT  = parseInt(process.env.ANYLOG_PORT  || '32149')
const IEMS_HOST    = process.env.IEMS_HOST    || '127.0.0.1'
const IEMS_PORT    = parseInt(process.env.IEMS_PORT    || '8000')
const HA_URL       = process.env.HA_URL || 'http://araspberrypi.home:8123'
const HA_TOKEN     = (() => {
  if (process.env.HA_TOKEN) return process.env.HA_TOKEN.trim()
  // Try the container path first, then the host locations the deploy script
  // uses. Reading none of them is reported as 'no HA token' rather than
  // silently disabling the thermostat controls.
  const cands = [process.env.HA_TOKEN_FILE, '/app/.ha_token',
                 '/home/microgrid/ha_token.txt',
                 (process.env.HOME || '') + '/.ha_token'].filter(Boolean)
  for (const f of cands) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t } catch (e) {}
  }
  return ''
})()
const HVAC_ENTITY  = process.env.HVAC_ENTITY || 'climate.sensi_2a293d_thermostat'
const RELAY_STATE  = process.env.RELAY_STATE || '/app/relay_state.json'
// Survives restore, unlike RELAY_STATE: this is what drift is measured against.
const RELAY_LAST   = process.env.RELAY_LAST   || '/app/relay_last.json'
const RELAY_CONFIG = process.env.RELAY_CONFIG || '/app/relay_config.json'
const TZ           = process.env.DISPLAY_TZ   || 'America/Los_Angeles'
const DEFAULT_STEPS = [2, 4]
// Breaker ratings are still unknown (see services/iems/detect/breaker_ratings.yaml).
// Margin is reported as null rather than guessed: a fabricated rating on a
// safety readout is worse than an empty field.
const BREAKER_AMPS = {
  'Panel1 (HVAC)':   parseFloat(process.env.P1_AMPS || '') || null,
  'Panel2 (H2O)':    parseFloat(process.env.P2_AMPS || '') || null,
  'Panel3 (Kitchen)':parseFloat(process.env.P3_AMPS || '') || null,
}

// ─── AnyLog helpers ───────────────────────────────────────────────────────────
let _partitionCache = {}
let _partitionCacheTs = {}   // per-table ts (was one shared ts -> could pin a table to a stale/dropped partition)

const PARTITION_TTL_MS = 60000   // was 300000: a 5-min pin spans a rollover

function _invalidatePartition(table) {
  delete _partitionCache[table]
  delete _partitionCacheTs[table]
}

// `get partitions` returns: par_<name>|<start-date>|<end-date>|
// Rank by END DATE (actual data recency), not by lexical name. A name sort
// silently returns a stale partition whenever a newer one is missing its
// date columns, which is how a dead partition ends up looking "latest".
async function _getPartition(table) {
  const now = Date.now()
  if (_partitionCache[table] && now - (_partitionCacheTs[table] || 0) < PARTITION_TTL_MS)
    return _partitionCache[table]
  const raw = await _alRequest(`get partitions where dbms=customers and table=${table}`)
  const parts = []
  for (const line of raw.split('\n')) {
    const m = line.match(/(par_[^\s|]+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(\d{4}-\d{2}-\d{2})/)
    if (m) { parts.push({ name: m[1], end: m[3] }) }
    else {
      // No date columns (e.g. a partition created moments ago). Keep it as a
      // candidate rather than dropping it -- dropping is what strands us on
      // an old partition -- but rank it last-resort by name.
      const n = line.match(/(par_[^\s|]+)/)
      if (n) parts.push({ name: n[1], end: null })
    }
  }
  if (!parts.length) return _partitionCache[table] || null
  const dated = parts.filter(p => p.end)
  let latest
  if (dated.length) {
    dated.sort((a, b) => a.end < b.end ? -1 : a.end > b.end ? 1 : (a.name < b.name ? -1 : 1))
    latest = dated[dated.length - 1].name
    // A brand-new undated partition sorts after every dated one by name.
    const undated = parts.filter(p => !p.end).map(p => p.name).sort()
    if (undated.length && undated[undated.length - 1] > latest)
      latest = undated[undated.length - 1]
  } else {
    parts.sort((a, b) => a.name < b.name ? -1 : 1)
    latest = parts[parts.length - 1].name
  }
  if (latest) { _partitionCache[table] = latest; _partitionCacheTs[table] = now }
  return latest
}

function _rewriteNow(sql) {
  return sql.replace(/NOW\(\)\s*-\s*(\d+)\s*(minutes?|hours?|days?)/gi, (_, n, unit) => {
    const ms = unit.startsWith('min') ? n*60000 : unit.startsWith('hour') ? n*3600000 : n*86400000
    const dt = new Date(Date.now() - ms)
    return `'${dt.toISOString().replace('T',' ').slice(0,19)}'`
  })
}

function _alRequest(cmd, timeout = 20000, network = false) {
  return new Promise((resolve) => {
    const net = require('net')
    const sock = net.createConnection(ANYLOG_PORT, ANYLOG_HOST)
    const headers = [
      `GET / HTTP/1.1`,
      `Host: ${ANYLOG_HOST}:${ANYLOG_PORT}`,
      `User-Agent: AnyLog/1.23`,
      `command: ${cmd}`,
      ...(network ? ['destination: network'] : []),
      `Connection: close`,
      ``,``,
    ].join('\r\n')
    let buf = ''
    sock.setTimeout(timeout)
    sock.on('connect', () => sock.write(headers))
    sock.on('data', d => { buf += d.toString() })
    sock.on('end', finish)
    sock.on('timeout', () => { sock.destroy(); finish() })
    sock.on('error', () => finish())
    function finish() {
      const body = buf.includes('\r\n\r\n') ? buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') : buf
      const cleaned = body.replace(/(?:^|\n)[0-9a-fA-F]+\r?\n/g, '\n').trim()
      resolve(cleaned)
    }
  })
}

async function alSql(sql, timeout = 25000, _retry = true) {
  let resolved = _rewriteNow(sql)
  const substituted = []
  for (const tbl of ['energy_readings', 'nilm_disaggregated', 'solar_data', 'anomalies']) {
    const re = new RegExp('\\b' + tbl + '\\b')
    if (re.test(resolved)) {
      const part = await _getPartition(tbl)
      if (part) { resolved = resolved.replace(re, part); substituted.push(tbl) }
    }
  }
  const cmd = `sql customers format=json and stat=false "${resolved}"`
  const raw = await _alRequest(cmd, timeout)
  // An empty result from a substituted partition usually means the cache is
  // pinned to a rolled-over partition. Drop it and re-resolve once.
  if (_retry && substituted.length &&
      (!raw || raw.includes('Empty data set') || raw.includes('"reply"'))) {
    substituted.forEach(_invalidatePartition)
    const again = await alSql(sql, timeout, false)
    if (again && again.length) return again
  }
  try {
    const j = JSON.parse(raw)
    if (Array.isArray(j)) return j
    if (j && Array.isArray(j.Query)) return j.Query
    if (j && typeof j.reply === 'string' && j.reply.toLowerCase().includes('empty')) return []
    if (j && j.err_text) { console.warn('[alSql] AnyLog error:', j.err_text, '| sql:', sql.slice(0,80)); return [] }
    return []
  } catch {
    if (raw.includes('Empty data set') || !raw) return []
    console.warn('[alSql] parse failed, raw=', raw.slice(0,120))
    return []
  }
}

// ─── IEMS FastAPI proxy helper ────────────────────────────────────────────────

function iemsGet(path, timeout = 15000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: IEMS_HOST, port: IEMS_PORT, path, method: 'GET',
      headers: { 'Accept': 'application/json' },
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
    })
    req.setTimeout(timeout, () => req.destroy(new Error('IEMS timeout')))
    req.on('error', e => resolve({ error: e.message }))
    req.end()
  })
}

function iemsPost(path, body, timeout = 600000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body)
    const req = http.request({
      hostname: IEMS_HOST, port: IEMS_PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = ''
      res.on('data', c => raw += c)
      res.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
    })
    req.setTimeout(timeout, () => req.destroy(new Error('IEMS cycle timeout')))
    req.on('error', e => resolve({ error: e.message }))
    req.write(data)
    req.end()
  })
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

const PANELS = [
  'Grid Power', 'Generac Power', 'Panel1 (HVAC)',
  'Panel2 (H2O)', 'Panel3 (Kitchen)', 'Shop',
]
const PANEL_SET = new Set(PANELS)

async function handleSnapshot(res) {
  const rows = await alSql(
    "SELECT ts, nm, w FROM energy_readings " +
    "WHERE ts > NOW() - 10 minutes ORDER BY ts ASC"
  )
  const snap = {}
  for (const r of rows) {
    if (!PANEL_SET.has(r.nm)) continue
    if (!snap[r.nm] || r.ts > snap[r.nm].ts)
      snap[r.nm] = { ts: r.ts, w: parseFloat(r.w) }
  }
  json(res, snap)
}

async function handleStorage(res) {
  // Latest watts per power channel (last 10 min)
  const rows = await alSql(
    "SELECT ts, nm, w FROM energy_readings WHERE ts > NOW() - 10 minutes ORDER BY ts ASC"
  )
  const latest = {}
  for (const r of rows) {
    if (!PANEL_SET.has(r.nm)) continue
    if (!latest[r.nm] || r.ts > latest[r.nm].ts) latest[r.nm] = { ts: r.ts, w: parseFloat(r.w) }
  }
  const W = nm => latest[nm] ? latest[nm].w : 0
  const grid    = W('Grid Power')        // signed: + import / - export
  const generac = W('Generac Power')
  const loadW   = Math.abs(W('Panel1 (HVAC)')) + Math.abs(W('Panel2 (H2O)')) +
                  Math.abs(W('Panel3 (Kitchen)')) + Math.abs(W('Shop'))
  // Energy balance: no PV CT on the meter, so derive solar.  Validated vs night data.
  const solarW  = Math.max(0, loadW - grid - generac)
  const netW    = solarW - loadW
  // Battery is authoritative from the backend (13.5 kWh / 50% floor); null if backend down.
  let battery = null
  try { const sb = await iemsGet('/iems/storage'); if (sb && sb.battery) battery = sb.battery } catch (e) {}
  json(res, {
    solar: {
      production_w:       Math.round(solarW),
      house_load_w:       Math.round(loadW),
      grid_w:             Math.round(grid),
      exporting_w:        Math.round(Math.max(0, -grid)),
      self_consumption_w: Math.round(Math.min(solarW, loadW)),
      method: 'derived: max(0, load - grid - generac)',
    },
    battery,
    net_w: Math.round(netW),
  })
}

// Measured Solar Assistant telemetry (separate from the derived estimate
// above). Mirrors fetch_solar_snapshot() in services/iems/load/anylog_query.py
// so the dashboard and the rules engine agree on what "recent" means.
async function handleSolarAssistant(res) {
  const rows = await alSql(
    "SELECT ts, pv_power, battery_power, battery_soc, grid_power, load_power, device_mode " +
    "FROM solar_data WHERE ts > NOW() - 10 minutes ORDER BY ts DESC"
  )
  if (!rows.length) return json(res, { connected: false })
  const r = rows[0]
  const ageS = Math.round((Date.now() - Date.parse(r.ts.replace(' ', 'T') + 'Z')) / 1000)
  json(res, {
    connected: true,
    pv_power_w:      Math.round(parseFloat(r.pv_power) || 0),
    battery_power_w: Math.round(parseFloat(r.battery_power) || 0),
    battery_soc_pct: parseFloat(r.battery_soc) || 0,
    grid_power_w:    Math.round(parseFloat(r.grid_power) || 0),
    load_power_w:    Math.round(parseFloat(r.load_power) || 0),
    device_mode:     r.device_mode || null,
    ts: r.ts,
    age_s: Number.isFinite(ageS) ? ageS : null,
  })
}

// Measured Solar Assistant history for the solar/battery sync chart.
// Same solar_data table the snapshot reads; series, not just the latest row.
async function handleSolarHistory(res, params) {
  const { m, fine, agg } = rangeSpec(params.get('minutes') || '180')
  const rows = aggregate(fine ? S10 : SM1, Date.now() - m * MIN_MS, agg, ['pv', 'batt', 'soc', 'load', 'grid'])
  json(res, rows.map(p => ({ ts: utcStr(p.t), pv: p.pv || 0, batt: p.batt || 0, soc: p.soc || 0,
    load: p.load || 0, grid: p.grid || 0 })))
}

// Source health: one call the UI can render per-link status from, rather than
// three separate polls that disagree with each other. Every field is measured -
// an unreachable source reports its error string, never a cheerful default.
// One /api/sources build costs ~15 s of AnyLog scanning, and two surfaces poll
// it continuously (this page and the GUI plugin), so uncached it keeps the
// operator's six REST threads busy and starves everything else, MCP handshakes
// included. A short TTL collapses the duplicate work without making the panel
// freshness dishonest.
let _SOURCES_CACHE = { at: 0, val: null }
// 60 s, not 15 s: the handler used to take ~22 s, so a 15 s entry was always
// stale by the time the next poll arrived and the cache never once served a
// request. The aggregate below brings the handler under a second, and 60 s is
// still well inside the 300 s staleness threshold the panels are judged by.
const SOURCES_TTL_MS = 60000
let _SOURCES_INFLIGHT = null

async function handleSources(res) {
  if (_SOURCES_CACHE.val && Date.now() - _SOURCES_CACHE.at < SOURCES_TTL_MS)
    return json(res, _SOURCES_CACHE.val)
  // Collapse concurrent misses onto one AnyLog round trip. Several browser tabs
  // polling together used to start a separate scan each and saturate the
  // operator's REST threads.
  if (!_SOURCES_INFLIGHT)
    _SOURCES_INFLIGHT = buildSources().finally(() => { _SOURCES_INFLIGHT = null })
  return json(res, await _SOURCES_INFLIGHT)
}

async function buildSources() {
  const out = { ts: new Date().toISOString() }

  // eGauge -> AnyLog: per-panel freshness (the panels are separate CT feeds and
  // do go stale independently, so one global "ok" would hide a dead channel).
  //
  // Counted and dated in SQL. Pulling 30 minutes of raw rows meant ~29k records
  // over the wire to compute one count and one max per channel, and took ~22 s;
  // AnyLog pushes the GROUP BY down to the operator and answers in ~0.1 s. The
  // latest watt value still needs a row, so that comes from a 10-minute window
  // -- the same one /api/snapshot uses, which is already fast.
  try {
    const agg = await alSql(
      "SELECT nm, count(*) as n, max(ts) as last_ts FROM energy_readings " +
      "WHERE ts > NOW() - 30 minutes GROUP BY nm") || []
    const recent = await alSql(
      "SELECT ts, nm, w FROM energy_readings " +
      "WHERE ts > NOW() - 10 minutes ORDER BY ts ASC") || []
    const per = {}, cnt = {}
    let rows30 = 0
    for (const r of agg) {
      rows30 += parseInt(r.n) || 0
      if (!PANEL_SET.has(r.nm)) continue
      cnt[r.nm] = parseInt(r.n) || 0
      per[r.nm] = { t: Date.parse((r.last_ts + '').replace(' ', 'T') + 'Z'), w: null }
    }
    for (const r of recent) {
      if (!per[r.nm]) continue
      per[r.nm].w = parseFloat(r.w)   // rows are ascending, so the last one wins
    }
    out.panels = PANELS.map(nm => {
      const p = per[nm]
      return {
        name: nm,
        ok: !!p && (Date.now() - p.t) < 300000,
        age_s: p ? Math.round((Date.now() - p.t) / 1000) : null,
        w: (p && p.w != null) ? Math.round(Math.abs(p.w)) : null,
        samples_30m: cnt[nm] || 0,
      }
    })
    out.anylog = { ok: rows30 > 0, rows_30m: rows30,
                   url: ANYLOG_HOST + ':' + ANYLOG_PORT }
  } catch (e) {
    out.anylog = { ok: false, error: e.message, url: ANYLOG_HOST + ':' + ANYLOG_PORT }
    out.panels = PANELS.map(nm => ({ name: nm, ok: false, age_s: null, w: null, samples_30m: 0 }))
  }

  // Raspberry Pi / Solar Assistant (MQTT -> AnyLog solar_data)
  try {
    const rows = await alSql(
      "SELECT ts, pv_power, battery_soc FROM solar_data " +
      "WHERE ts > NOW() - 30 minutes ORDER BY ts DESC") || []
    if (rows.length) {
      const age = Math.round((Date.now() - Date.parse((rows[0].ts + '').replace(' ', 'T') + 'Z')) / 1000)
      out.solar_assistant = { ok: age < 300, age_s: age, rows_30m: rows.length,
                              soc: parseFloat(rows[0].battery_soc) || 0, host: 'Raspberry Pi · MQTT' }
    } else {
      out.solar_assistant = { ok: false, age_s: null, rows_30m: 0,
                              error: 'no solar_data rows in 30 min', host: 'Raspberry Pi · MQTT' }
    }
  } catch (e) {
    out.solar_assistant = { ok: false, error: e.message, host: 'Raspberry Pi · MQTT' }
  }

  // Home Assistant (thermostat control path)
  try {
    const st = await haReq('/api/states/' + HVAC_ENTITY)
    out.home_assistant = {
      ok: !!(st && st.entity_id), url: HA_URL, entity: HVAC_ENTITY,
      mode: st && st.state,
      current_f: st && st.attributes ? st.attributes.current_temperature : null,
      target_f: st && st.attributes ? st.attributes.temperature : null,
    }
  } catch (e) {
    out.home_assistant = { ok: false, url: HA_URL, entity: HVAC_ENTITY, error: e.message }
  }

  // IEMS backend
  try {
    const h = await iemsGet('/iems/health', 5000)
    out.iems = { ok: !!h, url: IEMS_HOST + ':' + IEMS_PORT }
  } catch (e) {
    out.iems = { ok: false, error: e.message, url: IEMS_HOST + ':' + IEMS_PORT }
  }
  _SOURCES_CACHE = { at: Date.now(), val: out }
  return out
}

// 24h HVAC (Panel1) energy for the relay impact estimate.
//
// Aggregated in SQL, not in Node. Pulling a day of raw rows meant ~400k records
// crossing the wire to compute one mean, which timed out over any link slower
// than loopback. GROUP BY returns six rows instead. Channel names containing
// parentheses cannot be used in a WHERE predicate against AnyLog (they match
// nothing, silently), so the panel is selected from the grouped result here.
let _HVAC_CACHE = { at: 0, val: null }
async function handleHvacDay(res) {
  if (_HVAC_CACHE.val && Date.now() - _HVAC_CACHE.at < 300000)
    return json(res, Object.assign({ cached: true }, _HVAC_CACHE.val))
  let out
  try {
    const rows = await alSql(
      "SELECT nm, AVG(w) as avg_w, COUNT(*) as n FROM energy_readings " +
      "WHERE ts > NOW() - 1440 minutes GROUP BY nm", 40000) || []
    const r = rows.find(x => String(x.nm || '').trim() === 'Panel1 (HVAC)')
    const avgW = r ? Math.abs(parseFloat(r.avg_w) || 0) : 0
    const n = r ? parseInt(r.n) || 0 : 0
    out = {
      samples: n,
      avg_w: Math.round(avgW),
      kwh_24h: Math.round(avgW * 24 / 1000 * 100) / 100,
      note: n < 100 ? 'thin data - treat the estimate loosely' : 'ok',
    }
    _HVAC_CACHE = { at: Date.now(), val: out }
  } catch (e) {
    // No fabricated fallback: the impact tile prints a dash rather than a
    // number the user might act on.
    out = { samples: 0, avg_w: null, kwh_24h: null, error: e.message }
  }
  json(res, out)
}

async function handleHistory(res, params) {
  const { m, fine, agg } = rangeSpec(params.get('minutes') || '30')
  const src = fine ? H10 : M1, from = Date.now() - m * MIN_MS
  const out = []
  for (const nm of PANELS) {
    if (!src[nm]) continue
    for (const p of aggregate(src[nm], from, agg, ['w']))
      out.push({ ts: utcStr(p.t), nm, w: p.w, wmax: p.wmax, wmin: p.wmin })
  }
  out.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
  json(res, out)
}

async function handleNilm(res) {
  const rows = await alSql(
    "SELECT ts, circuit, appliance, state, confidence, avg_w " +
    "FROM nilm_disaggregated ORDER BY ts DESC LIMIT 100"
  )
  json(res, rows)
}

async function handleCycle(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', async () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    const result = await iemsPost('/iems/cycle', payload)
    json(res, result)
  })
}

// Ask: forward the question to the IEMS backend, which assembles the live
// context and asks Nemotron 3.5 Lightning against it.
async function handleAsk(req, res) {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', async () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    const result = await iemsPost('/iems/ask', payload, 600000)
    json(res, result)
  })
}

async function handleLlmModel(res) {
  // The configured Ollama model is owned by the IEMS backend, not by this page.
  // Asking for it keeps the Run button from calling a model that is not installed.
  const h = await iemsGet('/iems/ask/health')
  json(res, { model: (h && h.configured_model) ? h.configured_model : null })
}

function handleModelMeta(res) {
  // Per-appliance transparency: live decision threshold + held-out test F1.
  // Thresholds come from the norm jsons the inference loop actually loads;
  // F1s come from model_card.json written by the training pipeline.
  const root = pathm.join(__dirname, '..', 'models')
  const meta = {}
  for (const n of [1, 2, 3]) {
    try {
      const d = JSON.parse(fs.readFileSync(pathm.join(root, 'panel' + n + '_norm_bilstm.json'), 'utf8'))
      for (const [k, v] of Object.entries(d.thresholds || {})) meta[k] = { thr: v }
    } catch (e) {}
  }
  try {
    const card = JSON.parse(fs.readFileSync(pathm.join(root, 'model_card.json'), 'utf8'))
    for (const [k, v] of Object.entries(card.appliances || {})) {
      meta[k] = Object.assign(meta[k] || {}, { f1: v.f1, trained: card.trained_at })
    }
  } catch (e) {}
  json(res, meta)
}

async function handleModels(res) {
  const result = await iemsGet('/iems/models')
  json(res, result)
}

async function handleHealth(res) {
  const [anylogHealth, iemsHealth] = await Promise.allSettled([
    alSql("SELECT COUNT(*) as n FROM energy_readings WHERE ts > NOW() - 5 minutes"),
    iemsGet('/iems/health', 8000),
  ])
  const anylogRows = anylogHealth.status === 'fulfilled' ? anylogHealth.value : []
  const iemsData   = iemsHealth.status  === 'fulfilled' ? iemsHealth.value  : {}
  json(res, {
    anylog: { ok: anylogRows.length > 0, rows_5m: anylogRows[0]?.n || 0, url: `${ANYLOG_HOST}:${ANYLOG_PORT}` },
    iems: iemsData,
    server: { port: PORT, ts: new Date().toISOString() },
  })
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function readBody(req, limit = 65536) {
  return new Promise(resolve => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > limit) { b = b.slice(0, limit); req.destroy() } })
    req.on('end', () => resolve(b))
    req.on('error', () => resolve(''))
  })
}

function json(res, data) {
  const body = JSON.stringify(data)
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  })
  res.end(body)
}

function err(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: msg }))
}

// ─── Router ───────────────────────────────────────────────────────────────────


// ── Relay (manual HVAC control) + logs ───────────────────────────────────────

function haReq(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    if (!HA_TOKEN) return reject(new Error('no HA token available to the dashboard'))
    const u = new URL(HA_URL + path)
    const body = bodyObj ? JSON.stringify(bodyObj) : null
    const r = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: method || 'GET',
      headers: Object.assign(
        { 'Authorization': 'Bearer ' + HA_TOKEN, 'Content-Type': 'application/json' },
        body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
    }, resp => {
      let d = ''
      resp.on('data', c => d += c)
      resp.on('end', () => resp.statusCode >= 400
        ? reject(new Error('HA ' + resp.statusCode + ' ' + d.slice(0, 120)))
        : resolve(d.trim() ? JSON.parse(d) : null))
    })
    r.on('error', reject)
    r.setTimeout(10000, () => r.destroy(new Error('HA timeout')))
    if (body) r.write(body)
    r.end()
  })
}

function readRelayState() {
  try { return JSON.parse(fs.readFileSync(RELAY_STATE, 'utf8')) } catch (e) { return null }
}
function writeRelayState(s) {
  try {
    if (s === null) { fs.unlinkSync(RELAY_STATE); return }
    fs.writeFileSync(RELAY_STATE, JSON.stringify(s, null, 2))
  } catch (e) { console.warn('[relay] state write failed:', e.message) }
}

async function thermostat() {
  const s = await haReq('/api/states/' + HVAC_ENTITY)
  const a = (s && s.attributes) || {}
  return {
    entity_id: HVAC_ENTITY, hvac_mode: s && s.state, hvac_action: a.hvac_action,
    target_f: a.temperature, current_f: a.current_temperature,
    min_temp: a.min_temp, max_temp: a.max_temp,
    friendly_name: a.friendly_name, last_updated: s && s.last_updated,
  }
}

async function notifyHA(title, message) {
  const out = {}
  for (const svc of ['system_email', 'mantey_sms']) {
    try { await haReq('/api/services/notify/' + svc, 'POST', { title, message }); out[svc] = true }
    catch (e) { out[svc] = false; console.warn('[relay] notify.' + svc + ' failed:', e.message) }
  }
  return out
}

// Write an audit row to customers.anomalies via AnyLog streaming PUT.
function logRelayAction(row) {
  return new Promise(resolve => {
    const payload = JSON.stringify([Object.assign({
      ts: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      atype: 'relay', severity: 'info', source: 'relay', entity: HVAC_ENTITY,
      value: 0.0, threshold: 0.0, pct: 0.0, sustained_s: 0,
      status: 'open', fingerprint: 'relay:' + HVAC_ENTITY, notified: 'no',
      message: '', action: '',
    }, row)])
    const r = http.request({
      hostname: ANYLOG_HOST, port: ANYLOG_PORT, path: '/', method: 'PUT',
      headers: {
        'User-Agent': 'AnyLog/1.23', 'type': 'json', 'dbms': 'customers',
        'table': 'anomalies', 'mode': 'streaming', 'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, resp => { resp.on('data', () => {}); resp.on('end', () => resolve(resp.statusCode === 200)) })
    r.on('error', e => { console.warn('[relay] audit write failed:', e.message); resolve(false) })
    r.setTimeout(10000, () => { r.destroy(); resolve(false) })
    r.write(payload); r.end()
  })
}

// ── DSS: advisory only. Returns a recommendation, never acts on it. ──────────
async function dssRecommend(t) {
  const reasons = []
  let level = 0, action = 'none', urgency = 'info'

  let anomalies = []
  try {
    anomalies = await alSql("SELECT ts, atype, severity, entity, message FROM anomalies " +
                            "WHERE ts > NOW() - 120 minutes ORDER BY ts ASC") || []
  } catch (e) { reasons.push('anomaly feed unavailable: ' + e.message) }
  anomalies = anomalies.filter(r => String(r.source || '').trim() !== 'anomaly_store')

  const crit = anomalies.filter(r => String(r.severity || '').trim() === 'critical')
  const p1crit = crit.filter(r => /panel1|hvac/i.test(String(r.entity || '')))
  if (p1crit.length) {
    level = 3; action = 'Turn HVAC off'; urgency = 'critical'
    reasons.push(p1crit.length + ' critical anomaly on the HVAC panel in the last 2 h')
  } else if (crit.length) {
    level = Math.max(level, 2); action = 'Raise setpoint +4F'; urgency = 'warning'
    reasons.push(crit.length + ' critical anomaly elsewhere on the service')
  }

  let solar = null
  try {
    const rows = await alSql("SELECT ts, pv_power, battery_soc, grid_power, load_power " +
                             "FROM solar_data WHERE ts > NOW() - 15 minutes ORDER BY ts DESC")
    if (rows && rows.length) solar = rows[0]
  } catch (e) {}
  if (solar) {
    const soc = parseFloat(solar.battery_soc) || 0
    const grid = parseFloat(solar.grid_power) || 0
    if (grid > 1000 && soc < 40) {
      level = Math.max(level, 2)
      if (action === 'none') action = 'Raise setpoint +4F'
      urgency = urgency === 'info' ? 'warning' : urgency
      reasons.push('importing ' + Math.round(grid) + ' W from grid with battery at ' + soc + '%')
    } else if (grid < -500 && soc > 90) {
      reasons.push('exporting ' + Math.round(-grid) + ' W with battery at ' + soc + '% - no need to shed')
    }
  }

  // Comfort overrides everything: never recommend shedding a warm house.
  if (t && t.current_f != null && Number(t.current_f) >= 82) {
    level = 0; action = 'Restore normal cooling'; urgency = 'warning'
    reasons.length = 0
    reasons.push('indoor is ' + t.current_f + 'F - comfort takes priority over load')
  }

  if (!reasons.length) reasons.push('no critical anomalies; load and solar look normal')
  const local = readiness.snapshot()
  reasons.push(...local.recommendations.map(r => r.action + ': ' + r.rationale))
  return { level, action, urgency, reasons, readiness: local, considered: anomalies.length }
}

function readJsonFile(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return fallback }
}
function writeJsonFile(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); return true }
  catch (e) { console.warn('[relay] write ' + p + ' failed:', e.message); return false } }

function relayConfig() {
  const c = readJsonFile(RELAY_CONFIG, null) || {}
  let steps = Array.isArray(c.steps) ? c.steps : DEFAULT_STEPS
  steps = steps.map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 20)
  if (!steps.length) steps = DEFAULT_STEPS
  return { steps, allow_off: c.allow_off !== false }
}

// Remembered across restores so drift can still be detected afterwards.
function recordExpected(mode, target) {
  writeJsonFile(RELAY_LAST, {
    expected_mode: mode, expected_target: target == null ? null : Number(target),
    set_at: new Date().toISOString(),
  })
}

function computeDrift(t) {
  const last = readJsonFile(RELAY_LAST, null)
  if (!last || !t) return { drifted: false, reason: 'no relay action recorded yet' }
  const expT = last.expected_target, actT = t.target_f
  const expM = last.expected_mode === 'off' ? 'off' : null

  if (expM === 'off' && t.hvac_mode !== 'off') {
    return { drifted: true, expected: 'off', actual: t.hvac_mode,
             since: t.last_updated, set_at: last.set_at, field: 'mode' }
  }
  if (expT != null && actT != null && Math.abs(Number(actT) - Number(expT)) > 0.5) {
    return { drifted: true, expected: Number(expT), actual: Number(actT),
             since: t.last_updated, set_at: last.set_at, field: 'setpoint' }
  }
  return { drifted: false, expected: expT, actual: actT, set_at: last.set_at }
}

async function handleRelayConfig(req, res) {
  if (req.method === 'GET') return json(res, relayConfig())
  const raw = await readBody(req)
  let b = {}
  try { b = JSON.parse(raw || '{}') } catch (e) { return err(res, 400, 'bad JSON') }
  const cur = relayConfig()
  let steps = Array.isArray(b.steps) ? b.steps.map(Number) : cur.steps
  steps = steps.filter(n => Number.isFinite(n) && n > 0 && n <= 20)
  if (!steps.length) return err(res, 400, 'steps must be 1-20 degrees')
  const next = { steps: steps.slice(0, 4),
                 allow_off: b.allow_off === undefined ? cur.allow_off : !!b.allow_off }
  writeJsonFile(RELAY_CONFIG, next)
  json(res, next)
}

async function handleRelay(res) {
  let t = null, haOk = true, haErr = null
  try { t = await thermostat() } catch (e) { haOk = false; haErr = String(e.message || e) }
  const st = readRelayState()
  let dss = null
  try { dss = await dssRecommend(t) } catch (e) { dss = { error: String(e.message || e) } }
  const heldS = st && st.applied_at ? Math.round((Date.now() - Date.parse(st.applied_at)) / 1000) : null
  const drift = computeDrift(t)
  json(res, {
    tz: TZ,
    config: relayConfig(),
    drift,
    // The Sensi keeps its own schedule (intentionally left enabled), so the
    // thermostat can move without the relay. Drift is expected, not a fault.
    schedule_note: 'The Sensi thermostat runs its own schedule. Relay changes ' +
                   'hold only until the next scheduled step.',
    ha_connected: haOk, ha_error: haErr, ha_url: HA_URL,
    thermostat: t,
    relay_engaged: !!st, relay: st, held_s: heldS,
    // Surfaced so the UI can warn: with automation removed, nothing will put
    // HVAC back on its own. A forgotten OFF is the main hazard here.
    stale_warning: !!(st && st.applied_mode === 'off' && heldS != null && heldS > 1800),
    dss,
  })
}

async function handleRelaySet(req, res) {
  const raw = await readBody(req)
  let mode = 'cool', target = null, reason = 'manual from dashboard'
  try { const b = JSON.parse(raw || '{}'); mode = b.mode || 'cool'; target = b.target; reason = b.reason || reason } catch (e) {}

  let t
  try { t = await thermostat() } catch (e) { return err(res, 502, 'HA unreachable: ' + e.message) }

  const existing = readRelayState()
  const original = (existing && existing.original) || { hvac_mode: t.hvac_mode, target_f: t.target_f }

  try {
    if (mode === 'off') {
      await haReq('/api/services/climate/set_hvac_mode', 'POST',
                  { entity_id: HVAC_ENTITY, hvac_mode: 'off' })
    } else {
      if (target == null) return err(res, 400, 'target required when mode is not off')
      const cap = t.max_temp || 100
      target = Math.min(Number(target), Number(cap))
      await haReq('/api/services/climate/set_temperature', 'POST',
                  { entity_id: HVAC_ENTITY, temperature: target })
    }
  } catch (e) { return err(res, 502, 'HA call failed: ' + e.message) }

  const st = { original, applied_mode: mode, applied_target: mode === 'off' ? null : target,
               applied_at: new Date().toISOString(), reason }
  writeRelayState(st)
  recordExpected(mode, mode === 'off' ? null : target)

  const msg = mode === 'off'
    ? 'HVAC switched OFF from the dashboard. Nothing will switch it back automatically.'
    : 'HVAC setpoint set to ' + target + 'F from the dashboard (was ' + original.target_f + 'F).'
  await logRelayAction({ atype: 'relay_set', severity: mode === 'off' ? 'warning' : 'info',
                         value: Number(target || 0), message: msg, action: reason })
  const n = await notifyHA('Mantey: HVAC relay ' + (mode === 'off' ? 'OFF' : target + 'F'), msg + '\nReason: ' + reason)
  json(res, { ok: true, relay: st, notified: n, message: msg })
}

async function handleRelayRestore(req, res) {
  await readBody(req)
  const st = readRelayState()
  if (!st) return json(res, { ok: true, message: 'relay not engaged; nothing to restore' })
  const o = st.original || {}
  try {
    if (st.applied_mode === 'off' && o.hvac_mode) {
      await haReq('/api/services/climate/set_hvac_mode', 'POST',
                  { entity_id: HVAC_ENTITY, hvac_mode: o.hvac_mode })
      await new Promise(r => setTimeout(r, 2000))
    }
    if (o.target_f != null) {
      await haReq('/api/services/climate/set_temperature', 'POST',
                  { entity_id: HVAC_ENTITY, temperature: o.target_f })
    }
  } catch (e) { return err(res, 502, 'HA call failed: ' + e.message) }

  const held = st.applied_at ? Math.round((Date.now() - Date.parse(st.applied_at)) / 60000) : 0
  writeRelayState(null)
  recordExpected(o.hvac_mode, o.target_f)
  const msg = 'HVAC restored to ' + o.hvac_mode + ' / ' + o.target_f + 'F after ' + held + ' min.'
  await logRelayAction({ atype: 'relay_restore', severity: 'info', status: 'cleared',
                         value: Number(o.target_f || 0), message: msg, action: 'manual restore' })
  const n = await notifyHA('Mantey: HVAC relay restored', msg)
  json(res, { ok: true, notified: n, message: msg })
}

async function handleLoads(res) {
  const rows = await alSql("SELECT ts, nm, w FROM energy_readings " +
                           "WHERE ts > NOW() - 10 minutes ORDER BY ts ASC") || []
  const byCh = {}
  for (const r of rows) {
    const nm = r.nm
    if (!byCh[nm]) byCh[nm] = []
    byCh[nm].push(Math.abs(parseFloat(r.w) || 0))
  }
  const legs = { 'Panel1 (HVAC)': ['I11', 'I12'], 'Panel2 (H2O)': ['I21', 'I22'],
                 'Panel3 (Kitchen)': ['I31', 'I32'] }
  const out = []
  for (const panel of ['Panel1 (HVAC)', 'Panel2 (H2O)', 'Panel3 (Kitchen)', 'Grid Power', 'Shop']) {
    const v = byCh[panel] || []
    if (!v.length) { out.push({ panel, watts: null, amps: null, rating: null, pct: null, samples: 0 }); continue }
    const watts = Math.round(v[v.length - 1])
    let amps = null
    for (const leg of (legs[panel] || [])) {
      const lv = byCh[leg] || []
      if (lv.length) amps = Math.max(amps || 0, lv[lv.length - 1])
    }
    const rating = BREAKER_AMPS[panel] || null
    out.push({ panel, watts, amps: amps != null ? Math.round(amps * 100) / 100 : null,
               rating, pct: (rating && amps != null) ? Math.round(amps / rating * 1000) / 10 : null,
               samples: v.length })
  }
  json(res, { loads: out, ratings_configured: Object.values(BREAKER_AMPS).some(v => v) })
}

async function handleLogs(res, params) {
  const minutes = parseInt(params.get('minutes') || '1440')
  const rows = await alSql('SELECT ts, atype, severity, source, entity, value, threshold, pct, ' +
    'sustained_s, status, message, action FROM anomalies ' +
    `WHERE ts > NOW() - ${minutes} minutes ORDER BY ts ASC`) || []
  const clean = rows.filter(r => String(r.source || '').trim() !== 'anomaly_store').reverse()
  const sev = s => String(s || '').trim()
  json(res, {
    total: clean.length,
    critical: clean.filter(r => sev(r.severity) === 'critical').slice(0, 60),
    relay: clean.filter(r => String(r.source || '').trim() === 'relay').slice(0, 60),
    all: clean.slice(0, 150),
  })
}

// ─── Rolling history caches (storage stays UTC; Pacific is applied on display) ─
// The power chart used to pull raw 1 Hz rows and keep only the last 2000, so any
// range longer than about five minutes silently showed just its final minutes.
// Two rolling caches now back every range: 10 s buckets for the last hour and
// 1 min buckets for the last 24 h. Each is back-filled once (the 24 h cache in
// 3 h slices, since one 24 h aggregate exceeds AnyLog's query timeout) and then
// topped up with a few minutes per poll, so a 24 h chart costs the operator
// nothing per request.
const CH_WHERE = {
  'Grid Power':    "nm = 'Grid Power'",
  'Generac Power': "nm = 'Generac Power'",
  'Shop':          "nm = 'Shop'",
  // AnyLog returns nothing for a literal containing parentheses, so the three
  // panels are selected by a range that matches exactly one channel name.
  'Panel1 (HVAC)':    "nm > 'Panel1' and nm < 'Panel2'",
  'Panel2 (H2O)':     "nm > 'Panel2' and nm < 'Panel3'",
  'Panel3 (Kitchen)': "nm > 'Panel3' and nm < 'Panel4'",
}
const MIN_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000
const H10 = {}, M1 = {}                 // channel -> Map(bucket start ms -> {w, wmax, wmin})
const S10 = new Map(), SM1 = new Map()  // solar -> Map(bucket start ms -> {pv, batt, soc, load, grid})
const HIST = { ready1h: false, ready24h: false, tick: 0 }

const utcStr = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const utcMs  = ts => new Date(String(ts).trim().replace(' ', 'T').replace(/Z?$/, 'Z')).getTime()

// Parent-table query routed through the network layer, so a window that spans a
// monthly partition boundary still returns both sides.
async function alSqlNet(sql, timeout = 30000) {
  const raw = await _alRequest(`sql customers format=json and stat=false "${_rewriteNow(sql)}"`, timeout, true)
  try {
    const j = JSON.parse(raw)
    if (Array.isArray(j)) return j
    if (j && Array.isArray(j.Query)) return j.Query
    if (j && j.err_text) console.warn('[alSqlNet]', j.err_text, '|', sql.slice(0, 90))
  } catch {}
  return []
}

function mergeBuckets(map, rows, sizeMs, fields) {
  for (const r of rows) {
    const t = utcMs(r.ts); if (!isFinite(t)) continue
    const o = {}
    for (const f of fields) o[f] = parseFloat(r[f])
    map.set(Math.floor(t / sizeMs) * sizeMs, o)
  }
}
function pruneBuckets(map, keepMs) {
  const cut = Date.now() - keepMs
  for (const k of map.keys()) if (k < cut) map.delete(k)
}
const incr = sec => sec >= 60 ? `minute, ${sec / 60}` : `second, ${sec}`
const windowSql = (fromMs, toMs) =>
  `ts > '${utcStr(fromMs)}'` + (toMs ? ` and ts <= '${utcStr(toMs)}'` : '')

async function fillPower(nm, fromMs, toMs, sec, map) {
  const rows = await alSqlNet(`select increments(${incr(sec)}, ts), max(ts) as ts, avg(w) as w, ` +
    `max(w) as wmax, min(w) as wmin from energy_readings where ${windowSql(fromMs, toMs)} and ${CH_WHERE[nm]}`)
  mergeBuckets(map, rows, sec * 1000, ['w', 'wmax', 'wmin'])
  return rows.length
}
async function fillSolar(fromMs, toMs, sec, map) {
  const rows = await alSqlNet(`select increments(${incr(sec)}, ts), max(ts) as ts, avg(pv_power) as pv, ` +
    `avg(battery_power) as batt, avg(battery_soc) as soc, avg(load_power) as load, avg(grid_power) as grid ` +
    `from solar_data where ${windowSql(fromMs, toMs)}`)
  mergeBuckets(map, rows, sec * 1000, ['pv', 'batt', 'soc', 'load', 'grid'])
  return rows.length
}
async function backfill24h() {
  const now = Date.now(), SLICE = 3 * HOUR_MS
  for (let a = now - DAY_MS - 10 * MIN_MS; a < now; a += SLICE) {
    const b = Math.min(a + SLICE, now)
    for (const nm of Object.keys(CH_WHERE)) await fillPower(nm, a, b, 60, M1[nm])
    await fillSolar(a, b, 60, SM1)
  }
}
async function histTick() {
  const t0 = Date.now()
  try {
    for (const nm of Object.keys(CH_WHERE)) { H10[nm] = H10[nm] || new Map(); M1[nm] = M1[nm] || new Map() }
    const back = HIST.ready1h ? 2 * MIN_MS : HOUR_MS + 5 * MIN_MS
    for (const nm of Object.keys(CH_WHERE)) await fillPower(nm, t0 - back, null, 10, H10[nm])
    await fillSolar(t0 - back, null, 10, S10)
    HIST.ready1h = true
    if (!HIST.ready24h) {
      await backfill24h()
      HIST.ready24h = true
      await loadAnomalyFingerprints()
      await detectAnomalies()
    } else if (HIST.tick % 6 === 0) {
      for (const nm of Object.keys(CH_WHERE)) await fillPower(nm, t0 - 5 * MIN_MS, null, 60, M1[nm])
      await fillSolar(t0 - 5 * MIN_MS, null, 60, SM1)
      await detectAnomalies()
    }
    for (const nm of Object.keys(CH_WHERE)) {
      pruneBuckets(H10[nm], HOUR_MS + 5 * MIN_MS); pruneBuckets(M1[nm], DAY_MS + 15 * MIN_MS)
    }
    pruneBuckets(S10, HOUR_MS + 5 * MIN_MS); pruneBuckets(SM1, DAY_MS + 15 * MIN_MS)
  } catch (e) { console.warn('[hist]', e && e.message) }
  HIST.tick++
  setTimeout(histTick, Math.max(2000, 10000 - (Date.now() - t0)))
}
setTimeout(histTick, 1000)

// Re-aggregate cached buckets to the resolution a range needs (~300 points).
function aggregate(map, fromMs, aggMs, fields) {
  const g = new Map()
  for (const [k, v] of map) {
    if (k < fromMs) continue
    const b = Math.floor(k / aggMs) * aggMs
    let a = g.get(b)
    if (!a) { a = { n: 0, wmax: -Infinity, wmin: Infinity }; for (const f of fields) a[f] = 0; g.set(b, a) }
    a.n++
    for (const f of fields) if (isFinite(v[f])) a[f] += v[f]
    if (isFinite(v.wmax) && v.wmax > a.wmax) a.wmax = v.wmax
    if (isFinite(v.wmin) && v.wmin < a.wmin) a.wmin = v.wmin
  }
  return [...g.keys()].sort((x, y) => x - y).map(k => {
    const a = g.get(k), o = { t: k }
    for (const f of fields) o[f] = a[f] / a.n
    if (a.wmax > -Infinity) o.wmax = a.wmax
    if (a.wmin < Infinity) o.wmin = a.wmin
    return o
  })
}
function rangeSpec(minutes) {
  const m = Math.min(Math.max(parseInt(minutes) || 30, 5), 1440)
  if (m <= 60) return { m, fine: true, agg: 10000 }
  return { m, fine: false, agg: m <= 360 ? 60000 : m <= 720 ? 120000 : 300000 }
}

// ─── NILM activity over 24 h: share of each 15 min the model called a head on ─
const _NILMR = {}
async function handleNilm24(res, params) {
  const m = Math.min(Math.max(parseInt((params && params.get('minutes')) || '1440') || 1440, 5), 1440)
  const bmin = m <= 60 ? 1 : m <= 360 ? 5 : m <= 720 ? 10 : 15
  const hit = _NILMR[m]
  if (hit && Date.now() - hit.at < Math.min(5 * MIN_MS, bmin * MIN_MS)) return json(res, hit.val)
  const from = Date.now() - m * MIN_MS, BK = bmin * MIN_MS
  const q = cond => alSqlNet(`select increments(minute, ${bmin}, ts), appliance, max(ts) as ts, count(*) as n ` +
    `from nilm_disaggregated where ts > '${utcStr(from)}'${cond} group by appliance`, 45000)
  const all = await q(''), on = await q(" and state = 'ON'")
  const key = r => String(r.appliance).trim() + '|' + Math.floor(utcMs(r.ts) / BK) * BK
  const onN = new Map(on.map(r => [key(r), +r.n]))
  const apps = {}
  for (const r of all) {
    const a = String(r.appliance).trim(), b = Math.floor(utcMs(r.ts) / BK) * BK
    ;(apps[a] = apps[a] || {})[b] = (onN.get(key(r)) || 0) / (+r.n || 1)
  }
  const val = {
    from: utcStr(from), minutes: m, bucket_min: bmin,
    appliances: Object.keys(apps).sort().map(a => ({
      appliance: a,
      cells: Object.keys(apps[a]).map(Number).sort((x, y) => x - y)
        .map(b => ({ ts: utcStr(b), on: +apps[a][b].toFixed(3) })),
    })),
  }
  if (val.appliances.length) _NILMR[m] = { at: Date.now(), val }
  json(res, val)
}

// ─── Anomaly detector over the 1-minute cache ─────────────────────────────────
// Two rules, both on measured data only:
//   level_shift     a channel's steady level moves by at least max(min W, 15 %)
//                   between the 30 min before and the 30 min after a minute,
//                   with both windows steady (std under max(60 W, 12 % of level))
//   grid_high_load  grid import averages above GRID_HIGH_W for 3+ minutes
// Each event is written to customers.anomalies once, keyed by its fingerprint.
const LS_MIN_W = { 'Grid Power': 120, 'Panel1 (HVAC)': 100, 'Panel2 (H2O)': 100,
  'Panel3 (Kitchen)': 100, 'Shop': 100, 'Generac Power': 50 }
const GRID_HIGH_W = parseFloat(process.env.GRID_HIGH_W || '5000')
const DETECT_WRITE = process.env.DETECT_WRITE !== '0'
const DET_SEEN = new Set()
const DET_RECORDED = []   // {entity, atype, t} of events already in customers.anomalies
const nearRecorded = e => DET_RECORDED.some(r => r.entity === e.entity && r.atype === e.atype && Math.abs(r.t - e.ts) <= 30 * MIN_MS)
const ptClock = ms => new Date(ms).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })

async function loadAnomalyFingerprints() {
  const rows = await alSqlNet(`select ts, atype, entity, fingerprint from anomalies where ts > '${utcStr(Date.now() - 2 * DAY_MS)}'`)
  rows.forEach(r => {
    DET_SEEN.add(String(r.fingerprint || '').trim())
    DET_RECORDED.push({ entity: String(r.entity || '').trim(), atype: String(r.atype || '').trim(), t: utcMs(r.ts) })
  })
}
function meanStd(a) {
  const n = a.length; if (!n) return [NaN, NaN]
  const m = a.reduce((s, x) => s + x, 0) / n
  return [m, Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / n)]
}
function detectLevelShifts(nm, now) {
  const map = M1[nm]; if (!map || map.size < 120) return []
  const W = 30 * MIN_MS, minW = LS_MIN_W[nm] || 100, cands = []
  for (const t of [...map.keys()].sort((a, b) => a - b)) {
    if (t < now - DAY_MS + W || t + W > now) continue
    const before = [], after = []
    for (let k = t - W; k < t; k += MIN_MS) { const v = map.get(k); if (v && isFinite(v.w)) before.push(Math.abs(v.w)) }
    for (let k = t; k < t + W; k += MIN_MS) { const v = map.get(k); if (v && isFinite(v.w)) after.push(Math.abs(v.w)) }
    if (before.length < 24 || after.length < 24) continue
    const [mb, sb] = meanStd(before), [ma, sa] = meanStd(after), d = ma - mb
    if (Math.abs(d) < Math.max(minW, 0.15 * mb)) continue
    if (sb > Math.max(60, 0.12 * mb) || sa > Math.max(60, 0.12 * ma)) continue
    cands.push({ t, mb, ma, d })
  }
  const best = []   // strongest minute of each run of neighbouring candidates
  for (const c of cands) {
    const last = best[best.length - 1]
    if (last && c.t - last.t <= W) { if (Math.abs(c.d) > Math.abs(last.d)) best[best.length - 1] = c }
    else best.push(c)
  }
  return best.map(c => {
    const pct = c.mb > 1 ? c.d / c.mb * 100 : 100
    return {
      ts: c.t, atype: 'level_shift', severity: Math.abs(pct) >= 40 ? 'warning' : 'info',
      source: 'dashboard_detector', entity: nm, value: c.ma, threshold: c.mb, pct, sustained_s: 1800,
      fingerprint: `level_shift:${nm}:${utcStr(c.t).slice(0, 16)}`,
      message: `${nm} stepped ${c.d > 0 ? 'up' : 'down'} from ${Math.round(c.mb)} W to ${Math.round(c.ma)} W ` +
        `(${pct >= 0 ? '+' : ''}${pct.toFixed(0)} %) at ${ptClock(c.t)} and held for 30+ min`,
      action: 'Check which load changed state at that time',
    }
  })
}
function detectGridHigh(now) {
  const map = M1['Grid Power']; if (!map) return []
  const out = []
  let run = null
  const close = () => { if (run && run.n >= 3 && run.end + MIN_MS < now) out.push(run); run = null }
  for (const k of [...map.keys()].sort((a, b) => a - b)) {
    const v = map.get(k), hot = v && v.w > GRID_HIGH_W
    const peak = v ? (isFinite(v.wmax) ? v.wmax : v.w) : 0
    if (hot && run && k - run.end <= MIN_MS) { run.end = k; run.n++; run.sum += v.w; run.peak = Math.max(run.peak, peak) }
    else { close(); if (hot) run = { start: k, end: k, n: 1, sum: v.w, peak } }
  }
  close()
  return out.map(r => ({
    ts: r.start, atype: 'grid_high_load', severity: r.peak >= 1.5 * GRID_HIGH_W ? 'critical' : 'warning',
    source: 'dashboard_detector', entity: 'Grid Power', value: r.peak, threshold: GRID_HIGH_W,
    pct: r.peak / GRID_HIGH_W * 100, sustained_s: r.n * 60,
    fingerprint: `grid_high_load:${utcStr(r.start).slice(0, 16)}`,
    message: `Grid import averaged ${(r.sum / r.n / 1000).toFixed(2)} kW for ${r.n} min from ${ptClock(r.start)}, ` +
      `peaking at ${(r.peak / 1000).toFixed(2)} kW (limit ${(GRID_HIGH_W / 1000).toFixed(1)} kW)`,
    action: 'Defer shiftable loads while import is this high',
  }))
}
function candidateAnomalies() {
  const now = Date.now()
  let ev = []
  for (const nm of Object.keys(CH_WHERE)) ev = ev.concat(detectLevelShifts(nm, now))
  return ev.concat(detectGridHigh(now)).sort((a, b) => a.ts - b.ts)
}
// Floats are written with a decimal point: AnyLog fixed these columns as double
// on table creation and rejects an integer where it expects a float.
function putAnomalies(events) {
  const f1 = x => (isFinite(x) ? Number(x) : 0).toFixed(1)
  const s = v => JSON.stringify(String(v))
  const body = '[' + events.map(e => '{' + [
    `"ts":${s(utcStr(e.ts) + '.000')}`, `"atype":${s(e.atype)}`, `"severity":${s(e.severity)}`,
    `"source":${s(e.source)}`, `"entity":${s(e.entity)}`, `"value":${f1(e.value)}`,
    `"threshold":${f1(e.threshold)}`, `"pct":${f1(e.pct)}`, `"sustained_s":${Math.round(e.sustained_s)}`,
    `"status":"open"`, `"fingerprint":${s(e.fingerprint)}`, `"notified":"no"`,
    `"message":${s(e.message)}`, `"action":${s(e.action)}`].join(',') + '}').join(',') + ']'
  return new Promise(resolve => {
    const req = http.request({ hostname: ANYLOG_HOST, port: ANYLOG_PORT, path: '/', method: 'PUT',
      headers: { 'User-Agent': 'AnyLog/1.23', type: 'json', dbms: 'customers', table: 'anomalies',
        mode: 'streaming', 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) } },
      r => { r.resume(); r.on('end', () => resolve(r.statusCode)) })
    req.setTimeout(20000, () => req.destroy())
    req.on('error', () => resolve(0))
    req.end(body)
  })
}
async function detectAnomalies() {
  if (!HIST.ready24h || !DETECT_WRITE) return
  const ev = []
  candidateAnomalies().filter(e => !DET_SEEN.has(e.fingerprint))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .forEach(e => { if (!nearRecorded(e) && !ev.some(x => x.entity === e.entity && x.atype === e.atype && Math.abs(x.ts - e.ts) <= 30 * MIN_MS)) ev.push(e) })
  if (!ev.length) return
  const code = await putAnomalies(ev)
  if (code === 200) {
    ev.forEach(e => { DET_SEEN.add(e.fingerprint); DET_RECORDED.push({ entity: e.entity, atype: e.atype, t: e.ts }) })
    console.log('[detect] wrote', ev.length, ev.map(e => e.fingerprint).join(' '))
  } else console.warn('[detect] PUT failed', code)
}
async function handleDetectPreview(res) {
  json(res, { ready: HIST.ready24h, write: DETECT_WRITE, grid_high_w: GRID_HIGH_W,
    buckets: Object.fromEntries(Object.entries(M1).map(([k, m]) => [k, m.size])),
    events: candidateAnomalies().map(e => Object.assign({}, e, { ts: utcStr(e.ts), recorded: DET_SEEN.has(e.fingerprint) })) })
}

function forecastProxy(res, route) {
  const request = http.get({socketPath:'/forecast-run/forecast.sock',path:route,timeout:30000}, upstream => {
    res.writeHead(upstream.statusCode || 502, {'Content-Type':'application/json','Cache-Control':'no-store'});
    upstream.pipe(res);
  });
  request.on('timeout',()=>request.destroy(new Error('Forecast service timed out')));
  request.on('error',e=>{if(!res.headersSent) err(res,503,e.message); else res.end()});
}
function handleRecommendation(req,res,id,action){
  let decoded
  try{decoded=decodeURIComponent(id)}catch(_){return err(res,400,'Invalid recommendation id')}
  if(!decoded||decoded.length>256||/[\/\\\x00-\x1f]/.test(decoded))return err(res,400,'Invalid recommendation id')
  const upstream=http.request({host:IEMS_HOST,port:IEMS_PORT,path:'/iems/recommendations/'+encodeURIComponent(decoded)+'/'+action,method:'POST',headers:{'Content-Type':'application/json'},timeout:15000},response=>{
    res.writeHead(response.statusCode||502,{'Content-Type':'application/json','Cache-Control':'no-store'});response.pipe(res)
    response.on('error',()=>res.end())
  })
  upstream.on('timeout',()=>upstream.destroy(new Error('Recommendation service timed out')))
  upstream.on('error',e=>{if(!res.headersSent)err(res,502,e.message);else res.end()})
  req.on('aborted',()=>upstream.destroy());req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://${req.headers.host}`)
  const path   = url.pathname
  const params = url.searchParams

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST' })
    res.end()
    return
  }

  try {
    const rec=req.method==='POST'&&path.match(/^\/api\/recommendations\/([^/]+)\/(accept|defer|dismiss)$/)
    if(rec)return handleRecommendation(req,res,rec[1],rec[2])
    if (path === '/api/dss-plan' && req.method === 'GET') return forecastProxy(res, '/dss-plan')
    if (path === '/api/power-forecast' && req.method === 'GET') return forecastProxy(res, '/forecast'+url.search)
    if (path === '/api/battery-forecast' && req.method === 'GET') return forecastProxy(res, '/battery-forecast'+url.search)
    if (path === '/api/power-status' && req.method === 'GET') return forecastProxy(res, '/status')
    if (path === '/api/power-accuracy' && req.method === 'GET') return forecastProxy(res, '/accuracy')
    if (path === '/api/node-detail' && req.method === 'GET') return forecastProxy(res, '/node-detail'+url.search)
    if (path === '/api/system-map' && req.method === 'GET') return forecastProxy(res, '/system')
    if (path === '/chart-analysis.js' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8'})
      return res.end(fs.readFileSync(pathm.join(__dirname, 'chart-analysis.js')))
    }
    if (path === '/forecast-view' || path === '/system-view') {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      return res.end(fs.readFileSync(path === '/forecast-view' ? '/app/forecast.html' : '/app/system-map.html'));
    }
    if (path === '/api/readiness' && req.method === 'GET') return json(res, readiness.snapshot())
    if (path === '/api/snapshot' && req.method === 'GET') return handleSnapshot(res)
    if (path === '/api/history'  && req.method === 'GET') return handleHistory(res, params)
    if (path === '/api/solar-history' && req.method === 'GET') return handleSolarHistory(res, params)
    if (path === '/api/hvac-24h' && req.method === 'GET') return handleHvacDay(res)
    if (path === '/api/sources' && req.method === 'GET') return handleSources(res)
    if (path === '/api/nilm'     && req.method === 'GET') return handleNilm(res)
    if (path === '/api/cycle'    && req.method === 'POST') return handleCycle(req, res)
    if (path === '/api/models'   && req.method === 'GET') return handleModels(res)
    if (path === '/api/model-meta' && req.method === 'GET') return handleModelMeta(res)
    if (path === '/api/llm-model' && req.method === 'GET') return handleLlmModel(res)
    if (path === '/api/health'   && req.method === 'GET') return handleHealth(res)
    if (path === '/api/storage'  && req.method === 'GET') return handleStorage(res)
    if (path === '/api/solar-assistant' && req.method === 'GET') return handleSolarAssistant(res)
    if (path === '/api/relay'         && req.method === 'GET')  return handleRelay(res)
    if (path === '/api/relay/set'     && req.method === 'POST') return handleRelaySet(req, res)
    if (path === '/api/relay/restore' && req.method === 'POST') return handleRelayRestore(req, res)
    if (path === '/api/relay/config' && (req.method === 'GET' || req.method === 'POST'))
      return handleRelayConfig(req, res)
    if (path === '/api/loads'         && req.method === 'GET')  return handleLoads(res)
    if (path === '/api/logs'          && req.method === 'GET')  return handleLogs(res, params)
    if (path === '/api/nilm-24h'      && req.method === 'GET')  return handleNilm24(res, params)
    if (path === '/api/detect-preview' && req.method === 'GET') return handleDetectPreview(res)
    if (path === '/api/ask'           && req.method === 'POST') return handleAsk(req, res)
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }
    err(res, 404, `No route for ${req.method} ${path}`)
  } catch (e) {
    console.error(`[${path}]`, e.message)
    err(res, 500, e.message)
  }
})

server.listen(PORT, () => {
  console.log(`\n  IEMS Live Dashboard`)
  console.log(`  →   http://localhost:${PORT}`)
  console.log(`  ←   AnyLog  ${ANYLOG_HOST}:${ANYLOG_PORT}`)
  console.log(`  ←   IEMS    ${IEMS_HOST}:${IEMS_PORT}\n`)
})

// ─── Inline HTML ──────────────────────────────────────────────────────────────

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IEMS · Los Gatos Microgrid</title>



<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#ffffff; --paper:#ffffff; --paper-2:#ffffff;
  --ink:#182230; --ink-2:#475467; --ink-3:#667085;
  --line:#d0d5dd; --line-soft:#eaecf0;
  --grid:#d0562a; --hvac:#2a6fc9; --h2o:#c4508f;
  --kit:#2e8b3e; --shop:#e09a10; --gen:#6250d6;
  --ok:#5e8a5a; --warn:#c89a3a; --bad:#a64f3a; --info:#4a6b8a; --sa:#2e7d8a;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Inter',system-ui,sans-serif;
  --r:9px;
}
html,body{height:100%;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:12px;line-height:1.4}
body{padding:12px 16px;display:flex;flex-direction:column;gap:9px;min-height:100vh;overflow-y:auto;overflow-x:hidden}

.hdr{display:flex;justify-content:space-between;align-items:flex-end;gap:14px;border-bottom:1px solid var(--line);padding-bottom:7px}
.hdr h1{font-size:18px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.hdr .sub{font-size:9px;color:var(--ink-3);font-family:var(--mono);margin-top:2px;letter-spacing:.04em}
.badge{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:9px;
  letter-spacing:.18em;color:var(--ink-2);text-transform:uppercase;margin-bottom:3px;font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);
  box-shadow:0 0 0 0 rgba(94,138,90,.55);animation:ring 2s ease-in-out infinite}
.dot.err{background:var(--bad);animation:none}
.dot.warn{background:var(--warn);animation:none}
@keyframes ring{0%,100%{box-shadow:0 0 0 0 rgba(94,138,90,.55)}70%{box-shadow:0 0 0 6px rgba(94,138,90,0)}}
.mode-pill{display:inline-block;padding:2px 8px;border-radius:11px;background:color-mix(in srgb,var(--info) 15%,var(--paper-2));
  color:var(--info);font-family:var(--mono);font-size:8.5px;font-weight:700;border:1px solid var(--info);letter-spacing:.06em;margin-left:6px}
.poll{font-family:var(--mono);font-size:10.5px;color:var(--ink-2);text-align:right;white-space:nowrap}
.poll small{display:block;font-size:8.5px;color:var(--ink-3);margin-top:1px}

.errbar{display:none;background:color-mix(in srgb,var(--bad) 10%,var(--paper));border:1px solid var(--bad);
  border-radius:7px;padding:7px 12px;font-family:var(--mono);font-size:10.5px;color:var(--bad)}
.errbar.show{display:block}

.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;flex-shrink:0}
.kpi{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:12px 15px;position:relative;overflow:hidden;min-width:0}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c)}
.kpi .lbl{font-family:var(--mono);font-size:8px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-3);margin-bottom:3px;display:flex;align-items:center;gap:5px;font-weight:600}
.kpi .val{font-family:var(--mono);font-size:19px;font-weight:700;line-height:1.05;color:var(--ink)}
.kpi .hint{font-size:10.5px;color:var(--ink-3);margin-top:4px;font-family:var(--mono);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi .hint.up{color:var(--bad)} .kpi .hint.down{color:var(--ok)}
.kpi-glyph{width:10px;height:10px;display:inline-block;color:var(--c)}

.ctrl{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:7px 11px;background:var(--paper);border:1px solid var(--line);border-radius:var(--r);flex-shrink:0}
.ctrl label{font-family:var(--mono);font-size:9px;color:var(--ink-2);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.ctrl select,.ctrl input[type=number]{font-family:var(--mono);font-size:10.5px;background:var(--paper-2);border:1px solid var(--line);
  color:var(--ink);border-radius:5px;padding:3px 8px;outline:none}
.ctrl select:focus,.ctrl input:focus{border-color:var(--info)}
.toggle{display:inline-flex;border:1px solid var(--line);border-radius:5px;overflow:hidden;background:var(--paper-2)}
.toggle button{font-family:var(--mono);font-size:9.5px;font-weight:600;padding:4px 11px;border:none;background:transparent;color:var(--ink-2);cursor:pointer;letter-spacing:.06em}
.toggle button.active{background:var(--ink);color:var(--paper)}
.btn{font-family:var(--mono);font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;
  padding:5px 13px;border-radius:6px;border:1px solid var(--ink);cursor:pointer;transition:all .15s;background:var(--ink);color:var(--paper)}
.btn:hover{background:var(--paper);color:var(--ink)}
.btn:disabled{opacity:.5;cursor:wait}
.cycstat{font-family:var(--mono);font-size:9.5px;color:var(--ok);font-weight:600;margin-left:auto}
.spin{display:inline-block;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);padding-bottom:0;flex-shrink:0}
.tab-btn{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  padding:7px 16px;border:1px solid var(--line);border-bottom:none;border-radius:7px 7px 0 0;background:var(--bg);
  color:var(--ink-3);cursor:pointer;position:relative;top:1px}
.tab-btn:hover{color:var(--ink-2)}
.tab-btn.active{background:var(--paper);color:var(--ink);border-color:var(--line);border-bottom:1px solid var(--paper)}
.tab-panel{display:none;flex-direction:column;gap:9px;flex:1 0 auto;min-height:0}
.tab-panel.active{display:flex}

.gridmain{display:grid;grid-template-columns:1.35fr 1fr;grid-template-rows:minmax(500px,auto) minmax(200px,auto);gap:9px;flex:1 0 auto;min-height:0}
.region{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:9px 12px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.region h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.16em;color:var(--ink-2);margin-bottom:7px;display:flex;align-items:center;gap:7px;font-family:var(--mono);flex-shrink:0}
.region h2 .gly{width:12px;height:12px;color:var(--ink)}
.region h2 .tag{font-size:8px;letter-spacing:.05em;padding:2px 7px;border-radius:18px;background:var(--bg);color:var(--ink-3);font-weight:500;border:1px solid var(--line-soft);margin-left:auto;font-family:var(--mono)}
.region h2 .tag.ok{color:var(--ok);border-color:var(--ok);background:color-mix(in srgb,var(--ok) 10%,var(--paper))}
.region h2 .tag.warn{color:var(--warn);border-color:var(--warn);background:color-mix(in srgb,var(--warn) 10%,var(--paper))}
.region h2 .tag.bad{color:var(--bad);border-color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,var(--paper))}

.r-power{grid-column:1;grid-row:1}
.r-dss{grid-column:2;grid-row:1}
.r-tou{grid-column:1 / -1;grid-row:2}
.r-nilm{flex:1 0 auto}
.r-detail{grid-column:1 / -1;grid-row:3}.r-nilm24{grid-column:1 / -1;grid-row:4}.r-anom24{grid-column:1 / -1;grid-row:5}
.day-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:9px}
.day-card{border:1px solid var(--line);border-radius:6px;padding:6px 8px 4px;background:var(--paper)}
.day-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11px}
.day-h b{font-weight:600}
.day-h span{font-family:var(--mono);font-size:9px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.day-card svg{width:100%;height:120px;display:block}
.r-weather-tab{flex:1 0 auto}

.pwr-content{display:flex;flex-direction:column;gap:6px;flex:1;min-height:0}
.legend{display:flex;flex-wrap:wrap;gap:8px;font-family:var(--mono);font-size:8.5px;color:var(--ink-2);flex-shrink:0}
.legend-item{display:flex;align-items:center;gap:4px}
.legend-sw{width:12px;height:3px;border-radius:1.5px;background:var(--c)}
.pwr-graph-wrap{flex:1;min-height:0;position:relative}
.pwr-graph{width:100%;height:100%}
.pwr-stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:6px 0 0;flex-shrink:0}
.pwr-stat{text-align:center;font-family:var(--mono);background:var(--paper-2);border:1px solid var(--line-soft);border-radius:7px;padding:7px 8px;display:flex;flex-direction:column;justify-content:center;gap:3px;min-height:52px}
.pwr-stat .lbl{font-size:8.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-3);font-weight:700}
.pwr-stat .val{font-size:17px;font-weight:800;color:var(--c);line-height:1}

.nilm-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:7px;min-height:90px}
.nilm-groups{display:flex;flex-direction:column;gap:16px;flex:1;min-height:200px;overflow-y:auto}
.nilm-group-h{font-family:var(--mono);font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
  color:var(--ink-2);margin-bottom:7px;padding-bottom:5px;border-bottom:1px solid var(--line-soft)}
.nc{border:1px solid var(--line);border-radius:7px;padding:7px 9px;background:var(--paper-2);display:flex;flex-direction:column;min-height:90px;position:relative;transition:border-color .3s,background .3s}
.nc.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 7%,var(--paper-2))}
.nc-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.nc-gly{width:13px;height:13px;color:var(--c);flex-shrink:0}
.nc.off .nc-gly{color:var(--ink-3)}
.nc-state{width:6px;height:6px;border-radius:50%;background:var(--c);box-shadow:0 0 0 1.5px color-mix(in srgb,var(--c) 30%,transparent)}
.nc.off .nc-state{background:var(--ink-3);box-shadow:none}
.nc-name{font-family:var(--mono);font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nc-watt{font-family:var(--mono);font-size:13px;font-weight:800;line-height:1;color:var(--c);margin-bottom:3px}
.nc.off .nc-watt{color:var(--ink-3)}
.nc-circuit{font-family:var(--mono);font-size:7.5px;color:var(--ink-3);letter-spacing:.04em;margin-bottom:4px}
.nc-conf{display:flex;align-items:center;gap:4px;margin-top:auto}
.nc-conf .cb{flex:1;height:2.5px;background:var(--line-soft);border-radius:1.5px;overflow:hidden}
.nc-conf .cf{height:100%;background:var(--c);border-radius:1.5px}
.nc-conf .cp{font-family:var(--mono);font-size:7px;color:var(--ink-3);font-weight:700}
.nc.off .cf{background:var(--ink-3)}
.nilm-empty{grid-column:1/-1;font-family:var(--mono);font-size:10px;color:var(--ink-3);padding:18px;text-align:center}

.wtou-content{display:grid;grid-template-columns:240px 1fr;gap:10px;flex:1;min-height:0}
.wcol{display:flex;flex-direction:column;gap:5px;min-height:0}
.weather-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;flex:1;min-height:0}
.weather-grid .wstat{min-height:70px}
.wstat{background:var(--paper-2);border:1px solid var(--line-soft);border-radius:7px;padding:5px 9px;display:flex;align-items:center;gap:7px;flex:1;min-height:0}
.wstat-gly{width:26px;height:26px;color:var(--c);flex-shrink:0}
.wstat-body{flex:1;min-width:0}
.wstat .wl{font-family:var(--mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3);margin-bottom:2px;font-weight:700}
.wstat .wv{font-family:var(--mono);font-size:22px;font-weight:800;color:var(--ink);line-height:1.1}
.wstat .wu{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);margin-left:3px}

.tou-block{background:var(--paper-2);border:1px solid var(--line-soft);border-radius:7px;padding:8px 11px;flex:1;min-height:0;display:flex;flex-direction:column}
.tou-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;flex-shrink:0}
.tou-head-left{display:flex;align-items:center;gap:9px}
.tou-pill{padding:3px 10px;border-radius:14px;font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.08em;border:1.5px solid;background:var(--paper)}
.tou-pill.peak{border-color:var(--bad);color:var(--bad)}
.tou-pill.off{border-color:var(--ok);color:var(--ok)}
.tou-pill.super{border-color:var(--info);color:var(--info)}
.tou-pill.partial{border-color:var(--warn);color:var(--warn)}
.tou-rate{font-family:var(--mono);font-size:11.5px;color:var(--ink);font-weight:700}
.tou-next{font-family:var(--mono);font-size:9px;color:var(--ink-3)}
.tou-graph-wrap{flex:1;min-height:0;position:relative}
.tou-graph{width:100%;height:100%}
.tou-legend{display:flex;flex-wrap:wrap;gap:8px;font-family:var(--mono);font-size:8px;color:var(--ink-2);margin-top:3px;flex-shrink:0}
.tou-legend-item{display:flex;align-items:center;gap:3px}
.tou-legend-sw{width:10px;height:7px;border-radius:2px}

.dss-list{display:flex;flex-direction:column;gap:6px;flex:1;min-height:200px;overflow-y:auto;padding-right:2px}
.dss-rec{border:1px solid var(--line);border-radius:7px;padding:7px 10px;display:grid;grid-template-columns:22px 1fr;gap:9px;align-items:start;background:var(--paper-2);position:relative}
.dss-rec.urgent{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 5%,var(--paper-2))}
.dss-rec.advisory{border-color:var(--warn);background:color-mix(in srgb,var(--warn) 5%,var(--paper-2))}
.dss-rec.info{border-color:var(--info);background:color-mix(in srgb,var(--info) 5%,var(--paper-2))}
.dss-rec.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 5%,var(--paper-2))}
.dss-icon{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1.4px solid var(--rc);color:var(--rc);background:var(--paper);flex-shrink:0}
.dss-icon svg{width:10px;height:10px}
.dss-body .dt{font-size:11px;font-weight:700;margin-bottom:1px;color:var(--ink);line-height:1.3;display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dss-body .dt .amount{font-family:var(--mono);font-size:10.5px;color:var(--rc);font-weight:800;flex-shrink:0}
.dss-body .dd{font-size:9.5px;color:var(--ink-2);line-height:1.4}
.dss-body .dm{font-family:var(--mono);font-size:8.5px;color:var(--rc);margin-top:3px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.dss-actions{display:flex;gap:4px;margin-top:5px}
.dss-btn{font-family:var(--mono);font-size:8px;padding:2.5px 7px;border-radius:4px;border:1px solid var(--line);cursor:pointer;background:var(--paper);color:var(--ink-2);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.dss-btn:hover{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.ask-preset-btn{width:100%;text-align:left;white-space:normal;line-height:1.4;text-transform:none;
  letter-spacing:normal;padding:7px 9px;font-size:10px}
.dss-empty{font-family:var(--mono);font-size:10px;color:var(--ink-3);padding:18px;text-align:center}

.chart-wrap{position:relative;flex:1;min-height:150px}
.chart-wrap svg{width:100%;height:100%;display:block}
.chart-tip{position:absolute;pointer-events:none;display:none;background:var(--ink);color:var(--paper);
  border-radius:6px;padding:6px 9px;font-family:var(--mono);font-size:9px;line-height:1.6;z-index:5;
  box-shadow:0 3px 10px rgba(42,36,28,.25);white-space:nowrap}
.chart-tip .tt{color:#c9bea3;font-size:8px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px}
.chart-tip .tr{display:flex;align-items:center;gap:5px}
.chart-tip .sw{width:7px;height:7px;border-radius:2px;flex-shrink:0}
.legend-item{cursor:pointer;user-select:none;padding:2px 5px;border-radius:4px;transition:background .15s}
.legend-item:hover{background:var(--line-soft)}
.legend-item.off{opacity:.35}
.sync-head{font-family:var(--mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.14em;
  color:var(--ink-3);font-weight:700;display:flex;align-items:center;gap:7px;margin-top:2px;flex-shrink:0}
.sync-wrap{position:relative;height:88px;flex-shrink:0}
.sync-wrap svg{width:100%;height:100%;display:block}
.wx-chart{background:var(--paper-2);border:1px solid var(--line-soft);border-radius:7px;padding:8px 11px;
  display:flex;flex-direction:column;min-height:170px;flex:1}
.wx-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px;flex:0 0 auto;min-height:0}
.wx-chart .wx-title{font-family:var(--mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.14em;
  color:var(--ink-3);font-weight:700;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;gap:6px}
.wx-chart .wx-title>span:first-child{display:flex;align-items:center;gap:6px}
.wx-ico{width:12px;height:12px;color:var(--ink-2)}
.wx-chart{min-height:160px}
.wx-chart .chart-wrap{min-height:120px}
.r-weather-tab{display:flex;flex-direction:column}
.thermo{display:grid;grid-template-columns:1fr 1.2fr 1.2fr;gap:12px;align-items:stretch}
.th-card{background:var(--paper-2);border:1px solid var(--line-soft);border-radius:9px;padding:12px 14px;
  display:flex;flex-direction:column;gap:6px;min-height:150px}
.th-card .th-lbl{font-family:var(--mono);font-size:8px;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-3);font-weight:700}
.th-big{font-family:var(--mono);font-size:38px;font-weight:800;line-height:1;color:var(--ink)}
.th-big .u{font-size:15px;color:var(--ink-3);font-weight:600}
.th-sub{font-family:var(--mono);font-size:9.5px;color:var(--ink-2)}
.th-setrow{display:flex;align-items:center;justify-content:center;gap:14px;flex:1}
.step-btn{width:44px;height:44px;border-radius:50%;border:1.5px solid var(--line);background:var(--paper);
  color:var(--ink);font-size:22px;font-weight:700;cursor:pointer;transition:all .15s;line-height:1;font-family:var(--mono)}
.step-btn:hover{border-color:var(--ink);background:var(--ink);color:var(--paper)}
.step-btn:active{transform:scale(.93)}
.th-set{font-family:var(--mono);font-size:44px;font-weight:800;color:var(--info);line-height:1;min-width:96px;text-align:center}
.th-set.pending{color:var(--warn)}
.th-set .u{font-size:16px;color:var(--ink-3)}
.th-actions{display:flex;gap:7px;justify-content:center;flex-wrap:wrap}
.th-apply{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  padding:6px 18px;border-radius:6px;border:1.5px solid var(--ok);background:var(--ok);color:var(--paper);cursor:pointer;transition:all .15s}
.th-apply:disabled{opacity:.35;cursor:default}
.th-apply:not(:disabled):hover{background:var(--paper);color:var(--ok)}
.th-ghost{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.06em;padding:6px 12px;border-radius:6px;
  border:1px solid var(--line);background:var(--paper);color:var(--ink-2);cursor:pointer;transition:all .15s}
.th-ghost:hover{border-color:var(--ink);color:var(--ink)}
.imp-row{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px dashed var(--line-soft);padding:4px 0;font-size:11px}
.imp-row .k{color:var(--ink-2)}
.imp-row .v{font-family:var(--mono);font-weight:800;font-size:13px}
.imp-row .v.save{color:var(--ok)} .imp-row .v.cost{color:var(--bad)}
.imp-note{font-size:9.5px;color:var(--ink-3);line-height:1.5;margin-top:5px}
.src-pill{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:9.5px;font-weight:700;
  padding:3px 10px;border-radius:12px;border:1.4px solid var(--sc);color:var(--sc);background:color-mix(in srgb,var(--sc) 8%,var(--paper))}
/* ── link/source status strip ── */
.srcbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px;flex-shrink:0}
.src{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:7px 10px;
  display:flex;align-items:center;gap:8px;min-width:0;position:relative;overflow:hidden}
.src::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2.5px;background:var(--sc)}
.src-gly{width:17px;height:17px;color:var(--sc);flex-shrink:0}
.src-b{min-width:0;flex:1}
.src-n{font-family:var(--mono);font-size:8px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink-3);font-weight:700;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-v{font-family:var(--mono);font-size:11px;font-weight:700;color:var(--ink);line-height:1.25;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-s{font-family:var(--mono);font-size:8.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src.bad{border-color:var(--bad)} .src.bad .src-v{color:var(--bad)}
.src.warn{border-color:var(--warn)} .src.warn .src-v{color:var(--warn)}
.src-led{width:6px;height:6px;border-radius:50%;background:var(--sc);flex-shrink:0;
  box-shadow:0 0 0 2px color-mix(in srgb,var(--sc) 22%,transparent)}
.src.bad .src-led{background:var(--bad);box-shadow:0 0 0 2px color-mix(in srgb,var(--bad) 22%,transparent)}
.src.warn .src-led{background:var(--warn);box-shadow:0 0 0 2px color-mix(in srgb,var(--warn) 22%,transparent)}
.rangebtns{display:inline-flex;border:1px solid var(--line);border-radius:5px;overflow:hidden;margin-left:auto}
.rangebtns button{font-family:var(--mono);font-size:8.5px;font-weight:700;padding:2px 9px;border:none;
  background:transparent;color:var(--ink-3);cursor:pointer;letter-spacing:.06em}
.rangebtns button.active{background:var(--ink);color:var(--paper)}
/* weather: current conditions are the headline, charts are supporting detail */
.weather-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;flex:0 0 auto}
.weather-grid .wstat{min-height:0}
.wstat{background:var(--paper-2);border:1px solid var(--line-soft);border-radius:10px;padding:14px 16px;
  display:flex;align-items:center;gap:12px;flex:0 0 auto;min-height:0}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:2px}
::-webkit-scrollbar-track{background:transparent}
@media(max-width:800px){
.gridmain{display:flex;flex-direction:column}.r-dss{order:-1}.r-power{min-height:440px}
.tabs{overflow-x:auto}.tab-btn{padding:7px 10px}.day-grid{grid-template-columns:minmax(0,1fr)}
.region h2{flex-wrap:wrap}.dss-list{min-height:0}.region{flex-shrink:0}
}


.wx-row{grid-template-columns:repeat(2,minmax(0,1fr))}.wx-chart{background:var(--paper);padding:16px;min-width:0;border:1px solid var(--line);border-radius:10px}
.wx-chart.expanded{grid-column:1 / -1;order:-1}.wx-chart.expanded .sc-frame{height:400px}
.wx-chart .wx-title{font:600 16px var(--sans);color:var(--ink);letter-spacing:0;text-transform:none;flex-wrap:wrap}
.wx-current{font:700 25px var(--mono);margin:8px 0;color:var(--ink)}.wx-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.wx-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}.wx-controls label{font-size:12px;display:flex;gap:6px;align-items:center}
.wx-controls button,.wx-actions button{font:inherit;font-size:12px;min-height:34px;background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:7px 10px;color:var(--ink-2);cursor:pointer}
.wx-controls button[aria-pressed="true"]{background:#eff8ff;border-color:#84adff;color:#175cd3}.wx-help,.wx-status{font-size:11px;color:var(--ink-2);margin:8px 0;line-height:1.6}
.wx-body[hidden]{display:none!important}.wx-controls button:focus-visible,.wx-actions button:focus-visible{outline:3px solid var(--info);outline-offset:2px}
@media(max-width:800px){.wx-row{grid-template-columns:1fr}.wx-chart{padding:12px}.wx-chart.expanded .sc-frame{height:320px}}

/* Measurement cards are the graph controls; the chart remains the focus. */
.series-card{font:inherit;color:var(--ink);text-align:left;cursor:pointer;appearance:none}
.series-card[aria-pressed="true"]{border-color:color-mix(in srgb,var(--c) 55%,var(--line));background:color-mix(in srgb,var(--c) 4%,var(--paper))}
.series-card:hover{border-color:var(--c)}
.series-card:focus-visible,#pwr-reset:focus-visible,#pwr-collapse:focus-visible,#dss-toggle:focus-visible{outline:3px solid var(--info);outline-offset:3px}
.filter-status{font-size:10px;color:var(--c);display:block;margin-top:5px;font-weight:600}
.filter-status::before{content:"✓ ";font-weight:700}
.series-card[aria-pressed="false"] .filter-status{color:var(--ink-3)}
.series-card[aria-pressed="false"] .filter-status::before{content:"+ "}
.series-card[aria-pressed="false"]{border-style:dashed;background:var(--paper)}
.filter-help{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--ink-2);font-size:11px}
#pwr-reset,#pwr-collapse,#dss-toggle{font:inherit;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink-2);padding:7px 10px;cursor:pointer;flex-shrink:0;min-height:34px}
#pwr-reset:hover,#dss-toggle:hover{border-color:var(--info);color:var(--info)}
.power-extra-cards[hidden],#pwr-collapse[hidden]{display:none!important}
.power-extra-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:3px 0 5px}
.extra-card{border:1px solid var(--line);border-radius:7px;padding:9px 11px;min-width:0;display:flex;flex-direction:column;gap:3px}
.extra-card>span:first-child{font-size:11px;color:var(--ink-2)}
.filter-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.extra-card .lbl{font-size:11px;color:var(--ink-2)}
.extra-card .hint{font-size:10px;color:var(--ink-3)}
.extra-card .val,.extra-card b{font-family:var(--mono);font-size:15px;color:var(--c)}
.extra-card .filter-status{margin-top:0}
.gridmain{grid-template-columns:minmax(0,1.7fr) minmax(320px,.85fr);grid-template-rows:minmax(600px,auto) minmax(200px,auto)}
.gridmain.dss-collapsed{grid-template-columns:minmax(0,1fr) 86px}
.r-power{min-width:0;min-height:600px}
.r-power .chart-wrap{min-height:340px}
.r-power .chart-wrap>svg{position:absolute;inset:0}
.r-dss{max-height:760px}
.r-dss h2{letter-spacing:.08em;flex-wrap:wrap}
.dss-content{display:flex;flex-direction:column;gap:5px;min-height:0;overflow-y:auto;flex:1}
.dss-content[hidden]{display:none}
.dss-content .dss-list{flex:0 0 auto;overflow:visible;min-height:0}
.dss-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.dss-count{display:flex;align-items:center;gap:4px;font-size:11px;border:1px solid var(--line);border-radius:6px;padding:5px 7px;color:var(--ink-2);background:var(--paper)}
.dss-count.alert{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--line));background:color-mix(in srgb,var(--bad) 5%,var(--paper))}
.dss-count.unknown{color:var(--ink-3)}
.dss-chevron{font-size:19px;line-height:1;display:inline-block;vertical-align:middle;margin-right:5px}
.dss-collapsed .r-dss{padding:9px 7px}
.dss-collapsed .r-dss h2{justify-content:center}
.dss-collapsed .dss-title,.dss-collapsed #dss-branch,.dss-collapsed .r-dss h2>.gly{display:none}
.dss-collapsed #dss-toggle{width:100%;padding:7px 2px;display:flex;align-items:center;flex-direction:column;gap:3px;text-transform:none;letter-spacing:0;font-family:var(--sans);font-size:11px}
.dss-collapsed .dss-chevron{transform:rotate(180deg);margin:0}
.dss-collapsed .dss-badges{flex-direction:column;align-items:stretch}
.dss-collapsed .dss-count{flex-direction:column;text-align:center;font-size:10px;padding:7px 3px;gap:2px}
.dss-collapsed .dss-count b{font-size:18px}
.power-alerts{border-top:1px solid var(--line-soft);padding-top:7px;flex-shrink:0}
.power-alert-head{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ink-2)}
.power-alert-head span{color:var(--ink-3)}
#pwr-alert-timeline{width:100%;height:32px;display:block}
.power-alert-list{max-height:82px;overflow-y:auto;font-size:11px;line-height:1.5}
.power-alert-row{display:flex;align-items:baseline;gap:9px;border-top:1px solid var(--line-soft);padding:4px 0}
.power-alert-row time{font-family:var(--mono);white-space:nowrap;color:var(--bad);font-size:10px}
@media(max-width:800px){
  .r-dss{max-height:620px}.r-power{min-height:600px}
  .dss-collapsed .r-dss h2{margin:0}.dss-collapsed .r-dss{display:flex;flex-direction:row;align-items:center;gap:10px}
  .dss-collapsed #dss-toggle{width:auto;min-width:86px;flex-direction:row;padding:7px 9px}
  .dss-collapsed .dss-badges{flex:1;flex-direction:row;justify-content:flex-end;margin:0}
  .dss-collapsed .dss-count{flex-direction:row;font-size:11px;padding:5px 7px}.dss-collapsed .dss-count b{font-size:12px}
}
@media(max-width:480px){
  body{padding:10px}.hdr{align-items:flex-start;flex-wrap:wrap}.poll{text-align:left}
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi{padding:10px 12px}
  .r-power h2{letter-spacing:.05em;gap:6px}.rangebtns{margin-left:0}.rangebtns button{padding:7px 9px}
  .extra-card{padding:8px 7px}.filter-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.extra-card .lbl{font-size:11px;color:var(--ink-2)}
.extra-card .hint{font-size:10px;color:var(--ink-3)}
.extra-card .val,.extra-card b{font-size:12px}
  .power-alert-row{flex-wrap:wrap;gap:3px 9px}.pwr-stat-row{gap:5px}.pwr-stat .val{font-size:14px}
}


/* Rate is the focal value; series can move from overview to analysis. */
.tou-rate{font-size:clamp(32px,4vw,48px);font-weight:800;letter-spacing:-.04em;line-height:1.1;color:var(--ink);font-variant-numeric:tabular-nums}
.tou-rate .tou-unit{font-family:var(--sans);font-size:16px;font-weight:500;letter-spacing:0;color:var(--ink-3);margin-left:7px}
.tou-head-left{align-items:center;gap:16px}.tou-head{padding:7px 0 12px}
.tab-btn[hidden],#detail-content[hidden],.day-body[hidden],.day-mini[hidden],.day-analysis[hidden]{display:none!important}
.detail-help{font-size:12px;color:var(--ink-2);margin:0 0 12px;line-height:1.5}
#detail-toggle,.day-enlarge,.day-collapse{font:inherit;color:var(--ink-2);background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:7px 10px;cursor:pointer;min-height:34px}
#detail-toggle{font-family:var(--sans);font-size:11px;text-transform:none;letter-spacing:0}
#detail-toggle:focus-visible,.day-enlarge:focus-visible,.day-collapse:focus-visible{outline:3px solid var(--info);outline-offset:2px}
.day-card{padding:12px;min-width:0;scroll-margin-top:14px}.day-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.day-collapse{border:0;padding:2px 0;text-align:left;flex:1;min-width:0;display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--series-color)}
.day-collapse::before{content:'⌄';color:var(--ink-3)}.day-collapse[aria-expanded="false"]::before{content:'›'}
.day-enlarge{font-size:11px;flex-shrink:0}.day-enlarge[aria-pressed="true"]{border-color:var(--info);color:var(--info)}
.day-summary{font-size:11px;color:var(--ink-3);line-height:1.5;margin:7px 0;overflow-wrap:anywhere}
.day-mini{width:100%;height:120px;display:block}.day-card.expanded{grid-column:1 / -1;order:-1;border-color:var(--series-color);padding:16px}
.day-card.expanded .sc-frame{height:380px}.day-card.expanded .day-collapse{font-size:15px}
.day-analysis .sc-svg{height:100%}.day-analysis .sc-insights{margin-top:12px}
@media(max-width:480px){.tou-rate{font-size:36px}.tou-head{align-items:flex-start;flex-direction:column;gap:9px}.tou-head-left{gap:10px}.day-card.expanded{padding:10px}.day-card.expanded .sc-frame{height:300px}.day-card.expanded .day-collapse{font-size:13px}.r-detail h2{gap:8px}}

/* Power section: three charts on one time axis; legends double as filters */
.pchart{display:flex;flex-direction:column;gap:3px}
.pchart[hidden]{display:none}
.pchart-h{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}
.pchart-h b{font-size:12px;color:var(--ink)}
.pchart-h .pnote{font-size:11px;color:var(--ink-3)}
.pchart-h .lgs{display:flex;flex-wrap:wrap;gap:2px 4px;margin-left:auto}
.r-power .chart-wrap,.day-wrap{flex:0 0 auto;min-height:0}
.lg{font:inherit;font-size:11px;color:var(--ink-2);background:none;border:1px solid transparent;border-radius:5px;padding:2px 6px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.lg:hover{border-color:var(--line)}
.lg.off{color:var(--ink-3);text-decoration:line-through}
.lg.off .lg-sw{opacity:.3}
.lg:focus-visible{outline:3px solid var(--info);outline-offset:1px}
.lg-sw{width:10px;height:10px;border-radius:2px;display:inline-block;flex-shrink:0;vertical-align:-1px;margin-right:5px}
.lg .lg-sw{margin-right:0}
.pwr-stat .sub,.cost .sub{font-size:10px;color:var(--ink-3);font-weight:500;letter-spacing:0;text-transform:none}
.cost-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;flex-shrink:0}
.cost{border:1px solid var(--line-soft);border-radius:7px;padding:8px 10px;display:flex;flex-direction:column;gap:3px;min-width:0}
.cost .lbl{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-3);font-weight:700}
.cost .val{font-size:17px;font-weight:700;color:var(--ink);line-height:1.1}
.cost .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cost-note{font-size:10px;color:var(--ink-3)}
.day-h b{display:flex;align-items:center;font-size:12px;color:var(--ink)}
.day-note{font-size:10px}
.day-sub{font-family:var(--mono);font-size:10px;color:var(--ink-2);margin:2px 0 1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.day-card .day-mini{height:118px}
.detail-ctl{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--ink-2);margin:-2px 0 8px;text-transform:none;letter-spacing:0;font-family:var(--sans)}
.detail-ctl label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.linkbtn{font:inherit;color:var(--info);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline}
.ghost-btn{font:inherit;font-size:11px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink-2);padding:4px 9px;cursor:pointer}
.ghost-btn:hover{border-color:var(--info);color:var(--info)}
.nilm-key{display:inline-flex;align-items:center;gap:4px}
.nilm-key i{display:inline-block;width:14px;height:9px;border-radius:2px;background:#182230}
.web-note{font-size:11px;color:var(--ink-2);padding:2px 2px 0}
.tou-legend-item{font-size:10.5px}
@media(max-width:800px){.cost-row{grid-template-columns:repeat(2,minmax(0,1fr))}.pwr-stat-row{grid-template-columns:repeat(2,1fr)}}

.r-power .chart-wrap{min-height:0;height:auto;flex:0 0 auto}.r-power .chart-wrap>svg{position:static;width:100%;display:block}.gridmain{align-content:start}
.r-tou .tou-block,.r-tou .tou-graph-wrap{flex:0 0 auto}.r-tou .tou-graph-wrap{height:150px;min-height:150px;flex:0 0 150px}.tou-graph{height:150px!important;width:100%;display:block}
.day-mini{height:118px}.day-card[hidden]{display:none!important}.day-mini-wrap{position:relative;min-width:0}.day-mini-wrap[hidden]{display:none!important}
.series-card[aria-pressed="true"]{color:var(--ink)}.extra-card .val,.extra-card b{color:var(--ink)}

</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="badge"><div class="dot" id="dot"></div><span id="stxt">CONNECTING…</span><span class="mode-pill" id="nilm-mode">ONNX</span></div>
    <h1>IEMS · Los Gatos Microgrid</h1>
    <div class="sub">eGauge · AnyLog · ONNX disaggregator · Adabi DSS</div>
  </div>
  <div class="poll"><div id="pt">--:--:--</div><small id="dt">&mdash;</small></div>
</div>

<div class="errbar" id="errbar"></div>

<!-- KPI strip -->
<div class="kpis">
  <button type="button" class="kpi series-card" data-series="Grid Power" aria-pressed="true" aria-controls="pwr-charts" style="--c:var(--grid)">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1 L3 8 L7 8 L6 13 L11 6 L7 6 Z"/></svg>Grid Power</div>
    <div class="val" id="kg">—</div><div class="hint" id="kgh">—</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="Panel1 (HVAC)" aria-pressed="true" aria-controls="pwr-charts" style="--c:var(--hvac)">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7 1 V13 M1 7 H13 M2.5 2.5 L11.5 11.5 M11.5 2.5 L2.5 11.5"/></svg>Panel1 HVAC</div>
    <div class="val" id="kh">—</div><div class="hint" id="khh">—</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="Panel2 (H2O)" aria-pressed="true" aria-controls="pwr-charts" style="--c:var(--h2o)">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M7 1 C 4 5 3 7 3 9 A4 4 0 0 0 11 9 C 11 7 10 5 7 1 Z"/></svg>Panel2 H2O</div>
    <div class="val" id="kw">—</div><div class="hint" id="kwh">—</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="Panel3 (Kitchen)" aria-pressed="true" aria-controls="pwr-charts" style="--c:var(--kit)">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="7" cy="8" r="4.5"/><path d="M2.5 8 H11.5 M5 4 V2 M9 4 V2"/></svg>Panel3 Kitchen</div>
    <div class="val" id="kk">—</div><div class="hint" id="kkh">—</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="Shop" aria-pressed="true" aria-controls="pwr-charts" style="--c:var(--shop)">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><circle cx="7" cy="7" r="2"/></svg>Shop / Dryer</div>
    <div class="val" id="ks">—</div><div class="hint" id="ksh">—</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="Generac Power" aria-pressed="true" aria-controls="pwr-charts" style="--c:var(--gen)">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="3" width="9" height="8" rx="1"/><rect x="11" y="5" width="2" height="4"/></svg>Generac</div>
    <div class="val" id="kgn">—</div><div class="hint" id="kgnh">standby</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="PV (measured)" aria-pressed="true" aria-controls="pwr-charts" style="--c:#caa12e">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="3"/><path d="M7 1V2 M7 12V13 M1 7H2 M12 7H13 M3 3l.8.8 M10.2 10.2l.8.8 M11 3l-.8.8 M3.8 10.2l-.8.8"/></svg>Solar · measured</div>
    <div class="val" id="ksa">—</div><div class="hint" id="ksah">—</div>
    <span class="filter-status">Shown</span>
  </button>
  <button type="button" class="kpi series-card" data-series="Battery SOC" aria-pressed="true" aria-controls="pwr-charts" style="--c:#2e7d8a">
    <div class="lbl"><svg class="kpi-glyph" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="4" width="9" height="6" rx="1"/><rect x="11" y="6" width="1.5" height="2"/></svg>Battery SOC</div>
    <div class="val" id="kbat">—</div><div class="hint" id="kbath">13.5 kWh · 10% floor</div>
    <span class="filter-status">Shown</span>
  </button>
</div>

<!-- Controls -->
<div class="ctrl">
  <label>Mode</label>
  <select id="sel-mode">
    <option value="on_grid">on_grid</option>
    <option value="off_grid">off_grid</option>
    <option value="export">export</option>
  </select>
  <label>NILM</label>
  <div class="toggle" id="nilm-toggle">
    <button data-v="onnx" class="active">ONNX</button>
    <button data-v="ollama">Ollama</button>
  </div>
  <label>Window</label>
  <input type="number" id="sel-win" value="10" min="2" max="60" style="width:48px"> <span style="font-family:var(--mono);font-size:9px;color:var(--ink-3)">min</span>
  <button class="btn" id="run-btn">▷ Run IEMS Cycle</button>
  <span class="cycstat" id="cycle-status">no cycle yet</span>
</div>

<!-- Tab bar -->
<div class="tabs">
  <button class="tab-btn active" data-tab="general">General</button>
  <button class="tab-btn" data-tab="forecast">Predictions</button>
  <button class="tab-btn" data-tab="system">System map</button>
  <button class="tab-btn" data-tab="weather">Weather</button>
  <button class="tab-btn" data-tab="appliances">Appliances</button>
  <button class="tab-btn" data-tab="relay" hidden>Relay</button>
  <button class="tab-btn" data-tab="anomalies">Anomalies</button>
  <button class="tab-btn" data-tab="ask">Ask</button>
</div>

<!-- General tab: panel KPIs (above), raw power, dss, TOU/forecast -->
<div id="web-source-note" style="padding:8px 16px;color:#475467;font-size:12px"></div>
<div class="tab-panel" id="tab-forecast"><iframe id="forecast-frame" title="Panel and grid power predictions" src="/forecast-view" style="width:100%;height:1500px;border:0" loading="lazy"></iframe></div>
<div class="tab-panel" id="tab-system"><iframe title="GX10 system map" src="/system-view" style="width:100%;height:1200px;border:0" loading="lazy"></iframe></div>
<div class="tab-panel active" id="tab-general">
<div class="srcbar" id="srcbar"></div>
<div class="gridmain" id="general-grid">

  <!-- Raw Power -->
  <div class="region r-power">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 11 L4 7 L7 9 L10 4 L13 6"/><path d="M1 13 H13"/></svg>
      Power, solar &amp; battery
      <span class="rangebtns" id="pwr-range">
        <button data-min="30" class="active">30m</button>
        <button data-min="60">1h</button>
        <button data-min="360">6h</button>
        <button data-min="720">12h</button>
        <button data-min="1440">24h</button>
      </span>
      <span class="tag" id="pwr-age">&mdash;</span>
    </h2>
    <div class="pwr-content">
      <div class="filter-help"><span id="pwr-selection">Select the cards above to show or hide a series.</span><span class="filter-actions"><button type="button" id="pwr-collapse" hidden>Collapse cards</button> <button type="button" id="pwr-reset" aria-expanded="false" aria-controls="pwr-more-cards">Show all</button></span></div>
      <div id="pwr-more-cards" class="power-extra-cards" aria-label="Power, solar and battery graph filters" hidden></div>
      <div class="power-extra-cards" aria-label="Inverter graph filters">
        <button type="button" class="series-card extra-card" data-series="House load" aria-pressed="true" aria-controls="pwr-charts" style="--c:#6b5a8a"><span>House load</span><b id="filter-load">—</b><span class="filter-status">Shown</span></button>
        <button type="button" class="series-card extra-card" data-series="Grid flow (inverter)" aria-pressed="true" aria-controls="pwr-charts" style="--c:#9a6b4a"><span>Inverter grid flow</span><b id="filter-grid">—</b><span class="filter-status">Shown</span></button>
        <button type="button" class="series-card extra-card" data-series="Battery power" aria-pressed="true" aria-controls="pwr-charts" style="--c:#5e8a5a"><span>Battery power</span><b id="filter-batt">—</b><span class="filter-status">Shown</span></button>
      </div>
      <div id="pwr-charts" class="pcharts">
        <div class="pchart">
          <div class="pchart-h"><b>House demand by panel</b><span class="pnote">eGauge · panels stacked · grid line: import +, export −</span><span class="lgs" id="lg-load"></span></div>
          <div class="chart-wrap"><svg id="pwr-load" role="img" aria-label="House demand stacked by panel, with utility grid import and export"></svg><div class="chart-tip"></div></div>
        </div>
        <div class="pchart">
          <div class="pchart-h"><b>Solar, battery and inverter</b><span class="pnote">Solar Assistant · battery: charging +, discharging −</span><span class="lgs" id="lg-src"></span></div>
          <div class="chart-wrap"><svg id="pwr-src" role="img" aria-label="Solar production, battery power, inverter grid port and inverter load"></svg><div class="chart-tip"></div></div>
        </div>
        <div class="pchart" id="pc-soc">
          <div class="pchart-h"><b>Battery state of charge</b><span class="pnote">13.5 kWh · 10% reserve floor</span></div>
          <div class="chart-wrap"><svg id="pwr-soc" role="img" aria-label="Battery state of charge in percent"></svg><div class="chart-tip"></div></div>
        </div>
      </div>
      <div class="power-alerts" aria-label="Power alerts in the selected window">
        <div class="power-alert-head"><b>Power alerts</b><span id="pwr-alert-count">Loading…</span></div>
        <svg id="pwr-alert-timeline" viewBox="0 0 640 32" preserveAspectRatio="none" role="img" aria-label="Power alert timestamps"></svg>
        <div id="pwr-alert-list" class="power-alert-list"></div>
      </div>

      <div class="pwr-stat-row">
        <div class="pwr-stat" style="--c:var(--ink)"><div class="lbl">Demand now</div><div class="val" id="stat-sum">—</div><div class="sub">metered panels · live</div></div>
        <div class="pwr-stat" style="--c:var(--ink)"><div class="lbl" id="stat-kwh-lbl">Energy</div><div class="val" id="stat-kwh">—</div><div class="sub">metered panels</div></div>
        <div class="pwr-stat" style="--c:var(--ink)"><div class="lbl">Peak demand</div><div class="val" id="stat-peak">—</div><div class="sub" id="stat-peak-at"></div></div>
        <div class="pwr-stat" style="--c:var(--ink)"><div class="lbl">Average demand</div><div class="val" id="stat-avg">—</div><div class="sub">over the data in range</div></div>
      </div>
      <div class="cost-row" aria-label="Cost estimates">
        <div class="cost"><div class="lbl">Grid cost now</div><div class="val" id="cost-now">—</div><div class="sub" id="cost-now-sub"></div></div>
        <div class="cost"><div class="lbl">Grid import cost</div><div class="val" id="cost-imp">—</div><div class="sub" id="cost-imp-sub"></div></div>
        <div class="cost"><div class="lbl">Exported to grid</div><div class="val" id="cost-exp">—</div><div class="sub" id="cost-exp-sub"></div></div>
        <div class="cost"><div class="lbl">Solar value</div><div class="val" id="cost-pv">—</div><div class="sub" id="cost-pv-sub"></div></div>
      </div>
      <div class="cost-note">Estimates from the eGauge utility meter and the E-ELEC planning rates below. Account rates and export credits are unverified. Excludes fixed charges, taxes and NEM true-up.</div>
    </div>
  </div>

  <!-- Every series, same window as the power chart above (range buttons drive both) -->
  <div class="region r-detail">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="6"/><path d="M7 3 V7 L10 9"/></svg>
      Series graphs
      <span class="tag" id="day-age">&mdash;</span>
      <button type="button" id="detail-toggle" aria-expanded="true" aria-controls="detail-content">Collapse series</button>
    </h2>
    <div id="detail-content"><div class="detail-ctl"><label><input type="checkbox" id="shared-scale" checked> Same scale for the four panels</label><span id="day-hidden"></span></div><p class="detail-help">Lines show interval averages; shaded bands show measured minima and maxima. Select Enlarge, then zoom and pan to inspect an interval. All times Pacific.</p>
    <div class="day-grid" id="day-grid"><div style="color:var(--ink-3);padding:6px">Loading&hellip;</div></div>
    </div>
  </div>
  <div class="region r-nilm24">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 12 H13 M3 12 V7 M6.5 12 V4 M10 12 V9"/></svg>
      Appliance activity &middot; grouped under the panel that feeds it
      <span class="tag" id="nilm24-age">&mdash;</span>
    </h2>
    <div class="detail-ctl"><span class="nilm-key">Cell shade = share of the cell the model called it on:
      <i style="opacity:.25"></i>low <i style="opacity:.6"></i> <i style="opacity:1"></i>all of it</span>
      <button type="button" class="ghost-btn" id="nilm-idle">Show idle appliances</button><span id="nilm-hidden"></span></div>
    <div><svg id="nilm24" role="img" aria-label="Appliance on/off activity under each panel's power" style="width:100%;display:block"></svg></div>
  </div>
  <div class="region r-anom24">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1.5 L13 12 H1 Z"/><path d="M7 6 V8.5 M7 10 V10.6"/></svg>
      Anomalies in this window
      <span class="tag" id="day-anom-tag">&mdash;</span>
    </h2>
    <div id="day-anom-list" style="font-size:11px"></div>
  </div>

  <!-- DSS -->
  <div class="region r-dss" id="recommendations-panel">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><polygon points="7,1 13,7 7,13 1,7"/><path d="M7 4 V10 M4 7 H10"/></svg>
      <span class="dss-title">Recommended next steps</span>
      <span class="tag" id="dss-branch">—</span>
      <button type="button" id="dss-toggle" aria-expanded="true" aria-controls="dss-content" aria-label="Collapse recommended next steps"><span class="dss-chevron" aria-hidden="true">›</span><span class="dss-toggle-label">Collapse</span></button>
    </h2>
    <div class="dss-badges" id="dss-badges" role="status" aria-live="polite"></div>
    <div class="dss-content" id="dss-content">
    <div id="smart-dss"><div class="dss-empty">Preparing your appliance plan…</div></div>
    <div id="readiness-summary" style="font-size:11px;padding:8px 0;color:var(--ink-2)">Checking Los Gatos weather and outages…</div>
    <div id="readiness-recs"></div>
    <div class="dss-list" id="dss-list"></div>
    </div>
  </div>

  <!-- PG&E TOU schedule & forecast load -->
  <div class="region r-tou">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="6" r="2"/><path d="M5 1 V2.5 M1 6 H2.5"/><path d="M7 11 A3 3 0 1 1 13 11 H7 Z" fill="none"/></svg>
      PG&amp;E E-ELEC planning rates &middot; today
      <span class="tag" id="wtou-age">—</span>
    </h2>
    <div class="tou-block">
      <div class="tou-head">
        <div class="tou-head-left">
          <div class="tou-pill" id="tou-pill">—</div>
          <div class="tou-rate" id="tou-rate">—</div>
        </div>
        <div class="tou-next" id="tou-info">—</div>
      </div>
      <div class="tou-graph-wrap"><svg class="tou-graph" id="tou-graph" role="img" aria-label="Today’s time-of-use planning rate"></svg></div>
      <div class="tou-legend" id="tou-legend"></div>
    </div>
  </div>

</div>
</div>

<!-- Weather tab -->
<div class="tab-panel" id="tab-weather">
  <div class="region r-weather-tab">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="6" r="2"/><path d="M5 1 V2.5 M1 6 H2.5"/><path d="M7 11 A3 3 0 1 1 13 11 H7 Z" fill="none"/></svg>
      Weather
    </h2>
    <div class="weather-grid">
      <div class="wstat" style="--c:var(--bad)">
        <svg class="wstat-gly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0Z"/><circle cx="12" cy="17.5" r="1.6" fill="currentColor" stroke="none"/></svg>
        <div class="wstat-body"><div class="wl">Temp</div><div class="wv" id="w-temp">&mdash;<span class="wu">&deg;F</span></div></div>
      </div>
      <div class="wstat" style="--c:var(--info)">
        <svg class="wstat-gly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 17.5A4.5 4.5 0 0 1 7 8.6a5.5 5.5 0 0 1 10.5 1.6A3.7 3.7 0 0 1 17 17.5Z"/></svg>
        <div class="wstat-body"><div class="wl">Cloud</div><div class="wv" id="w-cloud">&mdash;<span class="wu">%</span></div></div>
      </div>
      <div class="wstat" style="--c:var(--warn)">
        <svg class="wstat-gly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5V5 M12 19V21.5 M2.5 12H5 M19 12H21.5 M5.2 5.2l1.8 1.8 M17 17l1.8 1.8 M18.8 5.2 17 7 M7 17l-1.8 1.8"/></svg>
        <div class="wstat-body"><div class="wl">Irradiance</div><div class="wv" id="w-irr">&mdash;<span class="wu">W/m&sup2;</span></div></div>
      </div>
      <div class="wstat" style="--c:var(--ok)">
        <svg class="wstat-gly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 18h8"/></svg>
        <div class="wstat-body"><div class="wl">Wind</div><div class="wv" id="w-wind">&mdash;<span class="wu">mph</span></div></div>
      </div>
      <div class="wstat" style="--c:var(--sa)">
        <svg class="wstat-gly" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 15 9 4h6l5 11Z"/><path d="M7 15h10M12 4v11M4 19h16"/></svg>
        <div class="wstat-body"><div class="wl">PV now</div><div class="wv" id="w-pv">&mdash;<span class="wu">W</span></div></div>
      </div>
    </div>
    <div class="wx-controls" aria-label="Weather graph filters">
      <label>Chart window <select id="wx-horizon"><option value="all">Past 24h + next 24h</option><option value="future">Next 24 hours</option><option value="recent">Past 6h + next 24h</option></select></label>
      <button type="button" data-wx-filter="history" aria-pressed="true">Past weather</button><button type="button" data-wx-filter="forecast" aria-pressed="true">Forecast</button>
      <button type="button" data-wx-filter="peak" aria-pressed="true">Peaks</button><button type="button" data-wx-filter="dip" aria-pressed="true">Dips</button><button type="button" data-wx-filter="selected" aria-pressed="true">Selected time</button>
    </div>
    <p class="wx-help">Select a peak or low to inspect the forecast at that time. Hover or tap for values; zoom and pan to analyze an interval. Times are Pacific. Solar irradiance measures sunlight in W/m².</p>
    <div id="wx-status" class="wx-status" role="status">Loading weather…</div>
    <div class="wx-row">
      <section class="wx-chart" id="wx-card-temp">
        <div class="wx-title"><span>Temperature</span><div class="wx-actions"><button type="button" class="wx-collapse" aria-expanded="true" aria-controls="wx-body-temp">Collapse</button><button type="button" class="wx-expand" aria-pressed="false">Enlarge</button></div></div>
        <div class="wx-current" id="wx-temp-now">—</div><div class="wx-body" id="wx-body-temp"><div id="wx-temp"></div></div>
      </section>
      <section class="wx-chart" id="wx-card-irr">
        <div class="wx-title"><span>Solar irradiance</span><div class="wx-actions"><button type="button" class="wx-collapse" aria-expanded="true" aria-controls="wx-body-irr">Collapse</button><button type="button" class="wx-expand" aria-pressed="false">Enlarge</button></div></div>
        <div class="wx-current" id="wx-irr-now">—</div><div class="wx-body" id="wx-body-irr"><div id="wx-irr"></div></div>
      </section>
    </div>
  </div>
</div>

<!-- Appliances tab -->
<div class="tab-panel" id="tab-appliances">
  <div class="region r-nilm">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="3.5" cy="3.5" r="1.8"/><circle cx="10.5" cy="3.5" r="1.8"/><circle cx="3.5" cy="10.5" r="1.8"/><circle cx="10.5" cy="10.5" r="1.8"/><path d="M3.5 5.3 V8.7 M10.5 5.3 V8.7 M5.3 3.5 H8.7 M5.3 10.5 H8.7"/></svg>
      NILM Disaggregator  ·  22 appliances inferred from 3 panels
      <span class="tag" id="nilm-age">—</span>
    </h2>
    <div class="nilm-groups" id="nilm-grid"><div class="nilm-empty">No predictions yet — run a cycle to populate.</div></div>
  </div>
</div>

<!-- Relay tab -->
<div class="tab-panel" id="tab-relay">
  <div class="region">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1 V6"/><path d="M3.5 3 A5 5 0 1 0 10.5 3"/></svg>
      HVAC Relay &middot; manual control
      <span class="tag" id="relay-state">—</span>
    </h2>
    <div class="thermo">
      <div class="th-card">
        <div class="th-lbl">Indoor now</div>
        <div class="th-big" id="th-indoor">&mdash;<span class="u">&deg;F</span></div>
        <div class="th-sub" id="th-action">&mdash;</div>
        <div class="th-sub" id="th-held" style="color:var(--warn)"></div>
        <div style="margin-top:auto;display:flex;gap:6px;flex-wrap:wrap">
          <button class="th-ghost" id="rl-off">HVAC OFF</button>
          <button class="th-ghost" id="rl-restore">Restore</button>
        </div>
      </div>
      <div class="th-card">
        <div class="th-lbl">Setpoint <span id="th-mode" style="color:var(--info)"></span></div>
        <div class="th-setrow">
          <button class="step-btn" id="th-minus" title="1&deg;F cooler">&minus;</button>
          <div class="th-set" id="th-set">&mdash;<span class="u">&deg;F</span></div>
          <button class="step-btn" id="th-plus" title="1&deg;F warmer">+</button>
        </div>
        <div class="th-actions">
          <button class="th-apply" id="th-apply" disabled>Apply</button>
          <button class="th-ghost" id="th-cancel" style="display:none">Cancel</button>
          <span id="rl-steps"></span>
        </div>
        <div class="th-sub" style="text-align:center" id="th-note">thermostat setpoint &mdash; tap &plusmn; then Apply</div>
      </div>
      <div class="th-card">
        <div class="th-lbl">Impact of this change</div>
        <div class="imp-row"><span class="k">HVAC energy &middot; last 24 h</span><span class="v" id="imp-base">&mdash;</span></div>
        <div class="imp-row"><span class="k" id="imp-dir">energy / day</span><span class="v" id="imp-energy">&mdash;</span></div>
        <div class="imp-row"><span class="k">at the current rate</span><span class="v" id="imp-cost">&mdash;</span></div>
        <div class="imp-row"><span class="k">extra load right now runs on</span><span class="v" id="imp-src">&mdash;</span></div>
        <div class="imp-note" id="imp-note">&approx;3%/&deg;F rule of thumb applied to this house's measured 24 h HVAC energy. Direction assumes cooling season.</div>
      </div>
    </div>
    <div id="relay-warn" style="display:none;margin-top:9px;padding:7px 9px;border:1px solid var(--bad);
         color:var(--bad);font-size:11px;line-height:1.5;border-radius:7px"></div>
    <div id="relay-drift" style="display:none;margin-top:9px;padding:7px 9px;border:1px solid var(--warn);
         color:var(--warn);font-size:11px;line-height:1.5;border-radius:7px"></div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap;font-size:11px">
      <span class="tag" id="relay-msg"></span>
      <span style="color:var(--ink-3);margin-left:auto">Set exactly</span>
      <input id="rl-exact" type="number" min="45" max="100" step="1"
             style="width:64px;font-family:var(--mono);font-size:11px;padding:3px 5px;
                    background:var(--paper);border:1px solid var(--line);color:var(--ink);border-radius:5px">
      <span style="color:var(--ink-3)">&deg;F</span>
      <button class="th-ghost" id="rl-exact-go">Apply</button>
      <span style="color:var(--ink-3);margin-left:10px">Quick steps (&deg;F)</span>
      <input id="rl-cfg" type="text" placeholder="2,4"
             style="width:78px;font-family:var(--mono);font-size:11px;padding:3px 5px;
                    background:var(--paper);border:1px solid var(--line);color:var(--ink);border-radius:5px">
      <button class="th-ghost" id="rl-cfg-save">Save</button>
    </div>
    <div style="font-size:10.5px;color:var(--ink-3);margin-top:8px;line-height:1.5">
      Manual only. Nothing here acts on its own &mdash; including putting HVAC back.
      Every action is logged and sends email + SMS.
    </div>
  </div>

  <div class="region">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="6"/><path d="M7 4 V7.5 L9.5 9"/></svg>
      DSS Recommendation
      <span class="tag" id="dss-urgency">—</span>
    </h2>
    <div id="dss-body" style="font-size:11.5px;line-height:1.6"></div>
  </div>

  <div class="region">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 12 H13 M3 12 V7 M6.5 12 V4 M10 12 V9"/></svg>
      Live Panel Loads
      <span class="tag" id="loads-tag">—</span>
    </h2>
    <div id="loads-table" style="font-size:11px"></div>
  </div>
</div>

<!-- Anomalies tab -->
<div class="tab-panel" id="tab-anomalies">
  <div class="region">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1.5 L13 12 H1 Z"/><path d="M7 6 V8.5 M7 10 V10.6"/></svg>
      Critical Issues
      <span class="tag" id="crit-tag">—</span>
    </h2>
    <div id="crit-list" style="font-size:11px"></div>
  </div>

  <div class="region">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 1 V6"/><path d="M3.5 3 A5 5 0 1 0 10.5 3"/></svg>
      Relay Action Log
      <span class="tag" id="rlog-tag">—</span>
    </h2>
    <div id="rlog-list" style="font-size:11px"></div>
  </div>

  <div class="region">
    <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3 H12 M2 7 H12 M2 11 H8"/></svg>
      All Events &middot; 24 h
      <span class="tag" id="all-tag">—</span>
    </h2>
    <div id="all-list" style="font-size:11px"></div>
  </div>
</div>

<script src="/chart-analysis.js"></script>

<!-- Ask tab -->
<div class="tab-panel" id="tab-ask">
  <div style="display:flex;gap:9px;flex:1 0 auto;min-height:0">
    <div class="region" style="flex:1 1 auto;min-width:0">
      <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5 A3 3 0 1 1 7 8 V9"/><circle cx="7" cy="12" r="0.6" fill="currentColor"/></svg>
        Ask Nemotron 3.5 Lightning
        <span class="tag" id="ask-tag">&mdash;</span>
      </h2>
      <div class="ctrl" style="margin-bottom:8px">
        <input id="ask-q" type="text" placeholder="Which appliances are on right now, and what is the grid doing?"
               style="flex:1;min-width:240px;font-family:var(--mono);font-size:11px;padding:5px 8px;
                      background:var(--paper);border:1px solid var(--line);color:var(--ink);border-radius:5px">
        <button class="btn" id="ask-go">Ask</button>
        <span class="cycstat" id="ask-status"></span>
      </div>
      <div class="dss-list" id="ask-log" style="min-height:240px">
        <div class="dss-empty">Runs on this machine. Grounded in the live panel and solar feeds,
          the post-inference rules, the breaker and leg map, and the canonical appliance spec.</div>
      </div>
    </div>
    <div class="region" style="flex:0 0 260px;min-width:0">
      <h2><svg class="gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5 A3 3 0 1 1 7 8 V9"/><circle cx="7" cy="12" r="0.6" fill="currentColor"/></svg>
        Useful Questions
      </h2>
      <div id="ask-presets" style="display:flex;flex-direction:column;gap:6px;overflow-y:auto"></div>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id)

/* ── Tabs ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
    btn.classList.add('active')
    $('tab-' + btn.dataset.tab).classList.add('active')
  }
})

/* ── PANEL META ── */
const PANELS = [
  {nm:'Grid Power',      key:'g',  c:'#b85c2e', max:8000, onW:50},
  {nm:'Panel1 (HVAC)',   key:'h',  c:'#4a6b8a', max:6000, onW:1000},
  {nm:'Panel2 (H2O)',    key:'w',  c:'#8a5a7a', max:4000, onW:200},
  {nm:'Panel3 (Kitchen)',key:'k',  c:'#5e8a5a', max:2500, onW:300},
  {nm:'Shop',            key:'s',  c:'#c89a3a', max:7500, onW:100},
  {nm:'Generac Power',   key:'gn', c:'#a17a28', max:5000, onW:10},
]

/* ── 14-appliance NILM catalog (abstract SVG glyphs, no emoji) ── */
const NILM_APPLIANCES = [
  {key:'heat_pump',       label:'Heat Pump',     circuit:'Panel1 (HVAC)',    model:'panel1', c:'#4a6b8a',
    glyph:'<circle cx="7" cy="7" r="5"/><path d="M3 5 L11 9 M3 9 L11 5"/>'},
  {key:'solar_pump',      label:'Solar Pump',    circuit:'Panel1 (HVAC)',    model:'panel1', c:'#a17a28',
    glyph:'<circle cx="7" cy="7" r="3"/><path d="M7 1 V3 M7 11 V13 M1 7 H3 M11 7 H13"/>'},
  {key:'water_heater',    label:'Water Heater',  circuit:'Panel2 (H2O)',     model:'panel2', c:'#8a5a7a',
    glyph:'<path d="M7 1 C 4 5 3 7 3 9 A4 4 0 0 0 11 9 C 11 7 10 5 7 1 Z"/>'},
  {key:'hair_dryer',      label:'Hair Dryer',    circuit:'Panel2 (H2O)',     model:'panel2', c:'#8a5a7a',
    glyph:'<path d="M2 5 H8 L10 4 V10 L8 9 H2 Z M8 7 H12"/>'},
  {key:'sprinklers',      label:'Sprinklers',    circuit:'Panel2 (H2O)',     model:'panel2', c:'#8a5a7a',
    glyph:'<path d="M3 12 H11 M5 12 V8 M7 12 V6 M9 12 V8"/>'},
  {key:'bath_lights',     label:'Bath Lights',   circuit:'Panel2 (H2O)',     model:'panel2', c:'#8a5a7a',
    glyph:'<path d="M7 2 A 3.5 3.5 0 0 1 10 8 L9 10 H5 L4 8 A 3.5 3.5 0 0 1 7 2 Z M5 11 H9"/>'},
  {key:'refrigerator',    label:'Refrigerator',  circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="3" y="2" width="8" height="11" rx="1"/><line x1="3" y1="6.5" x2="11" y2="6.5"/>'},
  {key:'garage_fridge',   label:'Garage Fridge', circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="3" y="2" width="8" height="11" rx="1"/><line x1="3" y1="6.5" x2="11" y2="6.5"/><path d="M9 3.5 V5"/>'},
  {key:'garage_freezer',  label:'Garage Freezer', circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<path d="M7 2 V12 M3 4.5 L11 9.5 M11 4.5 L3 9.5"/>'},
  {key:'dishwasher',      label:'Dishwasher',    circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="2.5" y="2" width="9" height="11" rx="1"/><line x1="2.5" y1="4.5" x2="11.5" y2="4.5"/><circle cx="7" cy="9" r="2.5"/>'},
  {key:'microwave',       label:'Microwave',     circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="1.5" y="3" width="11" height="8" rx="1"/><rect x="3" y="4.5" width="6" height="5"/>'},
  {key:'computers',       label:'Computers',     circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="2" y="3" width="10" height="6" rx="1"/><path d="M1 12 H13"/>'},
  {key:'tv_stereo',       label:'TV / Stereo',   circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="1.5" y="3" width="11" height="7" rx="1"/><path d="M5 12 H9"/>'},
  {key:'dryer',           label:'Dryer',         circuit:'Shop',             model:'panel3', c:'#c89a3a',
    glyph:'<rect x="2.5" y="2" width="9" height="11" rx="1"/><circle cx="7" cy="8.5" r="3"/><circle cx="7" cy="8.5" r="1"/>'},
  {key:'washing_machine', label:'Washer',        circuit:'Shop',             model:'panel3', c:'#c89a3a',
    glyph:'<rect x="2.5" y="2" width="9" height="11" rx="1"/><circle cx="7" cy="8" r="3"/>'},
  {key:'pressure_pump',   label:'Pressure Pump', circuit:'Shop',             model:'panel3', c:'#c89a3a',
    glyph:'<circle cx="7" cy="8" r="3.5"/><path d="M7 4.5 V2 M5 2 H9"/>'},
  {key:'oven', label:'Oven', circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="2" y="3" width="10" height="9" rx="1"/><line x1="2" y1="6" x2="12" y2="6"/><circle cx="7" cy="9" r="1.6"/>'},
  {key:'cooktop', label:'Cooktop/Range', circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<circle cx="4.5" cy="4.5" r="1.8"/><circle cx="9.5" cy="4.5" r="1.8"/><circle cx="4.5" cy="9.5" r="1.8"/><circle cx="9.5" cy="9.5" r="1.8"/>'},
  {key:'counter_appliance', label:'Counter 0.8-1.5kW', circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="2" y="5" width="10" height="7" rx="1.5"/><path d="M5 5 V3 M9 5 V3"/>'},
  {key:'garage_opener', label:'Garage Opener', circuit:'Panel3 (Kitchen)', model:'panel3', c:'#5e8a5a',
    glyph:'<rect x="2" y="4" width="10" height="8"/><path d="M2 6.5 H12 M2 9 H12"/>'},
  {key:'jacuzzi_pump', label:'Jacuzzi Pump', circuit:'Panel1 (HVAC)', model:'panel1', c:'#4a6b8a',
    glyph:'<path d="M2 9 Q4 7 6 9 T10 9 T13 9"/><path d="M2 11.5 Q4 9.5 6 11.5 T10 11.5 T13 11.5"/><circle cx="7" cy="4" r="2"/>'},
  {key:'strip_heater', label:'Strip Heater', circuit:'Panel1 (HVAC)', model:'panel1', c:'#4a6b8a',
    glyph:'<path d="M3 3 V11 M5.5 3 V11 M8 3 V11 M10.5 3 V11"/>'},
]

const prevStates = {}
let lastCycleResult = null
let cycleRunning = false
let nilmBackend = 'onnx'

/* ── Formatters ── */
const fW  = w => Math.abs(w) >= 1000 ? (Math.abs(w)/1000).toFixed(2)+' kW' : Math.round(Math.abs(w))+' W'
const PT_TZ = 'America/Los_Angeles'
// AnyLog hands back naive UTC strings; append Z so they are not read as local.
const asDate = ts => new Date(
  (ts && ts.includes && ts.includes('T')) ? ts : (ts + '').replace(' ', 'T') + 'Z')
const ptTime = ts => asDate(ts).toLocaleTimeString('en-US',
  { timeZone: PT_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const ptShort = ts => asDate(ts).toLocaleString('en-US',
  { timeZone: PT_TZ, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const ptNow = () => new Date().toLocaleTimeString('en-US',
  { timeZone: PT_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const sT = ts => ts ? ptTime(ts) : '—'
// A Date whose local fields read as Pacific wall-clock time, for code that uses getHours().
const ptWall = d => new Date(d.toLocaleString('en-US', { timeZone: PT_TZ }))
const fmtAge = sec => {
  if (sec < 60) return sec + 's'
  if (sec < 3600) return Math.floor(sec/60) + 'm'
  return Math.floor(sec/3600) + 'h'
}
const fAge = ts => {
  if (!ts) return '—'
  const t = new Date(ts.includes && ts.includes('T') ? ts : (ts+'').replace(' ','T')+'Z').getTime()
  const s = Math.round((Date.now() - t) / 1000)
  return s < 60 ? s+'s ago' : Math.floor(s/60)+'m ago'
}

/* ── KPI hint ── */
function hint(p, w) {
  const aw = Math.abs(w)
  if (p.nm === 'Grid Power') return w < -20 ? '↓ exporting' : w > 20 ? '▲ importing' : 'balanced'
  return aw >= p.onW ? 'ON' : aw > 20 ? 'standby' : 'off'
}

/* ── Snapshot polling — drives KPIs ── */
async function pollSnapshot() {
  try {
    const snap = await fetch('/api/snapshot').then(r => r.json())
    LAST_SNAP={at:Date.now(),snap}
    let newestTs = ''
    let count = 0
    PANELS.forEach(p => {
      const v = snap[p.nm]; if (!v) return
      count++
      if (v.ts > newestTs) newestTs = v.ts
      const w = v.w
      $('k'+p.key).textContent = fW(w)
      const h = hint(p, w)
      const hel = $('k'+p.key+'h'); hel.textContent = h
      hel.className = 'hint ' + (h.startsWith('▲') ? 'up' : h.startsWith('↓') ? 'down' : '')
    })
    syncLocalGraphValues()
    if(typeof LAST_P!=='undefined')renderCombined()
    // Color-code badge based on data lag — never go blank just because data is slow.
    let ageSec = 9999
    if (newestTs) ageSec = Math.round((Date.now() - new Date((newestTs+'').replace(' ','T')+'Z').getTime()) / 1000)
    const dotEl = $('dot')
    if (count === 0) {
      dotEl.className = 'dot err'
      $('stxt').textContent = 'NO DATA · check ingestion'
    } else if (ageSec > 300) {
      dotEl.className = 'dot err'
      $('stxt').textContent = 'STALE · ' + count + ' ch · ' + fmtAge(ageSec) + ' old'
    } else if (ageSec > 60) {
      dotEl.className = 'dot warn'
      $('stxt').textContent = 'LAGGING · ' + count + ' ch · ' + fmtAge(ageSec) + ' old'
    } else {
      dotEl.className = 'dot'
      $('stxt').textContent = 'LIVE · ' + count + ' ch · ' + fmtAge(ageSec)
    }
    $('pt').textContent = ptNow() + ' PT'
    if (newestTs) $('dt').textContent = 'data: ' + sT(newestTs)
    $('errbar').className = 'errbar'
  } catch (e) {
    $('dot').className = 'dot err'
    $('stxt').textContent = 'OFFLINE'
    $('errbar').className = 'errbar show'
    $('errbar').textContent = 'Power feed offline — ' + e.message
  }
  setTimeout(pollSnapshot, 3000)
}

/* ── Shared chart kit ────────────────────────────────────────────────────────
   Every time chart on the General tab goes through drawTimeChart(), so they all
   share one colour per entity, "nice" tick values, a stated unit, Pacific-time
   ticks on clock boundaries, and the SAME requested window [now − range, now].
   Gaps in the data stay gaps instead of being stretched across the axis.

   Sign conventions, as the feeds report them (checked against live rows):
     eGauge Grid Power      import +, export −
     eGauge subpanels       CTs read negative while consuming → plotted as |W|
     Solar Assistant grid   import +, export −   (inverter's own grid port)
     Solar Assistant batt   charging +, discharging −
   Separate hue families identify each entity. ── */
const COL = { hvac:'#2a6fc9', h2o:'#c4508f', kit:'#2e8b3e', shop:'#e09a10', grid:'#d0562a',
              gen:'#6250d6', pv:'#e0a800', batt:'#0a9488', load:'#344054' }
const INK = { axis:'#667085', grid:'#eaecf0', rule:'#98a2b3', text:'#344054' }
const SER = {
  'Panel1 (HVAC)':        { lbl:'HVAC',               c:COL.hvac, src:'p' },
  'Panel2 (H2O)':         { lbl:'H2O',                c:COL.h2o,  src:'p' },
  'Panel3 (Kitchen)':     { lbl:'Kitchen',            c:COL.kit,  src:'p' },
  'Shop':                 { lbl:'Shop / dryer',       c:COL.shop, src:'p' },
  'Grid Power':           { lbl:'Utility grid',       c:COL.grid, src:'p', signed:true, note:'eGauge · import +, export −' },
  'Generac Power':        { lbl:'Generac',            c:COL.gen,  src:'p', floor:25, note:'eGauge · under 25 W shown as 0' },
  'PV (measured)':        { lbl:'Solar PV',           c:COL.pv,   src:'s', key:'pv',   note:'inverter' },
  'Battery power':        { lbl:'Battery',            c:COL.batt, src:'s', key:'batt', signed:true, note:'inverter · charging +, discharging −' },
  'Grid flow (inverter)': { lbl:'Inverter grid port', c:COL.grid, src:'s', key:'grid', signed:true, note:'inverter · import +, export −' },
  'House load':           { lbl:'Inverter load',      c:COL.load, src:'s', key:'load', note:'loads behind the inverter' },
  'Battery SOC':          { lbl:'State of charge',    c:COL.batt, src:'s', key:'soc',  unit:'%', note:'inverter' },
}
const LOAD_ORDER = ['Panel1 (HVAC)', 'Panel2 (H2O)', 'Panel3 (Kitchen)', 'Shop']
const tsMs = ts => { const s=String(ts).replace(' ','T'); return Date.parse(/[zZ]$|[+-]\\d\\d:\\d\\d$/.test(s)?s:s+'Z') }
let CHART_END = Date.now()
const chartWindow = () => { const t1 = CHART_END; return { t0: t1 - CHART_MIN * 60000, t1 } }

function seriesPoints(name, rows, sol) {
  const s = SER[name]
  let pts
  if (s.src === 'p') {
    pts = (rows || []).filter(r => r.nm === name).map(r => {
      let v = r.w == null ? NaN : Number(r.w)
      let a = isFinite(+r.wmax) && r.wmax != null ? +r.wmax : v, b = isFinite(+r.wmin) && r.wmin != null ? +r.wmin : v
      let hi = Math.max(a, b), lo = Math.min(a, b)
      if (!s.signed) { const x = Math.abs(a), y = Math.abs(b); v = Math.abs(v); hi = Math.max(x, y); lo = a <= 0 && b >= 0 || b <= 0 && a >= 0 ? 0 : Math.min(x, y) }
      if (s.floor) { if (Math.abs(v) < s.floor) v = 0; if (Math.abs(hi) < s.floor) hi = 0; if (Math.abs(lo) < s.floor) lo = 0 }
      return { t: tsMs(r.ts), v, hi, lo }
    })
  } else {
    pts = (sol || []).map(r => {
      let v = r[s.key] == null ? NaN : Number(r[s.key])
      if (s.unit === '%') v = Math.min(100, Math.max(0, v)); else if (!s.signed) v = Math.max(0, v)
      return { t: tsMs(r.ts), v, hi: v, lo: v }
    })
  }
  return pts.filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t)
}

/* nice ticks + unit formatting */
const niceScale = SeriesAnalysis.niceScale
function powerAxis(sc) {
  const minus = s => s.replace('-', '−')
  if (Math.max(Math.abs(sc.lo), Math.abs(sc.hi)) < 1000) return { unit: 'W', f: v => minus(String(Math.round(v))) }
  const st = sc.step / 1000, isInt = v => Math.abs(v - Math.round(v)) < 1e-9
  const d = isInt(st) ? 0 : isInt(st * 10) ? 1 : 2
  return { unit: 'kW', f: v => v === 0 ? '0' : minus((v / 1000).toFixed(d)) }
}
const fSigned = v => (v < 0 ? '−' : v > 0 ? '+' : '') + fW(v)
const fPct = v => Math.round(v) + '%'
function fmtFor(name) { const s = SER[name]; return s.unit === '%' ? fPct : (s.signed ? fSigned : fW) }

/* Pacific-time ticks on clock boundaries (works across DST) */
const timeTicks = SeriesAnalysis.timeTicks
const ptHM = t => new Date(t).toLocaleTimeString('en-US', { timeZone: PT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const rangeLabel = m => m >= 60 ? (m / 60) + ' h' : m + ' min'

/* split a point list where the spacing jumps, so missing data reads as a gap */
function gapLimit(pts) {
  if (pts.length < 3) return Infinity
  const d = []
  for (let k = 1; k < pts.length; k++) d.push(pts[k].t - pts[k - 1].t)
  d.sort((a, b) => a - b)
  return Math.max(d[d.length >> 1] * 3, 30000)
}
function pathOf(pts, x, y, key) {
  const lim = gapLimit(pts); let d = ''
  pts.forEach((p, k) => {
    const brk = k === 0 || p.t - pts[k - 1].t > lim
    d += (brk ? 'M' : 'L') + x(p.t).toFixed(1) + ',' + y(p[key || 'v']).toFixed(1)
  })
  return d
}
function areaOf(pts, x, y, upKey, loKey) {
  const lim = gapLimit(pts), segs = []; let cur = []
  pts.forEach((p, k) => { if (k && p.t - pts[k - 1].t > lim) { segs.push(cur); cur = [] } cur.push(p) })
  if (cur.length) segs.push(cur)
  return segs.filter(s => s.length > 1).map(s => {
    let d = 'M' + s.map(p => x(p.t).toFixed(1) + ',' + y(typeof upKey === 'function' ? upKey(p) : p[upKey]).toFixed(1)).join(' L')
    for (let k = s.length - 1; k >= 0; k--) d += ' L' + x(s[k].t).toFixed(1) + ',' + y(typeof loKey === 'function' ? loKey(s[k]) : s[k][loKey]).toFixed(1)
    return d + ' Z'
  }).join(' ')
}

const CHARTS = {}
/* cfg: { t0, t1, H, unit:'power'|'%', stack:[{name,pts}], lines:[{name,pts}], band:bool,
          yLo, yHi, minSpan, group, marks:[{t,title}], empty:'text', compact:bool } */
function drawTimeChart(id, cfg) {
  const svg = $(id); if (!svg) return null
  const W = Math.max(240, Math.round(svg.parentElement.clientWidth || 640)), H = cfg.H
  const L = cfg.compact ? 44 : 52, R = cfg.compact ? 8 : 12, T = cfg.compact ? 8 : 10, B = 20
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
  svg.style.height = H + 'px'
  const { t0, t1 } = cfg
  svg.dataset.windowStart=t0;svg.dataset.windowEnd=t1
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R)
  // stack rows aligned on timestamps
  let stackRows = []
  if (cfg.stack && cfg.stack.length) {
    const maps = cfg.stack.map(s => new Map(s.pts.map(p => [p.t, p.v])))
    const ts = Array.from(new Set(cfg.stack.flatMap(s => s.pts.map(p => p.t)))).sort((a, b) => a - b)
    stackRows = ts.filter(t => maps.every(m => m.has(t))).map(t => {
      let acc = 0; const cum = maps.map(m => (acc += Math.max(0, m.get(t))))
      return { t, cum, v: acc }
    })
  }
  let sc
  if (cfg.unit === '%') sc = { lo: 0, hi: 100, step: 50, ticks: [0, 50, 100] }
  else {
    let lo = 0, hi = 0
    ;(cfg.lines || []).forEach(s => s.pts.forEach(p => { if (p.t < t0 || p.t > t1) return
      lo = Math.min(lo, cfg.band ? p.lo : p.v); hi = Math.max(hi, cfg.band ? p.hi : p.v) }))
    stackRows.forEach(r => { if (r.t >= t0) hi = Math.max(hi, r.v) })
    if (cfg.yLo != null) lo = Math.min(lo, cfg.yLo)
    if (cfg.yHi != null) hi = Math.max(hi, cfg.yHi)
    const ms = cfg.minSpan || 500
    if (hi - lo < ms) { if (lo < 0 && hi > 0) { hi = Math.max(hi, ms / 2); lo = Math.min(lo, -ms / 2) } else if (lo < 0) lo = hi - ms; else hi = lo + ms }
    sc = niceScale(lo, hi, cfg.compact ? 3 : 4)
  }
  const ax = cfg.unit === '%' ? { unit: '%', f: v => String(v) } : powerAxis(sc)
  const y = v => T + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - T - B)
  const fs = cfg.compact ? 9 : 10
  let o = '<g font-family="JetBrains Mono" font-size="' + fs + '" fill="' + INK.axis + '">'
  sc.ticks.forEach(v => {
    o += '</g><line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="' + (v === 0 && sc.lo < 0 ? INK.rule : INK.grid) + '" stroke-width="1"/>'
    const top = v === sc.ticks[sc.ticks.length - 1]
    o += '<text x="' + (L - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end"' + (top ? ' font-weight="600"' : '') + '>' +
      ax.f(v) + (top ? (ax.unit === '%' ? '%' : ' ' + ax.unit) : '') + '</text>'
  })
  const tt = timeTicks(t0, t1, Math.max(2, Math.floor((W - L - R) / (cfg.compact ? 70 : 90))))
  tt.forEach(t => {
    const px = x(t); if (px < L - 1 || px > W - R + 1) return
    o += '<line x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + (H - B) + '" y2="' + (H - B + 3) + '" stroke="' + INK.rule + '"/>'
    o += '<text x="' + px.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + ptHM(t) + '</text>'
  })
  o += '</g>'
  o += '<defs><clipPath id="'+id+'-clip"><rect x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'"/></clipPath></defs><g clip-path="url(#'+id+'-clip)">'
  // stacked areas: 1px surface gap between bands
  if (stackRows.length > 1) {
    cfg.stack.forEach((s, i) => {
      const d = areaOf(stackRows, x, y, r => r.cum[i], r => i ? r.cum[i - 1] : 0)
      o += '<path d="' + d + '" fill="' + SER[s.name].c + '" fill-opacity=".78" stroke="#fff" stroke-width="1"/>'
    })
  }
  ;(cfg.lines || []).forEach(s => {
    const c = SER[s.name].c
    if (cfg.band && s.pts.length > 1 && s.pts.some(p => p.hi !== p.lo)) o += '<path d="' + areaOf(s.pts, x, y, 'hi', 'lo') + '" fill="' + c + '" opacity=".16"/>'
    if (s.pts.length > 1) o += '<path d="' + pathOf(s.pts, x, y) + '" stroke="' + c + '" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>'
  })
  ;(cfg.marks || []).forEach(m => {
    const mx = x(m.t); if (mx < L || mx > W - R) return
    o += '<g><title>' + safeText(m.title) + '</title><line x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#a64f3a" stroke-width="1"/>' +
      '<circle cx="' + mx.toFixed(1) + '" cy="' + (T + 3) + '" r="3.5" fill="#a64f3a" stroke="#fff" stroke-width="2"/></g>'
  })
  const hasData = stackRows.length > 1 || (cfg.lines || []).some(s => s.pts.some(p => p.t >= t0))
  if (!hasData) o += '<text x="' + ((L + W - R) / 2) + '" y="' + ((T + H - B) / 2) + '" text-anchor="middle" font-size="11" fill="' + INK.axis + '">' + (cfg.empty || 'No data in this window') + '</text>'
  o += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="' + INK.rule + '"/>'
  o += '<g class="xh"></g>'
  svg.innerHTML = o
  const meta = { id, W, H, L, R, T, B, t0, t1, x, y, group: cfg.group, stack: cfg.stack || [], stackRows, lines: cfg.lines || [] }
  CHARTS[id] = meta
  return meta
}

/* hover: crosshair on every chart in the group, readout in the one under the pointer */
function nearest(pts, t, tol) {
  if (!pts.length) return null
  let lo = 0, hi = pts.length - 1
  while (hi - lo > 1) { const m = (lo + hi) >> 1; pts[m].t < t ? lo = m : hi = m }
  const p = Math.abs(pts[lo].t - t) <= Math.abs(pts[hi].t - t) ? pts[lo] : pts[hi]
  return Math.abs(p.t - t) <= tol ? p : null
}
function crossAll(group, t) {
  Object.values(CHARTS).forEach(m => {
    if (m.group !== group) return
    const g = document.querySelector('#' + m.id + ' .xh'); if (!g) return
    if (t == null || t < m.t0 || t > m.t1) { g.innerHTML = ''; return }
    const px = m.x(t).toFixed(1)
    g.innerHTML = '<line x1="' + px + '" x2="' + px + '" y1="' + m.T + '" y2="' + (m.H - m.B) + '" stroke="#182230" stroke-width="1" opacity=".55"/>'
  })
}
function hoverRows(m, t) {
  const sample=m.stackRows.length?m.stackRows:((m.lines[0]||{}).pts||[]),tol=Math.min(900000,Math.max(60000,gapLimit(sample)/3))
  let h = ''
  if (m.stackRows.length) {
    const r = nearest(m.stackRows, t, tol)
    if (r) {
      for (let i = m.stack.length - 1; i >= 0; i--) {
        const n = m.stack[i].name
        h += '<div class="tr"><span class="sw" style="background:' + SER[n].c + '"></span>' + SER[n].lbl + ' · <b>' + fW(r.cum[i] - (i ? r.cum[i - 1] : 0)) + '</b></div>'
      }
      h += '<div class="tr" style="border-top:1px solid #475467;margin-top:2px;padding-top:2px">Metered demand · <b>' + fW(r.v) + '</b></div>'
    }
  }
  m.lines.forEach(s => {
    const p = nearest(s.pts, t, tol); if (!p) return
    const f = fmtFor(s.name)
    h += '<div class="tr"><span class="sw" style="background:' + SER[s.name].c + '"></span>' + SER[s.name].lbl + ' · <b>' + f(p.v) + '</b>' +
      (p.hi !== p.lo && SER[s.name].unit !== '%' ? ' <span style="opacity:.7">(' + f(p.lo) + ' to ' + f(p.hi) + ')</span>' : '') + '</div>'
  })
  return h
}
function attachHover(wrap) {
  if (!wrap || wrap.__hover) return
  wrap.__hover = true
  const svg = wrap.querySelector('svg'), tip = wrap.querySelector('.chart-tip')
  wrap.addEventListener('pointermove', e => {
    const m = CHARTS[svg.id]; if (!m) return
    const rect = wrap.getBoundingClientRect(), fx = (e.clientX - rect.left) / rect.width * m.W
    if (fx < m.L || fx > m.W - m.R) { tip.style.display = 'none'; crossAll(m.group, null); return }
    const t = m.t0 + (fx - m.L) / (m.W - m.L - m.R) * (m.t1 - m.t0)
    crossAll(m.group, t)
    const rows = hoverRows(m, t)
    if (!rows) { tip.style.display = 'none'; return }
    tip.innerHTML = '<div class="tt">' + new Date(t).toLocaleTimeString('en-US', { timeZone: PT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' PT</div>' + rows
    tip.style.display = 'block'
    const tx = e.clientX - rect.left, flip = tx > rect.width * 0.6
    tip.style.left = flip ? '' : (tx + 14) + 'px'
    tip.style.right = flip ? (rect.width - tx + 14) + 'px' : ''
    tip.style.top = Math.max(2, Math.min(rect.height - tip.offsetHeight - 2, e.clientY - rect.top - 20)) + 'px'
  })
  wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; const m = CHARTS[svg.id]; if (m) crossAll(m.group, null) })
}

/* ── Combined power + solar + battery chart ───────────────────────────────
   One chart, three quantities that only mean anything together:
     upper plot : panel watts (left axis) + measured PV (gold area)
                  + battery state of charge (right axis, %)
     lower lane : battery power signed around its own midline,
                  charging above in green, discharging below in red
   Power comes from energy_readings, solar/battery from solar_data; both are
   fetched over the SAME window so the two x axes actually line up. ── */
let PWR_ROWS = null, SOL_ROWS = null, CHART_MIN = 30, LAST_P = {}
var LAST_SNAP = null
function liveW(name) { const row=LAST_SNAP?.snap[name];return row?.w!=null && Number.isFinite(Number(row.w)) && Date.now()-tsMs(row.ts)<120000 ? Number(row.w):null }
const SERIES_OFF = {}

// Keep a local copy of the header controls beside the chart, with shared filter state.
const localGraphCards = Array.from(document.querySelectorAll('.kpis [data-series]')).map(source => {
  const card = source.cloneNode(true)
  card.classList.remove('kpi'); card.classList.add('extra-card')
  card.removeAttribute('id')
  card.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
  $('pwr-more-cards').appendChild(card)
  return { source, card }
})
function syncLocalGraphValues() {
  localGraphCards.forEach(({source, card}) => {
    card.querySelector('.val').textContent = source.querySelector('.val').textContent
    card.querySelector('.hint').textContent = source.querySelector('.hint').textContent
  })
}
function setGraphCardsExpanded(expanded) {
  $('pwr-more-cards').hidden = !expanded
  $('pwr-collapse').hidden = !expanded
  $('pwr-reset').setAttribute('aria-expanded', String(expanded))
}
$('pwr-collapse').onclick = () => setGraphCardsExpanded(false)
const graphCards = Array.from(document.querySelectorAll('[data-series]'))
graphCards.forEach(card=>{if(SER[card.dataset.series])card.style.setProperty('--c',SER[card.dataset.series].c)})
function syncGraphCards() {
  graphCards.forEach(card => {
    const shown = !SERIES_OFF[card.dataset.series]
    card.setAttribute('aria-pressed', String(shown))
    card.querySelector('.filter-status').textContent = shown ? 'Shown' : 'Hidden'
    card.setAttribute('aria-label', card.dataset.series + ': ' + (shown ? 'shown, click to hide' : 'hidden, click to show'))
  })
  const names = Array.from(new Set(graphCards.map(card => card.dataset.series)))
  const n = names.filter(name => !SERIES_OFF[name]).length
  $('pwr-selection').textContent = n === names.length
    ? 'Select a card to show or hide its series.' : n + ' of ' + names.length + ' series shown · Select cards to adjust.'
}
graphCards.forEach(card => card.addEventListener('click', () => {
  SERIES_OFF[card.dataset.series] = !SERIES_OFF[card.dataset.series]
  syncGraphCards(); renderAllCharts()
}))
$('pwr-reset').onclick = () => {
  setGraphCardsExpanded(true)
  Object.keys(SERIES_OFF).forEach(name => delete SERIES_OFF[name])
  syncGraphCards(); renderAllCharts()
}
syncGraphCards()

function setDssCollapsed(collapsed) {
  $('general-grid').classList.toggle('dss-collapsed', collapsed)
  $('dss-content').hidden = collapsed
  $('dss-toggle').setAttribute('aria-expanded', String(!collapsed))
  $('dss-toggle').setAttribute('aria-label', (collapsed ? 'Expand' : 'Collapse') + ' recommended next steps')
  $('dss-toggle').querySelector('.dss-toggle-label').textContent = collapsed ? 'Next steps' : 'Collapse'
  try { localStorage.setItem('iems-dss-collapsed', String(collapsed)) } catch (_) {}
}
$('dss-toggle').onclick = () => setDssCollapsed(!$('dss-content').hidden)
try { setDssCollapsed(localStorage.getItem('iems-dss-collapsed') === 'true') } catch (_) {}


function niceCeil(v) {
  if (v <= 0) return 1000
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}


let HISTORY_LOAD=0
async function loadChartData() {
  const version=++HISTORY_LOAD
  const [rows, sol] = await Promise.all([
    fetch('/api/history?minutes=' + CHART_MIN).then(r => r.json()).catch(() => null),
    fetch('/api/solar-history?minutes=' + CHART_MIN).then(r => r.json()).catch(() => null),
  ])
  if(version!==HISTORY_LOAD)return
  if (Array.isArray(rows)) PWR_ROWS = rows
  SOL_ROWS = (sol && sol.length) ? sol : null
  renderAllCharts()
  refreshDetail().catch(() => {})
}

async function pollHistory() {
  try { await loadChartData() } catch {}
  setTimeout(pollHistory, 10000)
}

document.querySelectorAll('#pwr-range button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#pwr-range button').forEach(x => x.classList.remove('active'))
    b.classList.add('active')
    CHART_MIN = Number(b.dataset.min)
    loadChartData().catch(() => {})
  }
})

function toggleSeries(name){SERIES_OFF[name]=!SERIES_OFF[name];syncGraphCards();renderAllCharts()}
function legendHtml(names) {
  return names.map(n => '<button type="button" class="lg' + (SERIES_OFF[n] ? ' off' : '') + '" data-toggle="' + n + '" aria-pressed="' + !SERIES_OFF[n] + '">' +
    '<span class="lg-sw" style="background:' + SER[n].c + '"></span>' + SER[n].lbl + '</button>').join('')
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-toggle]')
  if (b) toggleSeries(b.dataset.toggle)
})

// energy and cost over a point list, cutting across data gaps rather than bridging them
function integrate(pts, fn, from=chartWindow().t0, to=chartWindow().t1) {
  const lim=gapLimit(pts);let acc=0,hours=0
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1],b=pts[i],dt=b.t-a.t
    if(dt<=0||dt>lim||!Number.isFinite(a.v)||!Number.isFinite(b.v))continue
    const start=Math.max(a.t,from),end=Math.min(b.t,to);if(end<=start)continue
    const value=t=>a.v+(b.v-a.v)*(t-a.t)/dt,cuts=[start,end]
    if(a.v*b.v<0){const zero=a.t-a.v*dt/(b.v-a.v);if(zero>start&&zero<end)cuts.push(zero)}
    for(let t=Math.floor(start/3600000+1)*3600000;t<end;t+=3600000)cuts.push(t)
    cuts.sort((a,b)=>a-b)
    for(let j=1;j<cuts.length;j++){const l=cuts[j-1],r=cuts[j],h=(r-l)/3600000,mid=(l+r)/2;acc+=(fn(value(l),mid)+fn(value(r),mid))/2*h;hours+=h}
  }
  return {acc,hours}
}
const rateAt = t => classifyTOU(ptWall(new Date(t))).r

function renderCombined() {
  syncLocalGraphValues()
  const { t0, t1 } = chartWindow()
  const rows = PWR_ROWS || [], sol = SOL_ROWS || []
  const P = {}
  Object.keys(SER).forEach(n => { P[n] = seriesPoints(n, rows, sol).filter(p => p.t <= t1) })
  LAST_P = P

  // 1. demand stack + utility grid
  const stackN = LOAD_ORDER.filter(n => !SERIES_OFF[n] && P[n].length > 1)
  const lineN1 = ['Grid Power', 'Generac Power'].filter(n => !SERIES_OFF[n] && P[n].length > 1 && (n !== 'Generac Power' || P[n].some(p => p.v !== 0)))
  const m1 = drawTimeChart('pwr-load', { t0, t1, H: 210, group: 'pwr', stack: stackN.map(n => ({ name: n, pts: P[n] })),
    lines: lineN1.map(n => ({ name: n, pts: P[n] })), minSpan: 1000,
    empty: LOAD_ORDER.concat(['Grid Power','Generac Power']).some(n=>!SERIES_OFF[n]) ? 'No eGauge data in this window' : 'All demand series hidden · use the cards above or Show all' })
  $('lg-load').innerHTML = legendHtml(LOAD_ORDER.concat(['Grid Power', 'Generac Power']))
  // 2. inverter view
  const lineN2 = ['PV (measured)', 'Battery power', 'Grid flow (inverter)', 'House load'].filter(n => !SERIES_OFF[n])
  drawTimeChart('pwr-src', { t0, t1, H: 180, group: 'pwr', lines: lineN2.map(n => ({ name: n, pts: P[n] })), minSpan: 1000,
    empty: lineN2.length ? 'No Solar Assistant data in this window' : 'All inverter series hidden · use the cards above or Show all' })
  $('lg-src').innerHTML = legendHtml(['PV (measured)', 'Battery power', 'Grid flow (inverter)', 'House load'])
  // 3. state of charge strip
  const socOn = !SERIES_OFF['Battery SOC']
  $('pc-soc').hidden = !socOn
  if (socOn) drawTimeChart('pwr-soc', { t0, t1, H: 84, unit: '%', group: 'pwr', lines: [{ name: 'Battery SOC', pts: P['Battery SOC'] }] })
  ;['pwr-load', 'pwr-src', 'pwr-soc'].forEach(id => attachHover($(id) && $(id).parentElement))

  // inverter cards show the latest reading
  const last = n => { const a = P[n]; return a && a.length ? a[a.length - 1].v : null }
  const setCard = (id, n) => { const v = last(n); $(id).textContent = v == null ? '—' : fmtFor(n)(v) }
  setCard('filter-load', 'House load'); setCard('filter-grid', 'Grid flow (inverter)'); setCard('filter-batt', 'Battery power')

  // stats: whole metered demand, independent of the filters
  const maps = LOAD_ORDER.map(n => new Map(P[n].map(p => [p.t, p.v])))
  const dem = Array.from(new Set(LOAD_ORDER.flatMap(n => P[n].map(p => p.t)))).sort((a, b) => a - b)
    .filter(t => t >= t0 && maps.every(m => m.has(t))).map(t => ({ t, v: maps.reduce((a, m) => a + m.get(t), 0) }))
  const ids = ['stat-sum', 'stat-kwh', 'stat-peak', 'stat-avg']
  if (!dem.length) {
    ids.forEach(id => { $(id).textContent = '—' }); $('stat-peak-at').textContent = ''
  } else {
    const e = integrate(dem, v => v)
    const pk = dem.reduce((a, p) => p.v > a.v ? p : a, dem[0])
    const live = LOAD_ORDER.map(liveW)
    $('stat-sum').textContent = fW(live.every(v => v != null) ? live.reduce((a, v) => a + Math.abs(v), 0) : dem[dem.length - 1].v)
    $('stat-kwh').textContent = (e.acc / 1000).toFixed(e.acc >= 10000 ? 1 : 2) + ' kWh'
    $('stat-peak').textContent = fW(pk.v)
    $('stat-peak-at').textContent = 'at ' + ptHM(pk.t) + ' PT'
    $('stat-avg').textContent = e.hours ? fW(e.acc / e.hours) : '—'
  }
  $('stat-kwh-lbl').textContent = 'Energy · ' + rangeLabel(CHART_MIN)
  renderCosts(P, t0)
  const newest = Math.max(...['Grid Power', 'PV (measured)'].map(n => P[n].length ? P[n][P[n].length - 1].t : 0))
  $('pwr-age').textContent = newest ? 'data to ' + ptHM(newest) + ' PT' : 'no data'

  const marks = (ANOM_ROWS || []).map(a => ({ t: tsMs(a.ts), a })).filter(k => k.t >= t0 && k.t <= t1)
  renderPowerAlerts(marks, t0, t1, m1 ? m1.W : 640, m1 ? m1.L : 46, m1 ? m1.R : 12)
}

function renderCosts(P, t0) {
  const g = P['Grid Power'], pv = P['PV (measured)']
  const rateNow = rateAt(Date.now())
  const gLive = liveW('Grid Power')
  const gNow = gLive != null ? gLive : (g.length ? g[g.length - 1].v : null)
  if (gNow == null) { $('cost-now').textContent = '—'; $('cost-now-sub').textContent = 'no utility meter data' }
  else if (gNow > 0) {
    $('cost-now').textContent = '$' + (gNow / 1000 * rateNow).toFixed(2) + '/h'
    $('cost-now-sub').textContent = 'importing ' + fW(gNow) + ' at $' + rateNow.toFixed(2) + '/kWh'
  } else {
    $('cost-now').textContent = '$0.00/h'
    $('cost-now-sub').textContent = 'exporting ' + fW(gNow) + ' · rate now $' + rateNow.toFixed(2) + '/kWh'
  }
  const imp = integrate(g, (v, t) => Math.max(0, v) / 1000 * rateAt(t))
  const impKwh = integrate(g, v => Math.max(0, v) / 1000).acc
  const expKwh = integrate(g, v => Math.max(0, -v) / 1000).acc
  const pvEnergy=integrate(pv,v=>v/1000),pvE=pvEnergy.acc,pvV=integrate(pv,(v,t)=>v/1000*rateAt(t)).acc
  $('cost-imp').textContent = imp.hours > 0 ? '$' + imp.acc.toFixed(2) : '—'
  $('cost-imp-sub').textContent = imp.hours > 0 ? impKwh.toFixed(2) + ' kWh imported · ' + rangeLabel(CHART_MIN) : 'no utility meter data'
  $('cost-exp').textContent = imp.hours > 0 ? expKwh.toFixed(2) + ' kWh' : '—'
  $('cost-exp-sub').textContent = 'credit depends on the NEM plan · ' + rangeLabel(CHART_MIN)
  $('cost-pv').textContent = pvEnergy.hours > 0 ? '$' + pvV.toFixed(2) : '—'
  $('cost-pv-sub').textContent = pvEnergy.hours > 0 ? pvE.toFixed(2) + ' kWh produced, valued at TOU rates' : 'no inverter data'
}

function renderPowerAlerts(marks, tMin, tMax, W, L, R) {
  const svg = $('pwr-alert-timeline')
  svg.setAttribute('viewBox', '0 0 ' + W + ' 32')
  const x = t => L + (t - tMin) / (tMax - tMin) * (W - L - R)
  svg.innerHTML = '<line x1="' + L + '" x2="' + (W - R) + '" y1="16" y2="16" stroke="#d0d5dd"/>' + marks.map(k => {
    const px = x(k.t).toFixed(1)
    return '<g><title>' + safeText(ptTime(k.a.ts) + ' PT · ' + String(k.a.entity || '') + ' · ' + String(k.a.message || k.a.atype || 'Power alert')) + '</title><line x1="' + px + '" x2="' + px + '" y1="5" y2="27" stroke="#a64f3a"/><circle cx="' + px + '" cy="16" r="3.5" fill="#a64f3a" stroke="#fff" stroke-width="2"/></g>'
  }).join('')
  $('pwr-alert-count').textContent = marks.length ? marks.length + ' in this window · Pacific time' : 'No alerts in this window'
  $('pwr-alert-list').innerHTML = marks.slice().sort((a,b) => b.t-a.t).map(k => '<div class="power-alert-row"><time>' + safeText(ptTime(k.a.ts)) + ' PT</time><span>' + safeText(k.a.entity || 'Power') + ' · ' + safeText(k.a.message || k.a.atype || 'Power alert') + '</span></div>').join('')
}
const renderPwrGraph = renderCombined

function renderAllCharts() {
  CHART_END=Date.now()
  try { renderCombined() } catch (e) { console.error(e) }
  try { if($('day-grid') && typeof DETAIL_VIEW!=='undefined')renderDetail() } catch (e) { console.error(e) }
  try { drawNilm() } catch (e) { console.error(e) }
  try { renderTOU() } catch (e) { console.error(e) }
}
let RESIZE_T = null, LAST_W = 0
if (window.ResizeObserver) new ResizeObserver(() => {
  const w = $('general-grid').clientWidth; if (w === LAST_W) return; LAST_W = w
  clearTimeout(RESIZE_T); RESIZE_T = setTimeout(renderAllCharts, 120)
}).observe($('general-grid'))

/* ── Every series + NILM strip + anomalies, all following the power chart's range buttons ── */
var ANOM_ROWS = []
const DAY_SERIES = Object.entries(SER).map(([name,s])=>({...s,name,key:name,label:s.lbl,unit:s.unit||'W'}))
let SHARED_PANEL_SCALE=true
try{SHARED_PANEL_SCALE=localStorage.getItem('iems-shared-scale')!=='false'}catch(_){}
$('shared-scale').checked=SHARED_PANEL_SCALE
$('shared-scale').onchange=e=>{SHARED_PANEL_SCALE=e.target.checked;try{localStorage.setItem('iems-shared-scale',String(SHARED_PANEL_SCALE))}catch(_){};renderDetail()}
function dayPoints(s,p,sol){return seriesPoints(s.name,p,sol)}

const DETAIL_VIEW = {expanded:null,closed:{},instances:{}}
$('detail-toggle').onclick = () => {
  const content=$('detail-content'),collapsed=!content.hidden
  content.hidden=collapsed
  $('detail-toggle').setAttribute('aria-expanded',String(!collapsed))
  $('detail-toggle').textContent=collapsed?'Expand series':'Collapse series'
}
window.addEventListener('message', event => {
  const frame=$('forecast-frame')
  if(event.origin!==location.origin || event.source!==frame.contentWindow || event.data?.type!=='iems-forecast-height')return
  const height=Number(event.data.height)
  if(Number.isFinite(height)&&height>=300&&height<=20000)frame.style.height=Math.ceil(height)+'px'
})
function renderDetail() {
  const {t0,t1}=chartWindow()
  const grid = $('day-grid')
  if(grid && !grid.querySelector('.day-top')) {
    grid.innerHTML=DAY_SERIES.map((s,i)=>'<section class="day-card" data-index="'+i+'" style="--series-color:'+s.c+'"><div class="day-top"><button type="button" class="day-collapse" aria-expanded="true" aria-controls="day-body-'+i+'">'+safeText(s.label)+'</button><button type="button" class="day-enlarge" aria-pressed="false" aria-controls="day-body-'+i+'" aria-label="Enlarge '+safeText(s.label)+'">Enlarge</button></div><div class="day-summary"></div><div class="day-body" id="day-body-'+i+'"><div class="day-mini-wrap chart-wrap"><svg class="day-mini" id="day-mini-'+i+'" role="img" aria-label="'+safeText(s.label)+' overview"></svg><div class="chart-tip"></div></div><div class="day-analysis" hidden></div></div></section>').join('')
    grid.querySelectorAll('.day-card').forEach(card=>{
      const i=Number(card.dataset.index)
      card.querySelector('.day-collapse').onclick=()=>{
        DETAIL_VIEW.closed[i]=!DETAIL_VIEW.closed[i]
        if(DETAIL_VIEW.closed[i]&&DETAIL_VIEW.expanded===i)DETAIL_VIEW.expanded=null
        renderDetail()
      }
      card.querySelector('.day-enlarge').onclick=()=>{
        DETAIL_VIEW.expanded=DETAIL_VIEW.expanded===i?null:i
        DETAIL_VIEW.closed[i]=false;renderDetail()
        if(DETAIL_VIEW.expanded===i)card.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})
      }
    })
  }
  const panelHi=Math.max(200,...LOAD_ORDER.flatMap(name=>seriesPoints(name,PWR_ROWS,SOL_ROWS).filter(p=>p.t>=t0&&p.t<=t1).map(p=>p.hi)))
  if(grid) DAY_SERIES.forEach((s,i)=>{
    const card=grid.querySelector('[data-index="'+i+'"]'),large=DETAIL_VIEW.expanded===i,closed=!!DETAIL_VIEW.closed[i]
    card.hidden=!!SERIES_OFF[s.name]
    if(card.hidden)return
    const shared=SHARED_PANEL_SCALE&&LOAD_ORDER.includes(s.name)
    const pts=dayPoints(s,PWR_ROWS,SOL_ROWS).filter(p=>p.t>=t0 && p.t<=t1)
    const finite=pts.filter(p=>Number.isFinite(p.v))
    const peak=finite.length?finite.reduce((a,b)=>b.hi>a.hi?b:a):null
    const fmt=v=>s.unit==='%'?v.toFixed(1)+'%':s.signed?fSigned(v):fW(v)
    const current=s.src==='p'?liveW(s.name):null
    card.querySelector('.day-summary').textContent=finite.length?'Now '+fmt(current===null?finite[finite.length-1].v:(s.floor&&Math.abs(current)<s.floor?0:s.signed?current:Math.abs(current)))+' · Average '+fmt(finite.reduce((sum,p)=>sum+p.v,0)/finite.length)+' · Peak '+fmt(peak.hi)+' at '+ptHM(peak.t)+' PT':'No data in this window'
    card.classList.toggle('expanded',large)
    card.querySelector('.day-body').hidden=closed
    card.querySelector('.day-collapse').setAttribute('aria-expanded',String(!closed))
    const enlarge=card.querySelector('.day-enlarge')
    enlarge.textContent=large?'Compact':'Enlarge';enlarge.setAttribute('aria-pressed',String(large));enlarge.setAttribute('aria-label',(large?'Compact ':'Enlarge ')+s.label)
    const mini=card.querySelector('.day-mini'),analysis=card.querySelector('.day-analysis')
    mini.parentElement.hidden=large;mini.toggleAttribute('hidden',large);analysis.hidden=!large
    const events=ANOM_ROWS.filter(a=>String(a.entity||'').trim()===s.key).map(a=>({t:tsMs(a.ts),title:ptShort(a.ts)+' PT · '+String(a.message||a.atype).trim()}))
    if(!large&&!closed){drawTimeChart(mini.id,{t0,t1,H:118,compact:true,band:s.src==='p',group:'day',unit:s.unit==='%'?'%':'power',lines:[{name:s.name,pts}],yHi:shared?panelHi:null,minSpan:s.floor?1000:200,marks:events});attachHover(mini.parentElement)}
    if(large&&!closed&&window.SeriesAnalysis){
      const config={name:s.label,unit:s.unit||'W',color:s.c,start:t0,end:t1,rangeKey:CHART_MIN,features:pts,includeZero:s.unit!=='%',bounds:s.unit==='%'?[0,100]:null,axisMax:shared?panelHi:null,events,
        tracks:[{id:s.key,color:s.c,points:pts,band:true}]}
      if(!DETAIL_VIEW.instances[i])DETAIL_VIEW.instances[i]=new SeriesAnalysis.Chart(analysis,config)
      else DETAIL_VIEW.instances[i].update(config)
    }
  })
  $('day-hidden').textContent=Object.values(SERIES_OFF).filter(Boolean).length+' series hidden · Show all restores them'
  const lst = $('day-anom-list'); if (lst) lst.innerHTML = evRows(ANOM_ROWS)
  const tg = $('day-anom-tag')
  if (tg) { tg.textContent = ANOM_ROWS.length + ' in ' + rangeLabel(CHART_MIN); tg.style.color = ANOM_ROWS.length ? 'var(--bad)' : 'var(--ok)' }
  const age = $('day-age'); if (age) age.textContent = rangeLabel(CHART_MIN) + ' · updated ' + ptNow() + ' PT'
}

let NILM_DATA = null, NILM_SHOW_IDLE = false
const NILM_META = Object.fromEntries(NILM_APPLIANCES.map(a => [a.key, a]))
async function renderNilmRange() {
  const range = CHART_MIN
  let d
  try { d = await fetch('/api/nilm-24h?minutes=' + range).then(r => r.json()) } catch (e) { return }
  if (range !== CHART_MIN || !d || !d.appliances) return
  NILM_DATA = d
  drawNilm()
}
function drawNilm() {
  const d = NILM_DATA, svg = $('nilm24'); if (!svg || !d) return
  const { t0, t1 } = chartWindow()
  const W = Math.max(300, Math.round(svg.parentElement.clientWidth || 640)), L = 150, R = 12
  const rowH = 16, panelH = 34, gapH = 10, T = 4, B = 22
  const x = t => L + (t - t0) / (t1 - t0) * (W - L - R)
  const bucket = (d.bucket_min || 1) * 60000
  const bw = Math.max(1.5, (W - L - R) * bucket / (t1 - t0) - 1)
  const apps = d.appliances.map(a => {
    const cells = a.cells.map(c => ({ t: tsMs(c.ts), on: +c.on || 0 })).filter(c => c.t >= t0 - bucket && c.t <= t1)
    const meta = NILM_META[a.appliance] || {}
    return { key: a.appliance, label: meta.label || a.appliance.replace(/_/g, ' '), circuit: meta.circuit || 'Panel3 (Kitchen)',
      cells, onMin: cells.reduce((s, c) => s + c.on, 0) * (d.bucket_min || 1) }
  })
  let y = T, o = '', idleTotal = 0, hiddenPanels = 0
  const groups = LOAD_ORDER.map(n => ({ n, apps: apps.filter(a => a.circuit === n).sort((a, b) => b.onMin - a.onMin) }))
  groups.forEach(g => {
    if (!g.apps.length) return
    if (SERIES_OFF[g.n]) { hiddenPanels++; return }
    const s = SER[g.n], pts = (LAST_P[g.n] || []).filter(p => p.t >= t0)
    // panel power strip
    const pmax = niceCeil(Math.max(200, ...pts.map(p => p.v)))
    const py = v => y + panelH - 4 - v / pmax * (panelH - 8)
    o += '<text x="' + (L - 8) + '" y="' + (y + 14) + '" text-anchor="end" font-size="11" font-weight="700" fill="' + INK.text + '">' + s.lbl + ' panel</text>'
    o += '<text x="' + (L - 8) + '" y="' + (y + 27) + '" text-anchor="end" font-size="9" fill="' + INK.axis + '" font-family="JetBrains Mono">0–' + fW(pmax) + '</text>'
    o += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (y + panelH - 4) + '" y2="' + (y + panelH - 4) + '" stroke="' + INK.grid + '"/>'
    if (pts.length > 1) {
      o += '<path d="' + areaOf(pts, x, py, 'v', () => 0) + '" fill="' + s.c + '" fill-opacity=".22"/>'
      o += '<path d="' + pathOf(pts, x, py) + '" stroke="' + s.c + '" stroke-width="1.5" fill="none"/>'
    }
    y += panelH
    const active = g.apps.filter(a => a.onMin > 0), idle = g.apps.filter(a => a.onMin === 0)
    idleTotal += idle.length
    const rowsToDraw = NILM_SHOW_IDLE ? active.concat(idle) : active
    rowsToDraw.forEach(a => {
      o += '<text x="' + (L - 8) + '" y="' + (y + 11.5) + '" text-anchor="end" font-size="10.5" fill="' + (a.onMin ? INK.text : INK.axis) + '">' + safeText(a.label) +
        '</text><line x1="' + L + '" x2="' + (W - R) + '" y1="' + (y + rowH - 0.5) + '" y2="' + (y + rowH - 0.5) + '" stroke="' + INK.grid + '"/>'
      a.cells.forEach(c => {
        if (!(c.on > 0)) return
        const cx = Math.max(L, x(c.t)), w = Math.min(bw, W - R - cx); if (w <= 0) return
        o += '<rect x="' + cx.toFixed(1) + '" y="' + (y + 2) + '" width="' + w.toFixed(1) + '" height="' + (rowH - 5) + '" rx="1.5" fill="#182230" fill-opacity="' +
          (0.15 + 0.85 * c.on).toFixed(2) + '"><title>' + safeText(a.label) + ' · ' + ptHM(c.t) + ' PT · on ' + Math.round(c.on * 100) + '% of the ' + d.bucket_min + ' min cell</title></rect>'
      })
      y += rowH
    })
    if (!NILM_SHOW_IDLE && idle.length) {
      o += '<text x="' + (L - 8) + '" y="' + (y + 11) + '" text-anchor="end" font-size="9.5" fill="' + INK.axis + '">+' + idle.length + ' idle</text>' +
        '<text x="' + L + '" y="' + (y + 11) + '" font-size="9.5" fill="' + INK.axis + '">' + safeText(idle.length+' idle appliances · expand to inspect') + '</text>'
      y += rowH
    }
    y += gapH
  })
  if (y === T) o += '<text x="' + ((L + W - R) / 2) + '" y="40" text-anchor="middle" font-size="11" fill="' + INK.axis + '">Every panel is hidden by the cards above</text>', y = 60
  const tt = timeTicks(t0, t1, Math.max(2, Math.floor((W - L - R) / 90)))
  o += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="' + INK.rule + '"/>'
  tt.forEach(t => { const px = x(t); if (px < L || px > W - R) return
    o += '<line x1="' + px.toFixed(1) + '" x2="' + px.toFixed(1) + '" y1="' + T + '" y2="' + y + '" stroke="' + INK.grid + '" stroke-opacity=".7"/>' +
      '<text x="' + px.toFixed(1) + '" y="' + (y + 15) + '" text-anchor="middle" font-size="10" font-family="JetBrains Mono" fill="' + INK.axis + '">' + ptHM(t) + '</text>' })
  const H = y + B
  svg.dataset.windowStart=t0;svg.dataset.windowEnd=t1
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
  svg.style.height = H + 'px'
  svg.innerHTML = '<g font-family="Inter, system-ui, sans-serif">' + o + '</g>'
  $('nilm24-age').textContent = apps.length + ' appliances · ' + d.bucket_min + ' min cells · ' + rangeLabel(CHART_MIN) + ' · PT'
  const btn = $('nilm-idle')
  btn.textContent = NILM_SHOW_IDLE ? 'Fold idle appliances' : 'Show idle appliances (' + idleTotal + ')'
  btn.hidden = !idleTotal && !NILM_SHOW_IDLE
  $('nilm-hidden').textContent = hiddenPanels ? hiddenPanels + ' panel' + (hiddenPanels > 1 ? 's' : '') + ' hidden by the cards above' : ''
}
$('nilm-idle').onclick = () => { NILM_SHOW_IDLE = !NILM_SHOW_IDLE; drawNilm() }

// Anomalies refresh every minute and the NILM strip every five, or at once
// when the range changes. The series come from the chart's own fetch.
const DETAIL = { range: null, anomAt: 0, nilmAt: 0 }
async function refreshDetail() {
  const range = CHART_MIN, now = Date.now(), changed = DETAIL.range !== range
  if (changed || now - DETAIL.anomAt > 60000) {
    DETAIL.anomAt = now
    try {
      const lg = await fetch('/api/logs?minutes=' + range).then(r => r.json())
      if (range !== CHART_MIN) return
      ANOM_ROWS = ((lg && lg.all) || []).filter(a => String(a.atype || '').trim() !== 'pipeline_verify')
      renderCombined()
    } catch (e) {}
  }
  renderDetail()
  if (changed || now - DETAIL.nilmAt > 300000) { DETAIL.nilmAt = now; renderNilmRange().catch(() => {}) }
  DETAIL.range = range
}
refreshDetail().catch(() => {})

/* ── Source / link status strip ── */
const SRC_ICONS = {
  ha: '<path d="M3 11 12 3l9 8"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
  pi: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="10" y="10" width="4" height="4"/>' +
      '<path d="M9 3v3.5M15 3v3.5M9 17.5V21M15 17.5V21M3 9h3.5M3 15h3.5M17.5 9H21M17.5 15H21"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>',
  panel: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M9 3v18"/><circle cx="15.5" cy="13" r="1.4"/>',
}
function srcGlyph(k) {
  return '<svg class="src-gly" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (SRC_ICONS[k] || '') + '</svg>'
}
function srcTile(icon, color, name, value, sub, cls) {
  return '<div class="src ' + (cls || '') + '" style="--sc:' + color + '">' + srcGlyph(icon) +
    '<div class="src-b"><div class="src-n">' + name + '</div>' +
    '<div class="src-v">' + value + '</div><div class="src-s">' + (sub || '') + '</div></div>' +
    '<div class="src-led"></div></div>'
}
const PANEL_COLORS = {
  'Grid Power': '#b85c2e', 'Panel1 (HVAC)': '#4a6b8a', 'Panel2 (H2O)': '#8a5a7a',
  'Panel3 (Kitchen)': '#5e8a5a', 'Shop': '#c89a3a', 'Generac Power': '#a17a28',
}
async function pollSources() {
  try {
    const d = await fetch('/api/sources').then(r => r.json())
    const bar = $('srcbar'); if (!bar) return
    let html = ''
    const ha = d.home_assistant || {}
    html += srcTile('ha', '#4a6b8a', 'Home Assistant',
      ha.ok ? (ha.mode || 'connected') : 'offline',
      ha.ok ? ((ha.current_f != null ? ha.current_f + '°F now' : '') +
               (ha.target_f != null ? ' · set ' + ha.target_f + '°F' : ''))
            : String(ha.error || '').slice(0, 34),
      ha.ok ? '' : 'bad')
    const sa = d.solar_assistant || {}
    html += srcTile('pi', '#2e7d8a', 'Raspberry Pi · Solar',
      sa.ok ? 'streaming' : 'no data',
      sa.ok ? (fmtAge(sa.age_s) + ' ago · ' + (sa.soc || 0).toFixed(0) + '% soc')
            : String(sa.error || 'silent').slice(0, 34),
      sa.ok ? '' : 'bad')
    const al = d.anylog || {}
    html += srcTile('db', '#8a5a7a', 'AnyLog', al.ok ? 'live' : 'unreachable',
      al.ok ? (al.rows_30m + ' rows / 30m') : String(al.error || '').slice(0, 34),
      al.ok ? '' : 'bad')
    const ie = d.iems || {}
    html += srcTile('cpu', '#a17a28', 'IEMS backend', ie.ok ? 'up' : 'down',
      ie.url || '', ie.ok ? '' : 'bad')
    ;(d.panels || []).forEach(function (p) {
      const cls = p.ok ? '' : (p.age_s == null ? 'bad' : (p.age_s > 900 ? 'bad' : 'warn'))
      html += srcTile('panel', PANEL_COLORS[p.name] || '#8a7d68', p.name,
        p.w == null ? 'no feed' : fW(p.w),
        p.age_s == null ? 'never seen' : (fmtAge(p.age_s) + ' ago · ' + p.samples_30m + ' pts'),
        cls)
    })
    bar.innerHTML = html
  } catch (e) {}
  setTimeout(pollSources, 15000)
}

let MODEL_META = {}
let LLM_MODEL = 'qwen2.5:1.5b-instruct'
fetch('/api/llm-model').then(r => r.json()).then(m => { if (m && m.model) LLM_MODEL = m.model }).catch(() => {})
fetch('/api/model-meta').then(r => r.json()).then(m => { MODEL_META = m || {} }).catch(() => {})
function metaLine(a) {
  const m = MODEL_META[a.key] || {}
  let s = a.model
  if (m.thr != null) s += ' · thr ' + Math.round(m.thr * 100) + '%'
  if (m.f1  != null) s += ' · F1 ' + Number(m.f1).toFixed(2)
  return s
}
/* ── NILM polling ── */
const PANEL_GROUP_LABELS = {
  panel1: 'Panel 1 · HVAC',
  panel2: 'Panel 2 · H2O',
  panel3: 'Panel 3 · Kitchen / Shop',
}
function groupedNilmHtml(cardFn) {
  const groups = {}, order = []
  NILM_APPLIANCES.forEach(a => {
    if (!groups[a.model]) { groups[a.model] = []; order.push(a.model) }
    groups[a.model].push(a)
  })
  return order.map(model =>
    '<div class="nilm-group">' +
      '<div class="nilm-group-h">' + (PANEL_GROUP_LABELS[model] || model) + '</div>' +
      '<div class="nilm-grid">' + groups[model].map(cardFn).join('') + '</div>' +
    '</div>'
  ).join('')
}
async function pollNilm() {
  try {
    const rows = await fetch('/api/nilm').then(r => r.json())
    renderNilm(rows)
  } catch {}
  setTimeout(pollNilm, 15000)
}

function renderNilm(rows) {
  if (!rows || rows.length === 0) {
    $('nilm-grid').innerHTML = groupedNilmHtml(emptyCard)
    $('nilm-age').textContent = 'awaiting cycle'
    return
  }
  const latest = {}
  rows.forEach(r => { if (!latest[r.appliance] || r.ts > latest[r.appliance].ts) latest[r.appliance] = r })
  const newestTs = rows.reduce((a, r) => r.ts > a ? r.ts : a, '')
  const ageSec = newestTs ? Math.round((Date.now() - new Date((newestTs+'').replace(' ','T')+'Z').getTime()) / 1000) : 9999
  const ageCls = ageSec > 300 ? 'bad' : ageSec > 90 ? 'warn' : 'ok'
  $('nilm-age').textContent = fAge(newestTs)
  $('nilm-age').className = 'tag ' + ageCls
  $('nilm-grid').innerHTML = groupedNilmHtml(function (a) {
    const r = latest[a.key]
    // state may arrive space-padded ('ON ') when the Postgres column is a
    // fixed-width char(3); trim before comparing or every row reads OFF.
    const st = r == null ? '' : String(r.state == null ? '' : r.state).trim().toUpperCase()
    const on = st === 'ON' || st === '1' || st === 'TRUE' || r?.state === 1 || r?.state === true
    const w = r ? parseFloat(r.avg_w) || 0 : 0
    const conf = r ? Math.round((parseFloat(r.confidence) || 0) * 100) : 0
    return '<div class="nc '+(on?'on':'off')+'" style="--c:'+a.c+'">' +
      '<div class="nc-head"><svg class="nc-gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">'+a.glyph+'</svg><div class="nc-state"></div></div>' +
      '<div class="nc-name">'+a.label+'</div>' +
      '<div class="nc-watt" title="On/off state inferred by the model">'+(on ? 'ON' : 'OFF')+'</div>' +
      '<div class="nc-circuit" title="decision threshold and held-out test F1">'+metaLine(a)+'</div>' +
      '<div class="nc-conf"><div class="cb"><div class="cf" style="width:'+conf+'%"></div></div><div class="cp">'+conf+'%</div></div>' +
    '</div>'
  })
}

function emptyCard(a) {
  return '<div class="nc off" style="--c:'+a.c+'">' +
    '<div class="nc-head"><svg class="nc-gly" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5">'+a.glyph+'</svg><div class="nc-state"></div></div>' +
    '<div class="nc-name">'+a.label+'</div>' +
    '<div class="nc-watt">—</div>' +
    '<div class="nc-circuit">'+metaLine(a)+'</div>' +
    '<div class="nc-conf"><div class="cb"><div class="cf" style="width:0%"></div></div><div class="cp">—</div></div>' +
  '</div>'
}
renderNilm([])  // bootstrap empty cards

/* ── Weather (Open-Meteo): current tiles + 48 h charts ── */
const WX = {data:null,charts:{},selected:null,filters:{history:true,forecast:true,peak:true,dip:true,selected:true}}
function renderWeatherCharts(){
  if(!WX.data)return
  const {hours,temp,irr,origin}=WX.data,horizon=$('wx-horizon').value
  const start=horizon==='future'?origin:horizon==='recent'?Math.max(hours[0],origin-6*3600000):hours[0],end=hours.at(-1)
  for(const [key,name,unit,color,values] of [['temp','Temperature','°F','#a64f3a',temp],['irr','Solar irradiance','W/m²','#947000',irr]]){
    const points=hours.map((t,i)=>({t,v:values[i],kind:t<origin?'Past weather':'Forecast'})),forecast=points.filter(p=>p.t>=origin),history=points.filter(p=>p.t<origin)
    const config={name,unit,color,start,end,origin,selectedTime:WX.selected,rangeKey:horizon,minSpan:3600000,features:forecast,inspection:(WX.filters.history?history:[]).concat(WX.filters.forecast?forecast:[]),bounds:key==='irr'?[0,Infinity]:null,highlights:{peak:WX.filters.peak,dip:WX.filters.dip,selected:WX.filters.selected},onSelect:t=>{WX.selected=t;renderWeatherCharts()},
      tracks:[{id:'history',color:'#98a2b3',width:1.6,points:history,visible:WX.filters.history},{id:'forecast',color,width:2.5,points:forecast,visible:WX.filters.forecast}]}
    if(!WX.charts[key])WX.charts[key]=new SeriesAnalysis.Chart($('wx-'+key),config);else WX.charts[key].update(config)
  }
}
document.querySelectorAll('[data-wx-filter]').forEach(button=>button.onclick=()=>{const key=button.dataset.wxFilter;WX.filters[key]=!WX.filters[key];button.setAttribute('aria-pressed',String(WX.filters[key]));renderWeatherCharts()})
$('wx-horizon').onchange=renderWeatherCharts
for(const key of ['temp','irr']){
  const card=$('wx-card-'+key),body=$('wx-body-'+key),collapse=card.querySelector('.wx-collapse'),expand=card.querySelector('.wx-expand')
  collapse.onclick=()=>{body.hidden=!body.hidden;collapse.textContent=body.hidden?'Expand chart':'Collapse';collapse.setAttribute('aria-expanded',String(!body.hidden))}
  expand.onclick=()=>{const large=!card.classList.contains('expanded');document.querySelectorAll('.wx-chart').forEach(other=>{other.classList.remove('expanded');const b=other.querySelector('.wx-expand');b.textContent='Enlarge';b.setAttribute('aria-pressed','false')});card.classList.toggle('expanded',large);expand.textContent=large?'Compact':'Enlarge';expand.setAttribute('aria-pressed',String(large));body.hidden=false;collapse.textContent='Collapse';collapse.setAttribute('aria-expanded','true')}
}

async function pollWeather() {
  try {
    const lat = 37.24, lon = -121.96
    const url = 'https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+
      '&current=temperature_2m,cloud_cover,wind_speed_10m,shortwave_radiation' +
      '&hourly=temperature_2m,shortwave_radiation&past_days=1&forecast_days=2' +
      '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FLos_Angeles&timeformat=unixtime'
    const response = await fetch(url); if(!response.ok)throw new Error('Weather feed unavailable')
    const d = await response.json()
    const c = d.current || {}
    if (Number.isFinite(c.temperature_2m))     $('w-temp').innerHTML  = (c.temperature_2m).toFixed(1) + '<span class="wu">°F</span>'
    if (Number.isFinite(c.cloud_cover))        $('w-cloud').innerHTML = c.cloud_cover + '<span class="wu">%</span>'
    if (Number.isFinite(c.shortwave_radiation))$('w-irr').innerHTML   = c.shortwave_radiation + '<span class="wu">W/m²</span>'
    if (Number.isFinite(c.wind_speed_10m))     $('w-wind').innerHTML  = c.wind_speed_10m.toFixed(1) + '<span class="wu">mph</span>'
    const hh = (d.hourly && d.hourly.time) || []
    if (!hh.length) throw new Error('No weather hours available')
    if (hh.length) {
      const now = Date.now()
      const times = hh.map(t => Number(t)*1000)
      // window: -24 h .. +24 h around now
      const idx = []
      times.forEach((t, k) => { if (t >= now - 24*3600e3 && t <= now + 24*3600e3) idx.push(k) })
      const hrs  = idx.map(k => times[k])
      const temp = idx.map(k => d.hourly.temperature_2m?.[k])
      const irr  = idx.map(k => d.hourly.shortwave_radiation?.[k])
      WX.data={hours:hrs,temp,irr,origin:now};if(!Number.isFinite(WX.selected))WX.selected=hrs.find(t=>t>=now)
      renderWeatherCharts()
      $('wx-status').textContent='Open-Meteo · Updated '+ptNow()+' PT · Gray: past weather · Color: forecast'
      if (Number.isFinite(c.temperature_2m)) $('wx-temp-now').textContent = c.temperature_2m.toFixed(1) + ' °F now'
      if (Number.isFinite(c.shortwave_radiation)) $('wx-irr-now').textContent = Math.round(c.shortwave_radiation) + ' W/m² now'
    }
    $('wtou-age').textContent = sT(new Date().toISOString())
    // measured PV alongside the forecast irradiance: the forecast is what the
    // sky offers, this is what the array actually produced.
    try {
      const sa = await fetch('/api/solar-assistant').then(r => r.json())
      $('w-pv').innerHTML = sa.connected
        ? Math.round(sa.pv_power_w) + '<span class="wu">W</span>'
        : '—<span class="wu">no feed</span>'
    } catch { $('w-pv').innerHTML = '—<span class="wu">W</span>' }

  } catch { $('wx-status').textContent=WX.data?'Weather refresh unavailable · Showing the previous update':'Weather unavailable · Retry on the next refresh' }
  setTimeout(pollWeather, 300000)
}

/* ── TOU pill + graph ── */
function classifyTOU(date) {
  const h=date.getHours()+date.getMinutes()/60, summer=date.getMonth()>=5 && date.getMonth()<=8;
  if(h>=16 && h<21)return {p:'PEAK',r:summer?0.55214:0.32063,cls:'peak'};
  if((h>=15 && h<16)||h>=21)return {p:'PARTIAL',r:summer?0.39026:0.29854,cls:'partial'};
  return {p:'OFF-PEAK',r:summer?0.33358:0.28468,cls:'off'};
}

const TOU_TIER = {
  super:   { c: '#eda57a', lbl: 'Super off-peak' },
  off:     { c: '#dc7a44', lbl: 'Off-peak' },
  partial: { c: '#b8521f', lbl: 'Partial peak' },
  peak:    { c: '#7f3412', lbl: 'Peak' },
}

function renderTOU() {
  const now = new Date()
  const cur = classifyTOU(ptWall(now))
  $('tou-pill').textContent = cur.p
  $('tou-pill').className = 'tou-pill ' + cur.cls
  $('tou-rate').innerHTML = '$' + cur.r.toFixed(2) + '<span class="tou-unit"> /kWh now</span>'

  let nxt = ''
  for (let dh = 1; dh <= 24; dh++) {
    const f = new Date(now.getTime() + dh * 3600 * 1000), nc = classifyTOU(ptWall(f))
    if (nc.p !== cur.p) {
      nxt = 'Next: ' + nc.p.toLowerCase() + ' at ' + String(ptWall(f).getHours()).padStart(2, '0') + ':00 PT ($' + nc.r.toFixed(2) + ')'
      break
    }
  }
  const wall = ptWall(now), summer = wall.getMonth() + 1 >= 6 && wall.getMonth() + 1 <= 9
  const weekday = wall.getDay() >= 1 && wall.getDay() <= 5
  $('tou-info').textContent = (nxt ? nxt + ' · ' : '') + (summer ? 'Summer' : 'Winter') + ' ' + 'E-ELEC planning example'

  const svg = $('tou-graph'); if (!svg) return
  const W = Math.max(300, Math.round(svg.parentElement.clientWidth || 600)), H = 150, L = 72, R = 12, T = 22, B = 22
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
  svg.style.height = H + 'px'
  const base = ptWall(now); base.setHours(0, 0, 0, 0)
  const rates = []
  for (let h = 0; h < 24; h++) rates.push(classifyTOU(new Date(base.getTime() + h * 3600 * 1000)))
  const sc = niceScale(0, Math.max(...rates.map(r => r.r)) * 1.08, 3)
  const x = h => L + h / 24 * (W - L - R)
  const y = v => T + (1 - v / sc.hi) * (H - T - B)
  let o = '<g font-family="JetBrains Mono" font-size="10" fill="' + INK.axis + '">'
  sc.ticks.forEach((v, i) => {
    o += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="' + INK.grid + '"/>'
    o += '<text x="' + (L - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end"' + (i === sc.ticks.length - 1 ? ' font-weight="600"' : '') + '>$' + v.toFixed(2) + (i === sc.ticks.length - 1 ? '/kWh' : '') + '</text>'
  })
  for (let h = 0; h <= 24; h += 3) o += '<text x="' + x(h).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (h === 0 ? 'start' : h === 24 ? 'end' : 'middle') + '">' + String(h).padStart(2, '0') + ':00</text>'
  o += '</g>'
  // contiguous blocks per tier, 1px surface gap between blocks
  let h0 = 0
  for (let h = 1; h <= 24; h++) {
    if (h < 24 && rates[h].cls === rates[h0].cls) continue
    const r = rates[h0]
    o += '<rect x="' + (x(h0) + 0.5).toFixed(1) + '" y="' + y(r.r).toFixed(1) + '" width="' + Math.max(1, x(h) - x(h0) - 1).toFixed(1) + '" height="' + (y(0) - y(r.r)).toFixed(1) +
      '" fill="' + TOU_TIER[r.cls].c + '" fill-opacity=".55"><title>' + String(h0).padStart(2, '0') + ':00–' + String(h).padStart(2, '0') + ':00 PT · ' + TOU_TIER[r.cls].lbl + ' · $' + r.r.toFixed(2) + '/kWh</title></rect>'
    h0 = h
  }
  // step line: horizontal for the hour, vertical at the change
  let d = 'M' + x(0).toFixed(1) + ',' + y(rates[0].r).toFixed(1)
  for (let h = 1; h <= 24; h++) {
    d += ' H' + x(h).toFixed(1)
    if (h < 24 && rates[h].r !== rates[h - 1].r) d += ' V' + y(rates[h].r).toFixed(1)
  }
  o += '<path d="' + d + '" stroke="#182230" stroke-width="2" fill="none"/>'
  o += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="' + INK.rule + '"/>'
  // now marker at the rate actually in force
  const nowFrac = wall.getHours() + wall.getMinutes() / 60, nx = x(nowFrac)
  o += '<line x1="' + nx.toFixed(1) + '" y1="' + (T - 4) + '" x2="' + nx.toFixed(1) + '" y2="' + y(0) + '" stroke="#182230" stroke-width="1"/>'
  o += '<circle cx="' + nx.toFixed(1) + '" cy="' + y(cur.r).toFixed(1) + '" r="4.5" fill="#182230" stroke="#fff" stroke-width="2"/>'
  const lbl = 'Now ' + String(wall.getHours()).padStart(2, '0') + ':' + String(wall.getMinutes()).padStart(2, '0') + ' · $' + cur.r.toFixed(2)
  const anchor = nx > W - R - 70 ? 'end' : nx < L + 70 ? 'start' : 'middle'
  o += '<text x="' + nx.toFixed(1) + '" y="' + (T - 8) + '" text-anchor="' + anchor + '" font-family="JetBrains Mono" font-size="10" font-weight="700" fill="#182230">' + lbl + '</text>'
  svg.innerHTML = o
  const present = Array.from(new Set(rates.map(r => r.cls)))
  $('tou-legend').innerHTML = ['super', 'off', 'partial', 'peak'].filter(k => present.includes(k)).map(k =>
    '<span class="tou-legend-item"><span class="tou-legend-sw" style="background:' + TOU_TIER[k].c + ';opacity:.8"></span>' + TOU_TIER[k].lbl + ' $' +
    rates.find(r => r.cls === k).r.toFixed(2) + '</span>').join('') +
    '<span class="tou-legend-item" style="margin-left:auto;color:var(--ink-3)">E-ELEC planning example · account rates and export credits unverified</span>'
}
setInterval(renderTOU, 60000)
renderTOU()

/* ── DSS ── */
function safeText(value) { const el=document.createElement('span'); el.textContent=String(value || ''); return el.innerHTML }
let readinessAlerts = [], dssAlerts = [], costAlerts = [], readinessStatus = 'pending'
function updateDssBadges() {
  const all = readinessAlerts.concat(dssAlerts,costAlerts)
  const urgent = all.filter(r => r.is_anomaly || r.severity === 'critical' || r.severity === 'high').length
  const other = all.length - urgent
  $('dss-badges').innerHTML = '<span class="dss-count' + (urgent ? ' alert' : '') + '"><b>' + urgent + '</b> alerts</span>' +
    '<span class="dss-count"><b>' + other + '</b> suggestions</span>' +
    (readinessStatus === 'unknown' ? '<span class="dss-count unknown">Monitor unavailable</span>' : readinessStatus === 'pending' ? '<span class="dss-count unknown">Checking feeds</span>' : '')
}
updateDssBadges()
async function refreshReadiness() {
  try {
    const response=await fetch('/api/readiness'); if(!response.ok) throw Error('Monitor unavailable')
    const data=await response.json()
    readinessAlerts = data.recommendations || []; readinessStatus = data.status; updateDssBadges()
    $('readiness-summary').textContent='Los Gatos · '+(data.status==='prepare'?'Prepare for possible disruption':data.status==='unknown'?'Some updates unavailable':'Monitoring conditions')+' · Checked '+(data.checked_at?new Date(data.checked_at).toLocaleTimeString():'pending')+' · Every 5 min'
    const wx=data.sources.weather?.usable ? data.sources.weather.data : null
    if(wx) $('readiness-summary').textContent+=' · Next 24h: '+Math.round(wx.high_f)+'°F high, gusts '+Math.round(wx.max_gust_mph)+' mph'
    $('readiness-recs').innerHTML=data.recommendations.map(r=>'<div class="dss-rec '+(r.severity==='high'?'urgent':'info')+'" style="display:block;margin-bottom:6px"><b>'+safeText(r.action)+'</b><div style="margin-top:4px;color:var(--ink-2)">'+safeText(r.rationale)+'</div></div>').join('')+'<div style="font-size:10px;padding:4px 0 8px">Live local weather and outage notices · Advice only<br><a href="https://pgealerts.alerts.pge.com/outage-tools/outage-map/" target="_blank" rel="noopener">PG&amp;E outage map</a> · <a href="https://forecast.weather.gov/MapClick.php?lat=37.24&lon=-121.96" target="_blank" rel="noopener">Local weather</a></div>'
  } catch(e) { readinessAlerts = []; readinessStatus = 'unknown'; updateDssBadges(); $('readiness-summary').textContent='Readiness monitor unavailable — check the official sources.'; $('readiness-recs').textContent='' }
}
refreshReadiness(); setInterval(refreshReadiness,60000)

async function refreshSmartDss() {
 try {
  const r=await fetch('/api/dss-plan');const d=await r.json();if(!r.ok)throw Error(d.detail||'Forecast advice unavailable');
  costAlerts=d.recommendations;updateDssBadges();
  const current=d.current;const kw=v=>Number.isFinite(v)?(v/1000).toFixed(1)+' kW':'unavailable';
  const cards=d.recommendations.map(x=>'<div class="dss-rec '+(x.severity==='high'?'urgent':'info')+'" style="display:block;margin:8px 0;padding:14px"><b style="font-size:14px">'+safeText(x.action)+'</b><div style="line-height:1.5;margin-top:6px;color:var(--ink-2)">'+safeText(x.rationale)+'</div>'+(x.savings_text?'<div style="margin-top:7px;font-weight:600">'+safeText(x.savings_text)+'</div>':'')+'</div>').join('');
  $('smart-dss').innerHTML='<div style="margin:12px 0;font-size:12px"><b>Your appliance plan</b> · Solar '+kw(current.solar_w)+' · Battery '+(Number.isFinite(current.battery_soc)?Math.round(current.battery_soc)+'%':'unavailable')+' · Updated '+new Date(d.checked_at).toLocaleTimeString('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'})+' PT</div>'+cards+'<div style="font-size:11px;line-height:1.5;color:var(--ink-2)">Uses E-ELEC as a planning example; account rates and export credits are unverified. Only run cycles you need. Refreshes every minute. Advice only; no appliances or battery settings are changed.</div><details style="font-size:11px;margin:8px 0"><summary>How costs and run times are estimated</summary><p>'+safeText(d.tariff.note)+'</p><p>'+safeText(d.method)+'</p><p>Appliance use is inferred; cycle energy comes from configured ranges, not separate appliance meters. '+safeText(d.notes.join(' '))+'</p><a href="https://www.pge.com/tariffs/assets/pdf/tariffbook/ELEC_SCHEDS_E-ELEC.pdf" target="_blank" rel="noopener">Current PG&E E-ELEC tariff</a></details>';
 }catch(e){costAlerts=[];updateDssBadges();$('smart-dss').innerHTML='<div class="dss-empty">The latest appliance plan is temporarily unavailable. Keep your normal routine and existing battery reserve; check back after the data refresh.</div>';}
}
refreshSmartDss();setInterval(refreshSmartDss,60000);

function renderDss(result) {
  if (!result) return
  const recs = (result.dss_recommendations || []).filter(r=>r.type!=='readiness' && (r.is_anomaly || r.severity==='critical' || r.severity==='high'))
  dssAlerts = recs; updateDssBadges()
  $('dss-branch').textContent = result.flow_chart_branch || (recs.length ? 'branch '+recs.length : '—')
  if (recs.length === 0) {
    $('dss-list').innerHTML = '<div class="dss-empty">No additional appliance alerts this cycle.</div>'
    return
  }
  $('dss-list').innerHTML = recs.map((r, i) => {
    const isAnomaly = r.is_anomaly || r.severity === 'critical' || r.severity === 'high'
    const savings = parseFloat(r.savings_dollars || 0)
    const c = isAnomaly ? 'urgent' : (savings > 0 ? 'advisory' : 'info')
    const rc = c === 'urgent' ? 'var(--bad)' : c === 'advisory' ? 'var(--warn)' : 'var(--info)'
    const icon = isAnomaly
      ? '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 2 L13 12 H1 Z M7 6 V9 M7 10.5 V11"/></svg>'
      : (savings > 0
        ? '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M7 2 V11 M3 7 L7 11 L11 7"/></svg>'
        : '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M7 7 V10 M7 4 V4.5"/></svg>')
    const amount = savings > 0 ? '<span class="amount">+ $'+savings.toFixed(2)+'</span>' : ''
    return '<div class="dss-rec '+c+'" style="--rc:'+rc+'">' +
      '<div class="dss-icon">'+icon+'</div>' +
      '<div class="dss-body">' +
        '<div class="dt"><span>'+safeText(r.action || r.label || 'Recommendation')+'</span>'+amount+'</div>' +
        '<div class="dd">'+safeText(r.rationale || r.reason || r.message || '')+'</div>' +
        '<div class="dm">'+(r.audience || r.type || 'INFO').toUpperCase()+(r.confidence ? '  ·  '+Math.round(r.confidence*100)+'% conf' : '')+'</div>' +
        '<div class="dss-actions">' +
          '<button class="dss-btn" onclick="ackRec('+i+',\\'accept\\')">Accept</button>' +
          '<button class="dss-btn" onclick="ackRec('+i+',\\'defer\\')">Defer</button>' +
          '<button class="dss-btn" onclick="ackRec('+i+',\\'dismiss\\')">Dismiss</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  }).join('')
}

window.ackRec = function(idx, action) {
  if (!lastCycleResult) return
  const recs = (lastCycleResult.dss_recommendations || []).filter(r=>r.type!=='readiness' && (r.is_anomaly || r.severity==='critical' || r.severity==='high'))
  const rec  = recs[idx]; if (!rec) return
  const id   = rec.id || ('rec_'+idx)
  // Same-origin route on server.js, which forwards to the IEMS backend (:8009).
  // The old call went to localhost:8000, i.e. the viewer's own machine.
  fetch('/api/recommendations/' + encodeURIComponent(id) + '/' + action, { method: 'POST' })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const all = lastCycleResult.dss_recommendations || []
      const k = all.indexOf(rec); if (k >= 0) all.splice(k, 1)
      renderDss(lastCycleResult)
      $('cycle-status').textContent = '✓ ' + action + ' recorded · ' + ptNow() + ' PT'
    })
    .catch(e => { $('cycle-status').textContent = '✗ ' + action + ' not recorded (' + e.message + ')' })
}

/* ── NILM backend toggle ── */
document.querySelectorAll('#nilm-toggle button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#nilm-toggle button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    nilmBackend = btn.dataset.v
    $('nilm-mode').textContent = nilmBackend.toUpperCase()
  }
})

/* ── Cycle ── */
$('run-btn').onclick = async () => {
  if (cycleRunning) return
  cycleRunning = true
  const btn = $('run-btn')
  btn.disabled = true
  btn.innerHTML = '<span class="spin">⟳</span> RUNNING…'
  $('cycle-status').innerHTML = '<span class="spin">⟳</span> calling backend…'
  const payload = {
    mode:           $('sel-mode').value,
    nilm_backend:   nilmBackend,
    llm_backend:    'ollama',
    llm_model:      LLM_MODEL,
    window_minutes: parseInt($('sel-win').value),
  }
  try {
    const result = await fetch('/api/cycle', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    }).then(r => r.json())
    lastCycleResult = result
    const tag = (result.metadata?.nilm_backend || nilmBackend).toUpperCase()
    $('nilm-mode').textContent = tag
    renderDss(result)
    renderNilmFromCycle(result)
    const lat = result.metadata?.latency_ms ? (result.metadata.latency_ms/1000).toFixed(1)+'s' : ''
    $('cycle-status').textContent = '✓ ' + ptNow() + ' PT' + (lat ? ' · '+lat : '')
  } catch (e) {
    $('cycle-status').textContent = '✗ ' + e.message
  }
  btn.disabled = false
  btn.textContent = '▷ Run IEMS Cycle'
  cycleRunning = false
}

function renderNilmFromCycle(result) {
  // Fetch real DB rows — never synthesize avg_w:0 placeholder rows.
  // The inference loop has already written fresh predictions; pull them honestly.
  fetch('/api/nilm').then(r => r.json()).then(renderNilm).catch(() => {})
}

async function pollStorage() {
  try {
    // Battery is MEASURED-only on this dashboard: Solar Assistant or nothing.
    // The derived estimate confused more than it informed - removed 2026-08-09.
    const bel = $('kbat'), bh = $('kbath')
    const sa = await fetch('/api/solar-assistant').then(r => r.json()).catch(() => ({}))
    if (sa.connected) {
      bel.textContent = sa.battery_soc_pct.toFixed(1) + '%'
      const flow = sa.battery_power_w > 50 ? 'charging' : sa.battery_power_w < -50 ? 'discharging' : 'idle'
      bh.textContent = flow + ' · ' + fW(sa.battery_power_w) + ' · measured'
      bh.className = 'hint ' + (flow === 'charging' ? 'up' : flow === 'discharging' ? 'down' : '')
    } else {
      bel.textContent = '—'; bh.textContent = 'awaiting Solar Assistant'; bh.className = 'hint'
    }
  } catch (e) {}
  setTimeout(pollStorage, 5000)
}

async function pollSolarAssistant() {
  try {
    const sa = await fetch('/api/solar-assistant').then(r => r.json())
    const el = $('ksa'), h = $('ksah')
    if (sa.connected) {
      el.textContent = fW(sa.pv_power_w)
      const parts = [
        (sa.battery_power_w >= 0 ? 'batt +' : 'batt ') + fW(sa.battery_power_w),
        sa.battery_soc_pct.toFixed(0) + '% soc',
        'load ' + fW(sa.load_power_w),
      ]
      if (sa.age_s != null && sa.age_s > 120) parts.push(sa.age_s + 's old')
      h.textContent = parts.join(' · ')
      h.className = 'hint ' + (sa.age_s != null && sa.age_s > 120 ? 'down' : '')
    } else {
      el.textContent = '—'; h.textContent = 'no Solar Assistant data'; h.className = 'hint'
    }
  } catch (e) {}
  setTimeout(pollSolarAssistant, 5000)
}

/* ── Boot ── */
pollSnapshot()
pollHistory()
pollNilm()
pollWeather()
pollStorage()
pollSolarAssistant()
pollSources()


// ── Relay + Anomalies tabs ───────────────────────────────────────────────────
const RSEV = { critical: 'var(--bad)', warning: 'var(--warn)', info: 'var(--info)' }
let RELAY_T = null

let TH_PENDING = null
let HVAC24 = null
let SA_SNAP = null

async function pollImpactData() {
  try { HVAC24 = await fetch('/api/hvac-24h').then(r => r.json()) } catch {}
  try { SA_SNAP = await fetch('/api/solar-assistant').then(r => r.json()) } catch {}
  renderImpact()
  setTimeout(pollImpactData, 120000)
}
pollImpactData()

function renderImpact() {
  const t = RELAY_T || {}
  const cur = t.target_f != null ? Number(t.target_f) : null
  const pend = TH_PENDING != null ? TH_PENDING : cur
  const base = $('imp-base'); if (!base) return
  base.textContent = HVAC24 && HVAC24.kwh_24h != null ? HVAC24.kwh_24h.toFixed(1) + ' kWh' : '—'
  const eEl = $('imp-energy'), cEl = $('imp-cost'), sEl = $('imp-src'), dEl = $('imp-dir'), nEl = $('imp-note')
  if (cur == null || pend == null || pend === cur || !HVAC24 || !HVAC24.kwh_24h) {
    eEl.textContent = '—'; eEl.className = 'v'
    cEl.textContent = '—'; cEl.className = 'v'
    dEl.textContent = 'energy / day'
  } else {
    const delta = pend - cur                      // +raise (cooler runs less), -lower
    const dkwh = HVAC24.kwh_24h * 0.03 * Math.abs(delta)
    const rate = classifyTOU(ptWall(new Date())).r
    const saves = delta > 0                       // cooling season: warmer = less compressor
    dEl.textContent = saves ? 'saved / day (est.)' : 'added / day (est.)'
    eEl.textContent = (saves ? '−' : '+') + dkwh.toFixed(1) + ' kWh'
    eEl.className = 'v ' + (saves ? 'save' : 'cost')
    cEl.textContent = (saves ? '−$' : '+$') + (dkwh * rate).toFixed(2) + ' /day'
    cEl.className = 'v ' + (saves ? 'save' : 'cost')
    nEl.innerHTML = '&approx;3%/&deg;F of measured 24 h HVAC energy (' + HVAC24.kwh_24h.toFixed(1) +
      ' kWh) &middot; rate $' + rate.toFixed(2) + '/kWh &middot; cooling-season direction'
  }
  // where the marginal watt comes from right now
  const sa = SA_SNAP || {}
  if (sa.connected) {
    const pv = sa.pv_power_w || 0, load = sa.load_power_w || 0, batt = sa.battery_power_w || 0
    const surplus = pv - load
    if (surplus > 300) {
      sEl.innerHTML = '<span class="src-pill" style="--sc:#caa12e">SOLAR · ' + fW(surplus) + ' spare</span>'
    } else if (batt < -100) {
      sEl.innerHTML = '<span class="src-pill" style="--sc:#2e7d8a">BATTERY · ' + (sa.battery_soc_pct || 0).toFixed(0) + '%</span>'
    } else {
      sEl.innerHTML = '<span class="src-pill" style="--sc:#b85c2e">GRID · $' + classifyTOU(ptWall(new Date())).r.toFixed(2) + '/kWh</span>'
    }
  } else {
    sEl.innerHTML = '<span class="src-pill" style="--sc:#8a7d68">GRID (no solar data)</span>'
  }
}

function setPending(v) {
  const t = RELAY_T || {}
  if (t.target_f == null) return
  const cur = Number(t.target_f)
  TH_PENDING = Math.min(100, Math.max(45, v))
  const set = $('th-set'), ap = $('th-apply'), cn = $('th-cancel'), note = $('th-note')
  const dirty = TH_PENDING !== cur
  set.innerHTML = TH_PENDING + '<span class="u">&deg;F</span>'
  set.className = 'th-set' + (dirty ? ' pending' : '')
  ap.disabled = !dirty
  cn.style.display = dirty ? '' : 'none'
  note.innerHTML = dirty
    ? 'pending: ' + cur + '&deg;F &rarr; <b>' + TH_PENDING + '&deg;F</b> — press Apply to send'
    : 'thermostat setpoint &mdash; tap &plusmn; then Apply'
  renderImpact()
}

async function renderRelay() {
  let d
  try { d = await fetch('/api/relay').then(r => r.json()) }
  catch (e) { $('relay-state').textContent = 'unreachable'; return }
  const t = d.thermostat || {}
  RELAY_T = t

  $('relay-state').textContent = !d.ha_connected ? 'HA offline'
    : (d.relay_engaged ? 'ENGAGED' : 'normal')
  $('relay-state').style.color = !d.ha_connected ? 'var(--bad)'
    : (d.relay_engaged ? 'var(--warn)' : 'var(--ok)')

  $('th-indoor').innerHTML = (t.current_f != null ? t.current_f : '&mdash;') + '<span class="u">&deg;F</span>'
  $('th-action').textContent = (t.hvac_action || '—') + ' · ' + (t.hvac_mode || '—')
  $('th-mode').textContent = t.hvac_mode ? '· ' + t.hvac_mode : ''
  $('th-held').textContent = d.relay_engaged
    ? 'relay held ' + Math.round((d.held_s || 0) / 60) + ' min · restores to ' +
      ((d.relay && d.relay.original || {}).target_f || '—') + '°F'
    : ''
  // setpoint display: keep an in-progress pending edit, else show live target
  if (TH_PENDING == null) {
    const set = $('th-set')
    set.innerHTML = (t.target_f != null ? t.target_f : '&mdash;') + '<span class="u">&deg;F</span>'
    set.className = 'th-set'
    $('th-apply').disabled = true
    $('th-cancel').style.display = 'none'
  }

  // quick steps preview pending instead of firing immediately
  const steps = (d.config && d.config.steps) || [2, 4]
  $('rl-steps').innerHTML = steps.map(s =>
    '<button class="th-ghost rl-step" data-step="' + s + '">+' + s + '&deg;</button>').join(' ')
  document.querySelectorAll('.rl-step').forEach(b => {
    b.onclick = () => { if (RELAY_T && RELAY_T.target_f != null)
      setPending(Number(RELAY_T.target_f) + Number(b.dataset.step)) }
  })
  if ($('rl-cfg') && document.activeElement !== $('rl-cfg')) $('rl-cfg').value = steps.join(',')
  if ($('rl-exact') && document.activeElement !== $('rl-exact') && t.target_f != null && !$('rl-exact').value)
    $('rl-exact').value = t.target_f

  const dr = d.drift || {}
  const drEl = $('relay-drift')
  if (dr.drifted) {
    drEl.style.display = 'block'
    drEl.innerHTML = 'Setpoint changed outside the relay at <b>' + ptShort(dr.since) + ' PT</b>' +
      ' — relay last set ' + (dr.expected === 'off' ? 'HVAC off' : dr.expected + '°F') +
      ', thermostat now reads ' + (dr.field === 'mode' ? dr.actual : dr.actual + '°F') + '.' +
      '<div style="color:var(--ink-3);margin-top:3px">' + (d.schedule_note || '') + '</div>'
  } else { drEl.style.display = 'none' }

  const warn = $('relay-warn')
  if (d.stale_warning) {
    warn.style.display = 'block'
    warn.textContent = 'HVAC has been OFF for ' + Math.round((d.held_s || 0) / 60) +
      ' minutes. Nothing will turn it back on automatically — press Restore when done.'
  } else { warn.style.display = 'none' }

  const dss = d.dss || {}
  $('dss-urgency').textContent = dss.urgency || '—'
  $('dss-urgency').style.color = RSEV[dss.urgency] || 'var(--ink-3)'
  $('dss-body').innerHTML = dss.error
    ? '<span style="color:var(--bad)">DSS unavailable: ' + dss.error + '</span>'
    : '<div style="margin-bottom:6px"><b>Recommended:</b> ' + (dss.action || 'none') + '</div>' +
      '<ul style="margin:0 0 0 16px;padding:0;color:var(--ink-2)">' +
      (dss.reasons || []).map(r => '<li>' + r + '</li>').join('') + '</ul>' +
      '<div style="margin-top:7px;color:var(--ink-3)">Advisory only — press a button above to act.</div>'
  renderImpact()
}

async function renderLoads() {
  let d
  try { d = await fetch('/api/loads').then(r => r.json()) } catch (e) { return }
  $('loads-tag').textContent = d.ratings_configured ? 'margins live' : 'breaker ratings not set'
  $('loads-tag').style.color = d.ratings_configured ? 'var(--ok)' : 'var(--warn)'
  $('loads-table').innerHTML =
    '<table style="width:100%;border-collapse:collapse">' +
    '<tr style="color:var(--ink-3);text-align:left"><th style="padding:3px 6px">Panel</th>' +
    '<th style="padding:3px 6px">Load</th><th style="padding:3px 6px">Amps</th>' +
    '<th style="padding:3px 6px">Rating</th><th style="padding:3px 6px">% of rating</th></tr>' +
    (d.loads || []).map(r => {
      const c = r.pct == null ? 'var(--ink-3)' : (r.pct >= 80 ? 'var(--bad)' : r.pct >= 60 ? 'var(--warn)' : 'var(--ok)')
      return '<tr style="border-top:1px solid var(--line)">' +
        '<td style="padding:3px 6px;font-family:var(--mono)">' + r.panel + '</td>' +
        '<td style="padding:3px 6px">' + (r.watts == null ? '—' : r.watts + ' W') + '</td>' +
        '<td style="padding:3px 6px">' + (r.amps == null ? '—' : r.amps + ' A') + '</td>' +
        '<td style="padding:3px 6px;color:var(--ink-3)">' + (r.rating == null ? 'not set' : r.rating + ' A') + '</td>' +
        '<td style="padding:3px 6px;color:' + c + '">' + (r.pct == null ? '—' : r.pct + '%') + '</td></tr>'
    }).join('') + '</table>'
}

function evRows(rows) {
  if (!rows || !rows.length)
    return '<div style="color:var(--ink-3);padding:6px">Nothing to show.</div>'
  return rows.map(r =>
    '<div style="border-top:1px solid var(--line);padding:5px 6px;display:flex;gap:8px">' +
    '<span style="font-family:var(--mono);color:var(--ink-3);white-space:nowrap">' +
      ptShort(r.ts) + ' PT</span>' +
    '<span style="font-family:var(--mono);white-space:nowrap;color:' +
      (RSEV[String(r.severity).trim()] || 'var(--ink-3)') + '">' +
      String(r.severity || '').trim() + '</span>' +
    '<span style="font-family:var(--mono);white-space:nowrap">' + String(r.atype || '').trim() + '</span>' +
    '<span style="color:var(--ink-2)">' + String(r.message || '').trim() + '</span></div>').join('')
}

async function renderLogs() {
  let d
  try { d = await fetch('/api/logs?minutes=1440').then(r => r.json()) } catch (e) { return }
  $('crit-tag').textContent = (d.critical || []).length + ' in 24 h'
  $('crit-tag').style.color = (d.critical || []).length ? 'var(--bad)' : 'var(--ok)'
  $('crit-list').innerHTML = evRows(d.critical)
  $('rlog-tag').textContent = (d.relay || []).length + ' actions'
  $('rlog-list').innerHTML = evRows(d.relay)
  $('all-tag').textContent = d.total + ' events'
  $('all-list').innerHTML = evRows(d.all)
}

async function relayPost(path, body) {
  $('relay-msg').textContent = 'working…'
  $('relay-msg').style.color = 'var(--ink-3)'
  try {
    const r = await fetch(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const j = await r.json()
    const ok = r.ok && j.ok !== false
    $('relay-msg').textContent = ok ? (j.message || 'done') : ('failed: ' + (j.error || r.status))
    $('relay-msg').style.color = ok ? 'var(--ok)' : 'var(--bad)'
  } catch (e) {
    $('relay-msg').textContent = 'failed: ' + e
    $('relay-msg').style.color = 'var(--bad)'
  }
  renderRelay(); renderLogs()
}

if ($('th-minus')) $('th-minus').onclick = () => {
  const t = RELAY_T || {}; if (t.target_f == null) return
  setPending((TH_PENDING != null ? TH_PENDING : Number(t.target_f)) - 1)
}
if ($('th-plus')) $('th-plus').onclick = () => {
  const t = RELAY_T || {}; if (t.target_f == null) return
  setPending((TH_PENDING != null ? TH_PENDING : Number(t.target_f)) + 1)
}
if ($('th-cancel')) $('th-cancel').onclick = () => { TH_PENDING = null; renderRelay() }
if ($('th-apply')) $('th-apply').onclick = () => {
  const t = RELAY_T || {}
  if (TH_PENDING == null || t.target_f == null || TH_PENDING === Number(t.target_f)) return
  const tgt = TH_PENDING; TH_PENDING = null
  relayPost('/api/relay/set', { mode: 'cool', target: tgt,
    reason: 'manual set ' + tgt + 'F from thermostat control' })
}
if ($('rl-off')) $('rl-off').onclick = () => {
  if (confirm('Turn HVAC OFF?\\n\\nNothing will turn it back on automatically — you must press Restore.'))
    relayPost('/api/relay/set', { mode: 'off', reason: 'manual OFF from dashboard' })
}
if ($('rl-restore')) $('rl-restore').onclick = () => relayPost('/api/relay/restore', {})

function refreshRelayTabs() { renderRelay(); renderLoads(); renderLogs() }
refreshRelayTabs()
setInterval(refreshRelayTabs, 30000)



// ── Relay: exact setpoint + editable shed steps ──────────────────────────────
if ($('rl-exact-go')) $('rl-exact-go').onclick = () => {
  const v = Number($('rl-exact').value)
  if (!Number.isFinite(v) || v < 45 || v > 100) {
    $('relay-msg').textContent = 'setpoint must be 45-100F'
    $('relay-msg').style.color = 'var(--bad)'
    return
  }
  relayPost('/api/relay/set', { mode: 'cool', target: v, reason: 'manual exact ' + v + 'F' })
}

if ($('rl-cfg-save')) $('rl-cfg-save').onclick = async () => {
  const steps = ($('rl-cfg').value || '').split(',').map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n <= 20)
  if (!steps.length) {
    $('relay-msg').textContent = 'steps must be numbers 1-20, comma separated'
    $('relay-msg').style.color = 'var(--bad)'
    return
  }
  try {
    const r = await fetch('/api/relay/config', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }) })
    const j = await r.json()
    $('relay-msg').textContent = r.ok ? ('steps saved: ' + j.steps.join(', ')) : 'save failed'
    $('relay-msg').style.color = r.ok ? 'var(--ok)' : 'var(--bad)'
  } catch (e) {
    $('relay-msg').textContent = 'save failed: ' + e
    $('relay-msg').style.color = 'var(--bad)'
  }
  renderRelay()
}

/* -- Ask tab: Nemotron 3.5 Lightning over the live context ------------------------- */
var ASK_PRESETS = [
  'Which appliances are on right now and what is each drawing?',
  'Is the battery charging or discharging, and what is the state of charge?',
  'What is the heat pump doing, and do the rules allow the solar pump to run?',
  'Are any panels near their breaker limits?',
  'Summarise the last 24 hours of HVAC energy.',
  'Which loads could I defer to cut the next peak period?'
]
var ASK_HISTORY = []

function askEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function askAppend(role, text, meta) {
  var log = $('ask-log')
  if (log.querySelector('.dss-empty')) log.innerHTML = ''
  var cls = role === 'user' ? 'info' : 'ok'
  var who = role === 'user' ? 'You' : 'Nemotron'
  var el = document.createElement('div')
  el.className = 'dss-rec ' + cls
  el.style.gridTemplateColumns = '1fr'
  el.innerHTML =
    '<div class="dss-body"><div class="dt">' + who +
    (meta ? '<span class="amount">' + askEsc(meta) + '</span>' : '') +
    '</div><div class="dd" style="white-space:pre-wrap">' + askEsc(text) + '</div></div>'
  log.appendChild(el)
  log.scrollTop = log.scrollHeight
}

async function askSend(q) {
  q = (q || '').trim()
  if (!q) return
  var btn = $('ask-go')
  btn.disabled = true
  $('ask-status').innerHTML = '<span class="spin">&#9696;</span> thinking'
  askAppend('user', q, null)
  $('ask-q').value = ''
  var t0 = Date.now()
  try {
    var r = await fetch('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, history: ASK_HISTORY.slice(-6) })
    })
    var j = await r.json()
    if (j && j.ok) {
      var secs = ((Date.now() - t0) / 1000).toFixed(1)
      var meta = j.model + ' · ' + secs + 's'
      if (j.eval_count) meta += ' · ' + j.eval_count + ' tok'
      askAppend('assistant', j.answer || '(empty answer)', meta)
      ASK_HISTORY.push({ role: 'user', content: q })
      ASK_HISTORY.push({ role: 'assistant', content: j.answer || '' })
      $('ask-tag').textContent = j.context_chars + ' chars of context'
      $('ask-tag').className = 'tag ok'
    } else {
      askAppend('assistant', 'Failed: ' + ((j && (j.detail || j.error)) || 'no response'), null)
      $('ask-tag').textContent = (j && j.error) || 'error'
      $('ask-tag').className = 'tag bad'
    }
  } catch (e) {
    askAppend('assistant', 'Failed: ' + e, null)
    $('ask-tag').className = 'tag bad'
  }
  $('ask-status').textContent = ''
  btn.disabled = false
}

if ($('ask-presets')) {
  ASK_PRESETS.forEach(function (p) {
    var b = document.createElement('button')
    b.className = 'dss-btn ask-preset-btn'
    b.textContent = p
    b.onclick = function () { askSend(p) }
    $('ask-presets').appendChild(b)
  })
}
if ($('ask-go')) $('ask-go').onclick = function () { askSend($('ask-q').value) }
if ($('ask-q')) $('ask-q').onkeydown = function (e) { if (e.key === 'Enter') askSend($('ask-q').value) }

async function refreshWebSourceNote(){
 try {const r=await fetch('/api/power-status');const d=await r.json();const x=d.sources;if(!x)return;const el=document.getElementById('web-source-note');const meter=x.egauge,solar=x.solar;el.textContent=(meter?.ok&&solar?.ok?'Direct web feeds: eGauge + Solar Assistant. ':'Web feed update unavailable. ')+ 'Switched from replay '+new Date(x.started_at).toLocaleString()+'. General-tab charts before this switch may contain replay; Predictions uses authenticated source history.';}catch(e){}
}
refreshWebSourceNote();setInterval(refreshWebSourceNote,30000);
</script>
</body>
</html>`
