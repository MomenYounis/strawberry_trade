#!/usr/bin/env python3
"""Operate only this campaign's marked synthetic AVD and DEBUG fixture.

Private job/result and backup files never enter logs. No fallback installer,
uninstall, data clear, production login, owner device, or cloud API is used.
"""
import argparse, datetime, hashlib, json, os, pathlib, re, shlex, stat, subprocess, time, urllib.parse
from native_fixture_signing import check_annual_campaign
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'verification/continuation-2026-11-02/native-durable'
ADB='/home/younis/Android/Sdk/platform-tools/adb'
PACKAGE='com.strawberrytrade.strawberry_trade'
APPROVED_CERT='bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b'
SDK=pathlib.Path('/home/younis/Android/Sdk')
DURABLE=pathlib.Path('/home/younis/.local/share/strawberry-trade-test-runtime')
SERIALS={'source':'emulator-5580','employee':'emulator-5582','replacement':'emulator-5584','compatibility':'emulator-5586','upgrade':'emulator-5578'}

def sha256_file(path):
 digest=hashlib.sha256()
 with pathlib.Path(path).open('rb') as source:
  while chunk:=source.read(1024*1024):digest.update(chunk)
 return digest.hexdigest()

def verification_file(path,root=ROOT):
 """Require an ordinary file beneath this checkout's verification directory."""
 original=pathlib.Path(path).absolute();resolved=original.resolve(strict=True)
 if not resolved.is_relative_to(root/'verification') or not resolved.is_file():raise RuntimeError('ordinary-verification-file-required')
 for part in [original,*original.parents]:
  if part.is_symlink():raise RuntimeError('ordinary-verification-file-required')
  if part==root:break
 return resolved

def validated_fixture(path,root=ROOT,run=subprocess.run):
 """Verify a test receipt and its actual APK, without reading signing secrets."""
 metadata_path=verification_file(path,root)
 with metadata_path.open('rb') as source:raw=source.read(65537)
 if len(raw)>65536:raise RuntimeError('bounded-signing-receipt-required')
 metadata=json.loads(raw)
 if (metadata.get('status')!='PASS' or metadata.get('synthetic') is not True
     or metadata.get('debugTestArtifact') is not True or metadata.get('certificateSha256')!=APPROVED_CERT
     or type(metadata.get('versionCode')) is not int or not 1<=metadata['versionCode']<=2147483647
     or not isinstance(metadata.get('sha256'),str) or not re.fullmatch('[0-9a-f]{64}',metadata['sha256'])):raise RuntimeError('passing-synthetic-debug-signing-receipt-required')
 artifact=verification_file(metadata['artifact'],root)
 if artifact.stat().st_size>256*1024*1024 or sha256_file(artifact)!=metadata['sha256']:raise RuntimeError('unchanged-bounded-debug-artifact-required')
 env={**os.environ,'JAVA_HOME':'/usr/lib/jvm/java-17-temurin-jdk'};env['PATH']=env['JAVA_HOME']+'/bin:'+env['PATH']
 def tool(*args):
  result=run(args,env=env,capture_output=True,text=True,timeout=60)
  if result.returncode or len(result.stdout)>256*1024:raise RuntimeError('fixture-static-verification-failed')
  return result.stdout
 signature=tool(str(SDK/'build-tools/36.0.0/apksigner'),'verify','--verbose','--print-certs',str(artifact))
 certificates=re.findall(r'^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F]+)\s*$',signature,re.M)
 if certificates!=[APPROVED_CERT]:raise RuntimeError('single-approved-existing-fixture-certificate-required')
 badging=tool(str(SDK/'build-tools/36.0.0/aapt'),'dump','badging',str(artifact))
 package=re.search(r"^package: name='([^']+)' versionCode='([^']+)'",badging,re.M)
 if not package or package.groups()!=(PACKAGE,str(metadata['versionCode'])) or not re.search(r'^application-debuggable\s*$',badging,re.M):raise RuntimeError('exact-synthetic-debug-package-version-required')
 annual={}
 if 'annualCampaign' in metadata:
  annual=check_annual_campaign(artifact,metadata['annualCampaign'])
  if any(metadata.get(key)!=value for key,value in annual.items()):raise RuntimeError('exact-annual-campaign-receipt-required')
 if sha256_file(artifact)!=metadata['sha256']:raise RuntimeError('fixture-changed-during-verification')
 return {'metadataPath':str(metadata_path),'metadataSha256':hashlib.sha256(raw).hexdigest(),
         'artifact':str(artifact),'sha256':metadata['sha256'],'bytes':artifact.stat().st_size,
         'versionCode':metadata['versionCode'],'certificateSha256':APPROVED_CERT,'debugTestArtifact':True,
         'sourceCommit':metadata.get('sourceCommit'),'sourceOrigin':metadata.get('sourceOrigin'),
         'signatureAndPackageIndependentlyVerified':True,**annual}

