from model import *
from fastapi import FastAPI,HTTPException
import subprocess,threading,time
app=FastAPI(title='GX10 measured power forecasts')
lock=threading.Lock();cache={};df_cache=None;mtime=None
torch.set_num_threads(2)
def source_clock():
 p=DATA/'web_source_status.json'
 if p.exists():
  d=json.loads(p.read_text());meter=d.get('egauge',{});solar=d.get('solar',{})
  if meter.get('ok') and solar.get('ok'):
   now=pd.Timestamp.now(tz='UTC')
   if now-pd.Timestamp(meter['device_time'])<pd.Timedelta(seconds=120) and now-pd.Timestamp(solar['received_at'])<pd.Timedelta(seconds=120):
    return now.ceil('15min'),'live',{'source':'Authenticated eGauge and Solar Assistant web feeds','egauge_time':meter['device_time'],'solar_received_at':solar['received_at']}
  return None,'unavailable',{'source':'Direct web feeds stale or unavailable'}
 try:
  d=get_json('http://127.0.0.1:8099/status',3)
  if d.get('source_time_utc'):return pd.Timestamp(d['source_time_utc']).floor('15min'),'replay',d
 except Exception:pass
 # Never mistake a dead replay endpoint for a real meter.
 return None,'unavailable',{}
def dataset():
 global df_cache,mtime
 p=DATA/'series.parquet';live=DATA/'live_genuine.parquet';direct=DATA/'direct_history.parquet';m=(p.stat().st_mtime,live.stat().st_mtime if live.exists() else 0,direct.stat().st_mtime if direct.exists() else 0)
 if m!=mtime:
  df_cache=pd.read_parquet(p)
  if live.exists():
   df_cache=pd.concat([df_cache,pd.read_parquet(live)]);df_cache=df_cache[~df_cache.index.duplicated(keep='last')].sort_index()
  if direct.exists():df_cache=pd.read_parquet(direct).combine_first(df_cache).sort_index()
  mtime=m
 return df_cache
@app.get('/health')
def health():return {'ok':True,'model_ready':(DATA/'champion.json').exists()}
@app.get('/status')
def status():
 return {k:json.loads((DATA/name).read_text()) if (DATA/name).exists() else None for k,name in [('training','training_status.json'),('model','champion.json'),('data','data_report.json'),('sources','web_source_status.json'),('web_import','direct_import_report.json'),('recurrent','recurrent_status.json'),('feedback','feedback_status.json'),('battery_training','battery_training_status.json')]}
@app.get('/system')
def system():
 p=DATA/'system_graph.json'
 if not p.exists():raise HTTPException(503,'System graph is being built')
 d=json.loads(p.read_text())
 try:
  d['inventory_note']='Container inventory is a verified deployment snapshot from '+str(d.get('updated_at'))
  gpu=subprocess.check_output(['nvidia-smi','--query-gpu=name,utilization.gpu,temperature.gpu,power.draw','--format=csv,noheader,nounits'],text=True,timeout=3).strip().split(', ')
  d['gpu']={'name':gpu[0],'utilization_pct':float(gpu[1]),'temperature_c':float(gpu[2]),'power_w':float(gpu[3]),'checked_at':pd.Timestamp.now(tz='UTC').isoformat()}
 except Exception as e:d['telemetry_error']=str(e)
 return d

_dss_cache={}
@app.get('/dss-plan')
def dss_plan():
 now=pd.Timestamp.now(tz='UTC')
 if _dss_cache and (now-_dss_cache['at']).total_seconds()<60:return _dss_cache['data']
 try:
  from smart_dss import plan
  from feedback import record
  from node_detail import latest_raw
  result=plan(record(make_forecast(),'power'),battery_forecast(),latest_raw('solar'),get_json('http://127.0.0.1:47821/api/nilm',5),get_json('http://127.0.0.1:47821/api/readiness',5))
  _dss_cache.update(at=now,data=result);return result
 except Exception as e:raise HTTPException(503,'Advice temporarily unavailable: '+str(getattr(e,'detail',e)))

@app.get('/battery-forecast')
def battery_forecast():
 origin,mode,_=source_clock()
 if origin is None or mode!='live':raise HTTPException(503,'Live battery source unavailable')
 try:
  from battery import forecast
  result=dict(forecast(origin))
  from node_detail import latest_raw
  result['latest']=latest_raw('solar')
  from feedback import record
  return record(result,'battery')
 except FileNotFoundError:raise HTTPException(503,'Battery model is being prepared')
 except Exception as e:raise HTTPException(503,str(e))

