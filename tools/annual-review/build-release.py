#!/usr/bin/env python3
"""Build with the existing approved release identity. Never creates credentials.
Password stays in memory; Gradle receives a /proc/<pid>/fd memfd properties path.
Run from the repo root. No deployment, install, publication or production API.
"""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, threading

root = pathlib.Path(__file__).resolve().parents[2]
out = root / 'verification/annual-2026-11-01/flutter'
out.mkdir(parents=True, exist_ok=True)
operator = pathlib.Path('/home/younis/.local/share/strawberry-trade-operator')
keystore = operator / 'android-release.jks'
defines = operator / 'firebase-production/cloudflare-setup-v8-defines.json'
metadata = {'startedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sourceCommit': subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip(),
            'dirtyTree': bool(subprocess.check_output(['git','status','--porcelain'],cwd=root)),
            'credentialHandling':'Existing Secret Service credential only in memory; anonymous memfd Java properties; no password argument or disk file',
            'productionAcceptance':False,'androidInstalled':False}
password = b''
fd = None
try:
    if not keystore.is_file() or not defines.is_file():
        raise RuntimeError('existing-signing-config-unavailable')
    config=json.loads(defines.read_text())
    if config.get('USE_EMULATORS') != 'false' or config.get('FIREBASE_PROJECT_ID') != 'strawberry-trade-261017-6a49b' or not str(config.get('GATEWAY_BASE_URL','')).startswith('https://'):
        raise RuntimeError('approved-public-definitions-mismatch')
    secret = subprocess.run(['secret-tool','lookup','purpose','android-release-v1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
    password=secret.stdout.rstrip(b'\r\n')
    if secret.returncode or not password:
        raise RuntimeError('existing-signing-password-unavailable')
    # Java Properties escapes, including non-ASCII and reserved characters.
    def escape(value):
        encoded=value.encode('utf-16-be')
        return ''.join('\\u'+encoded[i:i+2].hex() for i in range(0,len(encoded),2))
    password_text=password.decode('utf-8')
    properties='\n'.join(k+'='+escape(v) for k,v in {
        'storeFile':str(keystore),'keyAlias':'strawberry-release-v1',
        'storePassword':password_text,'keyPassword':password_text}.items())+'\n'
    fd=os.memfd_create('strawberry-signing-review', os.MFD_CLOEXEC)
    os.fchmod(fd,0o600);os.write(fd,properties.encode('ascii'))
    env=os.environ.copy()
    env['STRAWBERRY_SIGNING_PROPERTIES']=f'/proc/{os.getpid()}/fd/{fd}'
    env['JAVA_HOME']='/usr/lib/jvm/java-17-temurin-jdk'
    command=['flutter','build','apk','--release',f'--dart-define-from-file={defines}']
    metadata['command']=command
    with (out/'release-build-final.log').open('w') as log:
        process=subprocess.Popen(command,cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        timer=threading.Timer(1200,process.kill)
        timer.start()
        try:
            for line in process.stdout:
                log.write(line.replace(password_text,'[REDACTED]'))
            code=process.wait()
        finally:
            timer.cancel()
    metadata['exitCode']=code
    metadata['status']='PASS' if code==0 else 'FAIL'
    if code==0:
        source=root/'build/app/outputs/flutter-apk/app-release.apk'
        destination=out/'strawberry-trade-annual-review-v10-final.apk'
        shutil.copyfile(source,destination)
        metadata.update(artifact=str(destination),bytes=destination.stat().st_size,
                        sha256=hashlib.sha256(destination.read_bytes()).hexdigest(),versionName='1.0.0',versionCode=10)
except Exception as error:
    metadata['status']='BLOCKED'
    # Do not serialize upstream exception text or credential-bearing objects.
    metadata['reason']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
    if fd is not None:os.close(fd)
    password=b''
    metadata['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (out/'release-build-final.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps({k:v for k,v in metadata.items() if k in ['status','reason','exitCode','artifact','sha256']},indent=2))
sys.exit(0 if metadata['status']=='PASS' else 1)