def guard_runtime(runtime,device,durable_only=False,proc_root=pathlib.Path('/proc')):
 folder=pathlib.Path(runtime['runtimeRoot']);name='strawberry_commercial_disposable_'+device
 allowed={DURABLE} if durable_only else {pathlib.Path('/tmp'),pathlib.Path('/dev/shm'),DURABLE}
 avd=folder/'avd'/(name+'.avd')
 if (folder.parent not in allowed or not folder.name.startswith('strawberry-commercial-native-')
     or not folder.is_dir() or any(p.is_symlink() for p in [folder,folder/'avd',avd]) or folder.stat().st_mode&0o077
     or runtime.get('synthetic') is not True or runtime.get('ownerDeviceTouched') is not False
     or runtime.get('name')!=device or runtime.get('serial')!=SERIALS[device]
     or runtime.get('avdPath')!=str(avd) or runtime.get('avdName')!=name
     or runtime.get('avdHome')!=str(folder/'avd') or type(runtime.get('pid')) is not int or runtime['pid']<=0):raise RuntimeError('owned-disposable-runtime-required')
 command=(proc_root/str(runtime['pid'])/'cmdline').read_bytes().split(b'\0')
 for key,value in [('-avd',name),('-datadir',str(avd)),('-port',SERIALS[device].removeprefix('emulator-'))]:
  positions=[i for i,part in enumerate(command) if part==key.encode()]
  if len(positions)!=1 or positions[0]+1>=len(command) or command[positions[0]+1]!=value.encode():raise RuntimeError('owned-avd-command-and-port-required')
 if not pathlib.Path(os.fsdecode(command[0])).is_relative_to(SDK/'emulator'):raise RuntimeError('owned-emulator-executable-required')

def installed_fixture_identity(expected,shell_command):
 """Hash the actual single installed base APK using fixed, guarded ADB calls."""
 package_paths=shell_command('pm','path',PACKAGE)
 if len(package_paths)>8192:raise RuntimeError('bounded-installed-apk-path-required')
 lines=package_paths.splitlines()
 if len(lines)!=1 or not re.fullmatch(r'package:/data/app/[A-Za-z0-9_./+=~\-]+/base\.apk',lines[0]):raise RuntimeError('single-installed-base-apk-required')
 path=lines[0].removeprefix('package:')
 if any(part in {'.','..'} for part in pathlib.PurePosixPath(path).parts):raise RuntimeError('ordinary-installed-base-apk-path-required')
 hashed=shell_command('sha256sum',path)
 if len(hashed)>8192 or not re.fullmatch(re.escape(expected['sha256'])+r'\s+'+re.escape(path),hashed):raise RuntimeError('installed-fixture-sha256-mismatch')
 details=shell_command('dumpsys','package',PACKAGE)
 if len(details)>256*1024:raise RuntimeError('bounded-installed-package-details-required')
 versions=re.findall(r'^\s*versionCode=(\d+)\s',details,re.M)
 if versions!=[str(expected['versionCode'])]:raise RuntimeError('installed-fixture-version-mismatch')
 return {'sha256':expected['sha256'],'versionCode':expected['versionCode'],
         'singleBaseApk':True,'certificateSha256':expected['certificateSha256'],
         'certificateProof':'Exact installed SHA matches independently verified signed source APK',
         'sourceCommit':expected.get('sourceCommit'),'metadataSha256':expected['metadataSha256']}

