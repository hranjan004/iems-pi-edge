"""Read-only collection of genuine meter observations, gated on live producer provenance."""
from common import *
import subprocess,importlib.util

def provenance():
 if not os.access('/var/run/docker.sock',os.R_OK|os.W_OK):return None
 names=set(subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True,timeout=5).splitlines())
 if 'replay-producer' in names:return None
 if 'egauge-producer' not in names:return None
 info=json.loads(subprocess.check_output(['docker','inspect','egauge-producer','--format','{{json .State}}'],text=True,timeout=5))
 return pd.Timestamp(info['StartedAt'])
def collect():
 started=provenance()
 if started is None:
  save_json(DATA/'collector_status.json',{'mode':'replay or unverified','note':'No learning from replay. Automatic live ingestion requires readable producer provenance, currently unavailable to this unprivileged service. New original archive exports remain eligible for retraining.'});return
 now=pd.Timestamp.now(tz='UTC');since=max(started,now-pd.Timedelta(minutes=45))
 spec=importlib.util.spec_from_file_location('al_query',ROOT.parents[1]/'services/iems/load/anylog_query.py');al=importlib.util.module_from_spec(spec);spec.loader.exec_module(al)
 stamp=since.strftime('%Y-%m-%d %H:%M:%S')
 rows=al.anylog_query(f"SELECT ts, nm, w FROM energy_readings WHERE ts >= '{stamp}' ORDER BY ts ASC")
 if not rows:raise RuntimeError('Verified live producer has no recent meter rows')
 d=pd.DataFrame(rows);d['ts']=pd.to_datetime(d.ts,utc=True,format='mixed');d['w']=pd.to_numeric(d.w,errors='coerce');d=d[d.ts>=started].drop_duplicates(['ts','nm'])
 frames=[]
 for nm,g in d.groupby('nm'):
  g=g.sort_values('ts').set_index('ts');support=g.index.to_series().diff().dt.total_seconds().clip(0,30).resample('15min').sum()/900;v=g.w.resample('15min').mean().where(support>=.6)
  if nm in CHANNELS and nm!='Grid Power':v=v.abs()
  frames.append(v.rename(nm))
 df=pd.concat(frames,axis=1);df=df[(df.index<now.floor('15min'))&(df.index>=since.ceil('15min'))].dropna(how='all')
 sol=al.anylog_query(f"SELECT ts, pv_power, battery_power, battery_soc, grid_power, load_power FROM solar_data WHERE ts >= '{stamp}' ORDER BY ts ASC",table='solar_data')
 if sol:
  s=pd.DataFrame(sol);s.index=pd.to_datetime(s.pop('ts'),utc=True,format='mixed');s=s[s.index>=started];s=s[SOLAR].apply(pd.to_numeric,errors='coerce');v=s.resample('15min').mean();v[s.resample('15min').size()<10]=np.nan;df=df.join(v.add_prefix('solar__'))
 p=DATA/'live_genuine.parquet';old=pd.read_parquet(p) if p.exists() else pd.DataFrame()
 if len(df):
  combined=df.combine_first(old).sort_index()
  if not combined.equals(old):tmp=p.with_suffix('.tmp');combined.to_parquet(tmp);tmp.replace(p)
 p=DATA/'live_weather.json'
 if not p.exists() or now.timestamp()-p.stat().st_mtime>3600:
  params={'latitude':37.24,'longitude':-121.96,'hourly':','.join(WX),'past_days':2,'forecast_days':3,'timezone':'UTC','models':'gfs_seamless'}
  weather=get_json('https://api.open-meteo.com/v1/forecast?'+urllib.parse.urlencode(params));save_json(p,{'fetched_at':now.isoformat(),'response':weather})
 save_json(DATA/'collector_status.json',{'mode':'live','producer_started':str(started),'last_collect':now.isoformat(),'last_complete_bin':str(df.index.max()) if len(df) else None})
if __name__=='__main__':collect()
