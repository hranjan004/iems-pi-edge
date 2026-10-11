"""Unprivileged GX10 web ingestion. No Docker access, no stored login sessions."""
from device_clients import *
import time,sys,threading
status_lock=threading.Lock();status={'mode':'live-web','started_at':pd.Timestamp.now(tz='UTC').isoformat()}
def update(**kw):
 with status_lock:status.update(kw);save_json(DATA/'web_source_status.json',status)
def ingest(table,row):
 headers={'User-Agent':'AnyLog/1.23','type':'json','dbms':'customers','table':table,'mode':'streaming','Content-Type':'text/plain'}
 r=requests.put('http://127.0.0.1:32149',headers=headers,data=json.dumps(row),timeout=(3,5));r.raise_for_status()
def archive(source,ts,values):
 p=DATA/'web_observations';p.mkdir(exist_ok=True)
 with (p/(source+'-'+ts.strftime('%Y-%m-%d')+'.jsonl')).open('a') as f:f.write(json.dumps({'ts':ts.isoformat(),'values':values})+'\n')
def meter_loop(publish):
 client=Meter();last=None
 while True:
  try:
   ts,regs=client.current()
   if last!=ts:
    archive('egauge',ts,{r['name']:r['rate'] for r in regs if 'rate' in r})
    if publish:
     for r in regs:
      if r.get('rate') is not None:ingest('energy_readings',{'ts':ts.strftime('%Y-%m-%d %H:%M:%S'),'dev':'your-egauge-id','nm':r['name'],'tp':r.get('type','P'),'w':r['rate'],'kwh':0.0})
    last=ts
   update(egauge={'ok':True,'device_time':ts.isoformat(),'checked_at':pd.Timestamp.now(tz='UTC').isoformat(),'registers':len(regs)})
  except Exception as e:
   update(egauge={'ok':False,'error':type(e).__name__,'checked_at':pd.Timestamp.now(tz='UTC').isoformat()})
   client=Meter() # Renew failed/expired authentication on the next read.
  time.sleep(10)
def solar_loop(publish):
 client=None
 while True:
  try:
   if client is None:client=Solar()
   ts,row=client.current();archive('solar',ts,row)
   if publish:ingest('solar_data',{'ts':ts.strftime('%Y-%m-%d %H:%M:%S'),**{k:row[k] for k in SOLAR},'device_mode':''})
   update(solar={'ok':True,'received_at':ts.isoformat(),'values':row})
  except Exception as e:client=None;update(solar={'ok':False,'error':type(e).__name__,'checked_at':pd.Timestamp.now(tz='UTC').isoformat()})
  time.sleep(30)
def history_loop():
 meter=Meter();solar=None
 while True:
  try:
   if solar is None:solar=Solar()
   end=pd.Timestamp.now(tz='UTC').floor('15min');start=end-pd.Timedelta(days=3)
   # Fetch the newest completed intervals before refreshing older history.
   for a in reversed(pd.date_range(start,end-pd.Timedelta(days=1),freq='D')):
    d=meter.history(a,a+pd.Timedelta(days=1));merge_history(d,DATA/'direct_history.parquet')
   d=solar.history(start,end);merge_history(d,DATA/'direct_history.parquet')
   params={'latitude':37.24,'longitude':-121.96,'hourly':','.join(WX),'past_days':2,'forecast_days':3,'timezone':'UTC','models':'gfs_seamless'}
   now=pd.Timestamp.now(tz='UTC');weather=get_json('https://api.open-meteo.com/v1/forecast?'+urllib.parse.urlencode(params));save_json(DATA/'live_weather.json',{'fetched_at':now.isoformat(),'response':weather})
   update(history={'ok':True,'through':str(end),'updated_at':now.isoformat()})
  except Exception as e:meter=Meter();solar=None;update(history={'ok':False,'error':type(e).__name__,'checked_at':pd.Timestamp.now(tz='UTC').isoformat()})
  # Refresh just after each completed measurement interval, not 15 minutes after a slow request.
  next_boundary=pd.Timestamp.now(tz='UTC').floor('15min')+pd.Timedelta(minutes=15,seconds=3)
  delay=max(3,(next_boundary-pd.Timestamp.now(tz='UTC')).total_seconds())
  time.sleep(min(60,delay) if not status.get('history',{}).get('ok') else delay)
def main():
 publish='--publish' in sys.argv
 for fn in (meter_loop,solar_loop):threading.Thread(target=fn,args=(publish,),daemon=True).start()
 threading.Thread(target=history_loop,daemon=True).start()
 while True:time.sleep(30)
if __name__=='__main__':main()
