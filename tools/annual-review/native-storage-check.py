#!/usr/bin/env python3
"""Run storage-only fixtures on this review's disposable Android emulator.

Never selects a physical device, touches the owner's AVD, or initializes a
production gateway. The runtime.json must describe the separately provisioned
private synthetic AVD. No uninstall/data-clear is performed.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[2]
out = root / 'verification/annual-2026-11-01/flutter/native'
out.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('fixture', choices=['persistence', 'full-storage'])
parser.add_argument('--phase', choices=['roundtrip', 'seed', 'seed-v2', 'verify'], default='roundtrip')
args = parser.parse_args()
stem = f'{args.fixture}-{args.phase}'
result = {'synthetic': True, 'status': 'BLOCKED', 'ownerDeviceTouched': False,
          'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()}
try:
    runtime = json.loads((out / 'runtime.json').read_text())
    if runtime['serial'] != 'emulator-5580' or not runtime['avdHome'].startswith('/tmp/strawberry-annual-native-'):
        raise RuntimeError('synthetic-runtime-required')
    commandline = pathlib.Path(f"/proc/{runtime['pid']}/cmdline").read_bytes()
    if b'strawberry_annual_disposable' not in commandline:
        raise RuntimeError('synthetic-emulator-process-required')
    adb = ['/home/younis/Android/Sdk/platform-tools/adb', '-s', runtime['serial'], 'shell']
    def shell(*command):
        return subprocess.check_output([*adb, *command], text=True, stderr=subprocess.DEVNULL, timeout=10).strip()
    booted = False
    for _ in range(20):
        try:
            booted = shell('getprop', 'sys.boot_completed') == '1'
        except (subprocess.SubprocessError, OSError):
            pass
        if booted:
            break
        time.sleep(2)
    if not booted or shell('getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('synthetic-android-not-ready')
    shell('settings', 'put', 'global', 'mobile_data', '0')
    shell('cmd', 'connectivity', 'airplane-mode', 'enable')
    shell('svc', 'wifi', 'disable')
    shell('svc', 'data', 'disable')
    network = {key: shell('settings', 'get', 'global', key)
               for key in ['airplane_mode_on', 'wifi_on', 'mobile_data']}
    if network != {'airplane_mode_on': '1', 'wifi_on': '0', 'mobile_data': '0'}:
        raise RuntimeError('offline-isolation-required')
    target = 'integration_test/' + ('local_persistence_test.dart' if args.fixture == 'persistence' else 'native_full_storage_test.dart')
    command = ['flutter', 'test', target, '-d', runtime['serial'], '--no-uninstall', '--reporter', 'expanded']
    if args.fixture == 'persistence':
        command.append(f'--dart-define=PERSISTENCE_PHASE={args.phase}')
    env = os.environ.copy()
    env['JAVA_HOME'] = '/usr/lib/jvm/java-17-temurin-jdk'
    env['GRADLE_OPTS'] = '-Dorg.gradle.workers.max=2 -Dorg.gradle.jvmargs="-Xmx1536m -XX:MaxMetaspaceSize=512m -XX:ReservedCodeCacheSize=128m" -Dkotlin.compiler.execution.strategy=in-process'
    result.update(command=command, network=network, fixtureSha256=hashlib.sha256((root / target).read_bytes()).hexdigest())
    with (out / f'{stem}.log').open('w') as log:
        completed = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    text = (out / f'{stem}.log').read_text()
    match = re.search(r'\+(\d+): All tests passed!', text)
    result.update(exitCode=completed.returncode, status='PASS' if completed.returncode == 0 and match else 'FAIL',
                  tests=int(match[1]) if match else None, log=f'{stem}.log')
except RuntimeError as error:
    result['reason'] = str(error)
except Exception as error:
    result['reason'] = type(error).__name__
finally:
    (out / f'{stem}.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
sys.exit(0 if result['status'] == 'PASS' else 1)