def require_offline(shell_command):
 shell_command('settings','put','global','mobile_data','0')
 shell_command('cmd','connectivity','airplane-mode','enable')
 shell_command('svc','wifi','disable');shell_command('svc','data','disable')
 state={key:shell_command('settings','get','global',key) for key in ['airplane_mode_on','wifi_on','mobile_data']}
 if state!={'airplane_mode_on':'1','wifi_on':'0','mobile_data':'0'}:raise RuntimeError('offline-required')
 return state

def ensure_commercial_firewall(shell_command, *, disconnected=False):
 """Repair interrupted setup and prove exact rules before any network enable."""
 chain='STRAWBERRY_LOCAL_ACCEPTANCE'
 stage='STRAWBERRY_LOCAL_STAGE'
 def expected_rules(binary,target):
  expected=[['-N',target],['-A',target,'-o','lo','-j','ACCEPT']]
  if binary=='iptables' and not disconnected:expected.append(['-A',target,'-d','10.0.2.2/32','-p','tcp','-m','multiport','--dports','8788,9099','-j','ACCEPT'])
  expected.append(['-A',target,'-j','REJECT', '--reject-with', 'icmp-port-unreachable' if binary=='iptables' else 'icmp6-port-unreachable'] if disconnected else ['-A',target,'-j','DROP'])
  return expected
 def populate(binary,target):
  if '-N '+target not in shell_command(binary,'-S').splitlines():shell_command(binary,'-N',target)
  shell_command(binary,'-F',target)
  shell_command(binary,'-A',target,'-o','lo','-j','ACCEPT')
  if binary=='iptables' and not disconnected:shell_command(binary,'-A',target,'-d','10.0.2.2','-p','tcp','-m','multiport','--dports','8788,9099','-j','ACCEPT')
  shell_command(binary,'-A',target,'-j','REJECT' if disconnected else 'DROP')
  rules=[shlex.split(line) for line in shell_command(binary,'-S',target).splitlines()]
  if rules!=expected_rules(binary,target):raise RuntimeError('commercial-outbound-chain-mismatch')
 def output_rules(binary):
  return [shlex.split(line) for line in shell_command(binary,'-S','OUTPUT').splitlines() if line.startswith('-A ')]
 for binary in ['iptables','ip6tables']:
  hook=['-A','OUTPUT','-j',chain]
  stage_hook=['-A','OUTPUT','-j',stage]
  output=output_rules(binary)
  if stage_hook in output and output[:1]==[hook]:
   for _ in range(output.count(stage_hook)):shell_command(binary,'-D','OUTPUT','-j',stage)
   output=output_rules(binary)
   if stage_hook in output:raise RuntimeError('commercial-outbound-hook-missing')
  if stage_hook not in output:
   populate(binary,stage)
   shell_command(binary,'-I','OUTPUT','1','-j',stage)
   output=output_rules(binary)
   if not output or output[0]!=stage_hook:raise RuntimeError('commercial-outbound-hook-missing')
  populate(binary,chain)
  if output[:2]!=[stage_hook,hook]:
   shell_command(binary,'-I','OUTPUT','1','-j',chain)
   output=output_rules(binary)
   if not output or output[0]!=hook:raise RuntimeError('commercial-outbound-hook-missing')
  for _ in range(output.count(stage_hook)):shell_command(binary,'-D','OUTPUT','-j',stage)
  output=output_rules(binary)
  if not output or output[0]!=hook or stage_hook in output:raise RuntimeError('commercial-outbound-hook-missing')
  shell_command(binary,'-F',stage)
  shell_command(binary,'-X',stage)

