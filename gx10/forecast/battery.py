"""Battery-specific, unit-aware forecasts; no changes to the power model contract."""
from common import *
from model import TiDE,Windows,predict
import torch,time,copy,threading,fcntl
TARGET=['solar__battery_soc','solar__battery_temperature']
NAMES=['Battery state of charge','Battery temperature'];UNITS=['%','°F']
_guard=threading.Lock();_cache={}
def bounds(x):
 x=np.array(x,copy=True);x[...,0]=np.clip(x[...,0],0,100);return x

def frame():
 d=pd.read_parquet(DATA/'series.parquet');web=pd.read_parquet(DATA/'direct_history.parquet')
 d=web.combine_first(d).sort_index();return d.reindex(pd.date_range(d.index.min(),d.index.max(),freq='15min'))

def scale(d,cut):
 cols=[c for c in d if not c.startswith('future__')];v=d.iloc[:cut]
 return {'obs':cols,'mean':v[cols].mean().fillna(0).to_numpy(),'std':v[cols].std().fillna(1).clip(lower=1).to_numpy(),'ym':v[TARGET].mean().to_numpy(),'ys':v[TARGET].std().clip(lower=1).to_numpy()}

def arrays(d,s):
 raw=d[s['obs']].to_numpy();valid=np.isfinite(raw);past=np.column_stack([np.nan_to_num((raw-s['mean'])/s['std']),valid]).astype('float32')
 y=d[TARGET].to_numpy(dtype='float32');mask=np.isfinite(y);yn=np.nan_to_num((y-s['ym'])/s['ys']).astype('float32')
 wx=d[['future__'+k for k in WX]].to_numpy();future=np.column_stack([calendar(d.index),np.nan_to_num(wx/[30,100,1000,50]),np.isfinite(wx)]).astype('float32')
 return past,future,yn,mask,y

def origins(a,start,end,stride):
 return [i for i in range(max(L,start),end-H+1,stride) if a[3][i-L:i].mean(0).min()>=.8 and a[3][i:i+H].mean(0).min()>=.8 and np.isfinite(a[1][i:i+H]).all()]

def baseline(a,oo,s):
 y=a[4];out={k:[] for k in ['persistence','daily','weekly']}
 for i in oo:
  p=y[i-L:i];last=np.where(np.isfinite(p[-1]),p[-1],s['ym']);day=np.where(np.isfinite(p),p,last);week=y[i-7*L:i-6*L] if i>=7*L else day
  out['persistence'].append(np.tile(last,(H,1)));out['daily'].append(day);out['weekly'].append(np.where(np.isfinite(week),week,day))
 return {k:bounds(v) for k,v in out.items()}

def candidates(ck,a,oo,device='cpu'):
 out=baseline(a,oo,ck['scaler']);m=TiDE(len(ck['scaler']['obs']),a[1].shape[1],nt=2).to(device);m.load_state_dict(ck['weights'])
 out['tide']=bounds(predict(m,a,oo,device)*ck['scaler']['ys']+ck['scaler']['ym']);return out

def truth(a,oo):return np.stack([a[4][i:i+H] for i in oo])
def mae(p,y):return np.nanmean(np.abs(p-y),axis=(0,1))

