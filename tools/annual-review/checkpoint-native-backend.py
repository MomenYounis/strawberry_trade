#!/usr/bin/env python3
"""Durable local demo-emulator checkpoint; no production endpoint/credential."""
import argparse,pathlib,json,subprocess,os,datetime,hashlib,re
ROOT=pathlib.Path(__file__).resolve().parents[2];OUT=ROOT/'verification/continuation-2026-11-02/native-durable'
p=argparse.ArgumentParser(description=__doc__);p.add_argument('label');a=p.parse_args()
if not re.fullmatch('[a-z][a-z0-9-]{0,35}',a.label):raise SystemExit('bounded-local-label-required')
ready=None
for line in (OUT/'local-backend-serve.log').read_text().splitlines():
 try:
  value=json.loads(line)
  if value.get('state')=='ready':ready=value
 except ValueError:pass
if not ready or ready['projectId']!='demo-strawberry-flutter' or ready['ports']['hub']!=4418:raise SystemExit('owned-demo-backend-required')
folder=pathlib.Path(ready['runtimeRoot']);base=pathlib.Path('/home/younis/.local/share/strawberry-trade-test-runtime')
if folder.parent!=base or not folder.name.startswith('backend-') or folder.is_symlink() or folder.stat().st_mode&0o077:raise SystemExit('private-owned-runtime-required')
if str(folder/'backend/scripts/worker-http-test-runner.mjs').encode() not in pathlib.Path('/proc',str(ready['pid']),'cmdline').read_bytes():raise SystemExit('live-owned-backend-required')
dest=folder/('checkpoint-'+a.label)
if dest.exists():raise SystemExit('checkpoint-already-exists')
env={k:os.environ[k] for k in ['PATH','HOME','JAVA_HOME','LANG'] if k in os.environ};env.update(FIREBASE_EMULATOR_HUB='127.0.0.1:4418',GCLOUD_PROJECT='demo-strawberry-flutter',GOOGLE_CLOUD_PROJECT='demo-strawberry-flutter',XDG_CONFIG_HOME=str(folder/'config'),CI='true')
command=[str(ROOT/'backend/node_modules/.bin/firebase'),'emulators:export',str(dest),'--only','auth,firestore','--project','demo-strawberry-flutter','--config',str(folder/'firebase.json')]
with (OUT/('checkpoint-'+a.label+'.log')).open('w') as log:result=subprocess.run(command,env=env,cwd=folder,stdout=log,stderr=subprocess.STDOUT)
if result.returncode or not (dest/'firebase-export-metadata.json').is_file():raise SystemExit('local-checkpoint-failed')
# Keep the synthetic identity/password database private; publish aggregate only.
files=[f for f in dest.rglob('*') if f.is_file()];total=sum(f.stat().st_size for f in files)
meta={'synthetic':True,'projectId':'demo-strawberry-flutter','directory':dest.name,'capturedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
temporary=folder/'latest-checkpoint.json.new';temporary.write_text(json.dumps(meta));temporary.chmod(0o600);temporary.replace(folder/'latest-checkpoint.json')
(OUT/('checkpoint-'+a.label+'.json')).write_text(json.dumps({'status':'PASS','synthetic':True,'durableLocalCheckpoint':True,'files':len(files),'bytes':total,'productionDataUsed':False,**meta},indent=2)+'\n')
print(json.dumps({'status':'PASS','synthetic':True,'label':a.label,'files':len(files),'bytes':total}))
