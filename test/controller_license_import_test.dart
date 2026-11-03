import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart' hide canonicalJson;
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';

import 'controller_test.dart' as support;

class FaultMemorySecurity extends support.MemorySecurity {
  int writes = 0;
  int? failOnWrite;
  @override
  Future<void> writeSecureValue(String scope, String value) async {
    writes++;
    if (writes == failOnWrite) {
      throw StateError('synthetic secure-storage failure');
    }
    await super.writeSecureValue(scope, value);
  }
}

void main() {
  final algorithm = Ed25519();
  late SimpleKeyPair issuer;
  late LicenseVerifier verifier;
  late Directory directory;
  late FaultMemorySecurity security;
  late AppController app;
  late LedgerStore originalHandle;

  Future<Map<String, dynamic>> envelope(Map<String, dynamic> value) async {
    final raw = utf8.encode(canonicalJson(value));
    final signature = await algorithm.sign(raw, keyPair: issuer);
    return {
      'kid': 'isolated-import-test',
      'payload': base64UrlEncode(raw).replaceAll('=', ''),
      'signature': base64UrlEncode(signature.bytes).replaceAll('=', ''),
    };
  }

  Future<String> package({
    bool enabled = true,
    String role = 'manager',
    int epoch = 1,
  }) async => jsonEncode({
    'version': 1,
    'entitlement': await envelope({
      'type': 'entitlement',
      'version': 1,
      'tenantId': 'tenant',
      'licenseId': 'synthetic-license',
      'epoch': 1,
      'issuedAtMs': support.referenceTime,
      'notBeforeMs': support.referenceTime,
      'expiresAtMs': support.referenceTime + trialDurationMs,
      'trialStartMs': support.referenceTime,
      'trial': true,
      'maxDevices': 2,
    }),
    'membership': await envelope({
      'type': 'membership',
      'version': 1,
      'tenantId': 'tenant',
      'uid': 'manager',
      'deviceId': 'device-test',
      'role': role,
      'epoch': epoch,
      'entitlementEpoch': 1,
      'issuedAtMs': support.referenceTime,
      'expiresAtMs': null,
      'enabled': enabled,
    }),
  });

  setUpAll(() async {
    sqfliteFfiInit();
    issuer = await algorithm.newKeyPair();
    final public = await issuer.extractPublicKey();
    verifier = LicenseVerifier({
      'isolated-import-test': base64UrlEncode(public.bytes).replaceAll('=', ''),
    });
  });
  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'strawberry_import_revocation_',
    );
    security = FaultMemorySecurity();
    final gateway = support.ControlledGateway(
      () async => throw const SocketException('synthetic offline bootstrap'),
    );
    app = AppController(
      security: security,
      gateway: gateway,
      verifier: verifier,
    );
    app.identity = const InstallationIdentity(
      deviceId: 'device-test',
      publicKeySpki: 'synthetic-public-identity',
    );
    final session = LicenseSession(
      security: security,
      verifier: verifier,
      tenantId: 'tenant',
      uid: 'manager',
      deviceId: 'device-test',
    );
    await session.initialize();
    app.license = await session.importPackage(
      await package(),
      trustedOnline: true,
    );
    app.licenseSession = session;
    app.tenantId = 'tenant';
    app.uid = 'manager';
    app.loading = false;
    originalHandle = await LedgerStore.open(
      path: '${directory.path}/ledger.db',
      tenantId: 'tenant',
      userId: 'manager',
      factory: databaseFactoryFfi,
    );
    app.store = originalHandle;
    await originalHandle.saveEntry(
      LedgerEntry(
        id: 'durable_pending',
        tenantId: 'tenant',
        creatorUid: 'manager',
        kind: 'expense_business',
        date: '2026-10-01',
        totalMinor: 1250,
        paidMinor: 1250,
        category: 'نقل',
      ),
    );
    await originalHandle.saveDraft('durable_draft', {
      'id': 'durable_draft',
      'tenantId': 'tenant',
      'creatorUid': 'manager',
      'note': 'مسودة محفوظة',
    });
    await app.refresh();
    expect(app.entries.single.id, 'durable_pending');
  });
  tearDown(() async {
    await app.waitForSync();
    await app.store?.close();
    app.store = null;
    app.dispose();
    await directory.delete(recursive: true);
  });

  test('signed offline disable clears exposed data and revokes cached handles while preserving disk queue', () async {
    await app.importLicense(await package(enabled: false, epoch: 2));
    await app.waitForSync();
    expect(app.hasDataAccess, isFalse);
    expect(app.entries, isEmpty);
    expect(app.pending, isEmpty);
    await expectLater(
      originalHandle.listEntries(),
      throwsA(isA<LedgerException>()),
    );
    await originalHandle.close();
    app.store = null;
    final reopened = await LedgerStore.open(
      path: '${directory.path}/ledger.db',
      tenantId: 'tenant',
      userId: 'manager',
      factory: databaseFactoryFfi,
    );
    try {
      final pending = (await reopened.listOutbox()).single;
      expect(pending.id, 'durable_pending');
      expect(pending.attempts, 0);
      expect(pending.status, 'pending');
      expect((await reopened.listDrafts()).single['id'], 'durable_draft');
    } finally {
      await reopened.close();
    }
  });

  test('signed offline role change cannot keep a manager database open with an operational employee certificate', () async {
    final before = canonicalJson({
      'operation': (await originalHandle.listOutbox()).single.toOperation(),
      'drafts': await originalHandle.listDrafts(),
    });
    await app.importLicense(await package(role: 'employee', epoch: 2));
    await app.waitForSync();
    expect(app.license!.code, 'account_disabled');
    expect(app.hasDataAccess, isFalse);
    expect(app.entries, isEmpty);
    expect(app.pending, isEmpty);
    expect(
      app.allowed && app.store!.role != app.license!.role,
      isFalse,
      reason: 'A changed signed role must invalidate the old-role store before it can remain operational.',
    );
    await expectLater(
      originalHandle.exportPendingBackup(),
      throwsA(isA<LedgerException>()),
    );
    await expectLater(
      app.importLicense(await package(epoch: 1)),
      throwsA(isA<LicenseException>()),
    );
    expect(app.hasDataAccess, isFalse);
    // Even a newer authentic offline manager file cannot clear the persisted
    // role-change quarantine; only a fresh authenticated response can do that.
    await app.importLicense(await package(epoch: 3));
    await app.waitForSync();
    expect(app.license!.code, 'account_disabled');
    final persisted = LicenseSession(
      security: security,
      verifier: verifier,
      tenantId: 'tenant',
      uid: 'manager',
      deviceId: 'device-test',
    );
    expect((await persisted.initialize()).code, 'account_disabled');
    expect(
      (await persisted.importPackage(
        await package(role: 'employee', epoch: 4),
        trustedOnline: true,
      )).code,
      'account_disabled',
    );
    expect(
      (await persisted.importPackage(
        await package(enabled: false, epoch: 4),
        trustedOnline: true,
      )).code,
      'account_disabled',
    );
    expect(
      (await persisted.importPackage(
        await package(epoch: 4),
        trustedOnline: true,
      )).operationalAllowed,
      isTrue,
    );
    // Authenticated same-role recovery can create a new scoped handle; the
    // invalidated old handle remains unusable and disk facts remain identical.
    await originalHandle.close();
    app.store = null;
    final reopened = await LedgerStore.open(
      path: '${directory.path}/ledger.db',
      tenantId: 'tenant',
      userId: 'manager',
      factory: databaseFactoryFfi,
    );
    try {
      expect(
        canonicalJson({
          'operation': (await reopened.listOutbox()).single.toOperation(),
          'drafts': await reopened.listDrafts(),
        }),
        before,
      );
    } finally {
      await reopened.close();
    }
  });

  test('failed secure quarantine write cannot leave old-role handles or exposed financial data usable', () async {
    // The incoming package and its trusted-clock check persist first; failure
    // occurs specifically while recording the role-change quarantine flag.
    security.failOnWrite = security.writes + 3;
    await expectLater(
      app.importLicense(await package(role: 'employee', epoch: 2)),
      throwsA(isA<StateError>()),
    );
    expect(app.hasDataAccess, isFalse);
    expect(app.entries, isEmpty);
    expect(app.pending, isEmpty);
    await expectLater(
      originalHandle.listEntries(),
      throwsA(isA<LedgerException>()),
    );
  });
}
