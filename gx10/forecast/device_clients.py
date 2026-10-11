"""Read-only device clients. Credentials outside repository; sessions only in memory."""
from common import *
import sys
sys.path.insert(0,str(ROOT/'packages'))
import requests
from bs4 import BeautifulSoup
from egauge import webapi
from urllib.parse import urljoin,urlsplit,parse_qs
AUTH=Path('/home/asus/.config/iems/device-auth.json')
class BoundedSession(requests.Session):
 def request(self,*args,**kwargs):
  kwargs.setdefault('timeout',(10,40));return super().request(*args,**kwargs)
import threading
_meter_lock=threading.Lock()
class Meter:
 def __init__(self):
  c=json.loads(AUTH.read_text())['egauge'];self.dev=webapi.device.Device(c['url'],webapi.JWTAuth(c['user'],c['password']))
 def read(self,path,timeout):
  with _meter_lock:return self.dev.get(path,timeout=timeout)
 def current(self):
  d=self.read('/register?rate',timeout=(10,20));ts=pd.Timestamp(float(d['ts']),unit='s',tz='UTC')
  if abs((pd.Timestamp.now(tz='UTC')-ts).total_seconds())>120:raise ValueError('Meter clock is stale')
  return ts,d['registers']
 def history(self,start,end):
  q=f'/register?time={int(start.timestamp())}:900:{int(end.timestamp())}'
  d=self.read(q,timeout=(10,40));rows=[]
  for block in d.get('ranges',[]):
   delta=float(block['delta']);endts=float(block['ts']);vals=block['rows']
   if len(vals)<2 or delta==0:continue
   if delta!=900:raise ValueError('Unexpected meter history interval')
   for i in range(len(vals)-1):
    row={'ts':pd.Timestamp(endts-(i+1)*delta,unit='s',tz='UTC')}
    for j,reg in enumerate(d['registers']):
     if vals[i][j] is None or vals[i+1][j] is None:continue
     # Subtract Python integers before float conversion: counters exceed 2**53.
     v=(int(vals[i][j])-int(vals[i+1][j]))/delta
     if reg['type'] in ('V','I','F'):v/=1000
     cap={'P':100000,'V':300,'I':1000,'F':100}.get(reg['type'],1e9)
     if abs(v)>cap:continue # resets/discontinuities are missing, never zero.
     if reg['name'] in CHANNELS and reg['name']!='Grid Power':v=abs(v)
     row[reg['name']]=v
    rows.append(row)
  if not rows:return pd.DataFrame()
  df=pd.DataFrame(rows).set_index('ts').sort_index();return df[(df.index>=start)&(df.index<end)]
class Solar:
 def __init__(self):self.s=BoundedSession();self.login()
 def login(self):
  c=json.loads(AUTH.read_text())['solar'];self.base=c['url'];r=self.s.get(self.base);b=BeautifulSoup(r.text,'html.parser');f=b.select_one('form')
  if f is None:raise RuntimeError('Expected Solar Assistant login form')
  payload={i['name']:i.get('value','') for i in f.select('input[name]')};payload.update({'user[email]':c['user'],'user[password]':c['password'],'user[remember_me]':'false'})
  r=self.s.post(urljoin(r.url,f['action']),data=payload);r.raise_for_status();q=parse_qs(urlsplit(r.url).query)
  if 'token' not in q or 'key' not in q:raise RuntimeError('Solar Assistant login unsuccessful')
  self.headers={'Authorization':'Bearer '+q['token'][0],'Site-Id':str(c.get('site_id','')),'Site-Key':q['key'][0]}
  self.s.get(self.base).raise_for_status();self.logged=pd.Timestamp.now(tz='UTC');self.ds=None
 def current(self):
  if pd.Timestamp.now(tz='UTC')-self.logged>pd.Timedelta(hours=12):self.login()
  r=self.s.get(self.base+'/api/v1/metrics',headers=self.headers)
  if r.status_code in (401,403):self.login();r=self.s.get(self.base+'/api/v1/metrics',headers=self.headers)
  r.raise_for_status();metrics={x['topic']:x.get('value') for x in r.json()}
  mapping={'pv_power':'pv_power','battery_power':'battery_power','battery_soc':'battery_state_of_charge','grid_power':'grid_power','load_power':'load_power'}
  result={k:metrics.get('total/'+v) for k,v in mapping.items()}
  if any(result[k] is None for k in mapping):raise ValueError('Incomplete Solar Assistant metrics')
  temps=[x for x in r.json() if x.get('topic')=='total/battery_temperature' and x.get('group')=='Status']
  if temps and temps[0].get('value') is not None:
   unit=temps[0].get('unit');v=float(temps[0]['value'])
   if unit not in ('°F','°C'):raise ValueError('Unknown battery temperature unit')
   result['battery_temperature']=v if unit=='°F' else v*9/5+32
  return pd.Timestamp.now(tz='UTC'),result
 def history(self,start,end):
  if self.ds is None:
   r=self.s.get(self.base+'/grafana/api/frontend/settings');r.raise_for_status();self.ds=r.json()['datasources']['SolarAssistant']
  mapping={'pv_power':'PV power','battery_power':'Battery power','battery_soc':'Battery state of charge','grid_power':'Grid power','load_power':'Load power','battery_temperature':'Battery temperature'};frames=[]
  queries=[f'SELECT mean("combined") AS "value",count("combined") AS "samples" FROM "{measurement}" WHERE time >= \'{start.isoformat()}\' AND time < \'{end.isoformat()}\' GROUP BY time(15m) fill(null)' for measurement in mapping.values()]
  r=self.s.get(self.base+'/grafana'+self.ds['url']+'/query',params={'db':self.ds['database'],'q':';'.join(queries),'epoch':'ms'});r.raise_for_status();body=r.json()
  for result in body.get('results',[]):
   name=list(mapping)[result['statement_id']]
   if result.get('error'):raise ValueError('Solar history query failed')
   for series in result.get('series',[]):
    df=pd.DataFrame(series['values'],columns=series['columns']);df.index=pd.to_datetime(df['time'],unit='ms',utc=True)
    frames.append(pd.to_numeric(df['value'],errors='coerce').where(df['samples']>=1).rename('solar__'+name))
  return pd.concat(frames,axis=1).dropna(how='all') if frames else pd.DataFrame()

def merge_history(frame,path):
 if frame.empty:return
 import fcntl
 with path.with_suffix('.lock').open('w') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX)
  old=pd.read_parquet(path) if path.exists() else pd.DataFrame();out=frame.combine_first(old).sort_index();tmp=path.with_suffix('.tmp');out.to_parquet(tmp);tmp.replace(path)
