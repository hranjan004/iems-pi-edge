from common import *
import gc
RAW=Path('/home/asus/nilm/data/egauge_gx10.parquet')
def build():
 d=pd.read_parquet(RAW);d['ts']=pd.to_datetime(d.ts,utc=True);d=d.drop_duplicates(['ts','channel'],keep='last').sort_values(['channel','ts'])
 # Per-channel sample-support duration: gaps >30 seconds remain missing.
 columns=sorted(d.channel.unique());frames=[];coverage={}
 for c in columns:
  g=d[d.channel==c].copy(); g['support']=g.ts.diff().dt.total_seconds().clip(0,30).fillna(0)
  g=g.set_index('ts'); grouped=g.resample('15min'); v=grouped.w.mean();support=grouped.support.sum()/900
  v=v.where(support>=.6);frames.append(v.rename(c));coverage[c]=int(v.notna().sum())
 raw_count=len(d);del d;gc.collect();df=pd.concat(frames,axis=1)
 # Solar data have their own history and explicit missingness; no synthetic backfill.
 sol=pd.read_parquet('/home/asus/nilm/data/solar_gx10.parquet');sol.index=pd.to_datetime(sol.index,utc=True)
 sol=sol[~sol.index.duplicated(keep='last')].sort_index();s=sol.resample('15min').mean();n=sol.resample('15min').size();s.loc[n<10,:]=np.nan
 df=df.join(s.add_prefix('solar__'))
 # eGauge CT orientation makes panel loads negative in the raw archive.
 # Match the existing dashboard: consumed panel power is magnitude; grid retains import/export sign.
 for c in CHANNELS:
  if c!='Grid Power':df[c]=df[c].abs()
 live=DATA/'live_genuine.parquet'
 if live.exists():
  genuine=pd.read_parquet(live);genuine=genuine[genuine.index<pd.Timestamp.now(tz='UTC').floor('D')-pd.Timedelta(days=2)]
  df=pd.concat([df,genuine]);df=df[~df.index.duplicated(keep='last')].sort_index()
 direct=DATA/'direct_history.parquet'
 if direct.exists():
  web=pd.read_parquet(direct);web=web[web.index<pd.Timestamp.now(tz='UTC').floor('D')-pd.Timedelta(days=2)]
  df=web.combine_first(df).sort_index()
 df=df.reindex(pd.date_range(df.index.min(),df.index.max(),freq='15min'))
 start=str(df.index.min().date());end=str(df.index.max().date())
 past=expand_weather(weather(start,end,'history'),df.index).add_prefix('wx__');prior=expand_weather(weather(start,end,'prior'),df.index).add_prefix('future__')
 df=df.join(past).join(prior);df.index.name='ts';tmp=DATA/'series.tmp';df.to_parquet(tmp);tmp.replace(DATA/'series.parquet')
 report={'built_at':pd.Timestamp.now(tz='UTC').isoformat(),'raw_egauge_rows':raw_count,'start':str(df.index.min()),'end':str(df.index.max()),'rows_15min':len(df),'power_coverage_bins':coverage,'solar_start':str(sol.index.min()),'solar_end':str(sol.index.max()),'columns':df.columns.tolist(),'data_contract':2,'polarity':'Panel/Shop/Generac magnitude; Grid Power remains signed','aggregation':'15-minute sample mean W; bins require >=60% bounded sample support; gaps never zero-filled','weather_past':'GFS historical forecast archive','weather_future_training':'GFS previous_day2 (48-hour lead), available before 24-hour forecast origins','source':'deduplicated full March–October GX10 export; live replay excluded from retraining'}
 save_json(DATA/'data_report.json',report);print(json.dumps(report,indent=2),flush=True)
if __name__=='__main__':build()
