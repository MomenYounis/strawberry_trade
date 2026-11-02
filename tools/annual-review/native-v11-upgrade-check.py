#!/usr/bin/env python3
"""Storage-only signed upgrade acceptance on the separately owned offline AVD.

Explicit phases let the caller serialize release builds and fixture builds.
Never uses Flutter's installer after seeding: its install-failure fallback can
uninstall an existing app. Only scoped adb install -r is used, followed by a
host Dart driver attached to an already running VM service. No cloud APIs,
Firebase initialization, user account, key creation, or deployment is involved.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]
SDK = pathlib.Path('/home/younis/Android/Sdk')
ADB = str(SDK / 'platform-tools/adb')
BUILD_TOOLS = SDK / 'build-tools/36.0.0'
PACKAGE = 'com.strawberrytrade.strawberry_trade'
CERTIFICATE = 'bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b'
FIXTURE = ROOT / 'integration_test/local_persistence_test.dart'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['seed', 'replace', 'verify', 'reboot-verify'])
parser.add_argument('--evidence-dir', default='verification/annual-2026-11-02/native')
parser.add_argument('--release-apk', type=pathlib.Path)
parser.add_argument('--review-plan', action='store_true', help='Print commands without running a build, install, or device mutation.')
args = parser.parse_args()
OUT = (ROOT / args.evidence_dir).resolve()
if not OUT.is_relative_to(ROOT / 'verification'):
    raise SystemExit('private-verification-output-required')
OUT.mkdir(parents=True, exist_ok=True)
STATE_PATH = OUT / 'signed-upgrade-state.json'
STATE = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {'synthetic': True, 'ownerDeviceTouched': False, 'phases': {}}
ENV = os.environ.copy()
ENV['JAVA_HOME'] = '/usr/lib/jvm/java-17-temurin-jdk'
ENV['PATH'] = ENV['JAVA_HOME'] + '/bin:' + ENV['PATH']
ENV['GRADLE_OPTS'] = '-Dorg.gradle.workers.max=2 -Dorg.gradle.jvmargs="-Xmx1536m -XX:MaxMetaspaceSize=512m -XX:ReservedCodeCacheSize=128m" -Dkotlin.compiler.execution.strategy=in-process'
RESULT = {'synthetic': True, 'ownerDeviceTouched': False, 'phase': args.phase,
          'status': 'BLOCKED', 'startedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
          'fixtureSha256': hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
          'productionAuthenticationUsed': False, 'uninstallOrDataClearSinceSeed': False}
RUNTIME = None


def save_state():
    temporary = STATE_PATH.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(STATE, indent=2) + '\n')
    temporary.replace(STATE_PATH)


def check_runtime():
    runtime = json.loads((OUT / 'runtime.json').read_text())
    home = pathlib.Path(runtime['avdHome']).resolve()
    base = pathlib.Path(runtime['runtimeRoot']).resolve()
    if runtime['serial'] != 'emulator-5580' or not str(base).startswith('/tmp/strawberry-annual-native-') or not home.is_relative_to(base):
        raise RuntimeError('separate-owned-runtime-required')
    command = pathlib.Path(f"/proc/{runtime['pid']}/cmdline").read_bytes().split(b'\0')
    if runtime['avdPath'].encode() not in command or runtime['avdName'].encode() not in command or b'strawberry_annual_disposable' not in b' '.join(command):
        raise RuntimeError('owned-private-process-marker-required')
    return runtime


def device(*command, timeout=15, check=True):
    check_runtime()
    result = subprocess.run([ADB, '-s', RUNTIME['serial'], *command], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('scoped-device-command-failed')
    return result


def shell(*command):
    return device('shell', *command).stdout.strip()


def offline():
    if shell('getprop', 'sys.boot_completed') != '1' or shell('getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('owned-emulator-not-ready')
    shell('settings', 'put', 'global', 'mobile_data', '0')
    shell('cmd', 'connectivity', 'airplane-mode', 'enable')
    shell('svc', 'wifi', 'disable')
    shell('svc', 'data', 'disable')
    values = {key: shell('settings', 'get', 'global', key) for key in ['airplane_mode_on', 'wifi_on', 'mobile_data']}
    if values != {'airplane_mode_on': '1', 'wifi_on': '0', 'mobile_data': '0'}:
        raise RuntimeError('offline-isolation-required')
    RESULT['network'] = values


def sanitized(value):
    # VM-service authorization is a temporary local capability, never evidence.
    return re.sub(r'((?:https?|wss?)://(?:127\.0\.0\.1|localhost):\d+/)[A-Za-z0-9_+=%-]+/', r'\1[LOCAL_VM_AUTH_REDACTED]/', value)


def run_logged(command, stem, env=None, timeout=900):
    RESULT.setdefault('commands', []).append(command)
    completed = subprocess.run(command, cwd=ROOT, env=env or ENV, capture_output=True, text=True, timeout=timeout)
    (OUT / f'{stem}.log').write_text(sanitized(completed.stdout + completed.stderr))
    if completed.returncode:
        raise RuntimeError(stem + '-failed')
    return completed


def apk_identity(path, version, debug):
    path = path.resolve()
    if not path.is_file():
        raise RuntimeError('apk-file-required')
    badging = subprocess.check_output([str(BUILD_TOOLS / 'aapt'), 'dump', 'badging', str(path)], text=True, env=ENV, timeout=30)
    if f"name='{PACKAGE}'" not in badging or f"versionCode='{version}'" not in badging or ('application-debuggable' in badging) != debug:
        raise RuntimeError('apk-package-version-debug-mode-mismatch')
    signatures = subprocess.check_output([str(BUILD_TOOLS / 'apksigner'), 'verify', '--verbose', '--print-certs', str(path)], text=True, env=ENV, timeout=30)
    match = re.search(r'Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})', signatures)
    if not match:
        raise RuntimeError('verified-apk-certificate-required')
    return {'artifact': str(path), 'versionCode': version, 'debugTestArtifact': debug,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'certificateSha256': match.group(1)}


def install_retaining_data(identity):
    if identity['certificateSha256'] != CERTIFICATE:
        raise RuntimeError('existing-release-certificate-required')
    offline()
    completed = device('install', '-r', identity['artifact'], timeout=180)
    if 'Success' not in completed.stdout:
        raise RuntimeError('retained-data-install-not-confirmed')
    RESULT.setdefault('retainingDataInstalls', []).append(identity)


def build_fixture(phase, version):
    run_logged(['flutter', 'build', 'apk', '--debug', '--no-pub', '--target=integration_test/local_persistence_test.dart',
                f'--dart-define=PERSISTENCE_PHASE={phase}', f'--build-number={version}'], phase + '-build')
    run_logged([sys.executable, 'tools/annual-review/sign-native-fixture.py', phase,
                '--evidence-dir', args.evidence_dir], phase + '-signer')
    identity = apk_identity(OUT / f'persistence-{phase}-signed-DEBUG.apk', version, True)
    if identity['certificateSha256'] != CERTIFICATE:
        raise RuntimeError('signed-fixture-certificate-mismatch')
    return identity


def attach_storage_driver(stem):
    offline()
    driver = OUT / 'storage_integration_driver.dart'
    driver.write_text("import 'package:integration_test/integration_test_driver.dart';\n\n"
                      "Future<void> main() => integrationDriver(\n"
                      "  timeout: const Duration(minutes: 5),\n"
                      "  responseDataCallback: (_) async {},\n);\n")
    device('logcat', '-c')
    shell('am', 'force-stop', PACKAGE)
    shell('am', 'start', '-n', PACKAGE + '/.MainActivity')
    uri = None
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        log = device('logcat', '-d', '-v', 'brief').stdout
        match = re.search(r'The Dart VM service is listening on (http://127\.0\.0\.1:\d+/[^\s]+)', log)
        if match:
            uri = urllib.parse.urlsplit(match.group(1))
            break
        time.sleep(1)
    if uri is None or not uri.port or not uri.path.endswith('/'):
        raise RuntimeError('local-fixture-vm-service-not-found')
    forward = device('forward', 'tcp:0', f'tcp:{uri.port}').stdout.strip()
    if not forward.isdigit():
        raise RuntimeError('owned-local-port-forward-required')
    try:
        driver_env = ENV.copy()
        driver_env['VM_SERVICE_URL'] = urllib.parse.urlunsplit(('http', f'127.0.0.1:{forward}', uri.path, '', ''))
        completed = run_logged(['/home/younis/flutter/bin/cache/dart-sdk/bin/dart',
                                '--packages=.dart_tool/package_config.json', str(driver)], stem + '-driver', env=driver_env, timeout=360)
        if 'All tests passed.' not in completed.stdout:
            raise RuntimeError('native-test-success-not-confirmed')
        pid = shell('pidof', PACKAGE).split()[0]
        app_log = device('logcat', '-d', '--pid=' + pid, '-v', 'brief').stdout
        (OUT / f'{stem}-app.log').write_text(sanitized(app_log))
        RESULT.update(uniquePersistenceTests=3, allPersistenceAssertionsPassed=True,
                      retained=['installation Keystore identity', 'protected SQLCipher key digest',
                                'encrypted entry', 'stable outbox operation and wire payload digest',
                                'retry count and schedule', 'unfinished draft'],
                      driverUsesExistingApp=True, flutterInstallerUsedAfterSeed=False)
    finally:
        device('forward', '--remove', 'tcp:' + forward, check=False)


try:
    RUNTIME = check_runtime()
    RESULT.update(serial=RUNTIME['serial'], pid=RUNTIME['pid'], avdPath=RUNTIME['avdPath'])
    match = re.search(r'^version: [0-9]+\.[0-9]+\.[0-9]+\+(\d+)$', (ROOT / 'pubspec.yaml').read_text(), re.M)
    if not match or match.group(1) != '11':
        raise RuntimeError('review-v11-source-required')
    if STATE.get('seedAttempted') and (STATE.get('fixtureSha256') != RESULT['fixtureSha256'] or STATE.get('avdPath') != RUNTIME['avdPath']):
        raise RuntimeError('seeded-fixture-and-private-runtime-must-match')
    if not args.review_plan and STATE['phases'].get(args.phase, {}).get('status') == 'PASS':
        raise RuntimeError('phase-already-complete-do-not-repeat')
    if args.review_plan:
        RESULT.update(status='PLAN', sequence=['approved native roundtrip before seed',
          'initial disposable DEBUG certificate switch before any seed attempt',
          'build/sign DEBUG schema2 seed version8; explicit adb install -r; attach host Dart driver',
          'explicit adb install -r actual signed release v10 then v11',
          'build/sign DEBUG verify version11; explicit adb install -r; attach host Dart driver',
          'reboot same owned AVD; restore offline settings; attach same installed DEBUG verify'],
          noBuildInstallOrDeviceMutationRun=True)
    elif args.phase == 'seed':
        if STATE.get('seedAttempted'):
            raise RuntimeError('seed-already-attempted-preserve-installed-data')
        previous = json.loads((OUT / 'persistence-roundtrip.json').read_text())
        if previous.get('status') != 'PASS':
            raise RuntimeError('native-roundtrip-pass-required')
        offline()
        installed = shell('pm', 'path', PACKAGE)
        paths = [line.removeprefix('package:') for line in installed.splitlines() if line.startswith('package:')]
        if len(paths) != 1:
            raise RuntimeError('one-existing-roundtrip-debug-package-required')
        with tempfile.TemporaryDirectory(prefix='preseed-apk-', dir=RUNTIME['runtimeRoot']) as temporary:
            saved = pathlib.Path(temporary) / 'installed.apk'
            device('pull', paths[0], str(saved), timeout=90)
            identity = apk_identity(saved, 11, True)
            expected = apk_identity(ROOT / 'build/app/outputs/flutter-apk/app-debug.apk', 11, True)
            if identity['sha256'] != expected['sha256'] or identity['certificateSha256'] == CERTIFICATE:
                raise RuntimeError('exact-unsigned-roundtrip-debug-install-required')
        # This single removal occurs only before the first persistent seed.
        device('uninstall', PACKAGE, timeout=90)
        RESULT['initialDisposableDebugRemovalBeforeSeed'] = True
        identity = build_fixture('seed-v2', 8)
        STATE['seedAttempted'] = True
        STATE['fixtureSha256'] = RESULT['fixtureSha256']
        STATE['avdPath'] = RUNTIME['avdPath']
        save_state()
        install_retaining_data(identity)
        attach_storage_driver('signed-seed')
        RESULT.update(status='PASS', seededSchema=2, versionCode=8)
    elif args.phase == 'replace':
        if STATE['phases'].get('seed', {}).get('status') != 'PASS' or not args.release_apk:
            raise RuntimeError('passed-seed-and-review-release-apk-required')
        old_path = ROOT / 'verification/annual-2026-11-01/flutter/strawberry-trade-annual-review-v10-final.apk'
        old = apk_identity(old_path, 10, False)
        if old['sha256'] != '4c57af562a6f40c295385bb4439bf61105374be45c296b825ce59236a9c07679':
            raise RuntimeError('actual-previous-review-release-required')
        new = apk_identity(args.release_apk, 11, False)
        release_metadata = json.loads(pathlib.Path(new['artifact']).with_name('release-build-final.json').read_text())
        if release_metadata.get('status') != 'PASS' or release_metadata.get('sha256') != new['sha256']:
            raise RuntimeError('review-release-build-evidence-required')
        for identity in [old, new]:
            install_retaining_data(identity)
        shell('am', 'start', '-n', PACKAGE + '/.MainActivity')
        with (OUT / 'signed-v11-offline-start.png').open('wb') as screenshot:
            check_runtime()
            subprocess.run([ADB, '-s', RUNTIME['serial'], 'exec-out', 'screencap', '-p'], stdout=screenshot, check=True, timeout=20)
        shell('am', 'force-stop', PACKAGE)
        RESULT.update(status='PASS', installedReleaseVersions=[10, 11], offlineReleaseColdStart=True)
    elif args.phase == 'verify':
        if STATE['phases'].get('replace', {}).get('status') != 'PASS':
            raise RuntimeError('signed-release-replacements-required')
        identity = build_fixture('verify', 11)
        install_retaining_data(identity)
        attach_storage_driver('signed-verify')
        RESULT.update(status='PASS', schemaBeforeReplacements=2, schemaAfter=4, versionCode=11)
    elif args.phase == 'reboot-verify':
        if STATE['phases'].get('verify', {}).get('status') != 'PASS':
            raise RuntimeError('initial-signed-upgrade-verification-required')
        device('reboot')
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                if shell('getprop', 'sys.boot_completed') == '1':
                    break
            except (RuntimeError, OSError, subprocess.SubprocessError):
                pass
            time.sleep(2)
        offline()
        attach_storage_driver('signed-reboot-verify')
        RESULT.update(status='PASS', schemaAfter=4, versionCode=11, sameOwnedEmulatorRebooted=True)
except Exception as error:
    RESULT['reason'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
finally:
    RESULT['finishedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    if not args.review_plan:
        if STATE['phases'].get(args.phase, {}).get('status') != 'PASS':
            STATE['phases'][args.phase] = RESULT
        STATE.setdefault('attempts', []).append(RESULT)
        save_state()
        evidence = OUT / f'signed-upgrade-{args.phase}.json'
        if evidence.exists():
            evidence = OUT / f'signed-upgrade-{args.phase}-attempt-{time.time_ns()}.json'
        evidence.write_text(json.dumps(RESULT, indent=2) + '\n')
print(json.dumps(RESULT, indent=2))
sys.exit(0 if RESULT['status'] in ['PASS', 'PLAN'] else 1)
