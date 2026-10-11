import unittest
from unittest.mock import patch
import pandas as pd
import node_detail as n
class NodeDetailTests(unittest.TestCase):
 def setUp(self):
  self.now=pd.Timestamp.now(tz='UTC');self.df=pd.DataFrame({'Grid Power':[-100.], 'Panel1 (HVAC)':[200.]},index=[self.now.floor('15min')-pd.Timedelta(minutes=15)])
 def run_node(self,name,raw,forecast=lambda: {'channels':[]}):
  graph={'nodes':[{'id':name,'name':name,'kind':'meter channel'}],'edges':[]}
  with patch.object(n,'read',side_effect=lambda key,default=None:graph if key=='system_graph.json' else {}),patch.object(n,'latest_raw',return_value=raw):return n.detail(name,24,self.df,forecast)
 def test_signed_grid_and_source_time(self):
  ts=self.now.isoformat();d=self.run_node('Grid Power',{'ts':ts,'values':{'Grid Power':-2312}})
  self.assertEqual(d['facts'][0]['value'],-2312);self.assertEqual(d['facts'][0]['at'],ts);self.assertEqual(d['freshness'],'current')
 def test_panel_orientation(self):
  d=self.run_node('Panel1 (HVAC)',{'ts':self.now.isoformat(),'values':{'Panel1 (HVAC)':-300}});self.assertEqual(d['facts'][0]['value'],300)
 def test_stale_is_explicit(self):
  d=self.run_node('Grid Power',{'ts':(self.now-pd.Timedelta(hours=1)).isoformat(),'values':{'Grid Power':0}});self.assertEqual(d['freshness'],'stale');self.assertEqual(d['facts'][0]['value'],0)
 def test_missing_not_zero(self):
  d=self.run_node('Grid Power',{});self.assertIsNone(d['facts'][0]['value']);self.assertIsNone(d['observed_at'])
 def test_forecast_failure_preserves_measured_chart(self):
  def fail():raise RuntimeError('Unavailable')
  d=self.run_node('Grid Power',{},fail);self.assertTrue(d['charts']);self.assertTrue(any('unavailable' in x for x in d['notes']))
 def test_unknown_node_rejected(self):
  with patch.object(n,'read',return_value={'nodes':[]}):
   with self.assertRaises(KeyError):n.detail('../private',24,self.df,lambda:None)
if __name__=='__main__':unittest.main()
