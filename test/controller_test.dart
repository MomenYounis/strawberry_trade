import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart' hide canonicalJson;
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/services/gateway.dart';

const referenceTime = 1700000000000;

class MemorySecurity extends DeviceSecurity {
  final values = <String, String>{};
  ClockSample clock = const ClockSample(
    wallMs: referenceTime,
    elapsedMs: 1000,
    bootCount: 1,
  );
  @override
  Future<String?> readSecureValue(String scope) async => values[scope];
  @override
  Future<void> writeSecureValue(String scope, String value) async {
    values[scope] = value;
  }

  @override
  Future<ClockSample> platformClock() async => clock;

  void advance(int durationMs) {
    clock = ClockSample(
      wallMs: clock.wallMs + durationMs,
      elapsedMs: clock.elapsedMs + durationMs,
      bootCount: clock.bootCount,
    );
  }
}

/// Only the remote boundary is controlled. Controller coordination, signature
/// validation, license state, transactions and disk persistence are real.
class ControlledGateway implements SyncGateway {
  ControlledGateway(this.package);
  final Future<String> Function() package;
  Future<Map<String, dynamic>> Function(Map<String, dynamic>)? onSend;
  final sent = <Map<String, dynamic>>[];
  int bootstrapCalls = 0, pullCalls = 0, activations = 0;
  @override
  Future<Map<String, dynamic>> bootstrap(
    String tenantId,
    InstallationIdentity identity,
  ) async {
    bootstrapCalls++;
    return {'licensePackage': await package()};
  }

  @override
  Future<void> activateLicense(
    String tenantId,
    String deviceId,
    String package,
  ) async {
    activations++;
  }

  @override
  Future<Map<String, dynamic>> send(
    String tenantId,
    String deviceId,
    Map<String, dynamic> operation,
  ) async {
    final captured = <String, dynamic>{
      'tenantId': tenantId,
      'deviceId': deviceId,
      'operation': jsonDecode(jsonEncode(operation)),
    };
    sent.add(captured);
    return onSend == null
        ? {'id': operation['id'], 'status': 'accepted'}
        : onSend!(captured);
  }

  @override
  Future<Map<String, dynamic>> pull(
    String tenantId,
    String deviceId,
    int afterSequence,
  ) async {
    pullCalls++;
    return {
      'changes': <dynamic>[],
      'lastSequence': afterSequence,
      'hasMore': false,
    };
  }
}

