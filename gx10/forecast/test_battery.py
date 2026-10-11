import unittest
import numpy as np
import pandas as pd
from battery import scale,arrays,baseline,bounds,origins,TARGET,WX
class BatteryTests(unittest.TestCase):
 def setUp(self):
  idx=pd.date_range('2026-06-01',periods=1200,freq='15min',tz='UTC');r=np.random.default_rng(4)
  self.d=pd.DataFrame({TARGET[0]:r.uniform(10,100,len(idx)),TARGET[1]:r.normal(70,5,len(idx))},index=idx)
  for k in WX:self.d['future__'+k]=20.
 def test_units_and_limits(self):
  np.testing.assert_equal(bounds([[-5,-10],[110,140]]),[[0,-10],[100,140]])
 def test_scaling_does_not_use_test_targets(self):
  a=scale(self.d,700);changed=self.d.copy();changed.iloc[700:]=10000;b=scale(changed,700)
  np.testing.assert_equal(a['ym'],b['ym']);np.testing.assert_equal(a['ys'],b['ys'])
 def test_baselines_do_not_use_future_battery_readings(self):
  s=scale(self.d,700);a=baseline(arrays(self.d,s),[800],s);changed=self.d.copy();changed.loc[changed.index[800]:,TARGET]=999
  b=baseline(arrays(changed,s),[800],s)
  for k in a:np.testing.assert_equal(a[k],b[k])
 def test_both_battery_channels_need_history(self):
  self.d.loc[self.d.index[705]:self.d.index[799],TARGET[1]]=np.nan
  a=arrays(self.d,scale(self.d,700));self.assertNotIn(800,origins(a,800,1000,1))
 def test_no_targets_cross_split_boundary(self):
  a=arrays(self.d,scale(self.d,700));self.assertTrue(all(i+96<=1100 for i in origins(a,800,1100,1)))
if __name__=='__main__':unittest.main()
