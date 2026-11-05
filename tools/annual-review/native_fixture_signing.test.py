#!/usr/bin/env python3
"""Test signer input guards without credentials, signing, builds or devices."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

import native_fixture_signing as signing

ROOT = Path(__file__).resolve().parents[2]
preparation = signing.preparation_module(ROOT)


class NativeFixtureSigningInputTest(unittest.TestCase):
    def test_existing_phases_retain_their_exact_entrypoint_markers(self):
        expected = {
            'seed-v2': b'local_persistence_test.dart',
            'verify': b'local_persistence_test.dart',
            'recovery-seed': b'recovery_device_test.dart',
            'recovery-restore': b'recovery_device_test.dart',
            'commercial': b'commercial_business_test.dart',
            'annual': b'native_annual_scale_test.dart',
            'legacy-v9': b'legacy_client_compatibility_test.dart',
            'legacy-v11': b'legacy_client_compatibility_test.dart',
            'legacy-v12': b'legacy_client_compatibility_test.dart',
        }
        for phase, marker in expected.items():
            self.assertEqual(signing.required_marker(phase), marker)

    def test_ordinary_phases_cannot_sign_an_external_apk(self):
        self.assertEqual(signing.fixture_input(ROOT, 'commercial'), (ROOT / signing.BUILD_OUTPUT, {}))
        for phase in ['seed-v2', 'verify', 'recovery-seed', 'recovery-restore', 'commercial', 'annual']:
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, 'external-input-only'):
                signing.fixture_input(ROOT, phase, input_apk=Path('/tmp/arbitrary.apk'))

    def test_historical_clients_require_a_verified_private_source_folder(self):
        for phase in ['legacy-v9', 'legacy-v11']:
            with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, 'verified-private-historical'):
                signing.fixture_input(ROOT, phase)

    def test_historical_provenance_and_exact_build_output_are_enforced(self):
        folder, manifest = preparation.prepare('v9')
        try:
            source = folder / signing.BUILD_OUTPUT
            source.parent.mkdir(parents=True)
            with zipfile.ZipFile(source, 'w') as archive:
                archive.writestr('assets/flutter_assets/kernel_blob.bin', signing.required_marker('legacy-v9'))
            path, metadata = signing.fixture_input(ROOT, 'legacy-v9', folder, source)
            self.assertEqual(path, source)
            self.assertEqual(metadata['sourceOrigin'], manifest['sourceOrigin'])
            self.assertEqual(metadata['historicalSourceManifestSha256'], signing.file_sha256(folder / 'legacy-source-manifest.json'))
            self.assertEqual(metadata['historicalSourceFilesVerified'], len(manifest['files']))
            self.assertEqual(metadata['debugBuildNumberOverride'], 12)
            self.assertFalse(metadata['productionBinaryRetargeted'])
            with self.assertRaisesRegex(RuntimeError, 'source-client-mismatch'):
                signing.fixture_input(ROOT, 'legacy-v11', folder, source)
            with self.assertRaisesRegex(RuntimeError, 'exact-verified-source-build-output'):
                signing.fixture_input(ROOT, 'legacy-v9', folder, Path('/tmp/arbitrary.apk'))
            link = folder / 'linked.apk'
            link.symlink_to(source)
            with self.assertRaisesRegex(RuntimeError, 'exact-verified-source-build-output'):
                signing.fixture_input(ROOT, 'legacy-v9', folder, link)
            (folder / 'lib/services/gateway.dart').write_text('// altered old client')
            with self.assertRaisesRegex(RuntimeError, 'provenance-verification-failed'):
                signing.fixture_input(ROOT, 'legacy-v9', folder, source)
        finally:
            self.assertEqual(folder.parent, preparation.DURABLE)
            self.assertTrue(folder.name.startswith('legacy-native-v9-'))
            shutil.rmtree(folder)

    def test_kernel_marker_scanning_handles_chunk_boundaries_and_refuses_other_targets(self):
        with tempfile.TemporaryDirectory(prefix='strawberry-signer-input-unit-') as directory:
            path = Path(directory) / 'synthetic-not-installable.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('assets/flutter_assets/kernel_blob.bin', b'0' * (1024 * 1024 - 10) + signing.required_marker('legacy-v11'))
            signing.check_kernel(path, 'legacy-v11')
            with self.assertRaisesRegex(RuntimeError, 'persistence-test-entrypoint-required'):
                signing.check_kernel(path, 'commercial')

    def test_badging_requires_existing_package_debuggable_and_exact_version(self):
        valid = "package: name='com.strawberrytrade.strawberry_trade' versionCode='12'\napplication-debuggable\n"
        signing.check_badging(valid, '12')
        for badging in [valid.replace('application-debuggable', ''), valid.replace("versionCode='12'", "versionCode='9'"), valid.replace('com.strawberrytrade.strawberry_trade', 'example.other')]:
            with self.assertRaisesRegex(RuntimeError, 'synthetic-debug-package-version-required'):
                signing.check_badging(badging, '12')


if __name__ == '__main__':
    unittest.main(verbosity=2)