void main() {
  final algorithm = Ed25519();
  late SimpleKeyPair issuer;
  late LicenseVerifier verifier;
  late Directory directory;
  late MemorySecurity security;
  late ControlledGateway gateway;
  late AppController app;
  var membershipEpoch = 0;
  var paid = false;
  var disabled = false;

  Future<Map<String, dynamic>> envelope(Map<String, dynamic> payload) async {
    final bytes = utf8.encode(canonicalJson(payload));
    final signature = await algorithm.sign(bytes, keyPair: issuer);
    return {
      'kid': 'controller-test-only',
      'payload': base64UrlEncode(bytes).replaceAll('=', ''),
      'signature': base64UrlEncode(signature.bytes).replaceAll('=', ''),
    };
  }

  Future<String> package({required String tenant, required String uid}) async {
    final epoch = paid ? 2 : 1;
    return jsonEncode({
      'version': 1,
      'entitlement': await envelope({
        'type': 'entitlement',
        'version': 1,
        'tenantId': tenant,
        'licenseId': 'license-$epoch',
        'epoch': epoch,
        'issuedAtMs': referenceTime,
        'notBeforeMs': referenceTime,
        'expiresAtMs': paid ? null : referenceTime + trialDurationMs,
        'trialStartMs': paid ? null : referenceTime,
        'trial': !paid,
        'maxDevices': 2,
      }),
      'membership': await envelope({
        'type': 'membership',
        'version': 1,
        'tenantId': tenant,
        'uid': uid,
        'deviceId': 'device-test',
        'role': 'manager',
        'epoch': ++membershipEpoch,
        'entitlementEpoch': epoch,
        'issuedAtMs': security.clock.wallMs,
        'expiresAtMs': null,
        'enabled': !disabled,
      }),
    });
  }

  Future<LedgerStore> open(String tenant, String uid) => LedgerStore.open(
    path: '${directory.path}/$tenant-$uid.db',
    tenantId: tenant,
    userId: uid,
    factory: databaseFactoryFfi,
  );

  Future<void> attach({String tenant = 't1', String uid = 'u1'}) async {
    final session = LicenseSession(
      security: security,
      verifier: verifier,
      tenantId: tenant,
      uid: uid,
      deviceId: 'device-test',
    );
    await session.initialize();
    app.license = await session.importPackage(
      await package(tenant: tenant, uid: uid),
      trustedOnline: true,
    );
    app.tenantId = tenant;
    app.uid = uid;
    app.licenseSession = session;
    app.store = await open(tenant, uid);
    app.loading = false;
    await app.refresh();
  }

  LedgerEntry expense(String id) => LedgerEntry(
    id: id,
    tenantId: app.tenantId,
    creatorUid: app.uid,
    kind: 'expense_business',
    date: '2026-10-01',
    totalMinor: 1250,
    paidMinor: 1250,
    category: 'نقل',
    note: 'عملية مرجعية لاختبار المزامنة',
  );

  setUpAll(() async {
    sqfliteFfiInit();
    issuer = await algorithm.newKeyPair();
    final public = await issuer.extractPublicKey();
    verifier = LicenseVerifier({
      'controller-test-only': base64UrlEncode(public.bytes).replaceAll('=', ''),
    });
  });
  setUp(() async {
    directory = await Directory.systemTemp.createTemp('strawberry_controller_');
    security = MemorySecurity();
    membershipEpoch = 0;
    paid = false;
    disabled = false;
    gateway = ControlledGateway(
      () => package(tenant: app.tenantId, uid: app.uid),
    );
    app = AppController(
      security: security,
      gateway: gateway,
      verifier: verifier,
    );
    app.identity = const InstallationIdentity(
      deviceId: 'device-test',
      publicKeySpki: 'test-transport-does-not-enroll-device',
    );
    await attach();
  });
  tearDown(() async {
    await app.store?.close();
    app.store = null;
    app.dispose();
    await directory.delete(recursive: true);
  });

  test('failed transmission preserves stable payload and retry metadata across disk reopen', () async {
    final entry = expense('durable-failed-send');
    await app.store!.saveEntry(entry);
    gateway.onSend = (_) async => throw const SocketException('synthetic loss');
    await app.synchronize();
    final failed = (await app.store!.listOutbox()).single;
    expect(failed.id, entry.id);
    expect(failed.status, 'retry');
    expect(failed.attempts, 1);
    expect(failed.nextAttemptMs, greaterThan(0));
    expect(failed.payload, entry.toJson());
    expect(app.license!.operationalAllowed, true);
    final retryAt = failed.nextAttemptMs;
    await app.store!.close();
    app.store = await open('t1', 'u1');
    final reopened = (await app.store!.listOutbox()).single;
    expect(reopened.id, entry.id);
    expect(reopened.attempts, 1);
    expect(reopened.nextAttemptMs, retryAt);
    expect(reopened.payload, entry.toJson());
    gateway.onSend = null;
    await app.store!.retry(entry.id);
    await app.synchronize();
    expect(await app.store!.listOutbox(), isEmpty);
    expect(await app.store!.entryState(entry.id), 'server_accepted');
    expect(gateway.sent.map((call) => (call['operation'] as Map)['id']), [
      entry.id,
      entry.id,
    ]);
    expect(gateway.sent[0]['operation'], gateway.sent[1]['operation']);
  });

  test(
    'overlapping synchronization triggers use one sender and acknowledge once',
    () async {
      final entry = expense('single-coordinator');
      await app.store!.saveEntry(entry);
      final entered = Completer<void>();
      final response = Completer<Map<String, dynamic>>();
      gateway.onSend = (_) {
        if (!entered.isCompleted) entered.complete();
        return response.future;
      };
      final first = app.synchronize();
      await entered.future;
      await Future.wait([app.synchronize(), app.synchronize()]);
      expect(gateway.bootstrapCalls, 1);
      expect(gateway.sent.length, 1);
      expect(app.syncing, true);
      response.complete({'id': entry.id, 'status': 'accepted'});
      await first;
      expect(app.syncing, false);
      expect(await app.store!.listOutbox(), isEmpty);
      expect((await app.store!.listEntries()).single.id, entry.id);
    },
  );

  test('late acknowledgment after sign-out cannot modify another tenant with the same operation ID', () async {
    const id = 'same-id-in-independent-tenants';
    await app.store!.saveEntry(expense(id));
    final entered = Completer<void>();
    final response = Completer<Map<String, dynamic>>();
    gateway.onSend = (_) {
      entered.complete();
      return response.future;
    };
    final oldSync = app.synchronize();
    await entered.future;
    await app.signOut();
    await attach(tenant: 't2', uid: 'u2');
    await app.store!.saveEntry(expense(id));
    response.complete({'id': id, 'status': 'accepted'});
    await oldSync;
    expect((await app.store!.listOutbox()).single.id, id);
    expect(await app.store!.entryState(id), 'pending');
    final old = await open('t1', 'u1');
    try {
      expect((await old.listOutbox()).single.id, id);
      expect(await old.entryState(id), 'pending');
    } finally {
      await old.close();
    }
    expect(app.tenantId, 't2');
    expect(app.uid, 'u2');
  });

  test('disposing during a delayed send preserves the pending disk operation and ignores its late acknowledgment', () async {
    final entry = expense('disposed-during-delayed-send');
    final originalStore = app.store!;
    await originalStore.saveEntry(entry);
    final before = (await originalStore.listOutbox()).single;
    final entered = Completer<void>();
    final response = Completer<Map<String, dynamic>>();
    var notifications = 0;
    app.addListener(() => notifications++);
    gateway.onSend = (_) {
      entered.complete();
      return response.future;
    };
    final sending = app.synchronize();
    await entered.future;
    expect(gateway.sent.length, 1);
    final notificationsAtDisposal = notifications;

    // Riverpod or a route teardown can dispose while the remote response is
    // outstanding. Closing twice is harmless and must not erase its queue.
    app.dispose();
    app.dispose();
    await expectLater(
      originalStore.listOutbox(),
      throwsA(isA<LedgerException>()),
    );
    response.complete({'id': entry.id, 'status': 'accepted'});
    await sending;
    expect(gateway.pullCalls, 0);
    expect(notifications, notificationsAtDisposal);

    final reopened = await open('t1', 'u1');
    try {
      final retained = (await reopened.listOutbox()).single;
      expect(retained.id, before.id);
      expect(retained.payload, before.payload);
      expect(retained.status, 'pending');
      expect(retained.attempts, before.attempts);
      expect(retained.nextAttemptMs, before.nextAttemptMs);
      expect(await reopened.entryState(entry.id), 'pending');
      expect((await reopened.listEntries()).single.toJson(), entry.toJson());
    } finally {
      await reopened.close();
    }
    // Await a task turn before leaving the test. Any uncaught asynchronous
    // database-close error or disposed notifier callback fails the test zone.
    await Future<void>.delayed(Duration.zero);
  });

  test('known expiry retains the queue and renewal sends the original operation exactly once', () async {
    final entry = expense('queued-before-expiry');
    await app.store!.saveEntry(entry);
    security.advance(trialDurationMs);
    await app.synchronize();
    expect(app.license!.code, 'expired');
    expect(gateway.sent, isEmpty);
    expect((await app.store!.listOutbox()).single.id, entry.id);
    paid = true;
    app.license = await app.licenseSession!.importPackage(
      await package(tenant: 't1', uid: 'u1'),
    );
    await app.synchronize();
    expect(app.license!.operationalAllowed, true);
    expect(gateway.activations, 1);
    expect(app.licenseSession!.pendingTenantActivation, isNull);
    expect(await app.store!.listOutbox(), isEmpty);
    expect((gateway.sent.single['operation'] as Map)['id'], entry.id);
    expect((await app.store!.listEntries()).single.toJson(), entry.toJson());
  });

  test('explicit Auth account disable also clears cached data and invalidates stale storage access', () async {
    final entry = expense('auth-disabled-preservation');
    await app.store!.saveEntry(entry);
    await app.refresh();
    final staleStore = app.store!;
    gateway.onSend = (_) async =>
        throw FirebaseAuthException(code: 'user-disabled');
    await app.synchronize();
    expect(app.license!.code, 'account_disabled');
    expect(app.entries, isEmpty);
    expect(app.pending, isEmpty);
    await expectLater(
      staleStore.listEntries(),
      throwsA(isA<LedgerException>()),
    );
    final retained = await open('t1', 'u1');
    try {
      expect((await retained.listOutbox()).single.id, entry.id);
    } finally {
      await retained.close();
    }
  });
  test('ordinary auth-token expiry preserves offline authority and the original queued operation', () async {
    final entry = expense('token-expired-preservation');
    await app.store!.saveEntry(entry);
    gateway.onSend = (_) async =>
        throw FirebaseAuthException(code: 'user-token-expired');
    await app.synchronize();
    expect(app.license!.operationalAllowed, true);
    await app.requireAllowed();
    expect((await app.store!.listOutbox()).single.id, entry.id);
    expect((await app.store!.listEntries()).single.toJson(), entry.toJson());
  });
  test('a server authorization denial blocks the retained operation using its machine reason', () async {
    final entry = expense('permission-denied-preservation');
    await app.store!.saveEntry(entry);
    gateway.onSend = (_) async => throw FirebaseFunctionsException(
      code: 'failed-precondition',
      message: 'synthetic authorization rejection',
      details: {'reason': 'permission-denied'},
    );
    await app.synchronize();
    final blocked = (await app.store!.listOutbox()).single;
    expect(blocked.id, entry.id);
    expect(blocked.status, 'blocked');
    expect(blocked.error, 'permission-denied');
    expect(blocked.payload, entry.toJson());
    await app.synchronize();
    expect(gateway.sent.length, 1);
  });
  test('renewal automatically resumes a server-expiry block with the preserved operation ID', () async {
    final entry = expense('server-expired-before-ack');
    await app.store!.saveEntry(entry);
    gateway.onSend = (_) async => throw FirebaseFunctionsException(
      code: 'failed-precondition',
      message: 'synthetic expiry during transmission',
      details: {'reason': 'license-expired'},
    );
    await app.synchronize();
    expect((await app.store!.listOutbox()).single.status, 'blocked');
    paid = true;
    app.license = await app.licenseSession!.importPackage(
      await package(tenant: 't1', uid: 'u1'),
    );
    gateway.onSend = null;
    await app.synchronize();
    expect(await app.store!.listOutbox(), isEmpty);
    expect(gateway.sent.length, 2);
    expect(gateway.sent[0]['operation'], gateway.sent[1]['operation']);
    expect(await app.store!.entryState(entry.id), 'server_accepted');
  });
  test('a timed-out acknowledgment retains the same ID and clears only on a valid retry response', () async {
    final entry = expense('timed-out-acknowledgment');
    await app.store!.saveEntry(entry);
    gateway.onSend = (_) async => throw FirebaseFunctionsException(
      code: 'deadline-exceeded',
      message: 'synthetic response lost after send',
      details: null,
    );
    await app.synchronize();
    expect(app.syncing, false);
    expect((await app.store!.listOutbox()).single.id, entry.id);
    expect((await app.store!.listOutbox()).single.error, 'deadline-exceeded');
    gateway.onSend = null;
    await app.store!.retry(entry.id);
    await app.synchronize();
    expect(await app.store!.listOutbox(), isEmpty);
    expect(gateway.sent[0]['operation'], gateway.sent[1]['operation']);
    expect((await app.store!.listEntries()).length, 1);
  });
  test('an unrecognized send response cannot acknowledge and discard a durable operation', () async {
    final entry = expense('invalid-server-response');
    await app.store!.saveEntry(entry);
    for (final invalid in [
      {'id': entry.id, 'status': 'unknown'},
      {'id': 'another-operation', 'status': 'accepted'},
      {'id': entry.id, 'status': 'awaiting_approval'},
    ]) {
      gateway.onSend = (_) async => invalid;
      await app.store!.retry(entry.id);
      await app.synchronize();
      expect((await app.store!.listOutbox()).single.id, entry.id);
      expect(await app.store!.entryState(entry.id), isNot('server_accepted'));
    }
  });
  test('a signed live revocation clears exposed data and invalidates stale store handles without deleting the queue', () async {
    final entry = expense('preserve-on-revocation');
    await app.store!.saveEntry(entry);
    await app.refresh();
    expect(app.entries.single.id, entry.id);
    expect(app.pending.single['id'], entry.id);
    final staleStore = app.store!;
    disabled = true;
    await app.synchronize();
    expect(app.license!.operationalAllowed, false);
    expect(app.entries, isEmpty);
    expect(app.parties, isEmpty);
    expect(app.employees, isEmpty);
    expect(app.terms, isEmpty);
    expect(app.pending, isEmpty);
    expect(app.submissions, isEmpty);
    expect(gateway.sent, isEmpty);
    await expectLater(
      staleStore.listEntries(),
      throwsA(isA<LedgerException>()),
    );
    await expectLater(
      staleStore.exportBackup(),
      throwsA(isA<LedgerException>()),
    );
    // Reopening for this storage assertion does not grant controller authority;
    // the persisted license remains disabled and the UI remains empty.
    final retained = await open('t1', 'u1');
    try {
      expect((await retained.listOutbox()).single.id, entry.id);
      expect((await retained.listEntries()).single.id, entry.id);
    } finally {
      await retained.close();
    }
  });
}