def prepare_commercial_network(shell_command,adb_command):
 # Keep the device offline even when adbd is restarted as root. A failed
 # chain/readback/hook operation exits before the enable commands below.
 require_offline(shell_command)
 adb_command('root');adb_command('wait-for-device',timeout=90)
 if shell_command('getprop','sys.boot_completed')!='1':raise RuntimeError('boot-not-ready-after-adb-root')
 ensure_commercial_firewall(shell_command)
 shell_command('cmd','connectivity','airplane-mode','disable')
 shell_command('svc','data','enable');shell_command('svc','wifi','disable')


COMMERCIAL_PROBE_PORTS=(8788,9099)
BROKEN_PROBE_PATTERN=re.compile(
 r'(?:unknown|invalid|bad|unrecognized)\s+(?:option|command|argument|flag)'
 r'|usage:|not found|cannot execute|syntax error|no such file|applet not found',
 re.I,
)
BLOCKED_TRANSPORT_PATTERN=re.compile(
 r'\bnc\b[^:\n]*:\s*(?:connect|read|write|poll|timeout)?[^:\n]*:\s*'
 r'(?:connection refused|network is unreachable|no route to host|connection timed out|timed out|connection reset|operation not permitted|permission denied|network unreachable|host is down|address not available|invalid argument)'
 r'|\b(?:connection refused|network is unreachable|no route to host|connection timed out|connection reset by peer)\b',
 re.I,
)

def commercial_transport_probe_command(port):
 if port not in COMMERCIAL_PROBE_PORTS:raise RuntimeError('supported-commercial-probe-port-required')
 path='/health' if port==8788 else '/'
 return ("printf 'GET "+path+" HTTP/1.1\\r\\nHost: 10.0.2.2:"+str(port)+"\\r\\nConnection: close\\r\\n\\r\\n' "
         "| toybox nc -w 2 10.0.2.2 "+str(port)+" 2>&1; status=$?; printf '\\nTRANSPORT_EXIT:%s\\n' \"$status\"")

def run_commercial_transport_probe(adb_command,port):
 probe=adb_command('shell',commercial_transport_probe_command(port),check=False,timeout=5)
 if probe is None or getattr(probe,'returncode',1)!=0 or not isinstance(getattr(probe,'stdout',None),(bytes,bytearray)):
  raise RuntimeError('transport-probe-adb-failed')
 output=probe.stdout.decode(errors='replace').replace('\r\n','\n')
 match=re.search(r'(?:^|\n)TRANSPORT_EXIT:(\d+)\s*$',output)
 if not match:raise RuntimeError('transport-probe-broken')
 exit_code=int(match.group(1))
 body=output[:match.start()].strip()
 if exit_code in {2,126,127} or exit_code>1 or BROKEN_PROBE_PATTERN.search(body):
  raise RuntimeError('transport-probe-broken')
 if exit_code==1 and ('HTTP/' not in body and 'strawberry-gateway-v1' not in body) and not BLOCKED_TRANSPORT_PATTERN.search(body):
  raise RuntimeError('transport-probe-broken')
 return exit_code,body

def prove_commercial_transport_connected(adb_command,*,deadline_seconds=60,sleep=time.sleep,clock=time.monotonic):
 deadline=clock()+deadline_seconds
 proofs=[]
 for port in COMMERCIAL_PROBE_PORTS:
  expected_marker='strawberry-gateway-v1' if port==8788 else 'HTTP/'
  while True:
   exit_code,body=run_commercial_transport_probe(adb_command,port)
   if exit_code==0 and 'HTTP/' in body and expected_marker in body:
    proofs.append({'host':'10.0.2.2','port':port,'connectSucceeded':True,'exitCode':0,'expectedMarker':expected_marker})
    break
   if clock()>deadline:raise RuntimeError('local-services-not-reachable')
   sleep(1)
 return proofs

