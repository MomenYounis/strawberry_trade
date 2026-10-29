import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/security/license_sync.dart';
import 'package:strawberry_trade/security/trusted_clock.dart';

const start = 1700000000000;
final algorithm = Ed25519();
late SimpleKeyPair key;
late LicenseVerifier verifier;
Map<String, dynamic> license({
  int epoch = 1,
  bool trial = true,
  int? expiry = start + trialDurationMs,
}) => {
  'type': 'entitlement',
  'version': 1,
  'tenantId': 'tenant-a',
  'licenseId': 'license-$epoch',
  'epoch': epoch,
  'issuedAtMs': start,
  'notBeforeMs': start,
  'expiresAtMs': expiry,
  'trialStartMs': trial ? start : null,
  'trial': trial,
  'maxDevices': 3,
};
Map<String, dynamic> membership({
  String uid = 'employee-a',
  String role = 'employee',
  int epoch = 1,
  int entitlementEpoch = 1,
  int issued = start,
  bool enabled = true,
}) => {
  'type': 'membership',
  'version': 1,
  'tenantId': 'tenant-a',
  'uid': uid,
  'deviceId': 'device-a',
  'role': role,
  'epoch': epoch,
  'entitlementEpoch': entitlementEpoch,
  'issuedAtMs': issued,
  'expiresAtMs': null,
  'enabled': enabled,
};
Future<Map<String, dynamic>> envelope(Map<String, dynamic> payload) async {
  final bytes = utf8.encode(canonicalJson(payload));
  final signature = await algorithm.sign(bytes, keyPair: key);
  return {
    'kid': 'isolated-unit-test',
    'payload': base64Url.encode(bytes).replaceAll('=', ''),
    'signature': base64Url.encode(signature.bytes).replaceAll('=', ''),
  };
}

Future<String> package({
  Map<String, dynamic>? l,
  Map<String, dynamic>? m,
}) async => jsonEncode({
  'version': 1,
  'entitlement': await envelope(l ?? license()),
  'membership': await envelope(m ?? membership()),
});
Future<VerifiedLicensePackage> verify(
  String input, {
  String tenant = 'tenant-a',
  String uid = 'employee-a',
  String device = 'device-a',
}) =>
    verifier.verifyPackage(input, tenantId: tenant, uid: uid, deviceId: device);

class MemorySecurity extends DeviceSecurity {
  final values = <String, String>{};
  ClockSample clock = const ClockSample(
    wallMs: start,
    elapsedMs: 1000,
    bootCount: 1,
  );
  bool failWrites = false;
  @override
  Future<String?> readSecureValue(String scope) async => values[scope];
  @override
  Future<void> writeSecureValue(String scope, String value) async {
    if (failWrites) throw const FileSystemException('Synthetic full storage');
    values[scope] = value;
  }

  @override
  Future<ClockSample> platformClock() async => clock;
  void advance(int milliseconds) => clock = ClockSample(
    wallMs: clock.wallMs + milliseconds,
    elapsedMs: clock.elapsedMs + milliseconds,
    bootCount: clock.bootCount,
  );
}

LicenseSession session(MemorySecurity security) => LicenseSession(
  security: security,
  verifier: verifier,
  tenantId: 'tenant-a',
  uid: 'employee-a',
  deviceId: 'device-a',
);

