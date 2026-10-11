"""GX10 20-minute learning cycle; measured history, immutable forecasts, gated candidates."""
from common import *
import sys,subprocess,shutil,fcntl,time
from device_clients import Meter,Solar,merge_history
from feedback import learn

def main():
 lock=(DATA/'relearn.lock').open('w')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:return
 started=pd.Timestamp.now(tz='UTC');run=Path('/home/asus/forecast-runs')/('recurrent-'+started.strftime('%Y%m%dT%H%M%SZ'));run.mkdir(parents=True)
 state={'status':'running','started_at':started.isoformat(),'interval_minutes':20,'run':str(run),'stages':{}}
 def status(**kw):state.update(kw);save_json(DATA/'recurrent_status.json',state);save_json(run/'run.json',state)
 def publish(src):
  dest=DATA/src.name;tmp=dest.with_suffix(dest.suffix+'.recurrent-tmp');shutil.copy2(src,tmp);tmp.replace(dest)
 def versions():return {'power':json.loads((DATA/'champion.json').read_text())['version'],'battery':json.loads((DATA/'battery_champion.json').read_text())['version']}
 try:
  status(stage='refreshing actual readings')
  initial=versions();end=pd.Timestamp.now(tz='UTC').floor('15min');start=end-pd.Timedelta(days=3);m=Meter();s=Solar()
  for a in pd.date_range(start,end-pd.Timedelta(days=1),freq='D'):merge_history(m.history(a,a+pd.Timedelta(days=1)),DATA/'direct_history.parquet')
  merge_history(s.history(start,end),DATA/'direct_history.parquet')
  actual=pd.read_parquet(DATA/'direct_history.parquet');feedback=learn(actual,initial)
  status(stage='preparing training snapshot',feedback_matches=sum(x['matched_intervals'] for x in feedback['channels']))
  for p in ROOT.glob('*.py'):shutil.copy2(p,run/p.name)
  (run/'packages').symlink_to(ROOT/'packages',target_is_directory=True);rd=run/'data';rd.mkdir()
  files={'series.parquet','direct_history.parquet','live_weather.json','champion.json','battery_champion.json','neural_latest.pt'}
  for name in ('champion.json','battery_champion.json'):
   meta=json.loads((DATA/name).read_text());files.add(meta['file']);files.update(meta.get('boost_files',[]))
  for name in files:
   if (DATA/name).exists():shutil.copy2(DATA/name,rd/name)
  # Reuse the full previously deduplicated archive. Add genuine web intervals, never replay.
  d=pd.read_parquet(rd/'direct_history.parquet').combine_first(pd.read_parquet(rd/'series.parquet')).sort_index();d=d[d.index<end];d=d.reindex(pd.date_range(d.index.min(),d.index.max(),freq='15min'))
  # Refresh recent archived forecasts; only issue-safe past forecasts enter evaluation.
  for kind,prefix in [('history','wx__'),('prior','future__')]:
   suffix='_previous_day2' if kind=='prior' else '';base='https://previous-runs-api.open-meteo.com/v1/forecast' if kind=='prior' else 'https://historical-forecast-api.open-meteo.com/v1/forecast'
   params={'latitude':37.24,'longitude':-121.96,'start_date':str(start.date()),'end_date':str(end.date()),'hourly':','.join(k+suffix for k in WX),'models':'gfs_seamless','timezone':'UTC'}
   response=get_json(base+'?'+urllib.parse.urlencode(params));h=response['hourly'];w=pd.DataFrame({k:h[k+suffix] for k in WX},index=pd.to_datetime(h['time'],utc=True));expanded=expand_weather(w,d.index)
   for k in WX:d[prefix+k]=expanded[k].combine_first(d[prefix+k])
  d.to_parquet(rd/'series.parquet');status(data_through=str(d.index.max()),rows_15min=len(d))
  env={**os.environ,'FORECAST_ROOT':str(run),'FORECAST_CANDIDATE_ONLY':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2'}
  results={}
  for family,scripts in [('power',['train.py','boost.py']),('battery',['battery.py'])]:
   status(stage='training '+family)
   try:
    for script in scripts:
     with (run/(script+'.log')).open('w') as log:subprocess.run([sys.executable,'-u',str(run/script)],cwd=run,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=480,check=True)
    report=json.loads((rd/('training_status.json' if family=='power' else 'battery_training_status.json')).read_text());version=report['version']
    detail=json.loads((rd/('report_'+version+'_boost.json' if family=='power' else 'battery_report_'+version+'.json')).read_text())
    if versions()[family]!=initial[family]:raise RuntimeError('Live model changed during validation')
    # Files are in place before the small atomic champion switch. Preserve old model for rollback.
    for p in rd.iterdir():
     if version in p.name or (family=='power' and p.name=='neural_latest.pt'):publish(p)
    if detail['promoted']:publish(rd/('champion.json' if family=='power' else 'battery_champion.json'))
    publish(rd/('training_status.json' if family=='power' else 'battery_training_status.json'))
    results[family]={'status':'complete','candidate_version':version,'promoted':detail['promoted'],'validation_score':detail['validation_score'],'previous_validation_score':detail['previous_validation_score'],'device':detail.get('device')}
   except Exception as e:results[family]={'status':'failed','error':str(e),'logs':str(run)}
   state['stages']=results;status()
  publish(rd/'series.parquet')
  summary=json.loads((DATA/'data_report.json').read_text());summary.update(built_at=pd.Timestamp.now(tz='UTC').isoformat(),end=str(d.index.max()),rows_15min=len(d),source='Original archive plus authenticated web observations; recurrent refresh; replay excluded');save_json(DATA/'data_report.json',summary)
  status(status='complete' if all(x['status']=='complete' for x in results.values()) else 'partial failure',stage='finished',completed_at=pd.Timestamp.now(tz='UTC').isoformat(),active_versions=versions())
  print(json.dumps(state,indent=2),flush=True)
  if state['status']!='complete':raise RuntimeError('One or more model families failed; deployed champions retained')
 except Exception as e:
  status(status='failed',error=str(e),completed_at=pd.Timestamp.now(tz='UTC').isoformat());raise
if __name__=='__main__':main()
