#!/usr/bin/env python3
"""Retained-data install/fixture driver on this campaign's disposable AVD only.
No fallback installer, uninstall, production network or account mutation.
"""
import argparse,datetime,hashlib,json,os,pathlib,re,subprocess,time,urllib.parse
from native_network_isolation import ensure_synthetic_firewall
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'verification/continuation-2026-11-02/native'
ADB='/home/younis/Android/Sdk/platform-tools/adb'
PACKAGE='com.strawberrytrade.strawberry_trade'
CERT='bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase',choices=['install','drive','reboot'])
parser.add_argument('--apk',type=pathlib.Path)
parser.add_argument('--label',required=True)
parser.add_argument('--runtime',type=pathlib.Path,default=OUT/'source-runtime.json')
parser.add_argument('--network',choices=['offline','local-demo'],default='offline')
parser.add_argument('--job',type=pathlib.Path)
parser.add_argument('--private-result',type=pathlib.Path)
parser.add_argument('--evidence-dir',type=pathlib.Path)
args=parser.parse_args()
if args.evidence_dir:
 OUT=args.evidence_dir.resolve()
 if not OUT.is_relative_to(ROOT/'verification'):raise SystemExit('verification-evidence-directory-required')
if not re.fullmatch('[a-z0-9-]+',args.label):raise SystemExit('safe-label-required')
OUT.mkdir(parents=True,exist_ok=True)
runtime=json.loads(args.runtime.read_text())
result={'status':'BLOCKED','phase':args.phase,'synthetic':True,'ownerDeviceTouched':False,
 'productionAuthenticationUsed':False,'uninstallOrDataClear':False,'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
 'startedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def guard():
 command=pathlib.Path('/proc/'+str(runtime['pid'])+'/cmdline').read_bytes()
 folder=pathlib.Path(runtime['runtimeRoot'])
 durable=folder.parent==pathlib.Path('/home/younis/.local/share/strawberry-trade-test-runtime') and folder.name.startswith('strawberry-commercial-native-') and not folder.is_symlink()
 serials={'source':'emulator-5580','employee':'emulator-5582','replacement':'emulator-5584','compatibility':'emulator-5586','upgrade':'emulator-5578'}
 if runtime['serial'] not in set(serials.values()) or (durable and runtime.get('serial')!=serials.get(runtime.get('name'))) or not (durable or runtime['runtimeRoot'].startswith(('/tmp/strawberry-continuation-native-','/tmp/strawberry-commercial-native-'))) or runtime['avdPath'].encode() not in command or runtime['avdName'].encode() not in command:raise RuntimeError('owned-disposable-runtime-required')
def device(*command,timeout=30):
 guard();r=subprocess.run([ADB,'-s',runtime['serial'],*command],capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError('scoped-android-command-failed')
 return r.stdout.strip()
def offline():
 if device('shell','getprop','sys.boot_completed')!='1':raise RuntimeError('boot-not-complete')
 device('shell','settings','put','global','mobile_data','0')
 device('shell','cmd','connectivity','airplane-mode','enable');device('shell','svc','wifi','disable');device('shell','svc','data','disable')
 result['network']={key:device('shell','settings','get','global',key) for key in ['airplane_mode_on','wifi_on','mobile_data']}
 if result['network']!={'airplane_mode_on':'1','wifi_on':'0','mobile_data':'0'}:raise RuntimeError('offline-required')
def demo_network():
 # The Google APIs disposable image permits root. Chain belongs only to this
 # marked synthetic AVD, never to the host or a customer/owner installation.
 offline()
 device('root');time.sleep(1)
 if device('shell','id','-u')!='0':raise RuntimeError('outbound-isolation-root-required')
 ensure_synthetic_firewall(device)
 device('shell','cmd','connectivity','airplane-mode','disable');device('shell','svc','data','disable');device('shell','svc','wifi','enable')
 result['network']={'mode':'local-demo-only','allowedIPv4':'loopback + 10.0.2.2 TCP8788/9099/18788','otherIPv4':'REJECT','otherIPv6':'REJECT'}
def private_file(path):
 path=path.resolve()
 if str(path).startswith('/tmp/strawberry-') and path.parent.is_dir() and path.parent.stat().st_mode&0o077==0:return path
 raise RuntimeError('private-marked-transfer-directory-required')
def redact(text):return re.sub(r'((?:https?|wss?)://127\.0\.0\.1:\d+/)[A-Za-z0-9_+=%-]+/',r'\1[REDACTED]/',text)
try:
 guard();offline() if args.network=='offline' else demo_network()
 if args.phase=='install':
  if not args.apk:raise RuntimeError('apk-required')
  path=args.apk.resolve();tools='/home/younis/Android/Sdk/build-tools/36.0.0/'
  env=os.environ.copy();env['JAVA_HOME']='/usr/lib/jvm/java-17-temurin-jdk';env['PATH']=env['JAVA_HOME']+'/bin:'+env['PATH']
  signature=subprocess.check_output([tools+'apksigner','verify','--verbose','--print-certs',str(path)],env=env,text=True)
  if CERT not in signature:raise RuntimeError('existing-approved-certificate-required')
  badging=subprocess.check_output([tools+'aapt','dump','badging',str(path)],env=env,text=True)
  if "name='"+PACKAGE+"'" not in badging:raise RuntimeError('package-mismatch')
  result.update(sha256=hashlib.sha256(path.read_bytes()).hexdigest(),certificateSha256=CERT,artifact=str(path),badging=badging.splitlines()[0])
  if 'Success' not in device('install','-r',str(path),timeout=180):raise RuntimeError('retained-data-install-required')
  device('shell','am','start','-n',PACKAGE+'/.MainActivity');time.sleep(3);device('shell','am','force-stop',PACKAGE)
 elif args.phase in ['drive','reboot']:
  if args.phase=='reboot':
   device('reboot');deadline=time.monotonic()+180
   while time.monotonic()<deadline:
    try:
     if device('shell','getprop','sys.boot_completed')=='1':break
    except Exception:pass
    time.sleep(2)
   offline() if args.network=='offline' else demo_network()
  if args.job:
   job=private_file(args.job)
   raw=job.read_bytes()
   if len(raw)>65536 or not isinstance(json.loads(raw),dict):raise RuntimeError('bounded-synthetic-job-required')
   device('shell','am','force-stop',PACKAGE)
   written=subprocess.run([ADB,'-s',runtime['serial'],'shell','run-as',PACKAGE,'sh','-c',"'cat > files/commercial-job.json'"],input=raw,capture_output=True,timeout=30)
   if written.returncode:raise RuntimeError('private-fixture-job-write-failed')
  driver=OUT/'continuation_driver.dart'
  driver.write_text("import 'package:integration_test/integration_test_driver.dart';\nFuture<void> main()=>integrationDriver(timeout:const Duration(minutes:5),responseDataCallback:(_) async {});\n")
  device('logcat','-c');device('shell','am','force-stop',PACKAGE);device('shell','am','start','-n',PACKAGE+'/.MainActivity')
  deadline=time.monotonic()+90;uri=None
  while time.monotonic()<deadline:
   log=device('logcat','-d','-v','brief');match=re.search(r'The Dart VM service is listening on (http://127\.0\.0\.1:\d+/[^\s]+)',log)
   if match:uri=urllib.parse.urlsplit(match.group(1));break
   time.sleep(1)
  if uri is None:raise RuntimeError('fixture-vm-service-unavailable')
  port=device('forward','tcp:0','tcp:'+str(uri.port))
  try:
   env=os.environ.copy();env['VM_SERVICE_URL']=urllib.parse.urlunsplit(('http','127.0.0.1:'+port,uri.path,'',''))
   r=subprocess.run(['/home/younis/flutter/bin/cache/dart-sdk/bin/dart','--packages=.dart_tool/package_config.json',str(driver)],cwd=ROOT,env=env,capture_output=True,text=True,timeout=360)
   (OUT/(args.label+'-driver.log')).write_text(redact(r.stdout+r.stderr))
   if r.returncode or 'All tests passed.' not in r.stdout:raise RuntimeError('native-assertions-failed')
   app_log=device('logcat','-d','-v','brief')
   # Publish only Flutter assertion output, not unrelated system/Auth logs.
   (OUT/(args.label+'-app.log')).write_text(redact('\n'.join(line for line in app_log.splitlines() if 'flutter' in line.lower())))
   if re.search(r'flutter.*(?:Some tests failed\.|\[E\]\s*$)',app_log,re.M):raise RuntimeError('native-app-reported-test-failure')
   if not re.search(r'flutter.*All tests passed!',app_log):raise RuntimeError('native-app-success-not-observed')
   result['nativeAssertionsPassed']=True
   if args.private_result:
    private_result=private_file(args.private_result)
    raw=device('shell','run-as',PACKAGE,'cat','files/commercial-result.json')
    value=json.loads(raw)
    private_result.write_text(raw+'\n');os.chmod(private_result,0o600)
    result['fixturePhase']=value['phase'];result['publicInstallationDeviceId']=value['deviceId']
  finally:device('forward','--remove','tcp:'+port)
 result['status']='PASS'
except Exception as e:result['reason']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
result['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
path=OUT/(args.label+'.json')
if path.exists():path=OUT/(args.label+'-'+str(time.time_ns())+'.json')
path.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
raise SystemExit(0 if result['status']=='PASS' else 1)
