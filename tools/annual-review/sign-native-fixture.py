#!/usr/bin/env python3
"""Sign only the synthetic native persistence fixture with the existing key.

This is a DEBUG test artifact, never the distributed release APK. Credentials
remain in memory. Does not install, publish, create keys or change any identity.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
from native_fixture_signing import LEGACY_PHASES, check_badging, check_kernel, file_sha256, fixture_input

root = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('phase', choices=['seed-v2', 'verify', 'recovery-seed', 'recovery-restore', 'commercial', 'annual', 'legacy-v9', 'legacy-v11', 'legacy-v12'])
parser.add_argument('--evidence-dir', default='verification/annual-2026-11-02/native')
parser.add_argument('--source-folder', type=pathlib.Path)
parser.add_argument('--input-apk', type=pathlib.Path)
args = parser.parse_args()
out = (root / args.evidence_dir).resolve()
if not out.is_relative_to(root / 'verification'):
    raise SystemExit('verification-output-required')
out.mkdir(parents=True, exist_ok=True)
destination = out / f'persistence-{args.phase}-signed-DEBUG.apk'
receipt = out / f'{args.phase}-signing.json'
if receipt.exists():
    raise SystemExit('signing-evidence-already-exists; use a new evidence directory')
result = {'synthetic': True, 'debugTestArtifact': True, 'status': 'BLOCKED',
          'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()}
password = b''
fd = None
try:
    if destination.exists():
        raise RuntimeError('destination-already-exists')
    source, provenance = fixture_input(root, args.phase, args.source_folder, args.input_apk)
    if args.phase in LEGACY_PHASES:
        result['signingCoordinatorSourceCommit'] = result.pop('sourceCommit')
        result.update(provenance)
        if 'revision' in provenance['sourceOrigin']:
            result['sourceCommit'] = provenance['sourceOrigin']['revision']
    input_sha256 = file_sha256(source)
    check_kernel(source, args.phase)
    env = os.environ.copy()
    env['JAVA_HOME'] = '/usr/lib/jvm/java-17-temurin-jdk'
    env['PATH'] = env['JAVA_HOME'] + '/bin:' + env['PATH']
    tools = '/home/younis/Android/Sdk/build-tools/36.0.0/'
    badging = subprocess.check_output([tools + 'aapt', 'dump', 'badging', str(source)], env=env, text=True, timeout=30)
    if args.phase in LEGACY_PHASES:
        version = '12'
    else:
        match = re.search(r'^version: [0-9]+\.[0-9]+\.[0-9]+\+([0-9]+)$', (root / 'pubspec.yaml').read_text(), re.M)
        if not match:
            raise RuntimeError('invalid-public-build-version')
        version = '8' if args.phase == 'seed-v2' else match.group(1)
    check_badging(badging, version)
    if file_sha256(source) != input_sha256:
        raise RuntimeError('fixture-build-output-changed')
    secret = subprocess.run(['secret-tool', 'lookup', 'purpose', 'android-release-v1'], capture_output=True, timeout=20)
    password = secret.stdout.rstrip(b'\r\n')
    if secret.returncode or not password:
        raise RuntimeError('existing-signing-credential-unavailable')
    fd = os.memfd_create('synthetic-fixture-signing', os.MFD_CLOEXEC)
    os.fchmod(fd, 0o600)
    # apksigner caches a password-file reader and consumes one line per prompt
    # even when --ks-pass and --key-pass refer to the same anonymous file.
    os.write(fd, password + b'\n' + password + b'\n')
    credential = f'file:/proc/{os.getpid()}/fd/{fd}'
    command = [tools + 'apksigner', 'sign', '--ks', '/home/younis/.local/share/strawberry-trade-operator/android-release.jks',
               '--ks-key-alias', 'strawberry-release-v1', '--ks-pass', credential, '--key-pass', credential,
               '--out', str(destination), str(source)]
    signed = subprocess.run(command, env=env, capture_output=True, timeout=60)
    if signed.returncode:
        diagnostics = (signed.stdout + signed.stderr).replace(password, b'[REDACTED]')
        (out / f'{args.phase}-signing-error.log').write_bytes(diagnostics)
        raise RuntimeError('fixture-signing-failed')
    if file_sha256(source) != input_sha256:
        raise RuntimeError('fixture-build-output-changed-during-signing')
    verified = subprocess.run([tools + 'apksigner', 'verify', '--verbose', '--print-certs', str(destination)], env=env, capture_output=True, text=True, timeout=30)
    expected = 'bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b'
    if verified.returncode or expected not in verified.stdout:
        raise RuntimeError('fixture-certificate-mismatch')
    (out / f'{args.phase}-signature.log').write_text(verified.stdout)
    result.update(status='PASS', artifact=str(destination), sha256=file_sha256(destination),
                  inputSha256=input_sha256, versionCode=int(version),
                  certificateSha256=expected, signingCredential='Existing Secret Service value; anonymous memfd; no password arguments/disk file')
except RuntimeError as error:
    result['reason'] = str(error)
except Exception as error:
    result['reason'] = type(error).__name__
finally:
    if fd is not None:
        os.close(fd)
    password = b''
    receipt.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
sys.exit(0 if result['status'] == 'PASS' else 1)
