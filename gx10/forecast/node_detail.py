"""Node-specific read-only dashboard details. No container-control access."""
from common import *
import subprocess,socket,threading
telemetry_lock=threading.Lock()
def read(name,default=None):
 p=DATA/name
 try:return json.loads(p.read_text())
 except (OSError,ValueError):return default if default is not None else {}
def utc(value):
 t=pd.Timestamp(value)
 return t.tz_localize('UTC') if t.tzinfo is None else t.tz_convert('UTC')
def age(value):
 try:return max(0,int((pd.Timestamp.now(tz='UTC')-utc(value)).total_seconds()))
 except Exception:return None
def safe_num(v):
 try:return float(v) if np.isfinite(float(v)) else None
 except (ValueError,TypeError):return None
def latest_raw(source):
 files=sorted((DATA/'web_observations').glob(source+'-*.jsonl'))[-2:]
 for p in reversed(files):
  with p.open('rb') as f:
   f.seek(max(0,p.stat().st_size-65536));lines=f.read().decode(errors='replace').splitlines()
  for line in reversed(lines):
   try:return json.loads(line)
   except ValueError:continue
 return {}
def sample_telemetry():
 try:
  out=subprocess.check_output(['nvidia-smi','--query-gpu=utilization.gpu,temperature.gpu,power.draw','--format=csv,noheader,nounits'],text=True,timeout=4).strip().split(',')
  row={'ts':pd.Timestamp.now(tz='UTC').isoformat(),'gpu_pct':safe_num(out[0]),'gpu_c':safe_num(out[1]),'gpu_w':safe_num(out[2])}
  with telemetry_lock:
   rows=read('node_telemetry.json',[]);rows=[r for r in rows if age(r['ts']) is not None and age(r['ts'])<86400];rows.append(row);save_json(DATA/'node_telemetry.json',rows[-2880:])
 except Exception:pass

_archive_cache={}
def archive_coverage(source,hours):
 import pyarrow.parquet as pq
 import pyarrow.dataset as ds
 import pyarrow as pa
 path=Path('/home/asus/nilm/data')/('solar_gx10.parquet' if source=='solar' else 'egauge_gx10.parquet')
 key=(source,hours,path.stat().st_mtime)
 if key in _archive_cache:return _archive_cache[key]
 meta=pq.read_metadata(path);col=meta.schema.names.index('ts');stats=[meta.row_group(i).column(col).statistics for i in range(meta.num_row_groups)];start=min(x.min for x in stats if x and x.has_min_max);end=max(x.max for x in stats if x and x.has_min_max)
 table=ds.dataset(path);typ=table.schema.field('ts').type;cut=utc(end)-pd.Timedelta(hours=hours);bound=cut.to_pydatetime() if typ.tz else cut.tz_localize(None).to_pydatetime();values=table.to_table(columns=['ts'],filter=ds.field('ts')>=pa.scalar(bound,type=typ)).column('ts').to_pandas();times=pd.to_datetime(values,utc=True);counts=pd.Series(1,index=pd.DatetimeIndex(times)).resample('15min').sum()
 result=(meta.num_rows,utc(start).isoformat(),utc(end).isoformat(),counts);_archive_cache[key]=result
 return result

