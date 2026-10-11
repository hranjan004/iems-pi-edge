"""Read-only appliance timing advice; explicit tariff scenario and cycle assumptions."""
from common import *
from itertools import permutations
import math
TARIFF_URL='https://www.pge.com/tariffs/assets/pdf/tariffbook/ELEC_SCHEDS_E-ELEC.pdf'
# Existing house configuration ranges and cycle durations, not independent meter measurements.
JOBS=[{'id':'washing_machine','label':'Washing machine','minutes':45,'low_w':200,'high_w':2000}, {'id':'dryer','label':'Clothes dryer','minutes':60,'low_w':4000,'high_w':7000}, {'id':'dishwasher','label':'Dishwasher','minutes':75,'low_w':200,'high_w':1800}]
def rate(t):
 local=pd.Timestamp(t).tz_convert(TZ);h=local.hour+local.minute/60;summer=6<=local.month<=9
 period='peak' if 16<=h<21 else 'partial' if 15<=h<16 or h>=21 else 'off'
 return {'peak':.55214,'partial':.39026,'off':.33358}[period] if summer else {'peak':.32063,'partial':.29854,'off':.28468}[period]
def peak_rate(t):return .55214 if 6<=pd.Timestamp(t).tz_convert(TZ).month<=9 else .32063
def stamp(t):
 p=pd.Timestamp(t).tz_convert(TZ);return p.strftime('%a %-I:%M %p')
def number(value):
 try:v=float(value);return v if np.isfinite(v) else None
 except (TypeError,ValueError):return None

def states(rows,now):
 result={}
 for r in rows:
  try:
   t=pd.Timestamp(r['ts']);t=t.tz_localize('UTC') if t.tzinfo is None else t.tz_convert('UTC')
   if not 0<=(now-t).total_seconds()<=180:continue
   key=r.get('appliance');conf=number(r.get('confidence'))
   if conf is None or conf<.6:continue
   if key not in result or t>result[key]['ts']:result[key]={'on':str(r.get('state','')).strip().upper()=='ON','confidence':conf,'ts':t}
  except (KeyError,ValueError):continue
 return result

def optimize(jobs,times,net,soc,pv,cloud,earliest=None,latest=None):
 """Exact search by ordering + dynamic programming; no overlapping optional cycles."""
 earliest=earliest or {};latest=latest or {};n=len(times);options={}
 for job in jobs:
  length=job['minutes']//15;watts=(job['low_w']+job['high_w'])/2;choices={}
  for i in range(earliest.get(job['id'],0),min(n-length,latest.get(job['id'],n))+1):
   ix=range(i,i+length);end=times[i]+pd.Timedelta(minutes=job['minutes']);start=times[i].tz_convert(TZ);finish=end.tz_convert(TZ)
   if start.hour<8 or finish.date()!=start.date() or finish.hour>21 or (finish.hour==21 and finish.minute):continue
   # Advisory planning buffer only. Never change the inverter's actual reserve setting.
   if np.min(soc[i:i+length])<30:continue
   added=np.maximum(net[i:i+length]+watts,0)-np.maximum(net[i:i+length],0)
   cost=float(sum(added[k-i]*rate(times[k])*.25/1000 for k in ix))
   # Tie-break toward earlier starts; cloud context is already part of power forecasts.
   choices[i]={'score':cost+i*1e-7,'import_cost_scenario':cost,'solar_kwh':float(np.sum(watts-added)*.25/1000),'cloud_pct':float(np.mean(cloud[i:i+length])),'solar_kw':float(np.mean(pv[i:i+length])/1000),'soc_min':float(np.min(soc[i:i+length]))}
  options[job['id']]=choices
 best=None
 for order in permutations(jobs):
  ids=[j['id'] for j in order]
  if 'washing_machine' in ids and 'dryer' in ids and ids.index('dryer')!=ids.index('washing_machine')+1:continue
  dp={0:(0.,[])}
  for job in order:
   nxt={};length=job['minutes']//15
   for free,(cost,path) in dp.items():
    for i,option in options[job['id']].items():
     if i<free:continue
     if job['id']=='dryer' and path and path[-1][0]['id']=='washing_machine' and i-free>8:continue
     end=i+length;value=cost+option['score']
     if end not in nxt or value<nxt[end][0]:nxt[end]=(value,path+[(job,i,option)])
   dp=nxt
  if dp:
   candidate=min(dp.values(),key=lambda x:x[0])
   if best is None or candidate[0]<best[0]:best=candidate
 return best[1] if best else []

