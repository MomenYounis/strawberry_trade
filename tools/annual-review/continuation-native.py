#!/usr/bin/env python3
"""Retained-data install/fixture driver on this campaign's disposable AVD only.
No fallback installer, uninstall, production network or account mutation.
"""
import argparse,datetime,hashlib,json,os,pathlib,re,subprocess,time,urllib.parse
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'verification/continuation-2026-11-02/native'
ADB='/home/younis/Android/Sdk/platform-tools/adb'
PACKAGE='com.strawberrytrade.strawberry_trade'
CERT='bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase',choices=['install','drive','reboot'])
parser.add_argument('--apk',type=pathlib.Path)
parser.add_argument('--label',required=True)
args=parser.parse_args()
if not re.fullmatch('[a-z0-9-]+',args.label):raise SystemExit('safe-label-required')
runtime=json.loads((OUT/'runtime.json').read_text())
result={'status':'BLOCKED','phase':args.phase,'synthetic':True,'ownerDeviceTouched':False,
 'productionAuthenticationUsed':False,'uninstallOrDataClear':False,'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
 'startedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
def guard():
 command=pathlib.Path('/proc/'+str(runtime['pid'])+'/cmdline').read_bytes()
 if runtime['serial']!='emulator-5580' or not runtime['runtimeRoot'].startswith('/tmp/strawberry-continuation-native-') or runtime['avdPath'].encode() not in command or runtime['avdName'].encode() not in command:raise RuntimeError('owned-disposable-runtime-required')
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
def redact(text):return re.sub(r'((?:https?|wss?)://127\.0\.0\.1:\d+/)[A-Za-z0-9_+=%-]+/',r'\1[REDACTED]/',text)
try:
 guard();offline()
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
   offline()
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
   result['nativeAssertionsPassed']=True
   (OUT/(args.label+'-app.log')).write_text(redact(device('logcat','-d','-v','brief')))
  finally:device('forward','--remove','tcp:'+port)
 result['status']='PASS'
except Exception as e:result['reason']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
result['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
path=OUT/(args.label+'.json')
if path.exists():path=OUT/(args.label+'-'+str(time.time_ns())+'.json')
path.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
raise SystemExit(0 if result['status']=='PASS' else 1)