def detail(node_id,hours,df,forecast):
 graph=read('system_graph.json');node=next((n for n in graph.get('nodes',[]) if n['id']==node_id),None)
 if node is None:raise KeyError(node_id)
 now=pd.Timestamp.now(tz='UTC');edges=[e for e in graph['edges'] if node_id in (e['source'],e['target'])]
 d={'node':node,'checked_at':now.isoformat(),'summary':'','facts':[],'charts':[],'connections':edges,'notes':[],'observed_at':None,'age_seconds':None,'freshness':'configuration snapshot'}
 def fact(label,value,unit='',at=None):
  d['facts'].append({'label':label,'value':value,'unit':unit,'at':at})
 def observed(at,limit=120):
  if at:
   d['observed_at']=str(at);d['age_seconds']=age(at);d['freshness']='current' if d['age_seconds'] is not None and d['age_seconds']<=limit else 'stale'
 def chart(title,unit,times,values,label='Measured',kind='line'):
  d['charts'].append({'title':title,'unit':unit,'kind':kind,'series':[{'name':label,'times':[str(t) for t in times],'values':[safe_num(v) for v in values]}]})
 def measured(columns):
  hist=df.loc[(df.index>=now-pd.Timedelta(hours=hours))&(df.index<now)].reindex(columns=columns)
  for col in columns:
   if col not in hist or not hist[col].notna().any():continue
   unit='%' if col=='solar__battery_soc' else 'V' if col.startswith('Vrms') else 'Hz' if col=='F1' else 'A' if col.startswith('I') or col=='Current on Utility Tie' else 'W'
   chart(col.replace('solar__','Solar · '),unit,hist.index,hist[col], 'Measured · 15-minute mean')
 def add_forecasts(labels):
  try:
   fc=forecast()
   for c in fc['channels']:
    if c['name'] not in labels or c.get('unavailable'):continue
    chart(c['name']+' · next 24 hours','W',fc['forecast_times'],c['forecast_w'],'Predicted · '+c['model'])
    fact(c['name']+' forecast energy',c['energy_kwh'],'kWh',fc['generated_at'])
   d['notes'].append('Forecast curves are model estimates. Grid is signed: positive import, negative export.')
  except Exception:d['notes'].append('Current forecasts are unavailable; measured data remains visible.')
 kind=node['kind'];src=read('web_source_status.json');model=read('champion.json');nid=node_id
 if kind=='meter channel' or kind=='meter':
  solar=nid=='Solar Assistant';raw=latest_raw('solar' if solar else 'egauge');vals=raw.get('values',{});ts=raw.get('ts');observed(ts)
  columns=(['solar__'+k for k in SOLAR] if solar else CHANNELS) if kind=='meter' else [nid]
  d['summary']=('Solar production, battery and grid flow read directly from Solar Assistant.' if solar else 'Authenticated eGauge measurements of the house circuits.' if kind=='meter' else nid+' is a measured eGauge channel.')
  for col in (SOLAR if solar else list(vals) if kind=='meter' else [nid]):
   v=safe_num(vals.get(col));v=abs(v) if v is not None and col in CHANNELS and col!='Grid Power' else v
   unit='%' if col=='battery_soc' else 'V' if col.startswith('Vrms') else 'Hz' if col=='F1' else 'A' if col.startswith('I') or col=='Current on Utility Tie' else 'W'
   fact(col,v,unit,ts)
  measured(columns);add_forecasts(['Solar PV'] if solar else CHANNELS if kind=='meter' else [nid])
  d['notes'].append('Latest cards use raw web observations; history curves show completed 15-minute intervals. Missing readings are gaps.')
 elif kind=='appliance' or nid=='iems-inference':
  d['summary']=('Estimated appliance activity from the NILM model, inferred from its panel measurement.' if kind=='appliance' else 'Disaggregates circuit readings into estimated appliance activity.')
  try:
   rows=get_json('http://127.0.0.1:47821/api/nilm',5)
   rows=[r for r in rows if kind!='appliance' or r.get('appliance')==nid]
   if rows:
    rows.sort(key=lambda r:utc(r['ts']));last=rows[-1];observed(utc(last['ts']).isoformat())
    if kind=='appliance':
     fact('Estimated state',last['state'].strip());fact('Model confidence',safe_num(last['confidence']));fact('Estimated power',safe_num(last['avg_w']),'W',str(utc(last['ts'])))
     chart('Recent estimated appliance power','W',[utc(r['ts']).isoformat() for r in rows],[r['avg_w'] for r in rows],'NILM estimate')
    else:fact('Appliances in recent output',len({r['appliance'] for r in rows}))
   else:d['notes'].append('No recent NILM output is available for this appliance.')
  except Exception:d['notes'].append('The appliance estimation feed is unavailable.')
  panel=next((e['source'] for e in edges if e['label']=='NILM association'),None)
  if panel:fact('Associated circuit',panel);measured([panel])
  if node.get('nominal_w') is not None:fact('Configured nominal power',node['nominal_w'],'W')
  d['notes'].append('Appliance estimates and nominal ratings are not independent appliance meter readings. The parent-panel graph is labeled separately; recent NILM history is limited to the available feed window.')
 elif kind=='hardware':
  d['summary']='GX10 NVIDIA GB10 hosts ingestion, GPU training, local models and dashboard services.';sample_telemetry();rows=read('node_telemetry.json',[])
  if rows:
   last=rows[-1];observed(last['ts'])
   for key,label,unit in [('gpu_pct','GPU utilization','%'),('gpu_c','GPU temperature','°C'),('gpu_w','GPU power','W')]:
    fact(label,last[key],unit,last['ts']);subset=[r for r in rows if age(r['ts'])<hours*3600];chart(label,unit,[r['ts'] for r in subset],[r[key] for r in subset])
  d['notes'].append('GPU history starts when node telemetry collection was deployed; it is not backfilled.')
 elif kind=='model' or nid in ['Model registry','Power forecasting API']:
  d['summary']='Predicts 15-minute panel, grid and solar power using measured history, calendar and forecast weather. Each channel uses its best validated model.'
  fact('Model version',model.get('version'));fact('Training hardware',model.get('device'));fact('Training cutoff',model.get('train_end'));fact('Last training result',read('training_status.json').get('status'))
  p=read('prediction_status.json');observed(p.get('checked_at'));fact('Latest prediction',p.get('origin'))
  metrics=model.get('test_metrics',[]);chart('Held-out average absolute forecast error','W',[x['channel'] for x in metrics],[x.get('mae_w') for x in metrics],'Test MAE',kind='bar')
  add_forecasts(CHANNELS+['Solar PV']);d['notes'].append('Test error is historical evaluation, not a guarantee of today’s forecast accuracy.')
 elif kind=='external' or nid=='readiness monitor':
  d['summary']='Local weather and utility warning context used for preparation advice.'
  try:
   r=get_json('http://127.0.0.1:47821/api/readiness',5);keys={'Open-Meteo':['weather'],'NWS alerts':['alerts'],'PG&E outage / PSPS':['outages','psps']}.get(nid,list(r['sources']))
   ats=[]
   for key in keys:
    s=r['sources'].get(key,{});ats.append(s.get('last_success'));fact(key+' source',s.get('status'));data=s.get('data')
    if key=='weather' and data:
     h=data['hourly'];times=[utc(x).isoformat() for x in h['time']]
     for col,label,unit in [('temperature_2m','Forecast temperature','°F'),('wind_gusts_10m','Forecast wind gusts','mph'),('precipitation','Forecast precipitation','mm')]:chart(label,unit,times,h[col],'Weather forecast')
    if key=='outages' and data:fact('Los Gatos affected customers',data.get('los_gatos_customers'));fact('Santa Clara County affected customers',data.get('county_customers'));fact('Utility data timestamp',data.get('updated_at'))
    if key=='alerts' and data is not None:
     fact('Active alerts',len(data));d['notes'] += [str(a.get('headline',a.get('event','Weather alert'))) for a in data]
    if key=='psps' and data:d['notes'] += [str(x.get('date'))+': '+(', '.join(map(str,x.get('levels',[]))) or 'No listed PSPS warning level') for x in data]
   valid=[a for a in ats if a];observed(min(valid) if valid else None,900)
   d['notes'] += [x['action']+': '+x['rationale'] for x in r.get('recommendations',[])]
   if not d['charts']:d['notes'].append('This source supplies current warning snapshots, not a numerical time-series history.')
  except Exception:d['notes'].append('Readiness source is currently unavailable.')
 elif kind=='dataset':
  d['summary']='Stored observations used as historical context or training input. The chart shows available data, not a live device reading.'
  if nid in ('eGauge archive March–October','solar archive August–September'):
   count,start,end,counts=archive_coverage('solar' if nid.startswith('solar') else 'egauge',hours)
   fact('Original stored rows',count);fact('First observation',start);fact('Last observation',end);observed(end,1800)
   chart('Original archive sample coverage','rows',counts.index,counts.values,'Stored rows per 15 minutes')
   d['notes'].append('The window ends at this archive’s last observation, not at the current time. Original archives are separate from newer web imports.')
  else:
   columns=['wx__'+k for k in WX] if 'weather' in nid.lower() else CHANNELS+['solar__'+k for k in SOLAR]
   if 'Web source' in nid:
    path=DATA/'direct_history.parquet';dataset=pd.read_parquet(path) if path.exists() else pd.DataFrame()
   else:dataset=df.reindex(columns=columns).dropna(how='all')
   fact('Recorded interval',15,'minutes');fact('Available intervals',len(dataset));fact('First interval',str(dataset.index.min()) if len(dataset) else None);fact('Last interval',str(dataset.index.max()) if len(dataset) else None)
   if len(dataset):
    observed(dataset.index.max().isoformat(),1800);hist=dataset.loc[dataset.index>=dataset.index.max()-pd.Timedelta(hours=hours)]
    chart('Observed fields available per interval','fields',hist.index,hist.reindex(columns=columns).notna().sum(axis=1),'Data coverage')
   d['notes'].append('Coverage counts non-missing values; zero power is a valid measurement. Window ends at the last available interval.')

 else:
  roles={'Authenticated web collector':'Reads authenticated eGauge and Solar Assistant websites, saves original observations and publishes current readings to AnyLog.','operator1':'Serves the local AnyLog measurement tables used by the dashboard and inference.','postgres':'Stores measurement tables behind AnyLog.','kafka':'Message broker for the optional producer pipeline. Direct web collection currently writes to AnyLog.','replay-producer':'Optional demonstration replay. It is not the current data source.','egauge-producer':'Optional LAN producer. The authenticated web collector currently supplies eGauge readings.','iems-dashboard':'Serves the dashboard, graphs and preparation recommendations.','iems-backend':'Combines measurements, inferred activity and readiness context into decision-support responses.'}
  d['summary']=roles.get(nid,nid+' is a configured service in the microgrid deployment. Its verified connections are listed below.')
  fact('Inventory status',node.get('status','Configured'));fact('Inventory checked',graph.get('updated_at'));d['notes'].append('Container inventory is a deployment snapshot, not a live container inspection.')
  units={'Authenticated web collector':'iems-web-collector.service'}
  if nid in units:
   state=subprocess.run(['systemctl','--user','is-active',units[nid]],capture_output=True,text=True,timeout=3).stdout.strip();fact('Current service state',state);observed(now.isoformat())
   for key in ['egauge','solar','history']:
    val=src.get(key,{});fact(key+' feed', 'OK' if val.get('ok') else 'Unavailable');fact(key+' latest',val.get('device_time') or val.get('received_at') or val.get('updated_at'))
   measured(['Grid Power','solar__pv_power']);d['notes'].append('Charts show the collector’s source measurements, not server resource usage.')
  ports={'postgres':5432,'kafka':9092,'master':32049,'operator1':32149,'iems-dashboard':47821,'iems-backend':8009,'Ollama':11434,'iems-knowledge-app-1':47822}
  if nid in ports:
   try:
    conn=socket.create_connection(('127.0.0.1',ports[nid]),timeout=1);conn.close();fact('Current port reachability','Reachable');observed(now.isoformat())
   except OSError:fact('Current port reachability','Unavailable');observed(now.isoformat())
   d['notes'].append('An open port confirms reachability only, not full application health.')
  if not d['charts']:d['notes'].append('No dedicated time-series telemetry is configured for this service. Connections and available status are shown instead.')
 if d['freshness']=='stale':d['notes'].insert(0,'Latest available data is stale. Values are shown with their original timestamps.')
 return d