@app.get('/node-detail')
def node_detail(id:str,hours:int=24):
 if hours not in (1,6,24,72):raise HTTPException(400,'Supported windows: 1, 6, 24, 72 hours')
 from node_detail import detail
 try:
  from feedback import record
  return detail(id,hours,dataset(),lambda:record(make_forecast(),'power'))
 except KeyError:raise HTTPException(404,'Unknown system node')


def make_forecast(origin=None,view='validated'):
 now,mode,replay=source_clock()
 if origin:
  origin=pd.Timestamp(origin)
  if origin.tzinfo is None:raise HTTPException(400,'Origin must include a UTC offset')
  origin=origin.tz_convert('UTC').floor('15min');mode='historical inspection'
 elif now is None:raise HTTPException(503,'Verified source readings are unavailable or stale. Forecast withheld.')
 else:origin=now
 report=json.loads((DATA/'champion.json').read_text());ck=torch.load(DATA/report['file'],map_location='cpu',weights_only=False)
 calibrated=pd.Timestamp(report['calibration_range'][1])+pd.Timedelta(minutes=15)
 if origin<calibrated:raise HTTPException(422,'Choose an origin after calibration ended: '+str(calibrated))
 df=dataset()
 if origin>df.index.max()+pd.Timedelta(minutes=30 if mode=='live' else 15):raise HTTPException(503,'No recent verified source history. Archive ends '+str(df.index.max())+'. Replayed samples are not new training observations.')
 if origin<df.index.min()+pd.Timedelta(days=1):raise HTTPException(422,'At least one day of context is required')
 if view not in ['validated','weather-aware']:raise HTTPException(400,'Unknown forecast view')
 key=(str(origin),report['version'],report['file'],view)
 if key in cache:return cache[key]
 with lock:
  end=origin+pd.Timedelta(minutes=15*(H-1));idx=pd.date_range(df.index.min(),max(df.index.max(),end),freq='15min');work=df.reindex(idx).copy()
  i=idx.get_loc(origin)
  if mode=='live':
   wp=DATA/'live_weather.json'
   if not wp.exists():raise HTTPException(503,'Live forecast weather unavailable')
   wd=json.loads(wp.read_text());issued=pd.Timestamp(wd['fetched_at'])
   if pd.Timestamp.now(tz='UTC')-issued>pd.Timedelta(hours=2):raise HTTPException(503,'Live weather forecast is stale')
   hourly=wd['response']['hourly'];wf=pd.DataFrame({k:hourly[k] for k in WX},index=pd.to_datetime(hourly['time'],utc=True));expanded=expand_weather(wf,idx)
   for k in WX:
    work.loc[idx>=origin,'future__'+k]=expanded.loc[idx>=origin,k]
    recent=(idx<origin)&(idx>=wf.index.min());work.loc[recent,'wx__'+k]=expanded.loc[recent,k]
  history=work.iloc[i-L:i][TARGETS]
  if history[CHANNELS].notna().mean().min()<.8:raise HTTPException(503,'Less than 80% recent meter coverage; forecast withheld')
  # Archive replay uses the weather forecast issued for that source date. No today's weather mixed into old demand.
  if work.iloc[i:i+H][['future__'+c for c in WX]].notna().mean().min()<.8:raise HTTPException(503,'Archived issue-safe weather forecasts unavailable for this horizon')
  arr=arrays(work,ck['scaler']);candidates=all_candidates(ck,arr,[i]);selected=ck['chosen'] if view=='validated' else ['xgboost']*len(TARGETS);point=np.stack([candidates[k][0,:,j] for j,k in enumerate(selected)],-1);q=ck['interval'];lower=constrain(point-q);upper=constrain(point+q)
  times=idx[i:i+H];histidx=idx[i-L:i]
  def values(a):return [round(float(v),2) if np.isfinite(v) else None for v in a]
  channels=[]
  for j,label in enumerate(LABELS):
   p=point[:,j]
   if label=='Solar PV' and history.iloc[:,j].notna().mean()<.8 and selected[j] in ('daily','weekly','persistence'):
    channels.append({'name':label,'unavailable':'Insufficient recent measured solar history for the selected baseline; weather-aware model remains available.'});continue
   channels.append({'name':label,'model':selected[j],'history_w':values(history.iloc[:,j]),'forecast_w':values(p),'lower_w':values(lower[:,j]) if view=='validated' else [None]*H,'upper_w':values(upper[:,j]) if view=='validated' else [None]*H,'energy_kwh':round(float(p.sum()*.25/1000),3),'import_kwh':round(float(np.maximum(p,0).sum()*.25/1000),3) if label=='Grid Power' else None,'export_kwh':round(float(np.maximum(-p,0).sum()*.25/1000),3) if label=='Grid Power' else None,'test_mae_w':(report['test_metrics'] if view=='validated' else report['test_baselines']['xgboost'])[j]['mae_w'],'test_coverage':report['test_interval_coverage'].get(label) if view=='validated' else None})
  w=work.iloc[i:i+H];payload={'origin':origin.isoformat(),'generated_at':pd.Timestamp.now(tz='UTC').isoformat(),'mode':mode,'source_clock':replay,'horizon_hours':24,'step_minutes':15,'version':report['version'],'view':view,'history_times':[x.isoformat() for x in histidx],'forecast_times':[x.isoformat() for x in times],'channels':channels,'weather':{c:values(w['future__'+c]) for c in WX},'sun_elevation_deg':values(calendar(times)[:,7]*90),'weather_source':('Latest Open-Meteo GFS forecast, captured before forecast origin' if mode=='live' else 'Archived GFS forecasts issued 48 hours before valid time (source-date replay)'),'train_end':report['train_end'],'calibration_end':report['calibration_range'][1],'data_quality':{'solar_history_coverage':float(history['solar__pv_power'].notna().mean()),'meter_history_coverage':float(history[CHANNELS].notna().mean().mean())},'notes':['Forecasts are 15-minute mean watts, not instantaneous appliance switching.','Grid is signed: positive import, negative export.','Shaded bands are empirical 80% calibration bands; actual test coverage is shown per channel.',('Genuine meter observations; future values are forecasts.' if mode=='live' else 'The meter is replaying recorded history. Forecast timestamps and weather follow the source date. Replayed samples do not trigger relearning.')]}
  cache[key]=payload
  if len(cache)>24:cache.pop(next(iter(cache)))
  logs=DATA/'predictions';logs.mkdir(exist_ok=True)
  if mode in ('replay','live') and view=='validated':save_json(logs/(origin.strftime('%Y%m%dT%H%M')+'.json'),payload)
  return payload
