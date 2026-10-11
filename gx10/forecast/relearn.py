"""Retrain on original archive changes, never repeated demo playback."""
from common import *
import subprocess,sys,fcntl
def main():
 lock=open(DATA/'relearn.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 sources=[Path('/home/asus/nilm/data/egauge_gx10.parquet'),Path('/home/asus/nilm/data/solar_gx10.parquet')]
 fingerprint={str(p):[p.stat().st_size,p.stat().st_mtime_ns] for p in sources}
 live=DATA/'live_genuine.parquet'
 if live.exists():
  ld=pd.read_parquet(live);complete=ld[ld.index<pd.Timestamp.now(tz='UTC').floor('D')-pd.Timedelta(days=2)]
  fingerprint['live_completed_days']=int(len(complete)//96)
 direct=DATA/'direct_history.parquet'
 if direct.exists():
  web=pd.read_parquet(direct);complete=web[web.index<pd.Timestamp.now(tz='UTC').floor('D')-pd.Timedelta(days=2)]
  fingerprint['direct_completed_days']=int(len(complete)//96)
 state=DATA/'relearn_state.json';old=json.loads(state.read_text()) if state.exists() else {}
 if not old or fingerprint==old.get('fingerprint'):
  save_json(state,{'fingerprint':fingerprint,'last_checked':pd.Timestamp.now(tz='UTC').isoformat(),'note':'Waiting for new original observations. Replay excluded.'});return
 available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
 if available<8*1024**3:raise RuntimeError('Waiting for 8 GiB free memory; current model remains active')
 for script in ['build_data.py','train.py','boost.py'] + (['battery.py'] if (DATA/'battery_champion.json').exists() else []):
  subprocess.run([sys.executable,'-u',str(ROOT/script)],cwd=ROOT,env={**os.environ,'FORECAST_CANDIDATE_ONLY':'1'},check=True,timeout=1800)
 save_json(state,{'fingerprint':fingerprint,'last_checked':pd.Timestamp.now(tz='UTC').isoformat(),'note':'Candidate trained; registry changes only after >=1% validation improvement.'})
if __name__=='__main__':main()
