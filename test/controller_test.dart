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
import 'package:strawberry_trade/services/active_snapshot.dart';
import 'package:strawberry_trade/services/active_snapshot_gateway.dart';
import 'package:strawberry_trade/services/sync_protocol.dart';

import 'active_snapshot_test.dart' as snapshots;

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
class ControlledGateway implements SyncGateway, ActiveSnapshotGateway {
  ControlledGateway(this.package);
  final Future<String> Function() package;
  Future<Map<String, dynamic>> Function(Map<String, dynamic>)? onSend;
  Future<void> Function()? beforeBootstrap;
  Future<Map<String, dynamic>> Function(int)? onPull;
  Future<Map<String, dynamic>> Function(String, String)? onGetSnapshot;
  Future<Map<String, dynamic>> Function(Map<String, dynamic>)?
  onReadSnapshotPage;
  final snapshotPageRequests = <Map<String, dynamic>>[];
  int snapshotHeaderCalls = 0;
  @override
  Future<Map<String, dynamic>> getActiveSnapshot(
    String tenantId,
    String deviceId,
  ) async {
    snapshotHeaderCalls++;
    if (onGetSnapshot == null) {
      throw const LedgerException(
        'snapshot-unavailable',
        'Synthetic snapshot unavailable',
      );
    }
    return onGetSnapshot!(tenantId, deviceId);
  }

  @override
  Future<Map<String, dynamic>> readActiveSnapshotPage(
    String tenantId,
    String deviceId, {
    required String snapshotId,
    required int index,
    required String headerSha256,
  }) async {
    final request = {
      'tenantId': tenantId,
      'deviceId': deviceId,
      'snapshotId': snapshotId,
      'index': index,
      'headerSha256': headerSha256,
    };
    snapshotPageRequests.add(request);
    if (onReadSnapshotPage == null) {
      throw const LedgerException(
        'snapshot-unavailable',
        'Synthetic snapshot unavailable',
      );
    }
    return onReadSnapshotPage!(request);
  }

