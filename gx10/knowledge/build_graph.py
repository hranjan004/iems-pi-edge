"""Verified deployment graph + separately labelled txt2kg document extraction."""
import json,subprocess,urllib.request,datetime,sys,hashlib
from pathlib import Path
import yaml
ROOT=Path('/home/asus/Microgrid-UCSC');OUT=ROOT/'gx10/forecast/data/system_graph.json'
APP='http://127.0.0.1:47822'
def request(url,data=None):
 b=json.dumps(data).encode() if data is not None else None
 with urllib.request.urlopen(urllib.request.Request(url,data=b,headers={'Content-Type':'application/json'}),timeout=180) as r:return json.load(r)
def build(extract=False):
 nodes={};edges=[]
 def node(name,kind='service',**props):
  if name not in nodes:nodes[name]={'id':name,'name':name,'kind':kind,**props}
  return name
 def edge(a,b,label,evidence='deployment configuration',verified=True):
  edges.append({'source':a,'target':b,'label':label,'evidence':evidence,'verified':verified})
 node('GX10 / NVIDIA GB10','hardware')
 c=yaml.safe_load((ROOT/'gx10/docker-compose.gx10.yaml').read_text());services=c['services']
 running=[json.loads(s) for s in subprocess.check_output(['docker','ps','-a','--format','{{json .}}'],text=True).splitlines()]
 byname={r['Names']:r for r in running}
 for name,spec in services.items():
  cn=spec.get('container_name',name);node(name,status=byname.get(cn,{}).get('Status','not running / optional'),ports=spec.get('ports',[]));edge('GX10 / NVIDIA GB10',name,'hosts')
  for dep in spec.get('depends_on',[]):edge(node(dep),name,'starts before','Docker Compose depends_on (startup dependency, not proof of data flow)')
 for r in running:
  if r['Names'] not in [s.get('container_name',k) for k,s in services.items()]:
   node(r['Names'],status=r['Status']);edge('GX10 / NVIDIA GB10',r['Names'],'hosts','docker ps inventory')
 for name,kind in [('eGauge','meter'),('Solar Assistant','meter'),('Power forecasting API','service'),('GPU forecaster training','model'),('Ollama','service'),('Open-Meteo','external'),('NWS alerts','external'),('PG&E outage / PSPS','external'),('readiness monitor','service'),('eGauge archive March–October','dataset'),('solar archive August–September','dataset'),('weather forecast archive','dataset'),('Model registry','dataset')]:node(name,kind)
 for a,b,label in [('eGauge','eGauge archive March–October','exported history'),('eGauge archive March–October','replay-producer','replays'),('replay-producer','kafka','publishes'),('kafka','anylog-consumer','consumed by'),('anylog-consumer','operator1','writes readings'),('operator1','postgres','stores'),('operator1','iems-inference','serves readings'),('iems-inference','operator1','writes NILM'),('operator1','iems-backend','serves readings'),('iems-backend','iems-dashboard','serves DSS'),('Solar Assistant','solar archive August–September','exported history'),('solar archive August–September','replay-producer','replays solar'),('Open-Meteo','readiness monitor','weather forecast'),('NWS alerts','readiness monitor','active alerts'),('PG&E outage / PSPS','readiness monitor','outage warnings'),('readiness monitor','iems-backend','preparation advice'),('readiness monitor','iems-dashboard','readiness cards'),('eGauge archive March–October','GPU forecaster training','training observations'),('solar archive August–September','GPU forecaster training','past solar context'),('weather forecast archive','GPU forecaster training','past and issue-safe future weather'),('GPU forecaster training','Model registry','validated models'),('Model registry','Power forecasting API','loads champion'),('Power forecasting API','iems-dashboard','forecast graphs'),('Ollama','iems-knowledge-app-1','extracts triples')]:edge(node(a),node(b),label,'source code + configured pipeline')
 node('Authenticated web collector','service',status='systemd user service; direct HTTPS sources')
 node('Web source history March–October','dataset')
 for a,b,label in [('GX10 / NVIDIA GB10','Authenticated web collector','hosts'),('eGauge','Authenticated web collector','authenticated HTTPS readings'),('Solar Assistant','Authenticated web collector','authenticated HTTPS readings'),('Authenticated web collector','operator1','writes real current readings'),('Authenticated web collector','Web source history March–October','imports history'),('Web source history March–October','GPU forecaster training','verified training observations'),('Web source history March–October','Power forecasting API','current measured context')]:edge(a,b,label,'web collector source code and successful authenticated live reads')
 channels=['Panel1 (HVAC)','Panel2 (H2O)','Panel3 (Kitchen)','Grid Power','Shop','Generac Power','Current on Utility Tie','F1','I11','I12','I21','I22','I31','I32','VrmsA','VrmsB']
 for ch in channels:node(ch,'meter channel');edge('eGauge',ch,'measures','eGauge archive channel names')
 import ast
 tree=ast.parse(Path('/home/asus/iems/iems_fc/core.py').read_text())
 for item in tree.body:
  if (isinstance(item,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='APPLIANCES' for t in item.targets)) or (isinstance(item,ast.AnnAssign) and isinstance(item.target,ast.Name) and item.target.id=='APPLIANCES'):
   apps=ast.literal_eval(item.value)
   for app,(panel,nom,_) in apps.items():
    node(app,'appliance',nominal_w=nom);edge({'panel1_w':channels[0],'panel2_w':channels[1],'panel3_w':channels[2]}[panel],app,'NILM association','iems_fc/core.py appliance mapping; inferred appliance state, not independently metered')
 old=json.loads(OUT.read_text()) if OUT.exists() else {};inferred=old.get('inferred_triples',[])
 if extract:
  text='\n'.join(f'{e["source"]} {e["label"]} {e["target"]}.' for e in edges if e['evidence']=='source code + configured pipeline')
  data=request(APP+'/api/extract-triples',{'text':text,'llmProvider':'ollama','ollamaModel':'llama3.2:1b'})
  inferred=[t for t in data.get('triples',[]) if all(isinstance(t.get(k),str) and t[k].strip() for k in ['subject','predicate','object'])]
  if not inferred:raise RuntimeError('txt2kg returned no valid triples')
  # Keep inferred triples as provenance-bearing records; never auto-promote to verified wiring.
  (OUT.parent/'txt2kg_extraction.json').write_text(json.dumps({'source_text':text,'model':'llama3.2:1b','triples':inferred},indent=2))
 triples=[{'subject':e['source'],'predicate':e['label'],'object':e['target'],'metadata':{'source':e['evidence'],'verified':True}} for e in edges]
 request(APP+'/api/graph-db',{'triples':triples})
 # Explicit inference namespace avoids merging hallucinated edges with verified ones.
 if inferred:request(APP+'/api/graph-db',{'triples':[dict(subject='[inferred] '+t['subject'],predicate=t['predicate'],object='[inferred] '+t['object'],metadata={'source':'txt2kg / llama3.2:1b','verified':False}) for t in inferred]})
 graph={'updated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'nodes':list(nodes.values()),'edges':edges,'inferred_triples':inferred,'txt2kg_url':APP,'scope':'Discovered GX10 containers, configured services, meter channels and documented appliance associations. Does not assert a complete physical wiring survey.','tools':['NVIDIA txt2kg','Ollama local extraction','ArangoDB','txt2kg Three.js/WebGPU viewer','NVIDIA nvidia-smi device telemetry']}
 OUT.parent.mkdir(parents=True,exist_ok=True);tmp=OUT.with_suffix('.tmp');tmp.write_text(json.dumps(graph,indent=2));tmp.replace(OUT)
 print('graph',len(nodes),'nodes',len(edges),'verified relationships',len(inferred),'extracted triples',flush=True)
if __name__=='__main__':build('--extract' in sys.argv)