def plan(power,battery,raw,nilm,readiness,now=None):
 now=now or pd.Timestamp.now(tz='UTC');times=pd.to_datetime(power['forecast_times'],utc=True);channels={c['name']:c for c in power['channels']};bc={c['name']:c for c in battery['channels']}
 if power.get('mode')!='live':raise ValueError('Scheduling requires live, verified source data')
 if pd.Timestamp(power['generated_at'])<now-pd.Timedelta(minutes=30):raise ValueError('Power forecast is stale')
 if not times.equals(pd.to_datetime(battery['forecast_times'],utc=True)):raise ValueError('Battery and power forecasts have different origins; refresh shortly')
 grid=channels['Grid Power'];solar=channels['Solar PV'];charge=bc['Battery state of charge'];temp=bc['Battery temperature']
 if solar.get('unavailable'):raise ValueError('Solar forecast unavailable')
 fields=[grid['forecast_w'],solar['forecast_w'],charge['forecast'],temp['forecast'],power['weather']['cloud_cover'],power['weather']['temperature_2m']]
 if any(len(a)!=96 or not all(number(x) is not None for x in a) for a in fields):raise ValueError('Incomplete forecast inputs')
 gridpoint=np.array(grid['forecast_w']);pv=np.array(solar['forecast_w']);soc=np.array(charge['forecast']);cloud=np.array(power['weather']['cloud_cover']);temperature=np.array(temp['forecast'])
 # Conservative export availability: use grid's upper interval, cap surplus by predicted PV.
 upper=np.array([u if number(u) is not None else p for u,p in zip(grid['upper_w'],gridpoint)])
 net=np.maximum(upper,-pv);observations=states(nilm,now);cards=[]
 add=lambda title,why,kind='info',**kw:cards.append({'action':title,'rationale':why,'severity':kind,**kw})
 data=raw.get('values',{});rawtime=pd.Timestamp(raw['ts']) if raw.get('ts') else None
 if rawtime is None or not 0<=(now-rawtime).total_seconds()<180:raise ValueError('Current Solar Assistant readings are stale')
 prepare=readiness.get('status')=='prepare'
 if prepare:add('Keep backup power available','There is a local weather or outage warning. Delay optional laundry and dishwasher cycles; keep your existing battery reserve.','high')
 active=[j for j in JOBS if observations.get(j['id'],{}).get('on')]
 for j in active:add('Let the '+j['label'].lower()+' finish','The appliance detector thinks it is running. Let this cycle finish before starting another large appliance.',appliance=j['id'],evidence='Inferred appliance state')
 pending=[j for j in JOBS if j not in active]
 busy=max([j['minutes']//15 for j in active],default=0)
 earliest={j['id']:busy for j in pending}
 latest={'dryer':11} if any(j['id']=='washing_machine' for j in active) else {}
 schedule=[] if prepare else optimize(pending,times,net,soc,pv,cloud,earliest,latest)
 planned=[]
 for job,i,context in schedule:
  length=job['minutes']//15;end=times[i]+pd.Timedelta(minutes=job['minutes']);average=sum(rate(t) for t in times[i:i+length])/length
  kwh=[job['low_w']*job['minutes']/60000,job['high_w']*job['minutes']/60000];savings=[max(0,k*(peak_rate(times[i])-average)) for k in kwh]
  verb='Start' if times[i]-now<=pd.Timedelta(minutes=20) else 'Wait until'
  local=times[i].tz_convert(TZ);day='Today' if local.date()==now.tz_convert(TZ).date() else 'Tomorrow' if local.date()==(now.tz_convert(TZ)+pd.Timedelta(days=1)).date() else local.strftime('%a')
  action=f"{job['label']}: {day}, {local.strftime('%-I:%M %p')}–{end.tz_convert(TZ).strftime('%-I:%M %p')}"
  reason=f"If needed, use this window. Solar forecast: {context['solar_kw']:.1f} kW; cloud cover: {context['cloud_pct']:.0f}%. "
  reason+=('Some of the cycle may use spare solar. ' if context['solar_kwh']>.1 else 'This window limits expected grid cost. ')
  reason+='Run one large appliance at a time.'
  saving=f"Estimated timing savings: ${savings[0]:.2f}–${savings[1]:.2f} versus running the same cycle on grid power at 4–9 PM."
  rec={'action':action,'rationale':reason,'appliance':job['id'],'start':times[i].isoformat(),'end':end.isoformat(),'duration_minutes':job['minutes'],'savings_text':saving,'estimated_cycle_kwh':kwh,'severity':'info','basis':'Configured appliance power range and cycle duration; not a measured per-appliance forecast','scenario':context}
  cards.append(rec);planned.append(rec)
 if pending and not schedule and not prepare:add('Wait for a better battery or daytime window','The forecast does not fit all requested optional cycles into 8 AM–9 PM while keeping a 30% planning buffer. Delay optional cycles and check again; no device settings were changed.')
 peak=[i for i,t in enumerate(times) if 16<=t.tz_convert(TZ).hour<21]
 if peak:
  low=float(np.min(soc[peak]));imports=float(np.maximum(gridpoint[peak],0).sum()*.25/1000)
  add('Save battery energy for 4–9 PM',f"Battery charge is forecast to reach about {low:.0f}% during that window; grid imports about {imports:.1f} kWh under current operating patterns. Keep your existing backup reserve. Avoid adding large optional loads then; do not force extra battery cycling just for these estimates.")
 outside=np.array(power['weather']['temperature_2m'])*9/5+32
 if np.max(outside)>82:add('Cool the house before 4 PM, if comfortable',f"Outdoor temperature may reach {np.max(outside):.0f}°F. Use available solar for cooling earlier, then keep a comfortable thermostat setting during 4–9 PM. No fixed dollar saving is assumed.")

 if not active and not planned:add('Only run appliances you actually need','Refrigerators, freezers, essential pumps and needed hot water should stay available. The plan never asks you to switch them off for savings.')
 return {'checked_at':now.isoformat(),'forecast_origin':power['origin'],'status':'prepare' if prepare else 'ready','headline':'Your next steps to use less expensive electricity','recommendations':cards,'plan':planned,'current':{'solar_w':data.get('pv_power'),'battery_soc':data.get('battery_soc'),'battery_temperature_f':data.get('battery_temperature'),'battery_temperature_forecast_max_f':float(np.max(temperature)),'grid_w':data.get('grid_power')},'tariff':{'name':'PG&E E-ELEC · current published rates','assumption':True,'rates_effective':'2026-06-01','source':TARIFF_URL,'note':'Planning example, not confirmed account enrollment. Export credits are unknown. Savings cover rate timing only; fixed charges, taxes, CCA adjustments and lost export credits are excluded.'},'method':'Joint minimum incremental grid-import-cost schedule for optional cycles; 8 AM–9 PM, no overlap, washer followed by dryer within two hours; running cycles are allowed their configured duration to finish. Export credit set to zero in the planning scenario, so this is not a guaranteed minimum total bill. Battery settings are held unchanged. The 30% SOC planning buffer is not a device setting.','freshness':{'power_generated_at':power['generated_at'],'battery_generated_at':battery['generated_at'],'solar_observed_at':raw.get('ts'),'appliance_states':'current inferred states, not independently metered future appliance usage'},'notes':['Appliance cycle energies are house-configuration estimates; choose only the cycles you need.','Forecast uncertainty and appliance identification errors can change the best window. Advice refreshes every minute.']}
