import unittest
from unittest.mock import Mock
from device_clients import Meter,pd
class DeviceHistoryTests(unittest.TestCase):
 def test_exact_counter_differences_and_orientation(self):
  m=Meter.__new__(Meter);m.dev=Mock();big=2**60
  m.dev.get.return_value={'registers':[{'name':'Panel1 (HVAC)','type':'P'},{'name':'Grid Power','type':'P'},{'name':'VrmsA','type':'V'}],'ranges':[{'ts':1800,'delta':900,'rows':[[str(big-9000),str(big-18000),str(big+108000000)],[str(big),str(big),str(big)]]}]}
  d=m.history(pd.Timestamp(900,unit='s',tz='UTC'),pd.Timestamp(1800,unit='s',tz='UTC'))
  self.assertEqual(d.iloc[0]['Panel1 (HVAC)'],10);self.assertEqual(d.iloc[0]['Grid Power'],-20);self.assertEqual(d.iloc[0]['VrmsA'],120)
 def test_epoch_sentinel_not_data(self):
  m=Meter.__new__(Meter);m.dev=Mock();m.dev.get.return_value={'registers':[],'ranges':[{'ts':1433256900,'delta':0,'rows':[['0']]}]}
  self.assertTrue(m.history(pd.Timestamp('2026-03-06',tz='UTC'),pd.Timestamp('2026-04-06',tz='UTC')).empty)
 def test_stale_meter_is_rejected(self):
  m=Meter.__new__(Meter);m.dev=Mock();m.dev.get.return_value={'ts':1000,'registers':[]}
  with self.assertRaises(ValueError):m.current()
if __name__=='__main__':unittest.main()