@app.get('/forecast')
def forecast(origin:str|None=None,view:str='validated'):
 try:
  from feedback import record
  return record(make_forecast(origin,view),'power')
 except HTTPException:raise
 except Exception as e:raise HTTPException(503,str(e))
@app.get('/accuracy')
def accuracy():
 clock,mode,_=source_clock()
 if clock is None:return {'status':'clock unavailable','channels':[]}
 df=dataset();errors={x:[] for x in LABELS};count=0
 for p in sorted((DATA/'predictions').glob('*.json'))[-192:]:
  d=json.loads(p.read_text())
  if d.get('mode')!=mode:continue
  idx=pd.to_datetime(d['forecast_times'],utc=True);eligible=idx<clock;actual=df.reindex(idx)
  for j,c in enumerate(d['channels']):
   if c.get('unavailable'):continue
   y=actual[TARGETS[j]].to_numpy();pred=np.array(c['forecast_w']);mask=eligible&np.isfinite(y)&np.isfinite(pred)
   errors[LABELS[j]].extend(np.abs(y[mask]-pred[mask]).tolist())
  count+=1
 return {'mode':('Observed live forecast error' if mode=='live' else 'Replay forecast error; not independent live validation'),'as_of':str(clock),'forecast_origins':count,'channels':[{'name':k,'n':len(v),'mae_w':float(np.mean(v)) if v else None} for k,v in errors.items()]}

@app.on_event('startup')
def scheduled_predictions():
 def run():
  while True:
   try:
    from feedback import record
    result=record(make_forecast(),'power');save_json(DATA/'prediction_status.json',{'ok':True,'origin':result['origin'],'mode':result['mode'],'version':result['version'],'checked_at':pd.Timestamp.now(tz='UTC').isoformat()})
   except Exception as e:save_json(DATA/'prediction_status.json',{'ok':False,'error':getattr(e,'detail',type(e).__name__),'checked_at':pd.Timestamp.now(tz='UTC').isoformat()})
   try:battery_forecast()
   except Exception as e:save_json(DATA/'battery_prediction_status.json',{'ok':False,'error':getattr(e,'detail',str(e)),'checked_at':pd.Timestamp.now(tz='UTC').isoformat()})
   time.sleep(60)
 threading.Thread(target=run,daemon=True).start()

@app.on_event('startup')
def scheduled_node_telemetry():
 def run():
  from node_detail import sample_telemetry
  while True:
   sample_telemetry();time.sleep(30)
 threading.Thread(target=run,daemon=True).start()
