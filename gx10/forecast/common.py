"""Measured-power forecasting: 15-minute mean watts, 96-step horizon."""
from pathlib import Path
import json, os, urllib.request, urllib.parse
import numpy as np
import pandas as pd
ROOT=Path(os.environ.get('FORECAST_ROOT','/home/asus/Microgrid-UCSC/gx10/forecast'))
DATA=ROOT/'data'; DATA.mkdir(parents=True,exist_ok=True)
CHANNELS=['Panel1 (HVAC)','Panel2 (H2O)','Panel3 (Kitchen)','Grid Power','Shop','Generac Power']
SOLAR=['pv_power','battery_power','battery_soc','grid_power','load_power']
WX=['temperature_2m','cloud_cover','shortwave_radiation','wind_speed_10m']
H=96; L=96; TZ='America/Los_Angeles'
def save_json(path,obj):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(obj,default=str,allow_nan=False));tmp.replace(path)
def get_json(url,timeout=60):
 with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'IEMS-Forecast/1.0'}),timeout=timeout) as r:return json.load(r)
def calendar(idx):
 loc=idx.tz_convert(TZ); h=(loc.hour+loc.minute/60).to_numpy();d=loc.dayofweek.to_numpy();doy=idx.dayofyear.to_numpy()
 # NOAA approximate solar elevation, UTC hour and longitude correction.
 g=2*np.pi/365*(doy-1+(idx.hour.to_numpy()-12)/24)
 dec=.006918-.399912*np.cos(g)+.070257*np.sin(g)-.006758*np.cos(2*g)+.000907*np.sin(2*g)-.002697*np.cos(3*g)+.00148*np.sin(3*g)
 eq=229.18*(.000075+.001868*np.cos(g)-.032077*np.sin(g)-.014615*np.cos(2*g)-.040849*np.sin(2*g))
 minutes=(idx.hour*60+idx.minute).to_numpy()+eq+4*(-121.96);ha=np.deg2rad(minutes/4-180);lat=np.deg2rad(37.24)
 elev=np.rad2deg(np.arcsin(np.clip(np.sin(lat)*np.sin(dec)+np.cos(lat)*np.cos(dec)*np.cos(ha),-1,1)))
 return np.column_stack([np.sin(h*2*np.pi/24),np.cos(h*2*np.pi/24),np.sin(d*2*np.pi/7),np.cos(d*2*np.pi/7),(d>=5)*1.,np.sin(doy*2*np.pi/365),np.cos(doy*2*np.pi/365),elev/90,np.maximum(0,np.sin(np.deg2rad(elev)))]).astype('float32')
def weather(start,end,kind):
 path=DATA/f'weather_{kind}_{start}_{end}.parquet'
 if path.exists():return pd.read_parquet(path)
 suffix='_previous_day2' if kind=='prior' else ''
 base='https://previous-runs-api.open-meteo.com/v1/forecast' if kind=='prior' else 'https://historical-forecast-api.open-meteo.com/v1/forecast'
 parts=[]
 for a in pd.date_range(start,end,freq='MS').union(pd.DatetimeIndex([pd.Timestamp(start)])):
  b=min(a+pd.offsets.MonthEnd(0),pd.Timestamp(end))
  p={'latitude':37.24,'longitude':-121.96,'start_date':str(a.date()),'end_date':str(b.date()),'hourly':','.join(x+suffix for x in WX),'models':'gfs_seamless','timezone':'UTC'}
  print('weather',kind,str(a.date()),flush=True)
  d=get_json(base+'?'+urllib.parse.urlencode(p));hours=d['hourly'];frame=pd.DataFrame({k:hours[k+suffix] for k in WX},index=pd.to_datetime(hours['time'],utc=True));parts.append(frame)
 out=pd.concat(parts).sort_index();out=out[~out.index.duplicated()];out.to_parquet(path);return out

def expand_weather(w,idx):
 # Forward hourly values, never backward-fill future observations into history.
 return w.reindex(w.index.union(idx)).sort_index().ffill(limit=3).reindex(idx)
TARGETS=CHANNELS+['solar__pv_power']
LABELS=CHANNELS+['Solar PV']