def train():
 lock=(DATA/'battery_train.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 torch.set_num_threads(2);torch.manual_seed(42);np.random.seed(42)
 device='cuda' if torch.cuda.is_available() else 'cpu'
 try:
  if device=='cuda':torch.cuda.set_per_process_memory_fraction(.025);torch.empty(1,device='cuda')
 except RuntimeError:
  print('CUDA allocation unavailable; restarting battery training on GX10 CPU',flush=True)
  import sys
  os.execve(sys.executable,[sys.executable,'-u',__file__],{**os.environ,'CUDA_VISIBLE_DEVICES':''})
 hardware=torch.cuda.get_device_name() if device=='cuda' else 'GX10 CPU (CUDA allocation unavailable)'
 d=frame();d=d.loc[d[TARGET].notna().any(axis=1)];d=d.reindex(pd.date_range(d.index.min(),d.index.max(),freq='15min'))
 # Only times with archived issue-safe weather can enter the retrospective evaluation.
 complete=d[['future__'+k for k in WX]].notna().all(axis=1)
 d=d.loc[:d.index[complete][-1]];n=len(d);cuts=[n-42*L,n-28*L,n-14*L,n]
 if cuts[0]<14*L:raise ValueError('Need at least 56 days of battery history')
 s=scale(d,cuts[0]);warm=None
 prior=DATA/'battery_champion.json'
 if prior.exists():
  metadata=json.loads(prior.read_text());ck0=torch.load(DATA/metadata['file'],map_location='cpu',weights_only=False)
  if metadata['train_end']<=str(d.index[cuts[0]-1]) and all(c in d for c in ck0['scaler']['obs']):s=ck0['scaler'];warm=ck0['weights']
 a=arrays(d,s);oo=[origins(a,L,cuts[0],8),origins(a,cuts[0],cuts[1],16),origins(a,cuts[1],cuts[2],16),origins(a,cuts[2],n,16)]
 if min(map(len,oo))<5:raise ValueError('Not enough observed battery windows')
 m=TiDE(len(s['obs']),a[1].shape[1],nt=2).to(device);opt=torch.optim.AdamW(m.parameters(),lr=.0008,weight_decay=.01);loader=torch.utils.data.DataLoader(Windows(a,oo[0]),batch_size=64,shuffle=True)
 if warm is not None:m.load_state_dict(warm);print('battery warm start from deployed model',flush=True)
 best=float('inf');history=[];started=time.time();best_ep=0
 for ep in range(40):
  m.train()
  for p,f,z,y,mask in loader:
   p,f,z,y,mask=[v.to(device) for v in (p,f,z,y,mask)];opt.zero_grad(set_to_none=True);loss=(torch.nn.functional.smooth_l1_loss(m(p,f,z),y,reduction='none')*mask).sum()/mask.sum().clamp(min=1);loss.backward();torch.nn.utils.clip_grad_norm_(m.parameters(),1);opt.step();time.sleep(.01)
  score=float(np.mean(mae(bounds(predict(m,a,oo[1],device)*s['ys']+s['ym']),truth(a,oo[1]))/s['ys']));history.append(score)
  if score<best:best=score;weights=copy.deepcopy({k:v.cpu() for k,v in m.state_dict().items()});best_ep=ep
  save_json(DATA/'battery_training_status.json',{'status':'training','epoch':ep+1,'best_validation_error':best,'device':hardware});print('battery epoch',ep+1,score,flush=True)
  if ep-best_ep>=7:break
 ck={'weights':weights,'scaler':s};val=candidates(ck,a,oo[1]);vy=truth(a,oo[1]);errors={k:mae(p,vy) for k,p in val.items()};chosen=[min(errors,key=lambda k:errors[k][j]) for j in range(2)]
 selected=lambda c:np.stack([c[k][...,j] for j,k in enumerate(chosen)],-1)
 cal=selected(candidates(ck,a,oo[2]));q=np.nanquantile(np.abs(cal-truth(a,oo[2])),.8,axis=0)
 test=selected(candidates(ck,a,oo[3]));ty=truth(a,oo[3]);err=mae(test,ty);score=float(np.mean(mae(selected(val),vy)/s['ys']));promoted=True;oldscore=None
 old=DATA/'battery_champion.json'
 if old.exists():
  oldck=torch.load(DATA/json.loads(old.read_text())['file'],map_location='cpu',weights_only=False);oldc=candidates(oldck,arrays(d,oldck['scaler']),oo[1]);oldp=np.stack([oldc[k][...,j] for j,k in enumerate(oldck['chosen'])],-1);oldscore=float(np.mean(mae(oldp,vy)/s['ys']));promoted=score<oldscore*.99
 version=pd.Timestamp.now(tz='UTC').strftime('%Y%m%dT%H%M%SZ');ck.update(chosen=chosen,interval=q,version=version);file='battery_'+version+'.pt';torch.save(ck,DATA/file)
 report={'version':version,'file':file,'device':hardware,'train_end':str(d.index[cuts[0]-1]),'data_end':str(d.index[-1]),'selection_range':[str(d.index[cuts[0]]),str(d.index[cuts[1]-1])],'test_range':[str(d.index[cuts[2]]),str(d.index[-1])],'promoted':promoted,'validation_score':score,'previous_validation_score':oldscore,'training_seconds':round(time.time()-started,1),'window_counts':list(map(len,oo)),'channels':[]}
 for j,name in enumerate(NAMES):
  mask=np.isfinite(ty[...,j]);coverage=float((np.abs(test[...,j]-ty[...,j])[mask]<=np.broadcast_to(q[:,j],ty[...,j].shape)[mask]).mean())
  report['channels'].append({'name':name,'unit':UNITS[j],'model':chosen[j],'test_mae':float(err[j]),'test_coverage':coverage,'validation_mae':{k:float(v[j]) for k,v in errors.items()}})
 save_json(DATA/('battery_report_'+version+'.json'),report)
 if promoted:save_json(old,report)
 save_json(DATA/'battery_training_status.json',{'status':'complete',**report});print(json.dumps(report),flush=True)

def forecast(origin):
 report=json.loads((DATA/'battery_champion.json').read_text());key=(str(origin),report['version'])
 with _guard:
  if key in _cache:return _cache[key]
  ck=torch.load(DATA/report['file'],map_location='cpu',weights_only=False);d=frame();origin=pd.Timestamp(origin);idx=pd.date_range(d.index.min(),origin+pd.Timedelta(minutes=15*(H-1)),freq='15min');work=d.reindex(idx);i=idx.get_loc(origin)
  wx=json.loads((DATA/'live_weather.json').read_text())
  if pd.Timestamp.now(tz='UTC')-pd.Timestamp(wx['fetched_at'])>pd.Timedelta(hours=2):raise ValueError('Weather context is stale')
  h=wx['response']['hourly'];wf=pd.DataFrame({k:h[k] for k in WX},index=pd.to_datetime(h['time'],utc=True));expanded=expand_weather(wf,idx)
  for k in WX:work.loc[idx>=origin,'future__'+k]=expanded.loc[idx>=origin,k]
  if work.iloc[i-L:i][TARGET].notna().mean().min()<.8 or origin>d.index.max()+pd.Timedelta(minutes=30):raise ValueError('Recent battery history is incomplete')
  if work.iloc[i:i+H][['future__'+k for k in WX]].notna().mean().min()<.8:raise ValueError('Future weather is incomplete')
  a=arrays(work,ck['scaler']);c=candidates(ck,a,[i]);p=np.stack([c[k][0,:,j] for j,k in enumerate(ck['chosen'])],-1);lo=bounds(p-ck['interval']);hi=bounds(p+ck['interval'])
  vals=lambda x:[round(float(v),3) if np.isfinite(v) else None for v in x]
  payload={'version':report['version'],'origin':origin.isoformat(),'generated_at':pd.Timestamp.now(tz='UTC').isoformat(),'history_times':[t.isoformat() for t in idx[i-L:i]],'forecast_times':[t.isoformat() for t in idx[i:i+H]],'channels':[],'notes':['Measured battery sensor temperature, not outdoor or inverter temperature.','SOC is bounded to 0–100%. Forecasts assume operating patterns similar to the recorded history.','Bands are empirical 80% intervals; test coverage is reported for each channel.']}
  for j,meta in enumerate(report['channels']):payload['channels'].append({**meta,'history':vals(work.iloc[i-L:i][TARGET[j]]),'forecast':vals(p[:,j]),'lower':vals(lo[:,j]),'upper':vals(hi[:,j])})
  _cache.clear();_cache[key]=payload;return payload

if __name__=='__main__':train()
