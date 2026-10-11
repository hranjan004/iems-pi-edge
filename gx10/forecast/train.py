from model import *
import time,copy,fcntl,hashlib

def metric(pred,truth):
 out=[]
 for j,label in enumerate(LABELS):
  m=np.isfinite(truth[...,j]);a=truth[...,j][m];p=pred[...,j][m]
  out.append({'channel':label,'n':len(a),'mae_w':float(np.abs(a-p).mean()) if len(a) else None,'rmse_w':float(np.sqrt(((a-p)**2).mean())) if len(a) else None,'wape':float(np.abs(a-p).sum()/max(np.abs(a).sum(),1)) if len(a) else None})
 return out

def train(epochs=30):
 lock=open(DATA/'train.lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 torch.set_num_threads(2);torch.manual_seed(42);np.random.seed(42)
 device='cuda' if torch.cuda.is_available() else 'cpu'
 try:
  if device=='cuda':torch.cuda.set_per_process_memory_fraction(.025);torch.empty(1,device='cuda')
 except RuntimeError:
  import sys
  os.execve(sys.executable,[sys.executable,'-u',__file__],{**os.environ,'CUDA_VISIBLE_DEVICES':''})
 hardware=torch.cuda.get_device_name() if device=='cuda' else 'GX10 CPU'
 df=pd.read_parquet(DATA/'series.parquet');n=len(df)
 # Final 42 days: selection, interval calibration, untouched test, 14 days each.
 cuts=[n-42*L,n-28*L,n-14*L,n]
 if cuts[0]<14*L:raise ValueError('Insufficient history')
 sc=fit_scaler(df,cuts[0]);arr=arrays(df,sc)
 splits=[origins_for(arr,L,cuts[0],4),origins_for(arr,cuts[0],cuts[1],16),origins_for(arr,cuts[1],cuts[2],16),origins_for(arr,cuts[2],cuts[3],16)]
 if min(map(len,splits))<5:raise ValueError('Not enough observed windows in each chronological split')
 model=TiDE(len(sc['obs']),arr[1].shape[1]).to(device);opt=torch.optim.AdamW(model.parameters(),lr=.0008,weight_decay=.01)
 warm=DATA/'neural_latest.pt'
 if warm.exists():
  old=torch.load(warm,map_location='cpu',weights_only=False)
  # Warm starts only share scaling if the new training cutoff includes old training data.
  if old.get('data_contract')==2 and old.get('obs')==sc['obs'] and old['train_end']<=str(df.index[cuts[0]-1]):
   sc=old['scaler'];arr=arrays(df,sc);model.load_state_dict(old['weights']);print('warm start',flush=True)
 loader=torch.utils.data.DataLoader(Windows(arr,splits[0]),batch_size=64,shuffle=True)
 best=float('inf');weights=None;hist=[];started=time.time()
 valid_truth=np.stack([arr[4][i:i+H] for i in splits[1]])
 def status(**extra):save_json(DATA/'training_status.json',dict(status='training',device=hardware,started_at=pd.Timestamp(started,unit='s',tz='UTC').isoformat(),**extra))
 for ep in range(epochs):
  model.train();losses=[]
  for p,f,s,y,m in loader:
   p,f,s,y,m=[x.to(device) for x in (p,f,s,y,m)];opt.zero_grad(set_to_none=True)
   pred=model(p,f,s);loss=(torch.nn.functional.smooth_l1_loss(pred,y,reduction='none')*m).sum()/m.sum().clamp(min=1)
   loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1);opt.step();losses.append(loss.item())
   # Give the concurrent Nemotron training a scheduling break.
   time.sleep(.015)
  pv=constrain(predict(model,arr,splits[1],device)*sc['ys']+sc['ym']);metrics=metric(pv,valid_truth)
  score=float(np.mean([v['mae_w']/max(sc['ys'][j],50) for j,v in enumerate(metrics) if v['mae_w'] is not None]))
  hist.append({'epoch':ep+1,'loss':float(np.mean(losses)),'validation_normalized_mae':score})
  if score<best:best=score;weights=copy.deepcopy({k:v.cpu() for k,v in model.state_dict().items()});best_ep=ep
  status(epoch=ep+1,epochs=epochs,best_validation_mae=best);print(hist[-1],flush=True)
  if ep-best_ep>=7:break
 model.load_state_dict(weights)
 candidates=baselines(arr,splits[1],sc);candidates['tide']=constrain(predict(model,arr,splits[1],device)*sc['ys']+sc['ym'])
 # Select model independently per meter channel on validation only.
 errors={k:metric(v,valid_truth) for k,v in candidates.items()}
 chosen=[min(candidates,key=lambda k: errors[k][j]['mae_w'] if errors[k][j]['mae_w'] is not None else float('inf')) for j in range(len(TARGETS))]
 predictions=[];allmetrics=[]
 for origins in splits[2:]:
  c=baselines(arr,origins,sc);c['tide']=constrain(predict(model,arr,origins,device)*sc['ys']+sc['ym'])
  predictions.append(np.stack([c[k][...,j] for j,k in enumerate(chosen)],axis=-1));truth=np.stack([arr[4][i:i+H] for i in origins]);allmetrics.append({k:metric(v,truth) for k,v in c.items()})
 caltruth=np.stack([arr[4][i:i+H] for i in splits[2]]);resid=np.abs(caltruth-predictions[0]);q=np.nanquantile(resid,.8,axis=0)
 q=np.where(np.isfinite(q),q,sc['ys'][None,:]*2)
 testtruth=np.stack([arr[4][i:i+H] for i in splits[3]]);testmetrics=metric(predictions[1],testtruth)
 coverage=[]
 for j in range(len(TARGETS)):
  m=np.isfinite(testtruth[...,j]);coverage.append(float((np.abs(testtruth[...,j]-predictions[1][...,j])[m]<=np.broadcast_to(q[:,j],testtruth[...,j].shape)[m]).mean()) if m.any() else None)
 version=pd.Timestamp.now(tz='UTC').strftime('%Y%m%dT%H%M%SZ');path=DATA/('model_'+version+'.pt')
 checkpoint={'data_contract':2,'weights':weights,'scaler':sc,'obs':sc['obs'],'train_end':str(df.index[cuts[0]-1]),'nfuture':arr[1].shape[1],'chosen':chosen,'interval':q,'version':version}
 torch.save(checkpoint,path);torch.save(checkpoint,warm)
 # A retrain must beat the current champion on the SAME new validation origins.
 promote=True;current=DATA/'champion.json';old_score=None
 new_score=float(np.mean([errors[k][j]['mae_w']/max(sc['ys'][j],50) for j,k in enumerate(chosen) if errors[k][j]['mae_w'] is not None]))
 if current.exists():
  oldmeta=json.loads(current.read_text());ck=torch.load(DATA/oldmeta['file'],map_location='cpu',weights_only=False)
  oa=arrays(df,ck['scaler']);oc=all_candidates(ck,oa,splits[1]);op=np.stack([oc[k][...,j] for j,k in enumerate(ck['chosen'])],-1);oe=metric(op,valid_truth);old_score=float(np.mean([e['mae_w']/max(sc['ys'][j],50) for j,e in enumerate(oe) if e['mae_w'] is not None]));promote=new_score<old_score*.99
 report={'version':version,'file':path.name,'model':'TiDE-inspired residual dense encoder + per-channel validation-selected baselines','device':hardware,'training_seconds':round(time.time()-started,1),'gpu_peak_allocated_mb':round(torch.cuda.max_memory_allocated()/1024**2) if device=='cuda' else 0,'train_end':str(df.index[cuts[0]-1]),'selection_range':[str(df.index[cuts[0]]),str(df.index[cuts[1]-1])],'calibration_range':[str(df.index[cuts[1]]),str(df.index[cuts[2]-1])],'test_range':[str(df.index[cuts[2]]),str(df.index[-1])],'window_counts':dict(zip(['train','validation','calibration','test'],map(len,splits))),'chosen':dict(zip(LABELS,chosen)),'test_metrics':testmetrics,'test_baselines':allmetrics[1],'test_interval_coverage':dict(zip(LABELS,coverage)),'validation_metrics':errors,'validation_score':new_score,'previous_validation_score':old_score,'promoted':promote,'history':hist,'interval_note':'Empirical 80% absolute-error bands calibrated on a separate chronological block; not guaranteed coverage.','weather_note':'Future backtest inputs use GFS forecasts made 48 hours before valid time, never realized future weather.'}
 save_json(DATA/('report_'+version+'.json'),report)
 save_json(DATA/'candidate.json',report)
 if promote and os.environ.get('FORECAST_CANDIDATE_ONLY')!='1':save_json(current,report)
 save_json(DATA/'training_status.json',{'status':'complete','version':version,'promoted':promote,'device':report['device'],'training_seconds':report['training_seconds'],'next':'Retrain after new genuine archive observations arrive; replay is excluded.'})
 print(json.dumps({k:report[k] for k in ['version','chosen','test_metrics','promoted','training_seconds']},indent=2),flush=True)
if __name__=='__main__':
 try:train(int(os.environ.get('FORECAST_EPOCHS','30')))
 except Exception as e:save_json(DATA/'training_status.json',{'status':'failed','error':str(e)});raise
