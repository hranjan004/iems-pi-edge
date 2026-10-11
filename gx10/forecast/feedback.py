"""Immutable issued forecasts and chronological residual learning from genuine outcomes."""
from common import *
import copy,tempfile,hashlib
MAPPING=dict(zip(LABELS,TARGETS))|{'Battery state of charge':'solar__battery_soc','Battery temperature':'solar__battery_temperature'}
def read(path,default):
 try:return json.loads(path.read_text())
 except (OSError,ValueError):return default

def record(payload,kind):
 if kind=='power' and (payload.get('mode')!='live' or payload.get('view')!='validated'):return payload
 result=copy.deepcopy(payload);state=read(DATA/'feedback_models.json',{});corrections=state.get('channels',{});keys=('forecast_w','lower_w','upper_w') if kind=='power' else ('forecast','lower','upper')
 correction_ids=[]
 for c in result['channels']:
  if c.get('unavailable'):continue
  base=c[keys[0]][:];c['base_forecast']=base;model=corrections.get(c['name'],{})
  # A correction never migrates silently to a different base-model version.
  valid=model.get('base_version')==payload['version'] and pd.Timestamp(model.get('fitted_at','1970-01-01T00:00:00Z'))<=pd.Timestamp(payload['origin'])
  bias=float(model.get('bias',0)) if valid else 0.;correction_ids.append(model.get('id','none') if valid else 'none')
  if bias:
   for key in keys:
    c[key]=[clip(c['name'],v+bias) if v is not None else None for v in c[key]]
   c['feedback_bias']=bias;c['feedback_id']=model['id'];c['feedback_validation_mae']=model['validation_mae']
   if kind=='power':
    v=np.array(c[keys[0]]);c['energy_kwh']=round(float(v.sum()*.25/1000),3)
    if c['name']=='Grid Power':c['import_kwh']=round(float(np.maximum(v,0).sum()*.25/1000),3);c['export_kwh']=round(float(np.maximum(-v,0).sum()*.25/1000),3)
 # One immutable forecast per origin/base/correction combination. Readers never see a partial file.
 ident=hashlib.sha256(json.dumps([kind,payload['origin'],payload['version'],correction_ids]).encode()).hexdigest()[:24]
 directory=DATA/'issued_forecasts';directory.mkdir(exist_ok=True);dest=directory/(ident+'.json')
 result['feedback_note']='Corrections are enabled per channel only after improved chronological validation on completed actual readings. Historical base-model bands are not recalibrated by the online correction.'
 if not dest.exists():
  audit={**result,'kind':kind,'issued_at':pd.Timestamp.now(tz='UTC').isoformat()}
  with tempfile.NamedTemporaryFile(mode='w',dir=directory,delete=False) as f:json.dump(audit,f,allow_nan=False);temp=Path(f.name)
  try:os.link(temp,dest)
  except FileExistsError:pass
  finally:temp.unlink(missing_ok=True)
 return result

def clip(name,value):
 if name=='Battery state of charge':return min(100,max(0,float(value)))
 if name not in ('Grid Power','Battery temperature'):return max(0,float(value))
 return float(value)

def matched_rows(d,actual,now):
 """Only forecasts truly issued before the target and fully finished actual bins."""
 issued=pd.Timestamp(d['issued_at']);origin=pd.Timestamp(d['origin']);out=[]
 for c in d['channels']:
  name=c['name'];col=MAPPING.get(name)
  if c.get('unavailable') or col not in actual:continue
  predicted=c.get('forecast_w',c.get('forecast'));base=c.get('base_forecast',predicted)
  for i,t in enumerate(pd.to_datetime(d['forecast_times'],utc=True)):
   if issued>t or t+pd.Timedelta(minutes=15)>now or t not in actual.index:continue
   y=actual.at[t,col]
   if not all(np.isfinite(v) for v in [y,predicted[i] if predicted[i] is not None else np.nan,base[i] if base[i] is not None else np.nan]):continue
   out.append({'channel':name,'time':t,'issued':issued,'version':d['version'],'actual':float(y),'prediction':float(predicted[i]),'base':float(base[i]),'lead_minutes':float((t-origin).total_seconds()/60)})
 return out

def learn(actual,versions):
 now=pd.Timestamp.now(tz='UTC');rows=[]
 for p in (DATA/'issued_forecasts').glob('*.json'):
  d=read(p,{})
  if not d or pd.Timestamp(d['origin'])<now-pd.Timedelta(days=30):continue
  rows.extend(matched_rows(d,actual,now))
 state=read(DATA/'feedback_models.json',{'channels':{}});report={'checked_at':now.isoformat(),'channels':[],'policy':'At least 24 distinct completed target times per base version. Earliest 75% fit; latest 25% validation. Correction must improve validation MAE by 1%. Duplicate horizons do not inflate sample counts.'}
 for name in MAPPING:
  version=versions['battery' if name.startswith('Battery') else 'power'];rr=[r for r in rows if r['channel']==name and r['version']==version]
  # Use the latest eligible issue for each target, not 96 overlapping copies of the same truth.
  unique={}
  for r in sorted(rr,key=lambda r:r['issued']):unique[r['time']]=r
  rr=sorted(unique.values(),key=lambda r:r['time']);entry={'name':name,'base_version':version,'matched_intervals':len(rr),'status':'waiting for 24 completed observations'}
  if rr:
   entry['mae']=float(np.mean([abs(r['actual']-r['prediction']) for r in rr]));entry['latest_actual']=rr[-1]['time'].isoformat()
  if len(rr)>=24:
   cut=int(len(rr)*.75);fit=rr[:cut];hold=rr[cut:];bias=float(np.median([r['actual']-r['base'] for r in fit]));old=state['channels'].get(name,{})
   oldbias=float(old.get('bias',0)) if old.get('base_version')==version else 0.
   score=lambda b:float(np.mean([abs(r['actual']-clip(name,r['base']+b)) for r in hold]))
   oldscore=score(oldbias);newscore=score(bias);promote=newscore<oldscore*.99
   entry.update(status='correction promoted' if promote else 'current correction retained',validation_mae=newscore,previous_validation_mae=oldscore,fit_intervals=len(fit),validation_intervals=len(hold))
   if promote:state['channels'][name]={'id':now.strftime('%Y%m%dT%H%M%SZ'),'base_version':version,'bias':bias,'fitted_at':now.isoformat(),'fit_through':fit[-1]['time'].isoformat(),'validation_through':hold[-1]['time'].isoformat(),'validation_mae':newscore}
  report['channels'].append(entry)
 state['updated_at']=now.isoformat();save_json(DATA/'feedback_models.json',state);save_json(DATA/'feedback_status.json',report)
 return report
