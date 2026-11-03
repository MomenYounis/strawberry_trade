#!/usr/bin/env python3
"""Build with the existing approved release identity. Never creates credentials.
Password stays in memory; Gradle receives a /proc/<pid>/fd memfd properties path.
Run from the repo root. No deployment, install, publication or production API.
"""
import argparse, datetime, json, os, pathlib, re, subprocess, sys, threading
from release_build_validation import (ReleaseValidationError, fresh_output, public_definitions,
    source_inventory, inventory_sha256, require_unchanged, approved_keytool_certificate,
    approved_apk_certificate, release_badging, file_sha256)

root = pathlib.Path(__file__).resolve().parents[2]
args = argparse.ArgumentParser(description=__doc__)
args.add_argument('--output-dir', default='verification/annual-2026-11-02/flutter')
options = args.parse_args()
out = (root / options.output_dir).resolve()
if not out.is_relative_to(root / 'verification'):
    raise SystemExit('output-must-be-private-verification-directory')
match = re.search(r'^version: ([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)$', (root / 'pubspec.yaml').read_text(), re.M)
if not match:
    raise SystemExit('invalid-public-build-version')
version_name, version_code = match.group(1), int(match.group(2))
try:
    fresh_output(out)
except ReleaseValidationError as error:
    raise SystemExit(str(error))
out.mkdir(parents=True, exist_ok=True)
operator = pathlib.Path('/home/younis/.local/share/strawberry-trade-operator')
keystore = operator / 'android-release.jks'
defines = operator / 'firebase-production/cloudflare-setup-v8-defines.json'
metadata = {'startedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'sourceCommit': subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip(),
            'dirtyTree': bool(subprocess.check_output(['git','status','--porcelain'],cwd=root)),
            'credentialHandling':'Existing Secret Service credential only in memory; anonymous memfd Java properties; no password argument or disk file',
            'productionAcceptance':False,'androidInstalled':False}
metadata['buildHelperSha256']=file_sha256(pathlib.Path(__file__))
metadata['validationHelperSha256']=file_sha256(pathlib.Path(__file__).with_name('release_build_validation.py'))
password = b''
fd = None
password_fd = None
try:
    if keystore.is_symlink() or not keystore.is_file() or not defines.is_file():
        raise RuntimeError('existing-signing-config-unavailable')
    metadata['publicDefinitions']=public_definitions(defines)
    before=source_inventory(root)
    metadata['sourceInventoryBeforeSha256']=inventory_sha256(before)
    (out/'release-source-before.json').write_text(json.dumps(before,indent=2)+'\n')
    secret = subprocess.run(['secret-tool','lookup','purpose','android-release-v1'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
    password=secret.stdout.rstrip(b'\r\n')
    if secret.returncode or not password:
        raise RuntimeError('existing-signing-password-unavailable')
    # Java Properties escapes, including non-ASCII and reserved characters.
    def escape(value):
        encoded=value.encode('utf-16-be')
        return ''.join('\\u'+encoded[i:i+2].hex() for i in range(0,len(encoded),2))
    password_text=password.decode('utf-8')
    env=os.environ.copy()
    env['JAVA_HOME']='/usr/lib/jvm/java-17-temurin-jdk'
    # Verify the existing alias before building, using only an anonymous
    # password file. Neither keytool output nor passwords are logged.
    password_fd=os.memfd_create('strawberry-keystore-check',os.MFD_CLOEXEC)
    os.fchmod(password_fd,0o600);os.write(password_fd,password+b'\n')
    checked=subprocess.run([env['JAVA_HOME']+'/bin/keytool','-J-Duser.language=en','-J-Duser.country=US',
        '-list','-v','-keystore',str(keystore),'-alias','strawberry-release-v1',
        '-storepass:file',f'/proc/{os.getpid()}/fd/{password_fd}'],env=env,capture_output=True,text=True,timeout=30)
    if checked.returncode:
        raise RuntimeError('existing-keystore-check-failed')
    metadata['keystoreCertificateSha256']=approved_keytool_certificate(checked.stdout)
    properties='\n'.join(k+'='+escape(v) for k,v in {
        'storeFile':str(keystore),'keyAlias':'strawberry-release-v1',
        'storePassword':password_text,'keyPassword':password_text}.items())+'\n'
    fd=os.memfd_create('strawberry-signing-review', os.MFD_CLOEXEC)
    os.fchmod(fd,0o600);os.write(fd,properties.encode('ascii'))
    env['STRAWBERRY_SIGNING_PROPERTIES']=f'/proc/{os.getpid()}/fd/{fd}'
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
        destination=out/f'strawberry-trade-annual-review-v{version_code}-final.apk'
        after=source_inventory(root)
        metadata['sourceInventoryAfterSha256']=inventory_sha256(after)
        (out/'release-source-after.json').write_text(json.dumps(after,indent=2)+'\n')
        require_unchanged(before,after)
        if (file_sha256(pathlib.Path(__file__))!=metadata['buildHelperSha256'] or
            file_sha256(pathlib.Path(__file__).with_name('release_build_validation.py'))!=metadata['validationHelperSha256']):
            raise ReleaseValidationError('release-build-helper-changed')
        if public_definitions(defines)!=metadata['publicDefinitions']:
            raise ReleaseValidationError('approved-definitions-changed-during-build')
        if subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()!=metadata['sourceCommit']:
            raise ReleaseValidationError('source-revision-changed-during-build')
        if source.is_symlink() or not source.is_file():
            raise ReleaseValidationError('ordinary-release-apk-required')
        source_hash=file_sha256(source)
        tools='/home/younis/Android/Sdk/build-tools/36.0.0/'
        verified=subprocess.run([tools+'apksigner','verify','--verbose','--print-certs',str(source)],env=env,capture_output=True,text=True,timeout=30)
        if verified.returncode:
            raise ReleaseValidationError('release-apk-signature-invalid')
        metadata['certificateSha256']=approved_apk_certificate(verified.stdout)
        badging=subprocess.run([tools+'aapt','dump','badging',str(source)],env=env,capture_output=True,text=True,timeout=30)
        if badging.returncode:
            raise ReleaseValidationError('release-package-metadata-unavailable')
        metadata['package']=release_badging(badging.stdout,version_name,version_code)
        (out/'release-signature.log').write_text(verified.stdout)
        (out/'release-badging.log').write_text(badging.stdout)
        # Exclusive creation and a second hash prevent a competing build from
        # replacing the generic output between inspection and the final copy.
        with source.open('rb') as incoming,destination.open('xb') as copied:
            while chunk:=incoming.read(1024*1024):copied.write(chunk)
            copied.flush();os.fsync(copied.fileno())
        if file_sha256(source)!=source_hash or file_sha256(destination)!=source_hash:
            raise ReleaseValidationError('release-apk-changed-during-verification')
        metadata.update(artifact=str(destination),bytes=destination.stat().st_size,
                        sha256=source_hash,versionName=version_name,versionCode=version_code,
                        immutableBuildInputs=True)
except Exception as error:
    metadata['status']='FAIL' if isinstance(error,ReleaseValidationError) else 'BLOCKED'
    # Do not serialize upstream exception text or credential-bearing objects.
    metadata['reason']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
finally:
    if fd is not None:os.close(fd)
    if password_fd is not None:os.close(password_fd)
    password=b''
    metadata['finishedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    (out/'release-build-final.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps({k:v for k,v in metadata.items() if k in ['status','reason','exitCode','artifact','sha256']},indent=2))
sys.exit(0 if metadata['status']=='PASS' else 1)