  final sent = <Map<String, dynamic>>[];
  int bootstrapCalls = 0, pullCalls = 0, activations = 0;
  @override
  Future<Map<String, dynamic>> bootstrap(
    String tenantId,
    InstallationIdentity identity,
  ) async {
    bootstrapCalls++;
    await beforeBootstrap?.call();
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
    if (onPull != null) return onPull!(afterSequence);
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
  test('unsupported authenticated bootstrap preserves the untouched durable queue before any send', () async {
    final entry = expense('future-protocol-bootstrap');
    await app.store!.saveEntry(entry);
    final before = (await app.store!.listOutbox()).single;
    gateway.beforeBootstrap = () async {
      negotiateSyncProtocol({
        'syncProtocolVersions': [3],
        'minimumSyncProtocol': 3,
      });
    };
    await app.synchronize();
    expect(gateway.sent, isEmpty);
    final after = (await app.store!.listOutbox()).single;
    expect(after.id, before.id);
    expect(after.payload, before.payload);
    expect(after.status, before.status);
    expect(after.attempts, before.attempts);
    expect(after.nextAttemptMs, before.nextAttemptMs);
    expect((await app.store!.listEntries()).single.toJson(), entry.toJson());
    gateway.beforeBootstrap = null;
    await app.synchronize();
    expect(await app.store!.listOutbox(), isEmpty);
    expect(gateway.sent.single['operation'], before.toOperation());
  });
  test('server protocol upgrade refusal blocks original bytes and resumes the same ID only after compatible retry', () async {
    final entry = expense('minimum-protocol-block');
    await app.store!.saveEntry(entry);
    final operation = (await app.store!.listOutbox()).single.toOperation();
    gateway.onSend = (_) async => throw FirebaseFunctionsException(
      code: 'failed-precondition',
      message: 'synthetic minimum protocol rejection',
      details: {'reason': 'sync-upgrade-required'},
    );
    await app.synchronize();
    final refused = (await app.store!.listOutbox()).single;
    expect(refused.id, entry.id);
    expect(refused.payload, entry.toJson());
    expect(refused.status, 'blocked');
    expect(refused.error, 'sync-upgrade-required');
    expect(refused.attempts, 1);
    await app.synchronize();
    expect(gateway.sent.length, 1);
    await app.store!.close();
    app.store = await open('t1', 'u1');
    expect((await app.store!.listOutbox()).single.toOperation(), operation);
    gateway.onSend = null;
    await app.store!.retry(entry.id);
    await app.synchronize();
    expect(await app.store!.listOutbox(), isEmpty);
    expect(gateway.sent[0]['operation'], operation);
    expect(gateway.sent[1]['operation'], operation);
    expect((await app.store!.listEntries()).single.toJson(), entry.toJson());
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
  test('closed-period staging is retained across reopen and excluded from financial reports', () async {
    final entry = expense('closed-old-expense');
    await app.store!.saveEntry(entry);
    gateway.onSend = (_) async => {
      'id': entry.id,
      'status': 'needs_review',
      'reason': 'closed-period',
    };
    await app.synchronize();
    expect((await app.store!.listOutbox()).single.status, 'blocked');
    expect((await app.store!.listOutbox()).single.payload, entry.toJson());
    expect(app.entries, isEmpty);
    expect(app.recentEntries.single.id, entry.id);
    expect(app.syncMessage, contains('لم تُقبل مالياً'));
    await app.store!.close();
    app.store = await open('t1', 'u1');
    await app.refresh();
    await app.synchronize();
    expect(app.entries, isEmpty);
    expect(gateway.sent.length, 1);
    await expectLater(
      app.store!.retry(entry.id),
      throwsA(isA<LedgerException>()),
    );
  });

  test('held historical salary evidence stays durable without changing active obligations', () async {
    await app.store!.applyRemote(
      'employee',
      const Employee(id: 'staff', tenantId: 't1', name: 'Synthetic').toJson(),
    );
    const term = SalaryTerm(
      id: 'held-term',
      tenantId: 't1',
      employeeId: 'staff',
      effectiveMonth: '2026-08',
      monthlyMinor: 100000,
    );
    await app.store!.saveSalaryTerm(term);
    gateway.onSend = (_) async => {
      'id': term.id,
      'status': 'needs_review',
      'reason': 'closed-period',
    };
    await app.synchronize();
    expect(app.terms, isEmpty);
    expect((await app.store!.listSalaryTerms()).single.toJson(), term.toJson());
    expect((await app.store!.listOutbox()).single.status, 'blocked');
    await app.synchronize();
    expect(gateway.sent.length, 1);
  });

  test('normal synchronization delivers the manager reason for a prospective salary correction', () async {
    await app.store!.applyRemote(
      'employee',
      const Employee(id: 'staff', tenantId: 't1', name: 'Synthetic').toJson(),
    );
    const original = SalaryTerm(
      id: 'held-salary-reason',
      tenantId: 't1',
      employeeId: 'staff',
      effectiveMonth: '2026-08',
      monthlyMinor: 100000,
    );
    await app.store!.saveSalaryTerm(original);
    await app.store!.fail(original.id, 'closed-period');
    final corrected = await app.store!.saveClosedPeriodCorrection(
      original.id,
      date: '2026-11-03',
      note: 'Manager reviewed original closed salary evidence',
    );
    await app.synchronize();
    final operation = gateway.sent.single['operation'] as Map;
    expect(operation['id'], corrected);
    expect(operation['correctionOfOperationId'], original.id);
    expect(
      operation['correctionReason'],
      'Manager reviewed original closed salary evidence',
    );
    expect(
      (operation['payload'] as Map).containsKey('correctionReason'),
      isFalse,
    );
    final retained = (await app.store!.listOutbox()).single;
    expect(retained.id, original.id);
    expect(retained.status, 'blocked');
    expect(app.terms.single.effectiveMonth, '2026-11');
  });

  test(
    'malformed and history-floor pages preserve cursor and unsent work',
    () async {
      await app.store!.setPreference('cursor', 20);
      final entry = expense('retained-outbox');
      await app.store!.saveEntry(entry);
      await app.store!.fail(entry.id, 'permission-denied');
      for (final response in [
        {'changes': <dynamic>[], 'lastSequence': 19, 'hasMore': false},
        {
          'changes': <dynamic>[],
          'lastSequence': 20,
          'hasMore': false,
          'historyFloor': 21,
        },
        {'status': 'resync_required'},
      ]) {
        gateway.onPull = (_) async => response;
        await app.synchronize();
        expect(await app.store!.preference('cursor'), 20);
        expect(await app.store!.preference('lastSyncMs'), isNull);
        expect((await app.store!.listOutbox()).single.id, entry.id);
        expect(app.syncMessage, isNot('اكتملت المزامنة مع الخادم'));
      }
    },
  );

  test(
    'bounded paging does not label unfinished history as synchronized',
    () async {
      gateway.onPull = (cursor) async => {
        'changes': [
          {
            'sequence': cursor + 1,
            'entity': 'party',
            'payload': Party(
              id: 'paged-${cursor + 1}',
              tenantId: 't1',
              name: 'طرف مرجعي',
              kind: 'merchant',
            ).toJson(),
          },
        ],
        'lastSequence': cursor + 1,
        'hasMore': true,
      };
      await app.synchronize();
      expect(gateway.pullCalls, 200);
      expect(await app.store!.preference('cursor'), 200);
      expect(await app.store!.preference('lastSyncMs'), isNull);
      expect(app.syncMessage, contains('توجد سجلات أخرى'));
    },
  );

  test('signed-session snapshot recovery retains a deferred queued ID and applies only post-checkpoint deltas', () async {
    final queued = expense('accepted-but-still-queued');
    await app.store!.saveEntry(queued);
    await app.store!.fail(
      queued.id,
      'network',
      nowMs: DateTime.now().millisecondsSinceEpoch + 600000,
    );
    await app.store!.saveDraft('recovery-draft', {
      'note': 'مسودة أثناء استعادة السجل',
    });
    await app.store!.setPreference('cursor', 2);
    final before = await app.store!.exportBackup();
    snapshots.Fixture? active;
    gateway.onGetSnapshot = (tenant, device) async {
      expect(tenant, 't1');
      expect(device, 'device-test');
      active = snapshots.Fixture(
        [
          snapshots.record('entry', queued.toJson(), 3),
          snapshots.record(
            'party',
            const Party(
              id: 'server-party',
              tenantId: 't1',
              name: 'طرف الاستعادة',
              kind: 'merchant',
              openingMinor: 1200,
            ).toJson(),
            4,
          ),
        ],
        epoch: membershipEpoch,
        checkpoint: 10,
        floor: 5,
      );
      return {
        'header': active!.header,
        'headerSha256': activeSnapshotHash(active!.header),
      };
    };
    gateway.onReadSnapshotPage = (request) async => {
      'headerSha256': activeSnapshotHash(active!.header),
      'page': active!.pages[request['index'] as int],
    };
    final delta = expense('after-snapshot');
    final cursors = <int>[];
    gateway.onPull = (cursor) async {
      cursors.add(cursor);
      if (cursor < 5) {
        return {'status': 'resync_required'};
      }
      expect(cursor, 10);
      return {
        'syncProtocolVersion': 2,
        'historyFloor': 5,
        'changes': [
          {'entity': 'entry', 'sequence': 11, 'payload': delta.toJson()},
        ],
        'lastSequence': 11,
        'hasMore': false,
      };
    };
    await app.synchronize();
    expect(cursors, [2, 10]);
    expect(gateway.sent, isEmpty);
    expect(
      app.licenseSession!.verifiedPackage!.membership.epoch,
      membershipEpoch,
    );
    expect((await app.store!.listOutbox()).single.payload, queued.toJson());
    final after = await app.store!.exportBackup();
    expect(after['outbox'], before['outbox']);
    expect(after['drafts'], before['drafts']);
    expect(await app.store!.entryState(queued.id), 'retry');
    expect(await app.store!.entryState(delta.id), 'server_accepted');
    expect(await app.store!.preference('cursor'), 11);
    expect(await app.store!.preference('historyFloor'), 5);
    expect(app.entries.map((entry) => entry.id).toSet(), {queued.id, delta.id});
    expect(app.syncMessage, 'اكتملت المزامنة مع الخادم');
  });

  test('snapshot recovery downloads at most sixteen pages and resumes across a fresh signed bootstrap epoch', () async {
    final records = [
      for (var i = 1; i <= 18; i++)
        snapshots.record(
          'party',
          Party(
            id: 'resume-party-$i',
            tenantId: 't1',
            name: 'طرف $i',
            kind: 'merchant',
          ).toJson(),
          i,
        ),
    ];
    snapshots.Fixture? active;
    final publishedIds = <String>[];
    gateway.onGetSnapshot = (_, _) async {
      active = snapshots.Fixture(
        records,
        id: 'bound-$membershipEpoch',
        epoch: membershipEpoch,
        checkpoint: 20,
        floor: 10,
        pageSize: 1,
      );
      publishedIds.add(active!.header['snapshotId'] as String);
      return {
        'header': active!.header,
        'headerSha256': activeSnapshotHash(active!.header),
      };
    };
    gateway.onReadSnapshotPage = (request) async => {
      'headerSha256': activeSnapshotHash(active!.header),
      'page': active!.pages[request['index'] as int],
    };
    gateway.onPull = (cursor) async => cursor < 10
        ? {'status': 'resync_required'}
        : {
            'syncProtocolVersion': 2,
            'historyFloor': 10,
            'changes': [],
            'lastSequence': cursor,
            'hasMore': false,
          };
    await app.synchronize();
    expect(
      gateway.snapshotPageRequests.map((row) => row['index']),
      List.generate(16, (i) => i),
    );
    expect(await app.store!.listParties(), isEmpty);
    expect(await app.store!.preference('cursor'), isNull);
    expect(await app.store!.preference('lastSyncMs'), isNull);
    expect(app.syncMessage, contains('16/18'));
    final firstEpoch = membershipEpoch;
    await app.store!.close();
    app.store = await open('t1', 'u1');
    await app.synchronize();
    expect(membershipEpoch, greaterThan(firstEpoch));
    expect(publishedIds.toSet().length, 2);
    expect(gateway.snapshotPageRequests.length, 18);
    expect(gateway.snapshotPageRequests.skip(16).map((row) => row['index']), [
      16,
      17,
    ]);
    expect((await app.store!.listParties()).length, 18);
    expect(await app.store!.preference('cursor'), 20);
    expect(app.syncMessage, 'اكتملت المزامنة مع الخادم');
  });

  test(
    'snapshot page response after sign-out cannot install into either account',
    () async {
      final oldStore = app.store!;
      final entered = Completer<void>();
      final delayed = Completer<Map<String, dynamic>>();
      snapshots.Fixture? active;
      gateway.onGetSnapshot = (_, _) async {
        active = snapshots.Fixture(
          [
            snapshots.record(
              'party',
              const Party(
                id: 'old-snapshot-party',
                tenantId: 't1',
                name: 'طرف الجلسة السابقة',
                kind: 'merchant',
              ).toJson(),
              1,
            ),
          ],
          epoch: membershipEpoch,
          checkpoint: 10,
          floor: 5,
        );
        return {
          'header': active!.header,
          'headerSha256': activeSnapshotHash(active!.header),
        };
      };
      gateway.onReadSnapshotPage = (_) {
        entered.complete();
        return delayed.future;
      };
      gateway.onPull = (_) async => {'status': 'resync_required'};
      final recovery = app.synchronize();
      await entered.future;
      await app.signOut();
      await attach(tenant: 't2', uid: 'u2');
      delayed.complete({
        'headerSha256': activeSnapshotHash(active!.header),
        'page': active!.pages.single,
      });
      await recovery;
      expect(app.tenantId, 't2');
      expect(await app.store!.listParties(), isEmpty);
      expect(await app.store!.preference('cursor'), isNull);
      await expectLater(
        oldStore.listParties(),
        throwsA(isA<LedgerException>()),
      );
      final retained = await open('t1', 'u1');
      try {
        expect(await retained.listParties(), isEmpty);
        expect(await retained.preference('cursor'), isNull);
        final staged = (await retained.activeSnapshotStatus(
          'snapshot1',
          expectedMembershipEpoch: active!.header['membershipEpoch'] as int,
        ))!;
        expect(staged.receivedPageIndexes, isEmpty);
        expect(staged.installed, isFalse);
      } finally {
        await retained.close();
      }
    },
  );

  test('wrong snapshot response epoch or page digest preserves active cursor and retry work', () async {
    final queued = expense('snapshot-response-retained');
    await app.store!.saveEntry(queued);
    await app.store!.fail(
      queued.id,
      'network',
      nowMs: DateTime.now().millisecondsSinceEpoch + 600000,
    );
    await app.store!.setPreference('cursor', 1);
    final before = (await app.store!.exportBackup())['outbox'];
    var wrongEpoch = true;
    snapshots.Fixture? active;
    gateway.onGetSnapshot = (_, _) async {
      active = snapshots.Fixture(
        [snapshots.record('entry', queued.toJson(), 2)],
        id: 'tamper-$membershipEpoch',
        epoch: membershipEpoch + (wrongEpoch ? 1 : 0),
        checkpoint: 10,
        floor: 5,
      );
      return {
        'header': active!.header,
        'headerSha256': activeSnapshotHash(active!.header),
      };
    };
    gateway.onReadSnapshotPage = (_) async => {
      'headerSha256': '0' * 64,
      'page': active!.pages.single,
    };
    gateway.onPull = (_) async => {'status': 'resync_required'};
    await app.synchronize();
    expect(gateway.snapshotPageRequests, isEmpty);
    expect(await app.store!.preference('cursor'), 1);
    expect((await app.store!.exportBackup())['outbox'], before);
    wrongEpoch = false;
    await app.synchronize();
    expect(gateway.snapshotPageRequests, hasLength(1));
    expect(await app.store!.preference('cursor'), 1);
    expect((await app.store!.exportBackup())['outbox'], before);
    expect(app.syncMessage, isNot('اكتملت المزامنة مع الخادم'));
  });
}
