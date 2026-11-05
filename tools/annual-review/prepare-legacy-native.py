#!/usr/bin/env python3
"""Prepare byte-verified historical client source; never builds or touches devices.

v9 comes from the delivered source ZIP, not the later initial Git commit (+10).
v11 comes from the exact recorded app source commit. Added test-only files and
the three Gradle launcher files have their origins recorded separately.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DURABLE = Path('/home/younis/.local/share/strawberry-trade-test-runtime')
V9_ZIP = Path('/mnt/data/LinuxHome/Downloads/strawberry_trade/delivery/strawberry-trade-employee-invitations-v9-source.zip')
V9_SHA = '10dc781089cf37a0b9e5ef0279c400a0e3f2cfcbb47dac13a8de52e0860adeee'
V11_REVISION = '2ad243a44ac7886d2ad49f25b5368811d288d228'
LAUNCHERS = {'android/gradlew', 'android/gradlew.bat', 'android/gradle/wrapper/gradle-wrapper.jar'}
TOP_LEVEL = {'pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', '.metadata'}
MAX_BYTES = 64 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def selected(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        raise ValueError('safe-relative-source-path-required')
    return name in TOP_LEVEL or (path.parts and path.parts[0] in {'lib', 'android', 'assets'})


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=ROOT)


def v9_files():
    if V9_ZIP.is_symlink() or sha256(V9_ZIP.read_bytes()) != V9_SHA:
        raise ValueError('verified-delivered-v9-source-zip-required')
    result = {}
    with zipfile.ZipFile(V9_ZIP) as archive:
        for entry in archive.infolist():
            prefix = 'strawberry_trade/'
            if not entry.filename.startswith(prefix):
                raise ValueError('known-delivered-zip-root-required')
            name = entry.filename[len(prefix):]
            if not name or entry.is_dir() or not selected(name):
                continue
            if name in result or entry.file_size > 16 * 1024 * 1024:
                raise ValueError('bounded-unique-source-files-required')
            if ((entry.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError('source-symlinks-refused')
            result[name] = archive.read(entry)
    validate_files(result)
    return result


def validate_files(files):
    if not files or len(files) > 500 or sum(map(len, files.values())) > MAX_BYTES:
        raise ValueError('bounded-source-package-required')
    for name in files:
        selected(name)
        path = PurePosixPath(name)
        if any(part in {'build', '.gradle', '.dart_tool', '.cxx'} for part in path.parts):
            raise ValueError('generated-build-files-refused')
        if path.name in {'key.properties', 'local.properties'} or path.suffix in {'.jks', '.keystore', '.p12'}:
            raise ValueError('operator-credentials-refused')


def historical_files(client, v12_revision=None):
    delivered = v9_files()
    if client == 'v9':
        return delivered, {name: 'delivered-v9-source-zip' for name in delivered}, {
            'kind': 'delivered-source-zip', 'path': str(V9_ZIP), 'sha256': V9_SHA,
            'gitBaselineIsExactV9Source': False,
        }
    revision = V11_REVISION if client == 'v11' else (v12_revision or git('rev-parse', 'HEAD').decode().strip())
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('full-source-commit-required')
    if git('rev-parse', revision + '^{commit}').decode().strip() != revision:
        raise ValueError('exact-existing-commit-required')
    files, origins = {}, {}
    for record in git('ls-tree', '-rz', revision).split(b'\0'):
        if not record:
            continue
        header, raw_name = record.split(b'\t', 1)
        mode, kind, object_id = header.decode().split(' ')
        name = raw_name.decode()
        if not selected(name):
            continue
        if kind != 'blob' or mode not in {'100644', '100755'}:
            raise ValueError('ordinary-historical-source-files-required')
        files[name] = git('cat-file', 'blob', object_id)
        origins[name] = 'git:' + revision
    # These generated/ignored launchers were shipped in the verified v9 source
    # archive. The distribution properties must match before they can be reused.
    properties = 'android/gradle/wrapper/gradle-wrapper.properties'
    if files.get(properties) != delivered[properties]:
        raise ValueError('matching-reviewed-gradle-distribution-required')
    for name in LAUNCHERS:
        if name not in files:
            files[name] = delivered[name]
            origins[name] = 'delivered-v9-gradle-launcher'
    validate_files(files)
    return files, origins, {'kind': 'git-commit', 'revision': revision,
                            'gradleLauncherSourceZipSha256': V9_SHA}


def fixture(client):
    template = (ROOT / 'tools/annual-review/fixtures/legacy_client_compatibility.dart.template').read_text()
    if client == 'v9':
        protocol_import = ''
        # Exact historical v9 controller ordering: apply facts, then cursor.
        # This harness does not retrofit newer atomic-cursor behavior into v9.
        page = '''        await store.applyRemoteBatch([
          for (final change in (response['changes'] as List).cast<Map>())
            {'entity': change['entity'],
             'payload': Map<String, dynamic>.from(change['payload'] as Map)},
        ]);
        await store.setPreference('cursor', response['lastSequence'] as int);'''
    else:
        protocol_import = "import 'package:strawberry_trade/services/sync_protocol.dart';"
        page = '''        final page = SyncPage.parse(response, cursor);
        await store.applyRemoteBatch(page.changes,
          expectedCursor: cursor, lastSequence: page.lastSequence);'''
    result = template.replace('@@CLIENT@@', client).replace('@@PROTOCOL_IMPORT@@', protocol_import).replace('@@PAGE_IMPLEMENTATION@@', page)
    if '@@' in result:
        raise ValueError('fixture-template-marker-unresolved')
    return result.encode()


def verify(folder):
    if folder.is_symlink():
        raise ValueError('source-folder-symlink-refused')
    folder = folder.resolve(strict=True)
    if folder.parent != DURABLE or not re.fullmatch(r'legacy-native-(v9|v11|v12)-[a-z0-9_]+', folder.name):
        raise ValueError('marked-private-source-folder-required')
    if folder.is_symlink() or folder.stat().st_mode & 0o077:
        raise ValueError('private-source-folder-required')
    manifest = json.loads((folder / 'legacy-source-manifest.json').read_text())
    client = manifest['client']
    if client not in {'v9', 'v11', 'v12'}:
        raise ValueError('known-historical-client-required')
    source_revision = manifest['sourceOrigin'].get('revision') if client == 'v12' else None
    files, origins, origin = historical_files(client, source_revision)
    expected = [{'path': name, 'bytes': len(files[name]), 'sha256': sha256(files[name]), 'origin': origins[name]}
                for name in sorted(files)]
    if manifest['files'] != expected or manifest['sourceOrigin'] != origin:
        raise ValueError('historical-source-manifest-origin-mismatch')
    for item in expected:
        target = folder / item['path']
        if target.is_symlink() or not target.is_file() or sha256(target.read_bytes()) != item['sha256']:
            raise ValueError('historical-source-content-changed:' + item['path'])
    generated = manifest['testOnlyEntrypoint']
    if (generated['path'] != 'integration_test/legacy_client_compatibility_test.dart'
            or generated['sha256'] != sha256(fixture(client))
            or sha256((folder / generated['path']).read_bytes()) != generated['sha256']):
        raise ValueError('test-entrypoint-content-changed')
    actual_library = {str(path.relative_to(folder)) for path in (folder / 'lib').rglob('*') if path.is_file()}
    if actual_library != {name for name in files if name.startswith('lib/')}:
        raise ValueError('historical-library-file-set-changed')
    return manifest


def prepare(client, v12_revision=None):
    files, origins, origin = historical_files(client, v12_revision)
    DURABLE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if DURABLE.is_symlink() or DURABLE.stat().st_mode & 0o077:
        raise ValueError('private-durable-runtime-root-required')
    folder = Path(tempfile.mkdtemp(prefix='legacy-native-' + client + '-', dir=DURABLE))
    os.chmod(folder, 0o700)
    manifest = {
        'client': client, 'synthetic': True, 'historicalLibraryPatched': False,
        'sourceOrigin': origin, 'files': [],
        'productionNetworkTestOfReleasedBinary': False,
        'requiredBuildDefinitions': {'USE_EMULATORS': True, 'EMULATOR_HOST': '10.0.2.2',
                                     'GATEWAY_BASE_URL': 'http://10.0.2.2:8788'},
        'debugOnly': True, 'productionSigningIdentityChanged': False,
    }
    for name in sorted(files):
        target = folder / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(files[name])
        os.chmod(target, 0o700 if name == 'android/gradlew' else 0o600)
        manifest['files'].append({'path': name, 'bytes': len(files[name]),
                                  'sha256': sha256(files[name]), 'origin': origins[name]})
    entrypoint = 'integration_test/legacy_client_compatibility_test.dart'
    target = folder / entrypoint
    target.parent.mkdir(mode=0o700)
    data = fixture(client)
    target.write_bytes(data)
    os.chmod(target, 0o600)
    manifest['testOnlyEntrypoint'] = {'path': entrypoint, 'sha256': sha256(data), 'bytes': len(data)}
    path = folder / 'legacy-source-manifest.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    os.chmod(path, 0o600)
    verify(folder)
    return folder, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--client', choices=['v9', 'v11', 'v12'])
    group.add_argument('--verify', type=Path)
    parser.add_argument('--v12-revision')
    args = parser.parse_args()
    if args.v12_revision and args.client != 'v12':
        parser.error('--v12-revision requires --client v12')
    if args.verify:
        manifest = verify(args.verify)
        print(json.dumps({'status': 'PASS', 'client': manifest['client'],
                          'historicalSourceFilesUnchanged': len(manifest['files'])}))
    else:
        folder, manifest = prepare(args.client, args.v12_revision)
        print(json.dumps({'status': 'PREPARED', 'client': args.client, 'sourceFolder': str(folder),
                          'sourceOrigin': manifest['sourceOrigin'], 'historicalSourceFiles': len(manifest['files']),
                          'historicalBytes': sum(item['bytes'] for item in manifest['files']),
                          'testOnlyEntrypointSha256': manifest['testOnlyEntrypoint']['sha256'],
                          'androidBuildRun': False, 'deviceTouched': False}))


if __name__ == '__main__':
    main()
