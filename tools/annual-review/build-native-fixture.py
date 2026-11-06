#!/usr/bin/env python3
"""Build a frozen synthetic DEBUG fixture and sign with the existing identity.

Never installs, deploys, creates credentials or changes Android configuration.
The approved production release is built separately by build-release.py.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

from release_build_validation import (file_sha256, fresh_output, source_inventory,
                                      inventory_sha256, require_unchanged)

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['annual', 'commercial', 'verify'])
parser.add_argument('--output-dir', required=True)
parser.add_argument('--annual-campaign')
args = parser.parse_args()
if (args.phase == 'annual') != (args.annual_campaign is not None):
    parser.error('annual builds require --annual-campaign; other phases forbid it')
out = (ROOT / args.output_dir).resolve()
if not out.is_relative_to(ROOT / 'verification'):
    raise SystemExit('verification-output-required')
fresh_output(out)
out.mkdir(parents=True, exist_ok=True)
target = {'annual': 'native_annual_scale_test.dart',
          'commercial': 'commercial_business_test.dart',
          'verify': 'local_persistence_test.dart'}[args.phase]
target = 'integration_test/' + target
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
revision = lambda: subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
r = {'status': 'FAIL', 'synthetic': True, 'debugTestArtifact': True,
     'productionAcceptance': False, 'installed': False, 'startedAtUtc': now(),
     'sourceRevision': revision(), 'phase': args.phase,
     'helperSha256': file_sha256(Path(__file__))}
try:
    if args.phase == 'annual':
        import re
        if not re.fullmatch('[a-z0-9][a-z0-9-]{0,31}', args.annual_campaign):
            raise RuntimeError('bounded-safe-annual-campaign-required')
    before = source_inventory(ROOT)
    r['sourceInventoryBeforeSha256'] = inventory_sha256(before)
    r['fixture'] = {'path': target, 'sha256': file_sha256(ROOT / target)}
    # Mode-only owner differences are preserved; compiled bytes must all be
    # identified by this actual source commit, including the fixture entrypoint.
    for entry in [*before, r['fixture']]:
        original = subprocess.check_output(['git', 'show', r['sourceRevision'] + ':' + entry['path']], cwd=ROOT)
        import hashlib
        if hashlib.sha256(original).hexdigest() != entry['sha256']:
            raise RuntimeError('uncommitted-compiled-source-content')
    (out / 'source-before.json').write_text(json.dumps(before, indent=2) + '\n')
    command = ['/home/younis/flutter/bin/flutter', 'build', 'apk', '--debug', '--no-pub',
               '--target=' + target, '--build-number=12', '--build-name=1.0.0']
    if args.phase == 'annual':
        command.append('--dart-define=NATIVE_ANNUAL_CAMPAIGN=' + args.annual_campaign)
        r['annualCampaign'] = args.annual_campaign
    elif args.phase == 'commercial':
        command += ['--dart-define=USE_EMULATORS=true', '--dart-define=EMULATOR_HOST=10.0.2.2',
                    '--dart-define=GATEWAY_BASE_URL=http://10.0.2.2:8788']
    else:
        command.append('--dart-define=PERSISTENCE_PHASE=verify')
    r['command'] = command
    env = os.environ.copy()
    env['JAVA_HOME'] = '/usr/lib/jvm/java-17-temurin-jdk'
    env['PATH'] = env['JAVA_HOME'] + '/bin:' + env['PATH']
    with (out / (args.phase + '-build.log')).open('x') as log:
        p = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    r['exitCode'] = p.returncode
    if p.returncode:
        raise RuntimeError('native-fixture-build-failed')
    after = source_inventory(ROOT)
    (out / 'source-after.json').write_text(json.dumps(after, indent=2) + '\n')
    require_unchanged(before, after)
    r['sourceInventoryAfterSha256'] = inventory_sha256(after)
    if (revision() != r['sourceRevision'] or file_sha256(ROOT / target) != r['fixture']['sha256']
            or file_sha256(Path(__file__)) != r['helperSha256']):
        raise RuntimeError('native-build-source-changed')
    apk_hash = file_sha256(ROOT / 'build/app/outputs/flutter-apk/app-debug.apk')
    signing = [sys.executable, str(ROOT / 'tools/annual-review/sign-native-fixture.py'),
               args.phase, '--evidence-dir', str(out.relative_to(ROOT))]
    if args.phase == 'annual':
        signing += ['--annual-campaign', args.annual_campaign]
    with (out / 'signing-coordinator.log').open('x') as log:
        p = subprocess.run(signing, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=120)
    if p.returncode:
        raise RuntimeError('native-fixture-signing-failed')
    receipt = out / (args.phase + '-signing.json')
    signed = json.loads(receipt.read_text())
    if (signed['status'] != 'PASS' or signed['inputSha256'] != apk_hash
            or signed['sourceCommit'] != r['sourceRevision']):
        raise RuntimeError('native-signing-provenance-mismatch')
    r.update(status='PASS', immutableBuildInputs=True, signingReceipt=str(receipt.relative_to(ROOT)),
             signingReceiptSha256=file_sha256(receipt), artifact=signed['artifact'], sha256=signed['sha256'])
except Exception as error:
    r['reason'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
finally:
    r['finishedAtUtc'] = now()
    (out / (args.phase + '-build.json')).write_text(json.dumps(r, indent=2) + '\n')
print(json.dumps(r, indent=2))
raise SystemExit(0 if r['status'] == 'PASS' else 1)
