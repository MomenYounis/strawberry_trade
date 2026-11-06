"""Non-secret input/provenance checks for the synthetic native fixture signer."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import subprocess
import zipfile

LEGACY_PHASES = {'legacy-v9', 'legacy-v11', 'legacy-v12'}
BUILD_OUTPUT = Path('build/app/outputs/flutter-apk/app-debug.apk')


def preparation_module(root):
    spec = importlib.util.spec_from_file_location('verified_legacy_source', root / 'tools/annual-review/prepare-legacy-native.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fixture_input(root, phase, source_folder=None, input_apk=None):
    """No credential lookup, signing, device access or network operation here."""
    if phase not in LEGACY_PHASES:
        if source_folder is not None or input_apk is not None:
            raise RuntimeError('external-input-only-for-verified-legacy-fixtures')
        return root / BUILD_OUTPUT, {}
    client = phase.removeprefix('legacy-')
    preparation = preparation_module(root)
    if source_folder is not None:
        folder = Path(source_folder)
        try:
            manifest = preparation.verify(folder)
        except (ValueError, KeyError, OSError, TypeError):
            raise RuntimeError('legacy-source-provenance-verification-failed') from None
        if manifest['client'] != client:
            raise RuntimeError('legacy-phase-source-client-mismatch')
        folder = folder.resolve(strict=True)
        manifest_bytes = (folder / 'legacy-source-manifest.json').read_bytes()
        if json.loads(manifest_bytes) != manifest:
            raise RuntimeError('legacy-source-manifest-changed')
        source = folder / BUILD_OUTPUT
        metadata = {
            'historicalClient': client,
            'sourceFolder': str(folder),
            'sourceOrigin': manifest['sourceOrigin'],
            'historicalSourceManifestSha256': sha256(manifest_bytes),
            'historicalSourceFilesVerified': len(manifest['files']),
            'historicalLibraryPatched': False,
            'testOnlyEntrypoint': manifest['testOnlyEntrypoint'],
            'requiredBuildDefinitions': manifest['requiredBuildDefinitions'],
        }
    elif client == 'v12':
        source = root / BUILD_OUTPUT
        target = root / 'integration_test/legacy_client_compatibility_test.dart'
        if not target.is_file() or target.is_symlink() or target.read_bytes() != preparation.fixture('v12'):
            raise RuntimeError('exact-generated-v12-legacy-fixture-required')
        revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
        tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'lib', 'android', 'assets',
                                           'pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml', '.metadata'], cwd=root).split(b'\0')
        paths = {item.decode() for item in tracked if item}
        paths.update(str(path.relative_to(root)) for path in (root / 'lib').rglob('*') if path.is_file())
        hashes, changed = [], []
        for name in sorted(paths):
            path = root / name
            if path.is_symlink() or not path.is_file():
                raise RuntimeError('ordinary-current-source-files-required')
            data = path.read_bytes()
            hashes.append({'path': name, 'sha256': sha256(data), 'bytes': len(data)})
            original = subprocess.run(['git', 'show', revision + ':' + name], cwd=root, capture_output=True)
            if original.returncode or original.stdout != data:
                changed.append(name)
        metadata = {
            'historicalClient': client,
            'sourceFolder': str(root),
            'sourceOrigin': {'kind': 'current-review-checkout', 'revision': revision,
                             'sourceContentChangesSinceRevision': changed},
            'currentSourceFileHashes': hashes,
            'currentSourceFilesSha256': sha256(json.dumps(hashes, separators=(',', ':')).encode()),
            'testOnlyEntrypoint': {'path': str(target.relative_to(root)), 'sha256': sha256(target.read_bytes())},
            'requiredBuildDefinitions': {'USE_EMULATORS': True, 'EMULATOR_HOST': '10.0.2.2',
                                         'GATEWAY_BASE_URL': 'http://10.0.2.2:8788'},
        }
    else:
        raise RuntimeError('verified-private-historical-source-folder-required')
    if input_apk is not None:
        supplied = Path(input_apk)
        if supplied.is_symlink() or supplied.resolve() != source.resolve():
            raise RuntimeError('exact-verified-source-build-output-required')
    if source.is_symlink() or not source.is_file():
        raise RuntimeError('verified-historical-build-output-required')
    metadata.update(debugBuildNumberOverride=12, productionBinaryRetargeted=False,
                    productionNetworkTestOfReleasedBinary=False)
    return source, metadata


def required_marker(phase):
    if phase in LEGACY_PHASES:
        return b'legacy_client_compatibility_test.dart'
    if phase == 'annual':
        return b'native_annual_scale_test.dart'
    if phase == 'commercial':
        return b'commercial_business_test.dart'
    if phase.startswith('recovery-'):
        return b'recovery_device_test.dart'
    return b'local_persistence_test.dart'


def check_kernel(source, phase):
    if source.stat().st_size > 256 * 1024 * 1024:
        raise RuntimeError('bounded-synthetic-debug-apk-required')
    with zipfile.ZipFile(source) as archive:
        info = archive.getinfo('assets/flutter_assets/kernel_blob.bin')
        if info.file_size > 128 * 1024 * 1024:
            raise RuntimeError('bounded-synthetic-debug-kernel-required')
        marker, tail, found = required_marker(phase), b'', False
        with archive.open(info) as kernel:
            while chunk := kernel.read(1024 * 1024):
                combined = tail + chunk
                found = found or marker in combined
                tail = combined[-len(marker):]
        if not found:
            raise RuntimeError('persistence-test-entrypoint-required')


def check_badging(badging, version):
    if ("name='com.strawberrytrade.strawberry_trade'" not in badging
            or f"versionCode='{version}'" not in badging
            or 'application-debuggable' not in badging):
        raise RuntimeError('synthetic-debug-package-version-required')


def check_annual_campaign(source, campaign):
    """Bind a safe result namespace to the constant in the actual DEBUG kernel."""
    if not isinstance(campaign, str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,31}', campaign):
        raise RuntimeError('bounded-safe-annual-campaign-required')
    marker = ('NATIVE_ANNUAL_CAMPAIGN=' + campaign + ';').encode()
    if source.stat().st_size > 256 * 1024 * 1024:
        raise RuntimeError('bounded-synthetic-debug-apk-required')
    with zipfile.ZipFile(source) as archive:
        info = archive.getinfo('assets/flutter_assets/kernel_blob.bin')
        if info.file_size > 128 * 1024 * 1024:
            raise RuntimeError('bounded-synthetic-debug-kernel-required')
        tail, found = b'', False
        with archive.open(info) as kernel:
            while chunk := kernel.read(1024 * 1024):
                combined = tail + chunk
                found = found or marker in combined
                tail = combined[-len(marker):]
        if not found:
            raise RuntimeError('compiled-annual-campaign-marker-required')
    return {'annualCampaign': campaign, 'annualCampaignMarkerVerified': True,
            'annualResultsPath': 'native-annual-' + campaign + '/results.json'}
