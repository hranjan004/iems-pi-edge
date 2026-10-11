from device_clients import *
import time

def main():
 end=pd.Timestamp.now(tz='UTC').floor('15min');start=pd.Timestamp('2026-03-06',tz='UTC');m=Meter();s=Solar();path=DATA/'direct_history.parquet'
 for a in pd.date_range(start,end,freq='31D'):
  b=min(a+pd.Timedelta(days=31),end)
  for name,client in [('solar',s)]:
   frame=client.history(a,b);merge_history(frame,path)
   print(name,str(a.date()),len(frame),'bins',flush=True)
  time.sleep(1)
 d=pd.read_parquet(path)
 save_json(DATA/'direct_import_report.json',{'imported_at':pd.Timestamp.now(tz='UTC').isoformat(),'start':str(d.index.min()),'end':str(d.index.max()),'bins':len(d),'coverage':d.notna().sum().to_dict(),'sources':['authenticated eGauge register counter differences','authenticated Solar Assistant Grafana history'],'credentials_stored_in_repo':False,'sessions_persisted':False})
if __name__=='__main__':main()
