#!/usr/bin/env python3
"""Provenance/tamper checks; does not build Android or operate a device."""
import importlib.util
import json
from pathlib import Path
import shutil
import unittest

spec = importlib.util.spec_from_file_location('legacy_preparation', Path(__file__).with_name('prepare-legacy-native.py'))
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class LegacySourcePreparationTest(unittest.TestCase):
    def test_delivered_v9_is_distinct_from_later_git_baseline(self):
        files, origins, origin = legacy.historical_files('v9')
        self.assertEqual(origin['sha256'], legacy.V9_SHA)
        self.assertIn(b'version: 1.0.0+9', files['pubspec.yaml'])
        self.assertNotEqual(files['lib/services/gateway.dart'], legacy.git('show', 'e246f436:lib/services/gateway.dart'))
        self.assertNotIn(b'syncProtocolVersion', files['lib/services/gateway.dart'])
        self.assertEqual(origins['lib/services/gateway.dart'], 'delivered-v9-source-zip')

    def test_v11_client_implementation_is_exact_recorded_commit(self):
        files, origins, origin = legacy.historical_files('v11')
        self.assertEqual(origin['revision'], legacy.V11_REVISION)
        for name in ['lib/services/gateway.dart', 'lib/data/ledger_store.dart', 'lib/security/device_security.dart', 'pubspec.lock']:
            self.assertEqual(files[name], legacy.git('show', legacy.V11_REVISION + ':' + name))
            self.assertEqual(origins[name], 'git:' + legacy.V11_REVISION)
        self.assertIn(b"'syncProtocolVersion': _syncProtocol", files['lib/services/gateway.dart'])

    def test_fixture_keeps_the_actual_historical_cursor_path(self):
        v9, v11 = legacy.fixture('v9'), legacy.fixture('v11')
        self.assertNotIn(b'SyncPage.parse', v9)
        self.assertIn(b"await store.setPreference('cursor', response['lastSequence'] as int)", v9)
        self.assertIn(b'SyncPage.parse(response, cursor)', v11)
        self.assertIn(b'expectedCursor: cursor, lastSequence: page.lastSequence', v11)
        for data in [v9, v11]:
            self.assertNotIn(b'@@', data)
            self.assertIn(b"expect(FirebaseGateway.emulator, isTrue)", data)
            self.assertIn(b"expect(FirebaseGateway.endpoint.baseUrl, 'http://10.0.2.2:8788')", data)

    def test_source_credentials_and_unsafe_paths_are_refused(self):
        for name in ['../lib/bad.dart', '/lib/bad.dart', 'android/key.properties', 'android/local.properties', 'android/release.jks', 'lib/build/bad.dart']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                legacy.validate_files({name: b'content'})

    def test_changed_library_cannot_be_hidden_by_rewriting_its_manifest(self):
        folder, manifest = legacy.prepare('v9')
        try:
            target = folder / 'lib/services/gateway.dart'
            target.write_bytes(target.read_bytes() + b'\n// changed historical code\n')
            with self.assertRaisesRegex(ValueError, 'historical-source-content-changed'):
                legacy.verify(folder)
            for item in manifest['files']:
                if item['path'] == 'lib/services/gateway.dart':
                    item['sha256'] = legacy.sha256(target.read_bytes())
            (folder / 'legacy-source-manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'manifest-origin-mismatch'):
                legacy.verify(folder)
        finally:
            # Only the new private directory created by this test is removed.
            self.assertEqual(folder.parent, legacy.DURABLE)
            self.assertTrue(folder.name.startswith('legacy-native-v9-'))
            shutil.rmtree(folder)

    def test_extra_library_file_is_refused(self):
        folder, _ = legacy.prepare('v11')
        try:
            (folder / 'lib/added.dart').write_text('// unauthorized addition')
            with self.assertRaisesRegex(ValueError, 'library-file-set-changed'):
                legacy.verify(folder)
        finally:
            self.assertEqual(folder.parent, legacy.DURABLE)
            self.assertTrue(folder.name.startswith('legacy-native-v11-'))
            shutil.rmtree(folder)


if __name__ == '__main__':
    unittest.main(verbosity=2)
