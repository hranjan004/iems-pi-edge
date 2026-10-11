"""Small TiDE-inspired dense encoder / temporal decoder with daily residual.
Adaptation (joint channels, missingness masks), not a reproduction of paper scores.
"""
from common import *
import torch
from torch import nn
class Residual(nn.Module):
 def __init__(self,a,b):
  super().__init__();self.net=nn.Sequential(nn.Linear(a,b),nn.ReLU(),nn.Dropout(.1),nn.Linear(b,b));self.skip=nn.Linear(a,b);self.norm=nn.LayerNorm(b)
 def forward(self,x):return self.norm(self.net(x)+self.skip(x))
class TiDE(nn.Module):
 def __init__(self,nobs,nfuture,nt=len(TARGETS)):
  super().__init__();self.nt=nt
  self.encoder=nn.Sequential(Residual(L*nobs*2,128),Residual(128,128))
  self.projection=nn.Sequential(nn.Linear(nfuture,16),nn.ReLU())
  self.decoder=nn.Sequential(nn.Linear(128+16+nt*2,64),nn.ReLU(),nn.Linear(64,nt))
 def forward(self,past,future,seasonal):
  latent=self.encoder(past.flatten(1)).unsqueeze(1).expand(-1,H,-1)
  return seasonal[...,:self.nt]+self.decoder(torch.cat([latent,self.projection(future),seasonal],dim=-1))
def fit_scaler(df,cut):
 obs=[c for c in df.columns if not c.startswith('future__')];tr=df.iloc[:cut]
 mean=tr[obs].mean().fillna(0).values.astype('float32');std=tr[obs].std().fillna(1).clip(lower=1).values.astype('float32')
 ym=tr[TARGETS].mean().fillna(0).values.astype('float32');ys=tr[TARGETS].std().fillna(1).clip(lower=50).values.astype('float32')
 return dict(obs=obs,mean=mean,std=std,ym=ym,ys=ys)
def arrays(df,scaler):
 raw=df[scaler['obs']].values.astype('float32');valid=np.isfinite(raw)
 past=np.concatenate([np.nan_to_num((raw-scaler['mean'])/scaler['std']),valid.astype('float32')],axis=1)
 y=df[TARGETS].values.astype('float32');ymask=np.isfinite(y);yn=np.nan_to_num((y-scaler['ym'])/scaler['ys'])
 wx=df[['future__'+x for x in WX]].values.astype('float32');wxvalid=np.isfinite(wx)
 wx=np.nan_to_num(wx/np.array([30,100,1000,50],dtype='float32'))
 future=np.column_stack([calendar(df.index),wx,wxvalid.astype('float32')]).astype('float32')
 return past,future,yn,ymask,y
class Windows(torch.utils.data.Dataset):
 def __init__(self,arr,origins):self.arr=arr;self.origins=np.asarray(origins)
 def __len__(self):return len(self.origins)
 def __getitem__(self,k):
  i=self.origins[k];p,f,y,m,_=self.arr
  seasonal=np.concatenate([y[i-L:i],m[i-L:i].astype('float32')],axis=1)
  return tuple(torch.from_numpy(np.ascontiguousarray(x)) for x in (p[i-L:i],f[i:i+H],seasonal,y[i:i+H],m[i:i+H].astype('float32')))
def origins_for(arr,start,end,stride=4):
 # No target windows cross split boundaries. Missing targets stay masked in loss.
 m=arr[3];return [i for i in range(max(L,start),end-H+1,stride) if m[i-L:i,:6].mean()>=.8 and m[i:i+H,:6].mean()>=.8]
def predict(model,arr,origins,device='cpu'):
 loader=torch.utils.data.DataLoader(Windows(arr,origins),batch_size=64,shuffle=False)
 out=[];model.eval()
 with torch.no_grad():
  for p,f,s,_,_ in loader:out.append(model(p.to(device),f.to(device),s.to(device)).cpu().numpy())
 return np.concatenate(out)
def baselines(arr,origins,sc):
 y=arr[4];fallback=sc['ym'];res={'persistence':[],'daily':[],'weekly':[]}
 for i in origins:
  history=y[max(0,i-L):i];last=np.where(np.isfinite(history[-1]),history[-1],fallback)
  daily=np.where(np.isfinite(history),history,last)
  week=y[i-7*L:i-6*L] if i>=7*L else daily
  week=np.where(np.isfinite(week),week,daily)
  res['persistence'].append(np.tile(last,(H,1)));res['daily'].append(daily);res['weekly'].append(week)
 return {k:constrain(np.array(v)) for k,v in res.items()}
def constrain(x):
 x=x.copy();x[..., [0,1,2,4,5,6]]=np.maximum(x[...,[0,1,2,4,5,6]],0);return x
def all_candidates(ck,arr,origins):
 out=baselines(arr,origins,ck['scaler']);m=TiDE(len(ck['obs']),ck['nfuture']);m.load_state_dict(ck['weights']);out['tide']=constrain(predict(m,arr,origins)*ck['scaler']['ys']+ck['scaler']['ym'])
 if ck.get('boost_files'):
  import sys
  sys.path.insert(0,str(ROOT/'packages'));import xgboost as xgb
  from boost import features
  dm=xgb.DMatrix(features(arr,origins));pred=[]
  for name in ck['boost_files']:
   model=xgb.Booster();model.load_model(DATA/name);model.set_param({'device':'cpu','nthread':2})
   end=int(model.attr('best_iteration') or model.num_boosted_rounds()-1)+1
   pred.append(model.predict(dm,iteration_range=(0,end)))
  out['xgboost']=constrain(np.stack(pred,-1).reshape(len(origins),H,len(TARGETS)))
  out['boost_daily_blend']=(out['xgboost']+out['daily'])/2
 return out
