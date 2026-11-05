#!/usr/bin/env python3
"""Read-only verification of the recorded local release; no network or install."""
import argparse, datetime, hashlib, json, os, pathlib, re, struct, subprocess, zipfile
from release_build_validation import approved_apk_certificate, public_definitions, release_badging, file_sha256

ROOT=pathlib.Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('receipt',type=pathlib.Path);args=p.parse_args()
receipt=args.receipt.resolve()
if not receipt.is_relative_to(ROOT/'verification'):raise SystemExit('verification-receipt-required')
m=json.loads(receipt.read_text());apk=pathlib.Path(m['artifact'])
if m['status']!='PASS' or apk.parent!=receipt.parent or file_sha256(apk)!=m['sha256']:raise SystemExit('unchanged-passing-release-required')
out=receipt.parent/'apk-inspection-final.json'
if out.exists():raise SystemExit('inspection-evidence-already-exists')
env=os.environ.copy();env['JAVA_HOME']='/usr/lib/jvm/java-17-temurin-jdk';env['PATH']=env['JAVA_HOME']+'/bin:'+env['PATH']
sdk='/home/younis/Android/Sdk/build-tools/36.0.0/'
def run(*command):return subprocess.check_output(command,env=env,text=True,timeout=60)
result={'status':'FAIL','artifact':str(apk),'sha256':m['sha256'],'sourceCommit':m['sourceCommit'],
        'startedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'productionNetworkUsed':False,
        'physicalArmOr16KRuntimeTest':False}
password=b''
try:
 signature=run(sdk+'apksigner','verify','--verbose','--print-certs',str(apk))
 result['certificateSha256']=approved_apk_certificate(signature)
 badging=run(sdk+'aapt','dump','badging',str(apk));result['package']=release_badging(badging,m['versionName'],m['versionCode'])
 manifest=run(sdk+'aapt','dump','xmltree',str(apk),'AndroidManifest.xml')
 (receipt.parent/'apk-manifest-inspected.log').write_text(manifest)
 for key in ['allowBackup','usesCleartextTraffic']:
  found=re.search(r'android:'+key+r'\([^)]*\)=\(type 0x12\)(0x[0-9a-f]+)',manifest)
  if not found or int(found.group(1),16)!=0:raise RuntimeError('release-'+key+'-must-be-false')
 result['allowBackup']=False;result['usesCleartextTraffic']=False
 result['permissions']=re.findall(r"(?m)^uses-permission: name='([^']+)'",badging)
 if any(x in result['permissions'] for x in ['android.permission.MANAGE_EXTERNAL_STORAGE','android.permission.REQUEST_INSTALL_PACKAGES','android.permission.READ_SMS','android.permission.READ_CONTACTS']):raise RuntimeError('unexpected-sensitive-permission')
 definitions=pathlib.Path('/home/younis/.local/share/strawberry-trade-operator/firebase-production/cloudflare-setup-v8-defines.json')
 if public_definitions(definitions)!=m['publicDefinitions']:raise RuntimeError('approved-config-receipt-mismatch')
 public=json.loads(definitions.read_text());needles={key:public[key].encode() for key in ['FIREBASE_PROJECT_ID','FIREBASE_ANDROID_APP_ID','GATEWAY_BASE_URL']}
 # Scan for the known signing secret in memory and private-key PEM headers;
 # this bounded check is not a claim that every possible secret is detectable.
 secret=subprocess.run(['secret-tool','lookup','purpose','android-release-v1'],capture_output=True,timeout=20)
 password=secret.stdout.rstrip(b'\r\n')
 if secret.returncode or not password:raise RuntimeError('existing-signing-secret-scan-unavailable')
 forbidden=[password,b'-----BEGIN PRIVATE KEY-----',b'-----BEGIN RSA PRIVATE KEY-----',b'-----BEGIN EC PRIVATE KEY-----']
 natives=[];scanned=0;matches=[];config=[]
 with zipfile.ZipFile(apk) as z:
  for info in z.infolist():
   if info.is_dir():continue
   if info.file_size>256*1024*1024:raise RuntimeError('unexpected-apk-entry-size')
   tail=b''
   with z.open(info) as f:
    while chunk:=f.read(1024*1024):
     block=tail+chunk
     if any(n in block for n in forbidden):matches.append(info.filename)
     tail=block[-max(map(len,forbidden)):];scanned+=len(chunk)
   if info.filename.startswith('lib/') and info.filename.endswith('.so'):
    b=z.read(info)
    if b[:4]!=b'\x7fELF':raise RuntimeError('invalid-native-elf')
    cls=b[4];endian='<' if b[5]==1 else '>'
    if cls==2:offset=struct.unpack_from(endian+'Q',b,32)[0];size,count=struct.unpack_from(endian+'HH',b,54);alignoff=48
    elif cls==1:offset=struct.unpack_from(endian+'I',b,28)[0];size,count=struct.unpack_from(endian+'HH',b,42);alignoff=28
    else:raise RuntimeError('unsupported-elf-class')
    aligns=[]
    for j in range(count):
     pos=offset+j*size
     if struct.unpack_from(endian+'I',b,pos)[0]==1:aligns.append(struct.unpack_from(endian+('Q' if cls==2 else 'I'),b,pos+alignoff)[0])
    with apk.open('rb') as f:f.seek(info.header_offset);header=f.read(30)
    nam,extra=struct.unpack_from('<HH',header,26);payload=info.header_offset+30+nam+extra
    row={'path':info.filename,'minLoadAlignment':min(aligns),'zipOffsetMod16K':payload%16384,'compressed':info.compress_type!=0}
    if min(aligns)<16384 or info.compress_type!=0 or payload%16384:raise RuntimeError('native-16k-static-alignment-failed')
    natives.append(row)
    if info.filename.endswith('/libapp.so'):
     found={key:needle in b for key,needle in needles.items()}
     if not all(found.values()):raise RuntimeError('approved-public-config-not-found-in-abi')
     config.append({'path':info.filename,'approvedConfigFound':found})
 if matches:raise RuntimeError('known-secret-or-private-key-marker-found')
 if len(config)!=3:raise RuntimeError('expected-three-release-abis')
 if file_sha256(apk)!=m['sha256']:raise RuntimeError('artifact-changed-during-inspection')
 result.update(status='PASS',nativeLibraries=natives,publicConfigurationByAbi=config,scannedBytes=scanned,
               knownSecretAndPrivatePemMarkerMatches=0,scanLimit='Known signing password and PEM headers only; not exhaustive secret detection',
               static16KAlignment='PASS',signatureV2Verified='Verified using v2 scheme (APK Signature Scheme v2): true' in signature)
except Exception as error:result['reason']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
 password=b'';result['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({key:result[key] for key in ['status','reason','sha256','certificateSha256','static16KAlignment'] if key in result},indent=2))
raise SystemExit(0 if result['status']=='PASS' else 1)
