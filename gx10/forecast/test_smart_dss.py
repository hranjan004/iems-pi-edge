import unittest
import pandas as pd
import numpy as np
from smart_dss import rate,optimize,states,JOBS,plan
class PlannerTests(unittest.TestCase):
 def test_official_winter_weekend_and_summer_prices(self):
  self.assertEqual(rate('2026-10-11T23:00:00Z'),.32063)
  self.assertEqual(rate('2026-10-11T20:00:00Z'),.28468)
  self.assertEqual(rate('2026-07-12T23:00:00Z'),.55214)
  self.assertEqual(rate('2026-10-12T04:00:00Z'),.29854)
 def test_joint_schedule_is_nonoverlapping_and_laundry_ordered(self):
  ts=pd.date_range('2026-10-11T19:00:00Z',periods=96,freq='15min')
  result=optimize(JOBS,ts,np.full(96,1000),np.full(96,80),np.full(96,5000),np.zeros(96))
  self.assertEqual(len(result),3);intervals=sorted((i,i+j['minutes']//15,j['id']) for j,i,c in result)
  self.assertTrue(all(a[1]<=b[0] for a,b in zip(intervals,intervals[1:])))
  ids=[v[2] for v in intervals];self.assertLess(ids.index('washing_machine'),ids.index('dryer'))
  washer=next(v for v in intervals if v[2]=='washing_machine');dryer=next(v for v in intervals if v[2]=='dryer');self.assertLessEqual(dryer[0]-washer[1],8)
  self.assertTrue(all(ts[a].tz_convert('America/Los_Angeles').hour>=8 for a,b,c in intervals))
 def test_low_battery_does_not_schedule_optional_loads(self):
  ts=pd.date_range('2026-10-11T19:00:00Z',periods=96,freq='15min')
  self.assertEqual(optimize(JOBS,ts,np.zeros(96),np.full(96,15),np.zeros(96),np.zeros(96)),[])
 def test_running_appliance_requires_fresh_confident_evidence(self):
  now=pd.Timestamp('2026-10-11T19:00:00Z');rows=[{'appliance':'dryer','state':'ON','confidence':.9,'ts':'2026-10-11 18:00:00'}, {'appliance':'dishwasher','state':'ON','confidence':.8,'ts':'2026-10-11 18:59:00'}]
  self.assertNotIn('dryer',states(rows,now));self.assertTrue(states(rows,now)['dishwasher']['on'])
 def test_cheaper_grid_window_beats_peak_when_solar_equal(self):
  ts=pd.date_range('2026-10-11T23:00:00Z',periods=96,freq='15min');r=optimize([JOBS[1]],ts,np.full(96,1000),np.full(96,80),np.zeros(96),np.zeros(96))
  self.assertEqual(len(r),1);self.assertLess(rate(ts[r[0][1]]),rate(ts[0]))
 def test_replay_not_used_for_advice(self):
  with self.assertRaises(ValueError):plan({'forecast_times':[],'channels':[],'mode':'replay'},{'channels':[]},{},[],{})
if __name__=='__main__':unittest.main()
