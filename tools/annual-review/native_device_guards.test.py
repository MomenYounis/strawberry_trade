#!/usr/bin/env python3
"""Guard and launch tests: synthetic files/processes only, no ADB or device calls."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

device = load('tested_native_device', 'native-commercial-device.py')
launcher = load('tested_native_launcher', 'launch-native-drive.py')

class NativeDeviceGuardsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='strawberry-native-guard-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.verification = self.root / 'verification'
        self.verification.mkdir()
        self.apk = self.verification / 'synthetic-not-installable.apk'
        self.apk.write_bytes(b'test fixture bytes only; never install')
        self.metadata = self.verification / 'signing.json'
        self.receipt = {'status': 'PASS', 'synthetic': True, 'debugTestArtifact': True,
                        'certificateSha256': device.APPROVED_CERT, 'versionCode': 12,
                        'artifact': str(self.apk), 'sha256': device.sha256_file(self.apk),
                        'sourceCommit': '1' * 40}
        self.metadata.write_text(json.dumps(self.receipt))
        self.commands = []

    def tools(self, arguments, **options):
        self.commands.append(tuple(arguments))
        self.assertTrue(options['capture_output'])
        self.assertLessEqual(options['timeout'], 60)
        if Path(arguments[0]).name == 'apksigner':
            return SimpleNamespace(returncode=0, stdout='Signer #1 certificate SHA-256 digest: ' + device.APPROVED_CERT + '\n')
        if Path(arguments[0]).name == 'aapt':
            return SimpleNamespace(returncode=0, stdout="package: name='" + device.PACKAGE + "' versionCode='12'\napplication-debuggable\n")
        self.fail('Unexpected command; these tests never call ADB or credentials')

    def validate(self):
        return device.validated_fixture(self.metadata, root=self.root, run=self.tools)

    def test_receipt_requires_exact_artifact_and_independent_certificate_package_checks(self):
        proof = self.validate()
        self.assertEqual(proof['sha256'], self.receipt['sha256'])
        self.assertTrue(proof['signatureAndPackageIndependentlyVerified'])
        self.assertEqual([Path(c[0]).name for c in self.commands], ['apksigner', 'aapt'])
        self.apk.write_bytes(b'changed')
        self.commands.clear()
        with self.assertRaisesRegex(RuntimeError, 'unchanged-bounded-debug'):
            self.validate()
        self.assertEqual(self.commands, [])

    def test_non_test_wrong_certificate_and_bad_version_receipts_fail_before_tools(self):
        for changed in [{'synthetic': False}, {'debugTestArtifact': False}, {'status': 'FAIL'},
                        {'certificateSha256': '0' * 64}, {'versionCode': True}, {'versionCode': -1}]:
            self.metadata.write_text(json.dumps({**self.receipt, **changed}))
            with self.subTest(changed=changed), self.assertRaisesRegex(RuntimeError, 'passing-synthetic-debug'):
                self.validate()
        self.assertEqual(self.commands, [])

    def test_receipt_and_artifact_symlinks_or_outside_verification_are_refused(self):
        outside = self.root / 'outside.apk'
        outside.write_bytes(self.apk.read_bytes())
        self.metadata.write_text(json.dumps({**self.receipt, 'artifact': str(outside)}))
        with self.assertRaisesRegex(RuntimeError, 'ordinary-verification'):
            self.validate()
        self.metadata.write_text(json.dumps(self.receipt))
        linked = self.verification / 'linked.json'
        linked.symlink_to(self.metadata)
        with self.assertRaisesRegex(RuntimeError, 'ordinary-verification'):
            device.validated_fixture(linked, root=self.root, run=self.tools)
        self.assertEqual(self.commands, [])

    def test_actual_signature_and_debug_package_must_match_receipt(self):
        real_stub = self.tools
        def wrong_signer(arguments, **options):
            value = real_stub(arguments, **options)
            if Path(arguments[0]).name == 'apksigner':
                value.stdout += 'Signer #2 certificate SHA-256 digest: ' + device.APPROVED_CERT + '\n'
            return value
        with self.assertRaisesRegex(RuntimeError, 'single-approved'):
            device.validated_fixture(self.metadata, root=self.root, run=wrong_signer)
        def not_debug(arguments, **options):
            value = real_stub(arguments, **options)
            if Path(arguments[0]).name == 'aapt':
                value.stdout = value.stdout.replace('application-debuggable', '')
            return value
        with self.assertRaisesRegex(RuntimeError, 'exact-synthetic-debug'):
            device.validated_fixture(self.metadata, root=self.root, run=not_debug)

    def test_annual_result_path_is_bound_to_safe_campaign_and_label_requires_its_phase(self):
        self.assertEqual(device.annual_result_target({}), 'native-annual-v12/results.json')
        self.assertEqual(device.annual_result_target({'annualCampaign': 'nov6batch'}),
                         'native-annual-nov6batch/results.json')
        for fixture in [{'annualCampaign': '../owner'}, {'annualCampaign': ''},
                        {'annualCampaign': 'x' * 33},
                        {'annualCampaign': 'nov6batch', 'annualResultsPath': 'owner/results.json'}]:
            with self.subTest(fixture=fixture), self.assertRaises(RuntimeError):
                device.annual_result_target(fixture)
        for label, expected in [
            ('annual-nov6batch-base', 'BASE_INSTALLED_GROWTH_PENDING'),
            ('annual-nov6batch-resume-detached', 'BASE_INSTALLED_GROWTH_PENDING'),
            ('annual-nov6batch-growth', 'INSTALLED_REBOOT_VERIFICATION_PENDING'),
            ('annual-nov6batch-verify', 'PASS')]:
            self.assertEqual(device.expected_annual_status(label), expected)
        with self.assertRaisesRegex(RuntimeError, 'explicit-annual'):
            device.expected_annual_status('annual-ambiguous')

    def installed(self, replacements=None):
        expected = {'sha256': self.receipt['sha256'], 'versionCode': 12,
                    'certificateSha256': device.APPROVED_CERT, 'metadataSha256': '2' * 64}
        path = '/data/app/~~abc/' + device.PACKAGE + '-xyz==/base.apk'
        outputs = {('pm', 'path', device.PACKAGE): 'package:' + path,
                   ('sha256sum', path): expected['sha256'] + '  ' + path,
                   ('dumpsys', 'package', device.PACKAGE): 'Package [synthetic]\n    versionCode=12 minSdk=23\n'}
        outputs.update(replacements or {})
        calls = []
        def shell(*arguments):
            calls.append(arguments)
            return outputs[arguments]
        return expected, path, shell, calls

    def test_installed_proof_hashes_only_single_safe_base_apk_and_reads_actual_version(self):
        expected, path, shell, calls = self.installed()
        proof = device.installed_fixture_identity(expected, shell)
        self.assertEqual(proof['sha256'], expected['sha256'])
        self.assertEqual(proof['versionCode'], 12)
        self.assertEqual(calls, [('pm', 'path', device.PACKAGE), ('sha256sum', path), ('dumpsys', 'package', device.PACKAGE)])

    def test_installed_split_unsafe_path_wrong_digest_or_version_fail_closed(self):
        expected, path, _, _ = self.installed()
        failures = [
            {('pm', 'path', device.PACKAGE): 'package:' + path + '\npackage:/data/app/a/split_config.apk'},
            {('pm', 'path', device.PACKAGE): 'package:/data/app/a;id/base.apk'},
            {('pm', 'path', device.PACKAGE): 'package:/data/app/../owner/base.apk'},
            {('sha256sum', path): '0' * 64 + '  ' + path},
            {('dumpsys', 'package', device.PACKAGE): 'versionCode=11 minSdk=23\n'},
            {('dumpsys', 'package', device.PACKAGE): 'versionCode=12 minSdk=23\nversionCode=12 minSdk=23\n'},
            {('pm', 'path', device.PACKAGE): 'x' * 8193},
        ]
        for replacement in failures:
            expected, _, shell, _ = self.installed(replacement)
            with self.subTest(replacement=list(replacement)), self.assertRaises(RuntimeError):
                device.installed_fixture_identity(expected, shell)

    def test_runtime_guard_binds_exact_name_path_serial_and_process_port(self):
        with tempfile.TemporaryDirectory(prefix='strawberry-commercial-native-', dir='/tmp') as folder:
            folder = Path(folder); avd = folder / 'avd/strawberry_commercial_disposable_employee.avd'; avd.mkdir(parents=True)
            proc = self.root / 'proc/123'; proc.mkdir(parents=True)
            runtime = {'synthetic': True, 'ownerDeviceTouched': False, 'name': 'employee',
                       'runtimeRoot': str(folder), 'avdPath': str(avd), 'avdHome': str(folder / 'avd'),
                       'avdName': 'strawberry_commercial_disposable_employee', 'serial': 'emulator-5582', 'pid': 123}
            command = [str(device.SDK / 'emulator/qemu/linux-x86_64/qemu-system-x86_64'),
                       '-avd', runtime['avdName'], '-datadir', str(avd), '-port', '5582']
            (proc / 'cmdline').write_bytes(b'\0'.join(p.encode() for p in command) + b'\0')
            device.guard_runtime(runtime, 'employee', proc_root=proc.parent)
            for changed in [{'serial': 'emulator-5554'}, {'ownerDeviceTouched': True}, {'synthetic': False},
                            {'avdPath': str(folder / 'other.avd')}, {'name': 'source'}]:
                with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                    device.guard_runtime({**runtime, **changed}, 'employee', proc_root=proc.parent)
            command[-1] = '5554'
            (proc / 'cmdline').write_bytes(b'\0'.join(p.encode() for p in command))
            with self.assertRaisesRegex(RuntimeError, 'command-and-port'):
                device.guard_runtime(runtime, 'employee', proc_root=proc.parent)

class DetachedLaunchGuardsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='strawberry-launch-guard-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_unrelated_inhibitor_or_incomplete_receipts_do_not_block_a_device(self):
        for prior in [None, [], {}, {'pid': 123, 'duration': 3600, 'scope': 'annual inhibitor'},
                      {'device': 'employee', 'pid': 123},
                      {'device': 'employee', 'pid': True, 'label': 'base', 'command': []},
                      {'device': 'employee', 'pid': 123, 'label': '../unsafe', 'command': []}]:
            with self.subTest(prior=prior):
                self.assertFalse(launcher.legacy_drive_is_running(prior, 'employee', self.root))

    def test_historical_running_drive_requires_exact_arguments_and_live_process(self):
        command = [sys.executable, str(launcher.DRIVER), 'drive', 'employee', '--label', 'annual-base']
        prior = {'pid': 123, 'device': 'employee', 'label': 'annual-base', 'command': command}
        proc = self.root / '123'; proc.mkdir()
        current = proc / 'cmdline'
        current.write_bytes(b'\0'.join(p.encode() for p in command) + b'\0')
        self.assertTrue(launcher.legacy_drive_is_running(prior, 'employee', self.root))
        self.assertFalse(launcher.legacy_drive_is_running(prior, 'source', self.root))
        for changed in [command[:2] + ['other', *command[3:]],
                        command[:-1] + ['annual-base-other'],
                        ['/bin/false', *command[1:]]]:
            current.write_bytes(b'\0'.join(p.encode() for p in changed) + b'\0')
            with self.subTest(changed=changed):
                self.assertFalse(launcher.legacy_drive_is_running(prior, 'employee', self.root))
        current.unlink()
        self.assertFalse(launcher.legacy_drive_is_running(prior, 'employee', self.root))

    def test_atomic_receipt_never_replaces_existing_evidence(self):
        path = self.root / 'receipt.json'; path.write_text('preserve')
        with self.assertRaises(FileExistsError):
            launcher.publish_receipt(path, {'new': True})
        self.assertEqual(path.read_text(), 'preserve')
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_detached_child_only_runs_after_receipt_and_holds_lock_until_exit(self):
        receipt = self.root / 'receipt.json'; marker = self.root / 'ran'; release = self.root / 'release'
        target = self.root / 'synthetic-child.py'
        target.write_text("import json,os,pathlib,time\nr=pathlib.Path(" + repr(str(receipt)) + ")\nassert json.loads(r.read_text())['pid']==os.getpid()\npathlib.Path(" + repr(str(marker)) + ").write_text('receipt existed before child execution')\nend=time.monotonic()+5\nwhile not pathlib.Path(" + repr(str(release)) + ").exists() and time.monotonic()<end:time.sleep(.02)\n")
        lock = launcher.per_device_lock(self.root, 'employee')
        try:
            with (self.root / 'child.log').open('wb') as log:
                child = launcher.start_gated_drive([sys.executable, str(target)], {'synthetic': True}, receipt, log, lock)
        finally:
            os.close(lock)
        try:
            deadline = time.monotonic() + 4
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(marker.exists())
            with self.assertRaisesRegex(RuntimeError, 'already-has-a-running-drive'):
                launcher.per_device_lock(self.root, 'employee')
        finally:
            release.touch()
            self.assertEqual(child.wait(timeout=7), 0)
        # The old lock file remains, but cannot obstruct a new launch.
        fresh = launcher.per_device_lock(self.root, 'employee'); os.close(fresh)

    def test_failed_receipt_publication_closes_gate_before_any_child_action(self):
        target = self.root / 'synthetic-child.py'; marker = self.root / 'must-not-run'
        target.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ").write_text('bad')\n")
        record = {}; lock = launcher.per_device_lock(self.root, 'employee')
        try:
            with (self.root / 'child.log').open('wb') as log, patch.object(launcher, 'publish_receipt', side_effect=OSError('synthetic publication failure')):
                with self.assertRaises(OSError):
                    launcher.start_gated_drive([sys.executable, str(target)], record, self.root / 'receipt.json', log, lock)
            with self.assertRaises(ChildProcessError):
                os.waitpid(record['pid'], os.WNOHANG)
            self.assertFalse(marker.exists())
        finally:
            os.close(lock)
        fresh = launcher.per_device_lock(self.root, 'employee'); os.close(fresh)

class SyntheticCommercialNetwork:
    def __init__(self, corrupt=None, drop_hook=None, offline_unconfirmed=False):
        self.chain = 'STRAWBERRY_LOCAL_ACCEPTANCE'
        self.rules = {b: [['-A', self.chain, '-j', 'ACCEPT']] for b in ['iptables', 'ip6tables']}
        self.output = {b: [['-A', 'OUTPUT', '-j', 'ACCEPT'], ['-A', 'OUTPUT', '-j', self.chain]] for b in self.rules}
        self.calls = []
        self.corrupt, self.drop_hook, self.offline_unconfirmed = corrupt, drop_hook, offline_unconfirmed

    def adb(self, *arguments, **options):
        self.calls.append(('adb', *arguments))

    def shell(self, *arguments):
        self.calls.append(('shell', *arguments))
        binary, *args = arguments
        if binary == 'settings' and args[:2] == ['get', 'global']:
            return {'airplane_mode_on': '1', 'wifi_on': '0', 'mobile_data': '1' if self.offline_unconfirmed else '0'}[args[2]]
        if arguments == ('getprop', 'sys.boot_completed'):
            return '1'
        if binary not in self.rules:
            return ''
        if args == ['-S']:
            return '-N ' + self.chain
        if args == ['-F', self.chain]:
            self.rules[binary] = []
        elif args[:2] == ['-A', self.chain]:
            if '-d' in args:
                args[args.index('-d') + 1] += '/32'
            self.rules[binary].append(args)
        elif args == ['-S', self.chain]:
            rules = [['-N', self.chain], *self.rules[binary]]
            if self.corrupt == binary:
                rules.insert(1, ['-A', self.chain, '-j', 'ACCEPT'])
            return '\n'.join(' '.join(rule) for rule in rules)
        elif args == ['-S', 'OUTPUT']:
            return '-P OUTPUT ACCEPT\n' + '\n'.join(' '.join(rule) for rule in self.output[binary])
        elif args == ['-I', 'OUTPUT', '1', '-j', self.chain]:
            if self.drop_hook != binary:
                self.output[binary].insert(0, ['-A', 'OUTPUT', '-j', self.chain])
        else:
            raise AssertionError(arguments)
        return ''


class CommercialNetworkGuardsTest(unittest.TestCase):
    def test_exact_rules_repair_late_hooks_before_network_enable_for_both_families(self):
        network = SyntheticCommercialNetwork()
        device.prepare_commercial_network(network.shell, network.adb)
        for binary in network.rules:
            self.assertEqual(network.output[binary][0], ['-A', 'OUTPUT', '-j', network.chain])
            self.assertNotIn(['-A', network.chain, '-j', 'ACCEPT'], network.rules[binary])
        self.assertIn('8788,9099', ' '.join(map(str, network.calls)))
        self.assertNotIn('18788', ' '.join(map(str, network.calls)))
        root_index = network.calls.index(('adb', 'root'))
        self.assertTrue(all(('shell', 'settings', 'get', 'global', key) in network.calls[:root_index]
                            for key in ['airplane_mode_on', 'wifi_on', 'mobile_data']))
        enable_index = network.calls.index(('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'))
        self.assertLess(max(i for i, c in enumerate(network.calls) if c[:3] == ('shell', 'ip6tables', '-S')), enable_index)

    def test_unconfirmed_offline_fails_before_root_and_network_enable(self):
        network = SyntheticCommercialNetwork(offline_unconfirmed=True)
        with self.assertRaisesRegex(RuntimeError, 'offline-required'):
            device.prepare_commercial_network(network.shell, network.adb)
        self.assertFalse(any(c[0] == 'adb' for c in network.calls))
        self.assertNotIn(('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'), network.calls)

    def test_extra_chain_rule_in_either_family_keeps_network_disabled(self):
        for binary in ['iptables', 'ip6tables']:
            network = SyntheticCommercialNetwork(corrupt=binary)
            with self.subTest(binary=binary), self.assertRaisesRegex(RuntimeError, 'chain-mismatch'):
                device.prepare_commercial_network(network.shell, network.adb)
            self.assertNotIn(('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'), network.calls)

    def test_hook_insertion_not_confirmed_keeps_network_disabled(self):
        network = SyntheticCommercialNetwork(drop_hook='ip6tables')
        with self.assertRaisesRegex(RuntimeError, 'hook-missing'):
            device.prepare_commercial_network(network.shell, network.adb)
        self.assertNotIn(('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'), network.calls)

if __name__ == '__main__':
    unittest.main(verbosity=2)