def prove_commercial_transport_disconnected(adb_command):
 proofs=[]
 for port in COMMERCIAL_PROBE_PORTS:
  # An explicit marker is required because exec-out can return zero for a
  # failed remote command. Never infer disconnection from empty output.
  exit_code,body=run_commercial_transport_probe(adb_command,port)
  if exit_code==0 or 'HTTP/' in body or 'strawberry-gateway-v1' in body:
   raise RuntimeError('offline-transport-remains-reachable')
  if exit_code!=1 or not BLOCKED_TRANSPORT_PATTERN.search(body):
   raise RuntimeError('transport-probe-broken')
  proofs.append({'host':'10.0.2.2','port':port,'connectSucceeded':False,'exitCode':exit_code,'diagnostic':body[:240]})
 return proofs


def annual_result_target(fixture):
 campaign=fixture.get('annualCampaign','v12')
 if not isinstance(campaign,str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,31}',campaign):raise RuntimeError('bounded-safe-annual-campaign-required')
 expected='native-annual-'+campaign+'/results.json'
 if fixture.get('annualResultsPath',expected)!=expected:raise RuntimeError('exact-annual-result-path-required')
 return expected

def expected_annual_status(label):
 tokens=label.split('-')
 if 'verify' in tokens:return 'PASS'
 if 'growth' in tokens:return 'INSTALLED_REBOOT_VERIFICATION_PENDING'
 if 'base' in tokens or 'resume' in tokens:return 'BASE_INSTALLED_GROWTH_PENDING'
 raise RuntimeError('explicit-annual-base-growth-or-verify-label-required')


