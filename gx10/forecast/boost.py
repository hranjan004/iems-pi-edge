"""CUDA XGBoost direct multi-horizon regression with past-only meter features."""
from model import *
from train import metric
import sys
sys.path.insert(0,str(ROOT/'packages'))
import xgboost as xgb

def features(arr,origins):
 past,future,_,mask,y=arr;out=[]
 for i in origins:
  # All observation inputs precede origin. Future block contains calendar + weather forecasts only.
  p=past[i-L:i];ctx=np.concatenate([p[-1],p[-4:,:p.shape[1]//2].mean(0),p[:,:p.shape[1]//2].mean(0),p[:,:p.shape[1]//2].std(0)])
  daily=y[i-L:i];weekly=y[i-7*L:i-6*L] if i>=7*L else np.full_like(daily,np.nan)
  out.append(np.column_stack([np.tile(ctx,(H,1)),future[i:i+H],daily,weekly,np.arange(H)/H]))
 return np.concatenate(out).astype('float32')
def booster_predict(models,arr,origins):
 x=features(arr,origins)
 return constrain(np.stack([m.predict(x) for m in models],axis=-1).reshape(len(origins),H,len(TARGETS)))
def add_boosters():
 import time
 device='cuda' if xgb.build_info().get('USE_CUDA') and torch.cuda.is_available() and os.environ.get('CUDA_VISIBLE_DEVICES')!='' else 'cpu'
 started=time.time();df=pd.read_parquet(DATA/'series.parquet');report=json.loads((DATA/('candidate.json' if (DATA/'candidate.json').exists() else 'champion.json')).read_text());ck=torch.load(DATA/report['file'],map_location='cpu',weights_only=False);sc=ck['scaler'];arr=arrays(df,sc);n=len(df);cuts=[n-42*L,n-28*L,n-14*L,n]
 splits=[origins_for(arr,L,cuts[0],4),origins_for(arr,cuts[0],cuts[1],16),origins_for(arr,cuts[1],cuts[2],16),origins_for(arr,cuts[2],n,16)]
 xs=[features(arr,o) for o in splits];ys=[np.concatenate([arr[4][i:i+H] for i in o]) for o in splits]
 models=[];files=[]
 for j,label in enumerate(LABELS):
  save_json(DATA/'training_status.json',{'status':'training','stage':'XGBoost '+device,'channel':label,'device':'GX10 '+device})
  tr=np.isfinite(ys[0][:,j]);va=np.isfinite(ys[1][:,j]);m=xgb.XGBRegressor(n_estimators=350,max_depth=4,learning_rate=.04,subsample=.8,colsample_bytree=.8,reg_lambda=10,min_child_weight=20,tree_method='hist',device=device,objective='reg:squarederror',early_stopping_rounds=25,n_jobs=2,random_state=42)
  m.fit(xs[0][tr],ys[0][tr,j],eval_set=[(xs[1][va],ys[1][va,j])],verbose=False)
  p=DATA/f'boost_{ck["version"]}_{j}.json';m.get_booster().save_model(p);files.append(p.name);models.append(m);print('trained',label,'trees',m.best_iteration,flush=True)
 model=TiDE(len(ck['obs']),ck['nfuture']);model.load_state_dict(ck['weights'])
 def candidates(k):
  cs=baselines(arr,splits[k],sc);cs['tide']=constrain(predict(model,arr,splits[k])*sc['ys']+sc['ym']);cs['xgboost']=constrain(np.stack([m.predict(xs[k]) for m in models],-1).reshape(-1,H,len(TARGETS)))
  cs['boost_daily_blend']=(cs['xgboost']+cs['daily'])/2
  return cs
 val=candidates(1);truth=ys[1].reshape(-1,H,len(TARGETS));metrics={k:metric(v,truth) for k,v in val.items()};chosen=[min(val,key=lambda k:metrics[k][j]['mae_w'] if metrics[k][j]['mae_w'] is not None else 1e30) for j in range(len(TARGETS))]
 cal=candidates(2);cp=np.stack([cal[k][...,j] for j,k in enumerate(chosen)],-1);ct=ys[2].reshape(-1,H,len(TARGETS));q=np.nanquantile(np.abs(ct-cp),.8,axis=0);q=np.where(np.isfinite(q),q,sc['ys'][None,:]*2)
 test=candidates(3);tp=np.stack([test[k][...,j] for j,k in enumerate(chosen)],-1);tt=ys[3].reshape(-1,H,len(TARGETS));coverage={}
 for j,label in enumerate(LABELS):
  valid=np.isfinite(tt[...,j]);coverage[label]=float((np.abs(tt[...,j]-tp[...,j])[valid]<=np.broadcast_to(q[:,j],tt[...,j].shape)[valid]).mean()) if valid.any() else None
 ck.update(chosen=chosen,interval=q,boost_files=files);newfile=DATA/f'model_{ck["version"]}_boost.pt';torch.save(ck,newfile)
 report.update(file=newfile.name,model='TiDE-inspired neural + XGBoost + validation-selected seasonal baselines',chosen=dict(zip(LABELS,chosen)),test_metrics=metric(tp,tt),test_baselines={k:metric(v,tt) for k,v in test.items()},test_interval_coverage=coverage,validation_metrics=metrics,boost_training_seconds=round(time.time()-started,1),boost_files=files)
 previous=json.loads((DATA/'champion.json').read_text()) if (DATA/'champion.json').exists() else None
 promote=True
 if previous and previous['version']!=ck['version']:
  oldck=torch.load(DATA/previous['file'],map_location='cpu',weights_only=False);oldarr=arrays(df,oldck['scaler']);oldc=all_candidates(oldck,oldarr,splits[1]);oldp=np.stack([oldc[k][...,j] for j,k in enumerate(oldck['chosen'])],-1);newp=np.stack([val[k][...,j] for j,k in enumerate(chosen)],-1)
  olderr=metric(oldp,truth);newerr=metric(newp,truth)
  oldscore=np.mean([v['mae_w']/sc['ys'][j] for j,v in enumerate(olderr) if v['mae_w'] is not None]);newscore=np.mean([v['mae_w']/sc['ys'][j] for j,v in enumerate(newerr) if v['mae_w'] is not None]);promote=newscore<oldscore*.99
  report.update(validation_score=float(newscore),previous_validation_score=float(oldscore),previous_validation_version=previous['version'])
 report['promoted']=bool(promote)
 if promote:save_json(DATA/'champion.json',report)
 save_json(DATA/f'report_{ck["version"]}_boost.json',report)
 save_json(DATA/'training_status.json',{'status':'complete','stage':'TiDE + XGBoost','promoted':bool(promote),'version':ck['version'],'device':'GX10 '+device,'next':'Wait for new non-replayed observations; retrain with chronological validation before promotion.'})
 print(json.dumps({'chosen':chosen,'test_metrics':report['test_metrics'],'boost_seconds':report['boost_training_seconds']},indent=2),flush=True)
if __name__=='__main__':add_boosters()
