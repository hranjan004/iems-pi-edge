import unittest
from common import *
from model import *
from boost import features
class ForecastTests(unittest.TestCase):
 def setUp(self):
  self.n=1000;idx=pd.date_range('2026-07-01',periods=self.n,freq='15min',tz='UTC');rng=np.random.default_rng(7)
  self.df=pd.DataFrame({c:rng.normal(100,10,self.n) for c in TARGETS},index=idx)
  for c in WX:self.df['wx__'+c]=5.;self.df['future__'+c]=6.
  self.sc=fit_scaler(self.df,700);self.arr=arrays(self.df,self.sc)
 def test_no_future_observation_leakage(self):
  a=features(self.arr,[750]);d=self.df.copy();cols=[c for c in d if not c.startswith('future__')];d.loc[d.index[750]:,cols]=999999
  b=features(arrays(d,self.sc),[750]);np.testing.assert_allclose(a,b)
 def test_future_forecast_context_changes_features(self):
  a=features(self.arr,[750]);d=self.df.copy();d.loc[d.index[750]:,'future__cloud_cover']=99
  self.assertFalse(np.array_equal(a,features(arrays(d,self.sc),[750])))
 def test_scaler_uses_only_training(self):
  d=self.df.copy();d.iloc[700:]=99999;s=fit_scaler(d,700);np.testing.assert_allclose(s['mean'],self.sc['mean'])
 def test_window_targets_stay_inside_split(self):
  origins=origins_for(self.arr,700,1000,4);self.assertTrue(all(i>=700 and i+H<=1000 for i in origins))
 def test_gaps_are_excluded(self):
  d=self.df.copy();d.loc[d.index[600]:d.index[800],CHANNELS]=np.nan;a=arrays(d,self.sc);self.assertNotIn(750,origins_for(a,750,1000,1))
 def test_power_constraints_preserve_grid_export(self):
  x=constrain(np.full((96,7),-100.));self.assertTrue((x[:,0]==0).all());self.assertTrue((x[:,3]==-100).all())
 def test_daylight_and_timezone(self):
  idx=pd.to_datetime(['2026-07-01T07:00:00Z','2026-07-01T20:00:00Z']);c=calendar(idx);self.assertLess(c[0,7],0);self.assertGreater(c[1,7],0)
 def test_baseline_only_uses_past(self):
  b=baselines(self.arr,[750],self.sc);d=self.df.copy();d.iloc[750:]=10000;b2=baselines(arrays(d,self.sc),[750],self.sc)
  for k in b:np.testing.assert_allclose(b[k],b2[k])
 def test_neural_shape_finite(self):
  model=TiDE(len(self.sc['obs']),self.arr[1].shape[1]);out=predict(model,self.arr,[750]);self.assertEqual(out.shape,(1,96,7));self.assertTrue(np.isfinite(out).all())
if __name__=='__main__':unittest.main()
