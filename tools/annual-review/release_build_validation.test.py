import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_validation', Path(__file__).with_name('release_build_validation.py'))
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class ReleaseValidationTests(unittest.TestCase):
    def test_output_reuse_is_refused_before_any_credential_or_build_operation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            validation.fresh_output(root / 'new')
            validation.fresh_output(root)
            (root / 'old-result.json').write_text('preserve')
            with self.assertRaisesRegex(validation.ReleaseValidationError, 'already-in-use'):
                validation.fresh_output(root)
            self.assertEqual((root / 'old-result.json').read_text(), 'preserve')

    def test_definitions_are_exactly_pinned_and_metadata_does_not_copy_values(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'public.json'
            value = {key: 'synthetic-public' for key in validation.DEFINITION_KEYS}
            value.update(USE_EMULATORS='false', FIREBASE_PROJECT_ID='strawberry-trade-261017-6a49b', GATEWAY_BASE_URL='https://approved.example.test')
            file.write_text(json.dumps(value))
            expected = hashlib.sha256(file.read_bytes()).hexdigest()
            result = validation.public_definitions(file, expected)
            self.assertEqual(result['sha256'], expected)
            self.assertNotIn('approved.example.test', json.dumps(result))
            file.write_text(file.read_text() + '\n')
            with self.assertRaisesRegex(validation.ReleaseValidationError, 'hash-mismatch'):
                validation.public_definitions(file, expected)

    def test_emulator_private_field_and_credential_bearing_url_refused_even_if_input_hash_matches(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'public.json'
            base = {key: 'synthetic-public' for key in validation.DEFINITION_KEYS}
            base.update(USE_EMULATORS='false', FIREBASE_PROJECT_ID='strawberry-trade-261017-6a49b', GATEWAY_BASE_URL='https://approved.example.test')
            for change in [{'USE_EMULATORS': 'true'}, {'PRIVATE_KEY': 'not-allowed'}, {'GATEWAY_BASE_URL': 'https://user:secret@host.invalid'}, {'GATEWAY_BASE_URL': 'http://host.invalid'}]:
                file.write_text(json.dumps({**base, **change}))
                with self.assertRaises(validation.ReleaseValidationError):
                    validation.public_definitions(file, hashlib.sha256(file.read_bytes()).hexdigest())

    def test_inventory_tracks_app_android_fonts_and_new_source_but_excludes_generated_and_signing_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            names = ['lib/main.dart', 'lib/new.dart', 'assets/fonts/font.ttf', 'assets/build/public.pem',
                     'pubspec.yaml', 'pubspec.lock', 'android/app/build.gradle.kts',
                     'android/app/src/main/AndroidManifest.xml', 'android/local.properties',
                     'android/key.properties', 'android/.gradle/cache',
                     'android/app/build/intermediates/generated', 'android/app/src/main/java/GeneratedPluginRegistrant.java']
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            tracked = [name for name in names if name != 'lib/new.dart']
            before = validation.source_inventory(root, tracked)
            included = {entry['path'] for entry in before}
            self.assertIn('lib/new.dart', included)
            self.assertIn('assets/fonts/font.ttf', included)
            self.assertIn('assets/build/public.pem', included)
            self.assertIn('android/app/build.gradle.kts', included)
            self.assertNotIn('android/local.properties', included)
            self.assertNotIn('android/key.properties', included)
            self.assertNotIn('android/.gradle/cache', included)
            self.assertNotIn('android/app/build/intermediates/generated', included)
            self.assertFalse(any('GeneratedPluginRegistrant.java' in value for value in included))
            (root / 'lib/new.dart').write_text('changed')
            after = validation.source_inventory(root, tracked)
            with self.assertRaisesRegex(validation.ReleaseValidationError, 'source-changed'):
                validation.require_unchanged(before, after)
            self.assertNotEqual(validation.inventory_sha256(before), validation.inventory_sha256(after))

    def test_source_symlink_or_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'lib').mkdir()
            (root / 'outside').write_text('untrusted input')
            (root / 'lib/main.dart').symlink_to(root / 'outside')
            with self.assertRaises(validation.ReleaseValidationError):
                validation.source_inventory(root, ['lib/main.dart'])
            with self.assertRaises(validation.ReleaseValidationError):
                validation.source_inventory(root, ['../outside'])

    def test_only_the_approved_existing_key_and_single_apk_signer_pass(self):
        expected = validation.APPROVED_CERTIFICATE_SHA256
        fingerprint = ':'.join(expected[index:index+2].upper() for index in range(0, len(expected), 2))
        self.assertEqual(validation.approved_keytool_certificate('Entry type: PrivateKeyEntry\nCertificate fingerprints:\n  SHA256: ' + fingerprint + '\n'), expected)
        self.assertEqual(validation.approved_apk_certificate('Signer #1 certificate SHA-256 digest: ' + expected + '\n'), expected)
        for wrong in ['0' * 64, '', expected + '\nSigner #2 certificate SHA-256 digest: ' + expected]:
            with self.assertRaises(validation.ReleaseValidationError):
                validation.approved_apk_certificate('Signer #1 certificate SHA-256 digest: ' + wrong + '\n')
        with self.assertRaises(validation.ReleaseValidationError):
            validation.approved_keytool_certificate('SHA256: ' + ':'.join(['00'] * 32))
        with self.assertRaises(validation.ReleaseValidationError):
            validation.approved_keytool_certificate('Entry type: trustedCertEntry\nSHA256: '+fingerprint)

    def test_package_version_and_non_debuggable_are_mandatory(self):
        package = "package: name='com.strawberrytrade.strawberry_trade' versionCode='12' versionName='1.0.0' platformBuildVersionName='x'\n"
        self.assertEqual(validation.release_badging(package, '1.0.0', 12)['debuggable'], False)
        for bad in [package + 'application-debuggable\n', package.replace("versionCode='12'", "versionCode='11'"), package.replace('com.strawberrytrade.strawberry_trade', 'other.application')]:
            with self.assertRaises(validation.ReleaseValidationError):
                validation.release_badging(bad, '1.0.0', 12)


if __name__ == '__main__':
    unittest.main()