void main() {
  setUpAll(() async {
    key = await algorithm.newKeyPair();
    final public = await key.extractPublicKey();
    verifier = LicenseVerifier({
      'isolated-unit-test': base64Url.encode(public.bytes).replaceAll('=', ''),
    });
  });
  test('Node issuer fixture verifies in Dart; fixture trust is explicitly supplied only by test', () async {
    final fixture = jsonDecode(
      File('test/fixtures/license_package.json').readAsStringSync(),
    ) as Map<String, dynamic>;
    final v = LicenseVerifier(
      (fixture['publicKeys'] as Map<String, dynamic>).cast<String, String>(),
    );
    final result = await v.verifyPackage(
      jsonEncode(fixture['package']),
      tenantId: 'tenant-test-only',
      uid: 'manager-test-only',
      deviceId: 'device-test-only',
    );
    expect(
      result.license.expiresAtMs,
      result.license.trialStartMs! + trialDurationMs,
    );
    await expectLater(
      LicenseVerifier({}).verifyPackage(
        jsonEncode(fixture['package']),
        tenantId: 'tenant-test-only',
        uid: 'manager-test-only',
        deviceId: 'device-test-only',
      ),
      throwsA(isA<LicenseException>()),
    );
  });
  test('wrong tenant, user and installation are denied', () async {
    final input = await package();
    for (final action in [
      () => verify(input, tenant: 'tenant-b'),
      () => verify(input, uid: 'attacker'),
      () => verify(input, device: 'replacement'),
    ]) {
      await expectLater(action, throwsA(isA<LicenseException>()));
    }
  });
  test('tampered bytes and unknown issuer cannot grant activation', () async {
    final p = jsonDecode(await package()) as Map<String, dynamic>;
    final l = p['entitlement'] as Map<String, dynamic>;
    l['payload'] = base64Url
        .encode(utf8.encode(canonicalJson(license(epoch: 99))))
        .replaceAll('=', '');
    await expectLater(verify(jsonEncode(p)), throwsA(isA<LicenseException>()));
    l['kid'] = 'unknown';
    await expectLater(verify(jsonEncode(p)), throwsA(isA<LicenseException>()));
  });
  test(
    'issuer-signed malformed trial or mismatched entitlement is still invalid',
    () async {
      await expectLater(
        verify(await package(l: license(expiry: start + trialDurationMs + 1))),
        throwsA(isA<LicenseException>()),
      );
      await expectLater(
        verify(await package(m: membership(entitlementEpoch: 2))),
        throwsA(isA<LicenseException>()),
      );
      await expectLater(
        verify(await package(l: {...license(), 'surprise': true})),
        throwsA(isA<LicenseException>()),
      );
    },
  );
  test(
    'canonical signature format rejects padding and noncanonical JSON',
    () async {
      final bytes = utf8.encode(jsonEncode(license()));
      final signature = await algorithm.sign(bytes, keyPair: key);
      final p = jsonDecode(await package()) as Map<String, dynamic>;
      p['entitlement'] = {
        'kid': 'isolated-unit-test',
        'payload': base64Url.encode(bytes).replaceAll('=', ''),
        'signature': base64Url.encode(signature.bytes).replaceAll('=', ''),
      };
      await expectLater(
        verify(jsonEncode(p)),
        throwsA(isA<LicenseException>()),
      );
      final canonical = jsonDecode(await package()) as Map<String, dynamic>;
      (canonical['entitlement'] as Map<String, dynamic>)['payload'] += '=';
      await expectLater(
        verify(jsonEncode(canonical)),
        throwsA(isA<LicenseException>()),
      );
    },
  );
  test('employee joining day29 inherits original tenant expiration to exact millisecond', () async {
    final security = MemorySecurity();
    final s = session(security);
    final joined = start + 29 * 24 * 60 * 60 * 1000;
    final status = await s.importPackage(
      await package(m: membership(issued: joined)),
    );
    expect(status.operationalAllowed, true);
    expect(status.remaining, const Duration(days: 1));
    security.advance(24 * 60 * 60 * 1000 - 1);
    expect((await s.check()).operationalAllowed, true);
    security.advance(1);
    expect((await s.check()).code, 'expired');
  });
  test(
    'offline app reopening keeps entitlement, clock and no daily lease',
    () async {
      final security = MemorySecurity();
      await session(security).importPackage(await package());
      security.advance(20 * 24 * 60 * 60 * 1000);
      final reopened = session(security);
      expect((await reopened.initialize()).operationalAllowed, true);
      expect((await reopened.check()).remaining, const Duration(days: 10));
    },
  );
  test('re-imported package cannot rewind clock; expiry lock survives process restart', () async {
    final security = MemorySecurity();
    final s = session(security);
    final input = await package();
    await s.importPackage(input);
    security.advance(trialDurationMs);
    expect((await s.check()).code, 'expired');
    expect((await s.importPackage(input)).code, 'expired');
    expect((await session(security).initialize()).code, 'expired');
    expect(security.values, isNotEmpty);
  });
  test(
    'lower epoch and changed same-epoch payloads are denied; renewal resumes',
    () async {
      final security = MemorySecurity();
      final s = session(security);
      await s.importPackage(await package());
      security.advance(trialDurationMs);
      expect((await s.check()).operationalAllowed, false);
      final renewed = await package(
        l: license(epoch: 2, trial: false, expiry: null),
        m: membership(epoch: 2, entitlementEpoch: 2),
      );
      expect((await s.importPackage(renewed)).operationalAllowed, true);
      await expectLater(
        s.importPackage(await package()),
        throwsA(isA<LicenseException>()),
      );
      await expectLater(
        s.importPackage(
          await package(
            l: {
              ...license(epoch: 2, trial: false, expiry: null),
              'maxDevices': 4,
            },
            m: membership(epoch: 2, entitlementEpoch: 2),
          ),
        ),
        throwsA(isA<LicenseException>()),
      );
    },
  );
  test(
    'disabled employee remains separate from active business entitlement',
    () async {
      final security = MemorySecurity();
      final s = session(security);
      final state = await s.importPackage(
        await package(m: membership(enabled: false)),
      );
      expect(state.code, 'disabled');
      expect(state.operationalAllowed, false);
      expect(state.license!.expiresAtMs, start + trialDurationMs);
    },
  );
  test(
    'failed secure persistence does not report activation success',
    () async {
      final security = MemorySecurity()..failWrites = true;
      final s = session(security);
      await expectLater(
        s.importPackage(await package()),
        throwsA(isA<FileSystemException>()),
      );
      expect(s.exportPackage(), null);
    },
  );
  test('concurrent old check and renewal serialize without restoring an old package', () async {
    final security = MemorySecurity();
    final s = session(security);
    await s.importPackage(await package());
    final next = await package(
      l: license(epoch: 2, trial: false, expiry: null),
      m: membership(epoch: 2, entitlementEpoch: 2),
    );
    await Future.wait([s.check(), s.importPackage(next), s.check()]);
    final restored = session(security);
    await restored.initialize();
    expect(restored.verifiedPackage!.license.epoch, 2);
  });
  test(
    'old package reimport cannot erase wall rollback before reboot',
    () async {
      final security = MemorySecurity();
      final s = session(security);
      final input = await package();
      await s.importPackage(input);
      security.clock = const ClockSample(
        wallMs: start - 86400000,
        elapsedMs: 11000,
        bootCount: 1,
      );
      expect((await s.importPackage(input)).operationalAllowed, true);
      security.clock = const ClockSample(
        wallMs: start - 86400000 + 1000,
        elapsedMs: 500,
        bootCount: 2,
      );
      expect((await s.check()).code, 'clock');
      final fresh = await package(
        m: membership(epoch: 2, issued: start + 20000),
      );
      expect((await s.importPackage(fresh)).code, 'clock');
      // Only an authenticated fresh bootstrap can repair rollback.
      expect(
        (await s.importPackage(fresh, trustedOnline: true)).operationalAllowed,
        true,
      );
    },
  );
  test('fresh delayed offline package uses the later wall reference and does not restart trial', () async {
    final security = MemorySecurity()
      ..clock = const ClockSample(
        wallMs: start + trialDurationMs,
        elapsedMs: 1000,
        bootCount: 1,
      );
    expect(
      (await session(security).importPackage(await package())).code,
      'expired',
    );
  });
  test('authoritative account disable survives restart and offline activation until trusted recheck', () async {
    final security = MemorySecurity();
    final s = session(security);
    final input = await package();
    await s.importPackage(input);
    expect((await s.recordAccountDisabled()).code, 'account_disabled');
    expect((await session(security).initialize()).code, 'account_disabled');
    expect((await s.importPackage(input)).code, 'account_disabled');
    expect(
      (await s.importPackage(input, trustedOnline: true)).operationalAllowed,
      true,
    );
  });
  test('paid activation survives restart and redeems before stale trial bootstrap import', () async {
    final security = MemorySecurity();
    final s = session(security);
    final manager = membership(uid: 'employee-a', role: 'manager');
    await s.importPackage(await package(m: manager), trustedOnline: true);
    final paid = await package(
      l: license(epoch: 2, trial: false, expiry: null),
      m: membership(role: 'manager', epoch: 3, entitlementEpoch: 2),
    );
    await s.importPackage(paid);
    final reopened = session(security);
    await reopened.initialize();
    expect(reopened.pendingTenantActivation, isNotNull);
    var bootstraps = 0, activations = 0;
    final status = await synchronizeLicense(
      session: reopened,
      bootstrap: () async {
        bootstraps++;
        if (bootstraps == 1) {
          return package(m: membership(role: 'manager', epoch: 2));
        }
        return package(
          l: license(epoch: 2, trial: false, expiry: null),
          m: membership(role: 'manager', epoch: 4, entitlementEpoch: 2),
        );
      },
      activate: (value) async {
        activations++;
        expect(jsonDecode(value), jsonDecode(paid));
      },
    );
    expect(status.operationalAllowed, true);
    expect(activations, 1);
    expect(bootstraps, 2);
    expect(reopened.pendingTenantActivation, isNull);
    final after = session(security);
    await after.initialize();
    expect(after.pendingTenantActivation, isNull);
  });
  test('activation disconnect retains signed pending package and local entitlement', () async {
    final security = MemorySecurity();
    final s = session(security);
    await s.importPackage(
      await package(
        l: license(epoch: 2, trial: false, expiry: null),
        m: membership(role: 'manager', epoch: 3, entitlementEpoch: 2),
      ),
    );
    await expectLater(
      synchronizeLicense(
        session: s,
        bootstrap: () => package(m: membership(role: 'manager', epoch: 2)),
        activate: (_) async {
          throw const SocketException('Synthetic disconnected server');
        },
      ),
      throwsA(isA<SocketException>()),
    );
    expect(s.pendingTenantActivation, isNotNull);
    expect((await s.check()).operationalAllowed, true);
    final after = session(security);
    await after.initialize();
    expect(after.pendingTenantActivation, isNotNull);
  });
  test('signed disable from older server entitlement overrides unredeemed paid package', () async {
    final security = MemorySecurity();
    final s = session(security);
    await s.importPackage(
      await package(
        l: license(epoch: 2, trial: false, expiry: null),
        m: membership(role: 'manager', epoch: 3, entitlementEpoch: 2),
      ),
    );
    var activations = 0;
    final result = await synchronizeLicense(
      session: s,
      bootstrap: () =>
          package(m: membership(role: 'manager', epoch: 4, enabled: false)),
      activate: (_) async {
        activations++;
      },
    );
    expect(result.operationalAllowed, false);
    expect(activations, 0);
    expect((await session(security).initialize()).operationalAllowed, false);
    expect(s.pendingTenantActivation, isNotNull);
  });
  test('employee offline renewal keeps authentic newer entitlement until manager redeems', () async {
    final security = MemorySecurity();
    final s = session(security);
    await s.importPackage(
      await package(
        l: license(epoch: 2, trial: false, expiry: null),
        m: membership(epoch: 3, entitlementEpoch: 2),
      ),
    );
    expect(s.pendingTenantActivation, isNull);
    var activations = 0;
    final result = await synchronizeLicense(
      session: s,
      bootstrap: () => package(m: membership(epoch: 4)),
      activate: (_) async {
        activations++;
      },
    );
    expect(result.operationalAllowed, true);
    expect(result.license!.epoch, 2);
    expect(activations, 0);
  });
  test('live signed role change locks the old local store before any activation or ledger sync', () async {
    final security = MemorySecurity();
    final s = session(security);
    await s.importPackage(await package(m: membership(role: 'manager')));
    var activated = false;
    final status = await synchronizeLicense(
      session: s,
      bootstrap: () => package(m: membership(role: 'employee', epoch: 2)),
      activate: (_) async {
        activated = true;
      },
    );
    expect(status.operationalAllowed, false);
    expect(activated, false);
    expect((await session(security).initialize()).operationalAllowed, false);
  });
  test('an older redemption cannot clear a newer package imported while activation is in flight', () async {
    final security = MemorySecurity();
    final s = session(security);
    final first = await package(
      l: license(epoch: 2, trial: false, expiry: null),
      m: membership(role: 'manager', epoch: 3, entitlementEpoch: 2),
    );
    final newer = await package(
      l: license(epoch: 3, trial: false, expiry: null),
      m: membership(role: 'manager', epoch: 4, entitlementEpoch: 3),
    );
    await s.importPackage(first);
    var bootstraps = 0;
    await synchronizeLicense(
      session: s,
      bootstrap: () {
        bootstraps++;
        return bootstraps == 1
            ? package(m: membership(role: 'manager', epoch: 2))
            : Future.value(newer);
      },
      activate: (_) async {
        await s.importPackage(newer);
      },
    );
    expect(jsonDecode(s.pendingTenantActivation!), jsonDecode(newer));
    final restored = session(security);
    await restored.initialize();
    expect(jsonDecode(restored.pendingTenantActivation!), jsonDecode(newer));
    expect(restored.verifiedPackage!.license.epoch, 3);
  });
  group('trusted monotonic time', () {
    const anchor = TrustedClockCheckpoint(
      acceptedMs: start,
      wallMs: start,
      elapsedMs: 1000,
      bootCount: 1,
    );
    test('timezone and wall-clock changes do not change elapsed validity inside boot', () {
      final result = TrustedClock.advance(
        anchor,
        const ClockSample(
          wallMs: start - 86400000,
          elapsedMs: 2000,
          bootCount: 1,
        ),
      );
      expect(result.nowMs, start + 1000);
      expect(result.requiresTrustedTime, false);
      expect(result.wallRollback, true);
    });
    test('sane restart carries accepted elapsed wall time forward', () {
      final result = TrustedClock.advance(
        anchor,
        const ClockSample(
          wallMs: start + 86400000,
          elapsedMs: 500,
          bootCount: 2,
        ),
      );
      expect(result.nowMs, start + 86400000);
      expect(result.requiresTrustedTime, false);
    });
    test(
      'rollback after reboot and missing boot counter require trusted time',
      () {
        for (final sample in [
          const ClockSample(wallMs: start - 5000, elapsedMs: 500, bootCount: 2),
          const ClockSample(wallMs: start, elapsedMs: 500, bootCount: -1),
        ]) {
          expect(
            TrustedClock.advance(anchor, sample).requiresTrustedTime,
            true,
          );
        }
      },
    );
    test('rollback in same boot stays detectable if user reboots', () {
      final first = TrustedClock.advance(
        anchor,
        const ClockSample(
          wallMs: start - 86400000,
          elapsedMs: 11000,
          bootCount: 1,
        ),
      );
      final reboot = TrustedClock.advance(
        first.checkpoint,
        const ClockSample(
          wallMs: start - 86400000 + 1000,
          elapsedMs: 500,
          bootCount: 2,
        ),
      );
      expect(reboot.requiresTrustedTime, true);
    });
    test('replayed signed timestamp cannot repair rollback; a new signed response can', () {
      const sample = ClockSample(
        wallMs: start - 5000,
        elapsedMs: 500,
        bootCount: 2,
      );
      expect(
        TrustedClock.anchor(
          start,
          sample,
          previous: anchor,
        ).requiresTrustedTime,
        true,
      );
      final refreshed = TrustedClock.anchor(
        start + 10000,
        sample,
        previous: anchor,
        authenticatedFreshTime: true,
      );
      expect(refreshed.requiresTrustedTime, false);
      expect(refreshed.nowMs, start + 10000);
    });
    test('fresh trusted reboot recovery preserves an equal or later high-water mark', () {
      const sample = ClockSample(
        wallMs: start - 5000,
        elapsedMs: 500,
        bootCount: 2,
      );
      for (final signedTime in [start, start - 1000]) {
        final result = TrustedClock.anchor(
          signedTime,
          sample,
          previous: anchor,
          authenticatedFreshTime: true,
        );
        expect(result.requiresTrustedTime, false);
        expect(result.nowMs, start);
        final continued = TrustedClock.advance(
          result.checkpoint,
          const ClockSample(
            wallMs: start - 4000,
            elapsedMs: 1500,
            bootCount: 2,
          ),
        );
        expect(continued.nowMs, start + 1000);
        expect(continued.requiresTrustedTime, false);
      }
    });
  });
}