def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('phase',choices=['isolate','install','inspect-install','put-job','put-backup','get-result','get-backup','get-annual-result','offline','reboot','disconnect-for-retry','drive'])
 parser.add_argument('device',choices=['source','employee','replacement','compatibility','upgrade'])
 parser.add_argument('--file',type=pathlib.Path)
 parser.add_argument('--label',default='identity')
 parser.add_argument('--signing-metadata',type=pathlib.Path,default=OUT/'commercial-signing.json')
 parser.add_argument('--timeout-minutes',type=int,default=9)
 parser.add_argument('--expect-crash',action='store_true')
 args=parser.parse_args()
 if not 1<=args.timeout_minutes<=45 or (args.expect_crash and not args.label.startswith('annual-')):raise SystemExit('bounded-annual-crash-option-required')
 if not re.fullmatch('[a-z0-9-]+',args.label):raise SystemExit('safe-label-required')
 runtime=json.loads((OUT/(args.device+'-runtime.json')).read_text())
 def guard():
  guard_runtime(runtime,args.device)
 def adb(*command,data=None,check=True,timeout=45):
  guard()
  try:p=subprocess.run([ADB,'-s',runtime['serial'],*command],input=data,capture_output=True,timeout=timeout)
  except subprocess.TimeoutExpired:
   # Command names only; never serialize input jobs, credentials or VM URLs.
   raise RuntimeError('owned-device-command-timeout:'+('/'.join(command[:2]) if command and command[0]=='shell' else command[0])) from None
  if check and p.returncode:raise RuntimeError('owned-device-command-failed')
  return p
 def shell(*command,check=True):return adb('shell',*command,check=check).stdout.decode(errors='replace').strip()
 def redact(value):return re.sub(r'((?:https?|wss?)://127\.0\.0\.1:\d+/)[A-Za-z0-9_+=%-]+/',r'\1[LOCAL_VM_AUTH_REDACTED]/',value)
 def private_file():
  if args.file is None or args.file.is_symlink():raise RuntimeError('private-file-required')
  return args.file.resolve()
 result={'status':'BLOCKED','synthetic':True,'device':args.device,'phase':args.phase,'label':args.label,'ownerDeviceTouched':False,'uninstallOrDataClear':False,'productionAuthenticationUsed':False,'startedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 try:
  guard()
  if args.phase=='isolate':
   deadline=time.monotonic()+120
   while shell('getprop','sys.boot_completed')!='1':
    if time.monotonic()>deadline:raise RuntimeError('boot-not-ready')
    time.sleep(2)
   # Cellular supplies the emulator's eth0 route. The firewall above remains
   # in place before enabling it, and allows only the local synthetic services.
   prepare_commercial_network(shell,adb)
   # svc returns before netd finishes creating the cellular route. Prove both
   # local services are reachable before declaring the disposable network ready.
   proofs=prove_commercial_transport_connected(adb)
   result.update(status='PASS',localServicesReachable=True,outboundAllowlist=['loopback','10.0.2.2 TCP8788','10.0.2.2 TCP9099'],otherIpv4AndIpv6='DROP',transportProbes=proofs)
  elif args.phase=='install':
   path=private_file();metadata=validated_fixture(args.signing_metadata)
   if str(path)!=metadata['artifact']:raise RuntimeError('verified-commercial-debug-artifact-required')
   if 'Success' not in adb('install','-r',str(path),timeout=180).stdout.decode():raise RuntimeError('retained-data-install-not-confirmed')
   result.update(status='PASS',artifactSha256=metadata['sha256'],debugTestArtifact=True,fixture=metadata,installedFixture=installed_fixture_identity(metadata,shell))
  elif args.phase=='inspect-install':
   metadata=validated_fixture(args.signing_metadata)
   result.update(status='PASS',fixture=metadata,installedFixture=installed_fixture_identity(metadata,shell),readOnly=True)
  elif args.phase in ['put-job','put-backup']:
   path=private_file();data=path.read_bytes()
   if len(data)>24*1024*1024:raise RuntimeError('private-fixture-file-limit')
   if args.phase=='put-job':
    job=json.loads(data);allowed={'identity','manager_seed','employee_submit','manager_review','employee_revoked','replacement','offline_reopen','offline_transport','offline_transport_resume','resume_offline','legacy_seed_v9','legacy_unsupported_v9','legacy_resume_v11','legacy_resume_v12'}
    if job.get('phase') not in allowed:raise RuntimeError('known-demo-phase-required')
   target='commercial-job.json' if args.phase=='put-job' else 'commercial-recovery.json'
   shell('am','force-stop',PACKAGE)
   shell('run-as',PACKAGE,'mkdir','-p','files')
   temporary='files/'+target+'.next'
   adb('exec-in','run-as',PACKAGE,'sh','-c','cat > '+temporary,data=data)
   shell('run-as',PACKAGE,'chmod','600',temporary)
   shell('run-as',PACKAGE,'mv',temporary,'files/'+target)
   copied=adb('exec-out','run-as',PACKAGE,'cat','files/'+target).stdout
   if hashlib.sha256(copied).digest()!=hashlib.sha256(data).digest():raise RuntimeError('private-fixture-copy-mismatch')
   result.update(status='PASS',privateBytes=len(data))
  elif args.phase=='disconnect-for-retry':
   # The app is intentionally left running so its real controller observes the
   # transport failure. Only an explicit synthetic test handshake enables this.
   ready=json.loads(adb('exec-out','run-as',PACKAGE,'cat','files/commercial-network-ready.json').stdout)
   if ready.get('synthetic') is not True or ready.get('phase') not in {'offline_transport','offline_transport_resume'}:raise RuntimeError('synthetic-network-handshake-required')
   if not shell('pidof',PACKAGE,check=False):raise RuntimeError('running-fixture-required')
   ensure_commercial_firewall(shell,disconnected=True)
   require_offline(shell)
   proofs=prove_commercial_transport_disconnected(adb)
   state={key:shell('settings','get','global',key) for key in ['airplane_mode_on','wifi_on','mobile_data']}
   if state!={'airplane_mode_on':'1','wifi_on':'0','mobile_data':'0'}:raise RuntimeError('offline-required')
   adb('exec-in','run-as',PACKAGE,'sh','-c','cat > files/commercial-network-disconnected.flag',data=b'DISCONNECTED')
   result.update(status='PASS',network=state,appKeptRunning=True,nonLoopbackIpv4AndIpv6='REJECT',transportProbes=proofs)
  elif args.phase in ['offline','reboot']:
   shell('am','force-stop',PACKAGE);shell('settings','put','global','mobile_data','0');shell('cmd','connectivity','airplane-mode','enable');shell('svc','wifi','disable');shell('svc','data','disable')
   if args.phase=='reboot':
    adb('reboot',timeout=90);adb('wait-for-device',timeout=120);deadline=time.monotonic()+180
    while True:
     try:
      boot=adb('shell','getprop','sys.boot_completed',check=False,timeout=10)
      if boot.returncode==0 and boot.stdout.decode(errors='replace').strip()=='1':break
     except RuntimeError as error:
      if not str(error).startswith('owned-device-command-timeout:'):raise
     if time.monotonic()>deadline:raise RuntimeError('reboot-not-ready')
     time.sleep(2)
    shell('settings','put','global','mobile_data','0');shell('cmd','connectivity','airplane-mode','enable');shell('svc','wifi','disable');shell('svc','data','disable')
   adb('root');adb('wait-for-device',timeout=90)
   ensure_commercial_firewall(shell,disconnected=True)
   state=require_offline(shell)
   proofs=prove_commercial_transport_disconnected(adb)
   result.update(status='PASS',network=state,nonLoopbackIpv4AndIpv6='REJECT',transportProbes=proofs)
  elif args.phase in ['get-result','get-backup','get-annual-result']:
   path=private_file();target=annual_result_target(validated_fixture(args.signing_metadata)) if args.phase=='get-annual-result' else 'commercial-result.json' if args.phase=='get-result' else 'commercial-recovery.json'
   data=adb('exec-out','run-as',PACKAGE,'cat','files/'+target).stdout
   if len(data)>24*1024*1024:raise RuntimeError('private-fixture-file-limit')
   path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'wb') as f:f.write(data)
   result.update(status='PASS',privateBytes=len(data))
  else:
   # No Flutter install command is used after the first durable seed.
   metadata=validated_fixture(args.signing_metadata)
   result['fixture']=metadata
   result['installedFixtureBefore']=installed_fixture_identity(metadata,shell)
   if not args.label.startswith('annual-'):
    # A failed retry must never inherit an old result for the same phase.
    # Preserve it privately on this owned synthetic installation.
    old='files/commercial-result.json'
    if adb('shell','run-as',PACKAGE,'test','-f',old,check=False).returncode==0:
     shell('run-as',PACKAGE,'mv',old,'files/commercial-result.previous-'+str(time.time_ns())+'.json')
   adb('logcat','-c');shell('am','force-stop',PACKAGE);shell('am','start','-n',PACKAGE+'/.MainActivity')
   deadline=time.monotonic()+90;uri=None
   while time.monotonic()<deadline:
    log=adb('logcat','-d','-v','brief').stdout.decode(errors='replace')
    match=re.search(r'The Dart VM service is listening on (http://127\.0\.0\.1:\d+/[^\s]+)',log)
    if match:uri=urllib.parse.urlsplit(match.group(1));break
    time.sleep(1)
   if uri is None:raise RuntimeError('fixture-vm-service-unavailable')
   port=adb('forward','tcp:0','tcp:'+str(uri.port)).stdout.decode().strip()
   if not port.isdigit():raise RuntimeError('owned-port-forward-required')
   try:
    driver=OUT/(args.device+'-'+args.label+'-commercial_driver.dart');driver.write_text("import 'package:integration_test/integration_test_driver.dart';\nFuture<void> main()=>integrationDriver(timeout:const Duration(minutes:"+str(args.timeout_minutes)+"),responseDataCallback:(_) async {});\n")
    env=os.environ.copy();env['VM_SERVICE_URL']=urllib.parse.urlunsplit(('http','127.0.0.1:'+port,uri.path,'',''))
    p=subprocess.run(['/home/younis/flutter/bin/cache/dart-sdk/bin/dart','--packages=.dart_tool/package_config.json',str(driver)],cwd=ROOT,env=env,capture_output=True,text=True,timeout=args.timeout_minutes*60+60)
    (OUT/(args.device+'-'+args.label+'-driver.log')).write_text(redact(p.stdout+p.stderr))
    # Keep the app failure stack but exclude invitation/job/result contents.
    pids=shell('pidof',PACKAGE,check=False).split()
    app=adb('logcat','-d',*(['--pid='+pids[0]] if pids else []),'-v','brief').stdout.decode(errors='replace')
    if not pids:app='\n'.join(line for line in app.splitlines() if 'flutter' in line.lower() or 'NATIVE_ANNUAL_' in line)
    (OUT/(args.device+'-'+args.label+'-app.log')).write_text(redact(app))
    if args.expect_crash:
     if pids or 'NATIVE_ANNUAL_KILL_READY' not in app:raise RuntimeError('expected-controlled-process-death-not-proved')
     result['installedFixtureAfter']=installed_fixture_identity(metadata,shell)
     result.update(status='PASS',controlledProcessDeathObserved=True,completionRequiresRebootResume=True)
    else:
     if p.returncode or 'All tests passed.' not in p.stdout:raise RuntimeError('native-assertions-failed')
     if re.search(r'flutter.*(?:Some tests failed\.|\[E\]\s*$)',app,re.M):raise RuntimeError('native-app-reported-test-failure')
     if not re.search(r'flutter.*All tests passed!',app):raise RuntimeError('native-app-success-not-observed')
     if args.label.startswith('annual-'):
      capacity=json.loads(adb('exec-out','run-as',PACKAGE,'cat','files/'+annual_result_target(metadata)).stdout)
      expected=expected_annual_status(args.label)
      if capacity.get('campaign',metadata.get('annualCampaign','v12'))!=metadata.get('annualCampaign','v12'):raise RuntimeError('annual-native-campaign-mismatch')
      if capacity.get('status')!=expected:raise RuntimeError('annual-native-phase-not-complete')
      result['actualAnnualStatus']=capacity['status']
     if not args.label.startswith('annual-'):
      expectedJob=adb('exec-out','run-as',PACKAGE,'cat','files/commercial-job.json',check=False)
      expectedPhase=json.loads(expectedJob.stdout)['phase'] if expectedJob.returncode==0 else 'identity'
      actual=json.loads(adb('exec-out','run-as',PACKAGE,'cat','files/commercial-result.json').stdout)
      if actual.get('synthetic') is not True or actual.get('phase')!=expectedPhase:raise RuntimeError('actual-fixture-phase-mismatch')
      result['actualFixturePhase']=actual['phase']
      if 'client' in actual:result['historicalClient']=actual['client']
     result['installedFixtureAfter']=installed_fixture_identity(metadata,shell)
     if sha256_file(pathlib.Path(metadata['artifact']))!=metadata['sha256'] or sha256_file(pathlib.Path(metadata['metadataPath']))!=metadata['metadataSha256']:raise RuntimeError('fixture-input-changed-during-drive')
     result.update(status='PASS',actualNativeAssertionsPassed=True,driverUsesAlreadyInstalledApp=True)
   finally:adb('forward','--remove','tcp:'+port,check=False)
 except Exception as error:
  result['reason']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
 result['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 dest=OUT/(args.device+'-'+args.label+'-'+args.phase+'.json')
 if dest.exists():dest=dest.with_name(dest.stem+'-'+str(time.time_ns())+'.json')
 dest.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
 raise SystemExit(0 if result['status']=='PASS' else 1)

if __name__=='__main__':main()
