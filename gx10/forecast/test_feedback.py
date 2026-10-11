import unittest,tempfile
from pathlib import Path
from unittest.mock import patch
import pandas as pd
import feedback as f
class FeedbackTests(unittest.TestCase):
 def sample(self):
  return {'issued_at':'2026-10-11T10:00:00Z','origin':'2026-10-11T10:00:00Z','version':'v1','forecast_times':['2026-10-11T10:00:00Z','2026-10-11T10:15:00Z'],'channels':[{'name':'Battery state of charge','forecast':[50,60],'base_forecast':[49,59]}]}
 def actual(self):return pd.DataFrame({'solar__battery_soc':[52,61]},index=pd.to_datetime(self.sample()['forecast_times']))
 def test_partial_interval_not_scored(self):
  r=f.matched_rows(self.sample(),self.actual(),pd.Timestamp('2026-10-11T10:20:00Z'));self.assertEqual(len(r),1)
 def test_late_issued_forecast_not_scored(self):
  d=self.sample();d['issued_at']='2026-10-11T10:01:00Z';r=f.matched_rows(d,self.actual(),pd.Timestamp('2026-10-11T10:30:00Z'));self.assertEqual(len(r),1);self.assertEqual(r[0]['prediction'],60)
 def test_missing_measurement_is_not_zero(self):
  a=self.actual();a.iloc[0]=float('nan');r=f.matched_rows(self.sample(),a,pd.Timestamp('2026-10-11T10:15:00Z'));self.assertEqual(r,[])
 def test_limits_preserve_grid_and_temperature(self):
  self.assertEqual(f.clip('Battery state of charge',105),100);self.assertEqual(f.clip('Grid Power',-5),-5);self.assertEqual(f.clip('Battery temperature',-5),-5)
 def test_immutable_predictions_and_no_cross_version_bias(self):
  with tempfile.TemporaryDirectory() as tmp,patch.object(f,'DATA',Path(tmp)):
   f.save_json(Path(tmp)/'feedback_models.json',{'channels':{'Battery state of charge':{'base_version':'old','bias':10,'fitted_at':'2026-01-01T00:00:00Z','id':'bias1'}}})
   d=self.sample();d['channels'][0].update(lower=[40,50],upper=[60,70]);out=f.record(d,'battery');self.assertEqual(out['channels'][0]['forecast'],[50,60]);p=next((Path(tmp)/'issued_forecasts').glob('*.json'));first=p.read_text();d['channels'][0]['forecast']=[20,30];f.record(d,'battery');self.assertEqual(p.read_text(),first)
 def test_insufficient_unique_outcomes_do_not_promote(self):
  with tempfile.TemporaryDirectory() as tmp,patch.object(f,'DATA',Path(tmp)):
   report=f.learn(self.actual(),{'power':'v1','battery':'v1'});self.assertTrue(all(r['matched_intervals']==0 for r in report['channels']));self.assertEqual(f.read(Path(tmp)/'feedback_models.json',{})['channels'],{})
 def test_correction_promotes_only_with_later_validation_improvement(self):
  for tail,expected in [(55,True),(48,False)]:
   with self.subTest(tail=tail),tempfile.TemporaryDirectory() as tmp,patch.object(f,'DATA',Path(tmp)):
    times=pd.date_range(pd.Timestamp.now(tz='UTC').floor('15min')-pd.Timedelta(hours=8),periods=32,freq='15min')
    actual=pd.DataFrame({'solar__battery_soc':[55]*24+[tail]*8},index=times)
    d={'issued_at':(times[0]-pd.Timedelta(minutes=1)).isoformat(),'origin':times[0].isoformat(),'version':'v1','forecast_times':[x.isoformat() for x in times],'channels':[{'name':'Battery state of charge','forecast':[50]*32}]}
    directory=Path(tmp)/'issued_forecasts';directory.mkdir();f.save_json(directory/'one.json',d);f.save_json(directory/'duplicate.json',d)
    report=f.learn(actual,{'power':'v1','battery':'v1'});entry=next(c for c in report['channels'] if c['name']=='Battery state of charge')
    self.assertEqual(entry['matched_intervals'],32)
    self.assertEqual(entry['status']=='correction promoted',expected)
if __name__=='__main__':unittest.main()
