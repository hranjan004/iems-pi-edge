'use strict'
// Public, read-only feeds. No appliance or battery control.
const fs = require('fs')
const FILE = process.env.READINESS_FILE || '/data/readiness.json'
const LAT = Number(process.env.HOUSE_LAT || 37.24), LON = Number(process.env.HOUSE_LON || -121.96)
const PGE = 'https://ewapi.cloudapi.pge.com/'
const SOURCES = {
  weather: 'https://api.open-meteo.com/v1/forecast?latitude='+LAT+'&longitude='+LON+'&hourly=temperature_2m,wind_gusts_10m,precipitation&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_hours=24&timezone=UTC',
  alerts: 'https://api.weather.gov/alerts/active?point='+LAT+','+LON,
  outages: PGE+'aggregate-outage-data?level=Santa%20Clara',
  psps: PGE+'seven-day-weather-forecast',
}
let state = { sources: {} }, running = false
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch {}
function parse(name, d) {
  if (name === 'weather') {
    const h = d.hourly
    if (!h || !h.time?.length || !h.wind_gusts_10m?.some(Number.isFinite) || !h.temperature_2m?.some(Number.isFinite)) throw Error('Missing forecast data')
    return { high_f: Math.max(...h.temperature_2m.filter(Number.isFinite)), max_gust_mph: Math.max(...h.wind_gusts_10m.filter(Number.isFinite)), hourly: h }
  }
  if (name === 'alerts') {
    if (!Array.isArray(d.features)) throw Error('Invalid NWS alert response')
    return d.features.map(f => ({event:f.properties.event, severity:f.properties.severity, headline:f.properties.headline, expires:f.properties.expires}))
  }
  if (name === 'outages') {
    const county = d.results?.find(r => r.level === 'county' && r.display.toLowerCase() === 'santa clara')
    if (!county || !Array.isArray(county.value) || !Number.isFinite(Date.parse(d.current_outage_last_upload_time))) throw Error('Missing county outage data')
    const rows = county.value.filter(r => r.outage_type !== 'DISPLAY')
    if (rows.some(r => !Number.isFinite(Number(r.count)) || Number(r.count)<0)) throw Error('Invalid customer count')
    return { updated_at:d.current_outage_last_upload_time, forecast_updated_at:d.forecasted_outage_last_upload_time, rows, county_events:county.county_events || [], los_gatos_customers: rows.filter(r => r.city.toLowerCase()==='los gatos' && r.outage_type==='CURRENT').reduce((s,r)=>s+Number(r.count),0), county_customers:rows.filter(r=>r.outage_type==='CURRENT').reduce((s,r)=>s+Number(r.count),0) }
  }
  if (!Array.isArray(d.days) || !d.days.length || d.days.length !== d.dates?.length || d.days.some(day => ['elevated','watch','warning'].some(k => !Array.isArray(day[k])))) throw Error('Invalid PSPS forecast')
  return d.days.map((day,i) => ({date:d.dates[i], levels:['elevated','watch','warning'].filter(k=>day[k].some(c=>c.toLowerCase()==='santa clara'))}))
}
function snapshot(now=Date.now()) {
  const sources = JSON.parse(JSON.stringify(state.sources || {}))
  for (const [name,s] of Object.entries(sources)) {
    s.stale = !s.last_success || now-Date.parse(s.last_success)>15*60000
    if (name==='outages' && s.data && now-Date.parse(s.data.updated_at)>45*60000) s.stale=true
    if (name==='psps' && s.data) {
      const today = new Date(now).toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'2-digit',day:'2-digit',year:'numeric'})
      if (!s.data.some(d=>d.date===today)) s.stale=true
    }
    s.usable = s.status==='ok' && !s.stale
  }
  const recs=[]
  const add=(action,rationale,severity='info')=>recs.push({action,rationale,severity,type:'readiness',audience:'homeowner'})
  const outage=sources.outages?.usable ? sources.outages.data : null
  const weather=sources.weather?.usable ? sources.weather.data : null
  const alerts=sources.alerts?.usable ? sources.alerts.data.filter(a=>!a.expires || Date.parse(a.expires)>now) : []
  const psps=sources.psps?.usable ? sources.psps.data.filter(d=>d.levels.length) : []
  const severe=alerts.filter(a=>['Extreme','Severe'].includes(a.severity) || /Red Flag|High Wind|Fire Weather|Flood|Thunderstorm/i.test(a.event))
  const local=outage?.los_gatos_customers>0
  const planned=outage?.rows?.some(r=>r.city.toLowerCase()==='los gatos' && r.outage_type!=='CURRENT' && Number(r.count)>0)
  const prepare=local || planned || psps.length>0 || severe.length>0 || weather?.max_gust_mph>=35
  if (prepare) add('Keep backup power ready', local ? 'PG&E reports customers without power in Los Gatos. Check your address and save battery power for essential loads.' : 'Weather or a county PSPS warning could affect power. Check your backup charge and postpone optional heavy loads.', 'high')
  if (planned) add('Check the planned outage', 'PG&E lists a future outage affecting customers in Los Gatos. Check your address and expected times on the official map.', 'high')
  if (psps.length) add('Check PG&E shutoff updates', 'Santa Clara County: '+psps.map(d=>d.date+' '+d.levels.join(', ')).join('; ')+'. A county warning does not confirm an outage at your home.', 'high')
  if (severe.length) add('Review the local weather warning',severe.map(a=>a.headline || a.event).join(' · '),'high')
  if (weather?.max_gust_mph>=35) add('Prepare for strong wind', 'Forecast gusts reach '+Math.round(weather.max_gust_mph)+' mph in the next 24 hours. Charge phones and check backup supplies.')
  if (weather?.high_f>=95) add('Keep cooling available','The next 24 hours may reach '+Math.round(weather.high_f)+'°F. Keep essential cooling running; delay optional appliances.')
  if (outage?.county_customers>0 && !local) add('Watch nearby outages', 'PG&E reports '+outage.county_customers+' affected customers across Santa Clara County; '+outage.los_gatos_customers+' in Los Gatos. This does not predict an outage at your home.')
  const missing=Object.keys(SOURCES).filter(k=>!sources[k]?.usable)
  if (missing.length) add('Check missing updates', 'Unavailable or stale: '+missing.join(', ')+'. Check the official outage map before relying on a normal status.')
  if (!prepare && !missing.length) add('Continue your normal routine', 'No local warning signs met the preparation rules. Keep your usual backup reserve; conditions can change.')
  return {location:'Los Gatos, CA',lat:LAT,lon:LON,nearby_scope:'Santa Clara County (not a distance radius)',checked_at:state.checked_at,interval_seconds:300,status:prepare?'prepare':missing.length?'unknown':'monitor',sources,recommendations:recs,advisory_only:true}
}
async function poll() {
  if(running) return
  running=true
  try {
    await Promise.all(Object.entries(SOURCES).map(async([name,url])=>{
      const old=state.sources[name] || {}
      try {
        const r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'IEMS-LosGatos/1.0','Accept':'application/json'}})
        if(!r.ok) throw Error('HTTP '+r.status)
        const data=parse(name,await r.json())
        state.sources[name]={url,status:'ok',last_success:new Date().toISOString(),data}
      } catch(e) {state.sources[name]={...old,url,status:'error',error:e.message}}
    }))
    state.checked_at=new Date().toISOString()
    try { fs.mkdirSync(require('path').dirname(FILE),{recursive:true}); fs.writeFileSync(FILE+'.tmp',JSON.stringify(state)); fs.renameSync(FILE+'.tmp',FILE) } catch(e) {console.error('[readiness] persistence:',e.message)}
    console.log('[readiness]',state.checked_at,snapshot().status)
  } finally { running=false }
}
function start(){poll();setInterval(poll,300000).unref()}
module.exports={parse,snapshot,poll,start,_setState:s=>{state=s}}
