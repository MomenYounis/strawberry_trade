// Synthetic, disposable-Android acceptance only. Never a release entrypoint.
// The host writes a private job containing only demo-emulator account details.
import 'dart:convert';
import 'dart:io';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:crypto/crypto.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart' hide canonicalJson;
import 'package:strawberry_trade/services/gateway.dart';
import 'package:strawberry_trade/services/recovery_backup.dart';
import 'package:strawberry_trade/services/sync_protocol.dart';

const _phrase = 'Synthetic independent recovery phrase 2026';
const _security = DeviceSecurity();

// These overrides observe real SDK calls. They do not fabricate responses or
// errors, change transport configuration, or bypass the FirebaseGateway path in
// AppController. A disconnected bootstrap must fail in super.bootstrap itself.
class _ObservedFirebaseGateway extends FirebaseGateway {
  _ObservedFirebaseGateway() : super(_security);
  int bootstrapCalls = 0,
      successfulBootstraps = 0,
      sendCalls = 0,
      pullCalls = 0;
  Object? bootstrapError;
  Map<String, dynamic>? sentOperation, sendResponse;

  @override
  Future<Map<String, dynamic>> bootstrap(
    String tenantId,
    InstallationIdentity identity,
  ) async {
    bootstrapCalls++;
    try {
      final response = await super.bootstrap(tenantId, identity);
      successfulBootstraps++;
      return response;
    } catch (error) {
      bootstrapError = error;
      rethrow;
    }
  }

  @override
  Future<Map<String, dynamic>> send(
    String tenantId,
    String deviceId,
    Map<String, dynamic> operation,
  ) async {
    sendCalls++;
    sentOperation = Map<String, dynamic>.from(
      jsonDecode(jsonEncode(operation)) as Map,
    );
    final response = await super.send(tenantId, deviceId, operation);
    sendResponse = response;
    return response;
  }

  @override
  Future<Map<String, dynamic>> pull(
    String tenantId,
    String deviceId,
    int afterSequence,
  ) async {
    pullCalls++;
    return super.pull(tenantId, deviceId, afterSequence);
  }
}

String _digest(Object? value) =>
    sha256.convert(utf8.encode(canonicalJson(value))).toString();

final _explicitNativeTransportCause = RegExp(
  r'network error|network.*(?:unreachable|failed)|unable to resolve host|'
  r'failed to connect|connect failed|connection (?:refused|reset|timed out|closed)|'
  r'no route to host|connectexception|socketexception|unknownhostexception|'
  r'econnrefused|enetunreach|ehostunreach|etimedout',
  caseSensitive: false,
);

String? _networkFailureCode(Object? error) {
  if (error is FirebaseAuthException) {
    if (error.code == 'network-request-failed') return error.code;
    // Some emulator/native SDK combinations wrap the same network cause with
    // a generic Auth code. Accept only an explicit transport cause in the
    // native SDK message; a generic internal/unknown error is not proof.
    if (_explicitNativeTransportCause.hasMatch(
      '${error.message ?? ''} $error',
    )) {
      return '${error.code}:native-network-cause';
    }
  }
  if (error is FirebaseFunctionsException) {
    if ({'unavailable', 'deadline-exceeded'}.contains(error.code)) {
      return error.code;
    }
    if (_explicitNativeTransportCause.hasMatch(
      '${error.message ?? ''} ${error.details ?? ''} $error',
    )) {
      return '${error.code}:native-network-cause';
    }
  }
  return null;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('actual native commercial and replacement-device phase', (
    tester,
  ) async {
    expect(Platform.isAndroid, isTrue);
    // Fail before SDK initialization if a production destination was compiled.
    expect(FirebaseGateway.emulator, isTrue);
    expect(FirebaseGateway.endpoint.baseUrl, 'http://10.0.2.2:8788');
    final directory = await getApplicationSupportDirectory();
    final identity = await _security.installationIdentity();
    final jobFile = File('${directory.path}/commercial-job.json');
    final job = await jobFile.exists()
        ? Map<String, dynamic>.from(
            jsonDecode(await jobFile.readAsString()) as Map,
          )
        : <String, dynamic>{'phase': 'identity'};
    final phase = job['phase'] as String;
    final result = <String, dynamic>{
      'phase': phase,
      'synthetic': true,
      'deviceId': identity.deviceId,
      'publicKeySpki': identity.publicKeySpki,
      'productionAuthenticationUsed': false,
    };
    final gateway = FirebaseGateway(_security);
    final accounts = Map<String, dynamic>.from(job['accounts'] as Map? ?? {});
    final campaign = job['campaign'] as String? ?? 'identity';
    expect(RegExp(r'^[a-z0-9_-]{1,80}$').hasMatch(campaign), isTrue);

    Map<String, dynamic> account(String name) =>
        Map<String, dynamic>.from(accounts[name] as Map);
    Future<Map<String, dynamic>> login(String name) async {
      final a = account(name);
      await gateway.login(a['email'] as String, a['password'] as String);
      final bootstrap = await gateway.bootstrap(
        a['tenantId'] as String,
        identity,
      );
      final status =
          await LicenseSession(
            security: _security,
            // This test-only entrypoint trusts the public synthetic issuer supplied
            // through the host's private demo job. Release configuration is untouched.
            verifier: LicenseVerifier(
              Map<String, String>.from(job['licensePublicKeys'] as Map),
            ),
            tenantId: a['tenantId'] as String,
            uid: a['uid'] as String,
            deviceId: identity.deviceId,
          ).importPackage(
            jsonEncode(bootstrap['licensePackage']),
            trustedOnline: true,
          );
      expect(status.operationalAllowed, isTrue);
      expect(status.role, name.startsWith('employee') ? 'employee' : 'manager');
      return bootstrap;
    }

    Future<LedgerStore> open(String name) async {
      final a = account(name);
      final scope = 'commercial:$campaign:${a['tenantId']}:${a['uid']}';
      return LedgerStore.open(
        path:
            '${directory.path}/commercial-$campaign-${a['tenantId']}-${a['uid']}.db',
        tenantId: a['tenantId'] as String,
        userId: a['uid'] as String,
        role: name.startsWith('employee') ? 'employee' : 'manager',
        employeeId: name.startsWith('employee') ? 'staff' : null,
        password: await _security.databasePassword(scope),
      );
    }

    LicenseSession sessionFor(String name) {
      final a = account(name);
      return LicenseSession(
        security: _security,
        verifier: LicenseVerifier(
          Map<String, String>.from(job['licensePublicKeys'] as Map),
        ),
        tenantId: a['tenantId'] as String,
        uid: a['uid'] as String,
        deviceId: identity.deviceId,
      );
    }

    AppController attachController(
      LedgerStore store,
      LicenseSession session,
      LicenseStatus status,
      FirebaseGateway transport,
    ) =>
        AppController(
            security: _security,
            gateway: transport,
            verifier: session.verifier,
          )
          ..identity = identity
          ..store = store
          ..licenseSession = session
          ..license = status
          ..tenantId = store.tenantId
          ..uid = store.userId
          ..employeeId = store.employeeId ?? ''
          ..business = 'Synthetic native offline acceptance'
          ..loading = false;

    // The controller does not own this fixture's custom-path store. In
    // particular, never initialize it and reopen the canonical application DB.
    void detachController(AppController controller) {
      controller.store = null;
      controller.dispose();
    }

    final offlineState = File(
      '${directory.path}/commercial-offline-state.json',
    );
    Future<Map<String, dynamic>> readOfflineState() async {
      final state = Map<String, dynamic>.from(
        jsonDecode(await offlineState.readAsString()) as Map,
      );
      final a = account('managerA');
      expect(state['synthetic'], isTrue);
      expect(state['campaign'], campaign);
      expect(state['deviceId'], identity.deviceId);
      expect(state['tenantId'], a['tenantId']);
      expect(state['uid'], a['uid']);
      expect(state['operationSha256'], _digest(state['operation']));
      expect(state['draftSha256'], _digest(state['draft']));
      expect(state['operation']['id'], 'replacement_offline_pending');
      expect(state['savedThroughControllerWhileDisconnected'], isTrue);
      return state;
    }

    Future<void> expectOfflinePending(
      LedgerStore store,
      Map<String, dynamic> state,
    ) async {
      final pending = (await store.listOutbox()).single;
      expect(pending.id, 'replacement_offline_pending');
      expect(pending.status, 'pending');
      expect(pending.attempts, 0);
      expect(pending.nextAttemptMs, 0);
      expect(pending.error, isEmpty);
      expect(_digest(pending.toOperation()), state['operationSha256']);
      expect(
        canonicalJson(pending.toOperation()),
        canonicalJson(state['operation']),
      );
      expect(await store.entryState(pending.id), 'pending');
      expect(await store.preference('cursor'), state['cursor']);
      expect(_digest((await store.listDrafts()).single), state['draftSha256']);
      final entries = await store.listEntries();
      expect(entries.any((entry) => entry.id == 'lost_only'), isFalse);
      expect(
        LedgerRules.partyBalance(
          (await store.listParties()).singleWhere(
            (party) => party.id == 'customer',
          ),
          entries,
        ),
        20000,
      );
      expect(LedgerRules.netRecordedCash(entries), -6700);
    }

    Future<void> pull(LedgerStore store) async {
      for (var pages = 0; pages < 100; pages++) {
        final cursor = (await store.preference('cursor') as int?) ?? 0;
        final response = await gateway.pull(
          store.tenantId,
          identity.deviceId,
          cursor,
        );
        final page = SyncPage.parse(response, cursor);
        await store.applyRemoteBatch(
          page.changes,
          expectedCursor: cursor,
          lastSequence: page.lastSequence,
        );
        if (!page.hasMore) return;
      }
      fail('fixture-page-budget-exceeded');
    }

    Future<Map<String, dynamic>> send(
      LedgerStore store,
      OutboxItem item,
    ) async {
      final ack = await gateway.send(
        store.tenantId,
        identity.deviceId,
        item.toOperation(),
      );
      expect(ack['id'], item.id, reason: 'Receipt must bind the queued ID.');
      final duplicate = await gateway.send(
        store.tenantId,
        identity.deviceId,
        item.toOperation(),
      );
      expect(
        duplicate,
        ack,
        reason: 'An identical retry must have one receipt.',
      );
      expect(
        {'accepted', 'awaiting_approval'}.contains(ack['status']),
        isTrue,
        reason: 'Unexpected synthetic acknowledgement: ${ack['reason']}',
      );
      await store.acknowledge(
        item.id,
        sessionTenantId: store.tenantId,
        sessionUserId: store.userId,
        serverEntry: ack['entry'] is Map
            ? Map<String, dynamic>.from(ack['entry'] as Map)
            : null,
      );
      return ack;
    }

    Future<void> flush(LedgerStore store) async {
      for (final item in await store.listOutbox()) {
        if (item.status != 'conflict' && item.status != 'blocked') {
          await send(store, item);
        }
      }
    }

    Party customer(String tenant, int opening) => Party(
      id: 'customer',
      tenantId: tenant,
      name: 'عميل تجريبي',
      kind: 'merchant',
      openingMinor: opening,
    );
    LedgerEntry invoice(
      String tenant,
      String uid,
      String id, {
      String kind = 'sale',
      String party = 'customer',
      int quantity = 1000,
      int price = 2000,
      int total = 2000,
      int paid = 500,
      String original = '',
    }) => LedgerEntry(
      id: id,
      tenantId: tenant,
      creatorUid: uid,
      kind: kind,
      date: '2026-10-18',
      partyId: party,
      partyName: party == 'customer' ? 'عميل تجريبي' : 'مورد تجريبي',
      qtyMilli: quantity,
      priceMinor: price,
      totalMinor: total,
      paidMinor: paid,
      grade: 'أول',
      unit: 'كجم',
      originalId: original,
    );

    if (phase == 'manager_seed') {
      final invitations = <String, dynamic>{};
      for (final name in ['managerA', 'managerB']) {
        await login(name);
        final a = account(name),
            tenant = a['tenantId'] as String,
            uid = a['uid'] as String;
        var store = await open(name);
        await store.saveParty(
          customer(tenant, name == 'managerA' ? 5000 : 700),
        );
        await store.saveEmployee(
          Employee(id: 'staff', tenantId: tenant, name: 'موظف تجريبي'),
        );
        await store.saveSalaryTerm(
          SalaryTerm(
            id: 'term',
            tenantId: tenant,
            employeeId: 'staff',
            effectiveMonth: '2026-10',
            monthlyMinor: 100000,
          ),
        );
        if (name == 'managerA') {
          await store.saveParty(
            Party(
              id: 'supplier',
              tenantId: tenant,
              name: 'مورد تجريبي',
              kind: 'supplier',
              openingMinor: 7000,
            ),
          );
          await store.saveEntry(
            invoice(
              tenant,
              uid,
              'accepted_sale',
              quantity: 10000,
              total: 20000,
              paid: 5000,
            ),
          );
          await store.saveEntry(
            LedgerEntry(
              id: 'collection',
              tenantId: tenant,
              creatorUid: uid,
              kind: 'merchant_payment',
              date: '2026-10-18',
              partyId: 'customer',
              partyName: 'عميل تجريبي',
              totalMinor: 1000,
              paidMinor: 1000,
            ),
          );
          await store.saveEntry(
            invoice(
              tenant,
              uid,
              'return_reversed',
              kind: 'sale_return',
              quantity: 2000,
              total: 4000,
              paid: 0,
              original: 'accepted_sale',
            ),
          );
          await store.saveEntry(
            LedgerEntry(
              id: 'reverse_return',
              tenantId: tenant,
              creatorUid: uid,
              kind: 'reversal',
              date: '2026-10-18',
              originalId: 'return_reversed',
              note: 'تصحيح مرتجع تجريبي',
            ),
          );
          await store.saveEntry(
            invoice(
              tenant,
              uid,
              'replacement_return',
              kind: 'sale_return',
              quantity: 2000,
              total: 4000,
              paid: 0,
              original: 'accepted_sale',
            ),
          );
          await store.saveEntry(
            invoice(
              tenant,
              uid,
              'purchase',
              kind: 'purchase',
              party: 'supplier',
              quantity: 5000,
              price: 1000,
              total: 5000,
              paid: 1000,
            ),
          );
          await store.saveEntry(
            LedgerEntry(
              id: 'supplier_payment',
              tenantId: tenant,
              creatorUid: uid,
              kind: 'supplier_payment',
              date: '2026-10-18',
              partyId: 'supplier',
              partyName: 'مورد تجريبي',
              totalMinor: 2000,
              paidMinor: 2000,
            ),
          );
          await store.saveEntry(
            invoice(
              tenant,
              uid,
              'purchase_return',
              kind: 'purchase_return',
              party: 'supplier',
              quantity: 1000,
              price: 1000,
              total: 1000,
              paid: 0,
              original: 'purchase',
            ),
          );
          await store.saveEntry(
            LedgerEntry(
              id: 'payroll',
              tenantId: tenant,
              creatorUid: uid,
              kind: 'payroll',
              date: '2026-10-18',
              employeeId: 'staff',
              salaryMonth: '2026-10',
              totalMinor: 10000,
              paidMinor: 10000,
            ),
          );
          await store.saveEntry(
            LedgerEntry(
              id: 'expense',
              tenantId: tenant,
              creatorUid: uid,
              kind: 'expense_business',
              date: '2026-10-18',
              totalMinor: 700,
              paidMinor: 700,
            ),
          );
        } else {
          await store.saveEntry(
            invoice(
              tenant,
              uid,
              'accepted_sale',
              price: 3000,
              total: 3000,
              paid: 1000,
            ),
          );
        }
        // The queue is durable before any financial network call.
        final before = (await store.listOutbox())
            .map((o) => canonicalJson(o.toOperation()))
            .toList();
        await store.close();
        store = await open(name);
        expect(
          (await store.listOutbox())
              .map((o) => canonicalJson(o.toOperation()))
              .toList(),
          before,
        );
        await flush(store);
        await pull(store);
        expect(await store.listOutbox(), isEmpty);
        final entries = await store.listEntries();
        expect(
          LedgerRules.partyBalance(
            customer(tenant, name == 'managerA' ? 5000 : 700),
            entries,
          ),
          name == 'managerA' ? 15000 : 2700,
        );
        if (name == 'managerA') {
          expect(
            LedgerRules.partyBalance(
              (await store.listParties()).singleWhere(
                (p) => p.id == 'supplier',
              ),
              entries,
            ),
            8000,
          );
          expect(LedgerRules.netRecordedCash(entries), -7700);
          expect(
            LedgerRules.payroll(
              'staff',
              '2026-10',
              await store.listSalaryTerms(),
              entries,
            ).remainingMinor,
            90000,
          );
          await store.saveEntry(invoice(tenant, uid, 'backed_pending'));
          await store.fail('backed_pending', 'unavailable', nowMs: 100);
          await store.saveDraft('unfinished_draft', {
            'id': 'unfinished_draft',
            'note': 'مسودة تجريبية محفوظة',
          });
          final backup = await store.exportPendingBackup();
          expect(backup['coverage'], 'pending-and-dependencies');
          await File('${directory.path}/commercial-recovery.json')
              .writeAsString(
                jsonEncode(await RecoveryBackup.encrypt(backup, _phrase)),
                flush: true,
              );
          // This later unsynchronized operation has no durable recovery copy.
          await store.saveEntry(invoice(tenant, uid, 'lost_only'));
          expect((await store.listOutbox()).map((o) => o.id).toSet(), {
            'backed_pending',
            'lost_only',
          });
        }
        invitations[name] = await gateway.createEmployeeInvitation(
          tenant,
          identity.deviceId,
          employeeId: 'staff',
        );
        await store.close();
      }
      result['invitations'] =
          invitations; // Private host transfer; never log it.
      result['expectedAcceptedCustomerMinor'] = {
        'managerA': 15000,
        'managerB': 2700,
      };
    } else if (phase == 'employee_submit') {
      for (final name in ['employeeA', 'employeeB']) {
        final a = account(name), tenant = a['tenantId'] as String;
        await gateway.login(a['email'] as String, a['password'] as String);
        await gateway.acceptInvitation(
          tenant,
          job['invitations'][name] as String,
          identity,
        );
        await login(name);
        var store = await open(name);
        await pull(store);
        final directories = await store.listParties();
        expect(
          directories.every((p) => p.openingMinor == 0 && p.phone.isEmpty),
          isTrue,
        );
        await expectLater(store.listEntries(), throwsA(isA<LedgerException>()));
        final submission = EmployeeSubmission(
          id: 'delivery',
          tenantId: tenant,
          creatorUid: a['uid'] as String,
          employeeId: 'staff',
          kind: 'delivery',
          date: '2026-10-18',
          partyId: 'customer',
          partyName: 'عميل تجريبي',
          qtyMilli: 1000,
          grade: 'أول',
          unit: 'كجم',
        );
        await store.saveSubmission(submission);
        await store.saveSubmission(
          EmployeeSubmission(
            id: 'rejected_expense',
            tenantId: tenant,
            creatorUid: a['uid'] as String,
            employeeId: 'staff',
            kind: 'expense_business',
            date: '2026-10-18',
            amountMinor: 300,
            note: 'طلب تجريبي للرفض',
          ),
        );
        await store.fail('delivery', 'unavailable', nowMs: 100);
        final expected = canonicalJson(
          (await store.listOutbox()).first.toOperation(),
        );
        await store.close();
        store = await open(name);
        expect(
          canonicalJson((await store.listOutbox()).first.toOperation()),
          expected,
        );
        expect((await store.listOutbox()).first.attempts, 1);
        await flush(store);
        await pull(store);
        expect(await store.listOutbox(), isEmpty);
        expect(
          (await store.listSubmissions()).every(
            (s) => s['state'] == 'awaiting_approval',
          ),
          isTrue,
        );
        // Authenticated employee cannot submit a manager financial entry.
        await expectLater(
          gateway.send(tenant, identity.deviceId, {
            'id': 'employee_forbidden',
            'entity': 'entry',
            'expectedRevision': 0,
            'payload': invoice(
              tenant,
              a['uid'] as String,
              'employee_forbidden',
            ).toJson(),
          }),
          throwsA(anything),
        );
        // A tenant selector is not permission to read the other business.
        final other = name == 'employeeA'
            ? account('managerB')
            : account('managerA');
        await expectLater(
          () => gateway.pull(other['tenantId'] as String, identity.deviceId, 0),
          throwsA(anything),
        );
        await store.close();
      }
    } else if (phase == 'manager_review') {
      for (final name in ['managerA', 'managerB']) {
        await login(name);
        final a = account(name), tenant = a['tenantId'] as String;
        final store = await open(name);
        await pull(store);
        final submissions = await store.listSubmissions();
        final originalRow = Map<String, dynamic>.from(
          submissions.singleWhere((s) => s['id'] == 'delivery'),
        )..removeWhere((key, _) => {'state', 'review'}.contains(key));
        final original = EmployeeSubmission.fromJson(originalRow);
        final before = (await store.listEntries()).length;
        await store.saveReview(
          id: 'approve_delivery',
          submissionId: 'delivery',
          approved: true,
          entry: invoice(
            tenant,
            original.creatorUid,
            'approved_delivery',
            total: 2000,
            paid: 0,
          ),
        );
        expect(
          (await store.listEntries()).length,
          before,
          reason: 'Pending approval has no posting.',
        );
        await store.saveReview(
          id: 'reject_expense',
          submissionId: 'rejected_expense',
          approved: false,
          note: 'رفض تجريبي موثق',
        );
        for (final item in await store.listOutbox()) {
          if (item.entity == 'review') await send(store, item);
        }
        await pull(store);
        final approved = (await store.listEntries()).singleWhere(
          (e) => e.id == 'approved_delivery',
        );
        expect(approved.creatorUid, original.creatorUid);
        expect(
          (await store.listEntries()).any((e) => e.id == 'rejected_expense'),
          isFalse,
        );
        final balance = LedgerRules.partyBalance(
          customer(tenant, name == 'managerA' ? 5000 : 700),
          await store.listEntries(),
        );
        // A's two preserved local pending sales add 3000; accepted review adds 2000.
        expect(balance, name == 'managerA' ? 20000 : 4700);
        await gateway.setMemberActive(
          tenant,
          identity.deviceId,
          uid:
              account(name == 'managerA' ? 'employeeA' : 'employeeB')['uid']
                  as String,
          active: false,
        );
        await store.close();
      }
    } else if (phase == 'employee_revoked') {
      for (final name in ['employeeA', 'employeeB']) {
        final a = account(name);
        await gateway.login(a['email'] as String, a['password'] as String);
        final bootstrap = await gateway.bootstrap(
          a['tenantId'] as String,
          identity,
        );
        final payload = jsonDecode(
          utf8.decode(
            base64Url.decode(
              base64Url.normalize(
                bootstrap['licensePackage']['membership']['payload'] as String,
              ),
            ),
          ),
        ) as Map;
        expect(payload['enabled'], isFalse);
        await expectLater(
          gateway.pull(a['tenantId'] as String, identity.deviceId, 0),
          throwsA(anything),
        );
      }
    } else if (phase == 'replacement') {
      expect(identity.deviceId, isNot(job['sourceDeviceId']));
      await login('managerA');
      await expectLater(
        // Bootstrap reaches server authority directly; the client-side bound
        // session guard used by pull/send cannot reject this tenant selector.
        gateway.bootstrap(account('managerB')['tenantId'] as String, identity),
        throwsA(
          isA<FirebaseFunctionsException>().having(
            (error) =>
                error.details is Map ? (error.details as Map)['reason'] : null,
            'server refusal reason',
            'permission-denied',
          ),
        ),
      );
      result['crossTenantBootstrapRefusedByServer'] = true;
      final store = await open('managerA');
      final envelope = Map<String, dynamic>.from(
        jsonDecode(
          await File('${directory.path}/commercial-recovery.json')
              .readAsString(),
        ) as Map,
      );
      final backup = await RecoveryBackup.decrypt(envelope, _phrase);
      await store.restoreBackup(backup);
      await store.restoreBackup(backup);
      expect((await store.listEntries()).map((e) => e.id).toSet(), {
        'backed_pending',
      });
      final pending = (await store.listOutbox()).single;
      expect(pending.id, 'backed_pending');
      expect(pending.status, 'retry');
      expect(pending.attempts, 1);
      expect((await store.listDrafts()).single['id'], 'unfinished_draft');
      expect(await store.preference('cursor'), isNull);
      expect(await store.preference('licensePackage'), isNull);
      await pull(store);
      final entries = await store.listEntries();
      expect(entries.any((e) => e.id == 'accepted_sale'), isTrue);
      expect(entries.any((e) => e.id == 'approved_delivery'), isTrue);
      expect(entries.any((e) => e.id == 'lost_only'), isFalse);
      expect(
        canonicalJson((await store.listOutbox()).single.toOperation()),
        canonicalJson(pending.toOperation()),
      );
      expect((await store.listOutbox()).single.attempts, 1);
      expect(
        LedgerRules.partyBalance(
          (await store.listParties()).singleWhere((p) => p.id == 'customer'),
          entries,
        ),
        18500,
      );
      await send(store, pending);
      await pull(store);
      expect(await store.listOutbox(), isEmpty);
      expect(
        (await store.listEntries())
            .where((e) => e.id == 'backed_pending')
            .length,
        1,
      );
      expect(
        LedgerRules.partyBalance(
          (await store.listParties()).singleWhere((p) => p.id == 'customer'),
          await store.listEntries(),
        ),
        18500,
      );
      await store.close();
      result['acceptedHydratedFromAuthenticatedServer'] = true;
      result['backedPendingPreservedAndAcceptedOnce'] = true;
      result['lostOnlyNotRecoverable'] = true;
      result['expectedCustomerMinor'] = 18500;
    } else if (phase == 'offline_transport' ||
        phase == 'offline_transport_resume') {
      final resumePending = phase == 'offline_transport_resume';
      // Establish the actual native Auth session before the host disconnects
      // radios. The later failure must arise from a real SDK network request.
      await login('managerA');
      expect(await offlineState.exists(), resumePending);
      final retainedState = resumePending ? await readOfflineState() : null;
      if (resumePending) {
        expect(retainedState!['transportFailureObserved'], isFalse);
        expect(retainedState['rebootVerified'], isFalse);
      }
      final ready = File('${directory.path}/commercial-network-ready.json');
      final disconnected = File(
        '${directory.path}/commercial-network-disconnected.flag',
      );
      expect(await ready.exists(), isFalse);
      expect(await disconnected.exists(), isFalse);
      final store = await open('managerA');
      final session = sessionFor('managerA');
      final status = await session.initialize();
      expect(status.operationalAllowed, isTrue);
      expect(status.role, 'manager');
      final transport = _ObservedFirebaseGateway();
      final controller = attachController(store, session, status, transport);
      try {
        expect(controller.store, same(store));
        expect(controller.allowed, isTrue);
        if (resumePending) {
          await expectOfflinePending(store, retainedState!);
        } else {
          expect(await store.listOutbox(), isEmpty);
        }
        expect(
          LedgerRules.partyBalance(
            (await store.listParties()).singleWhere(
              (party) => party.id == 'customer',
            ),
            await store.listEntries(),
          ),
          resumePending ? 20000 : 18500,
        );
        expect(
          LedgerRules.netRecordedCash(await store.listEntries()),
          resumePending ? -6700 : -7200,
        );
        await controller.refresh();
        await ready.writeAsString(
          jsonEncode({
            'synthetic': true,
            'phase': phase,
            'campaign': campaign,
            'deviceId': identity.deviceId,
            'operationId': 'replacement_offline_pending',
            'radiosMustBeDisconnectedWithoutRestart': true,
          }),
          flush: true,
        );
        final deadline = DateTime.now().add(const Duration(seconds: 90));
        while (!await disconnected.exists()) {
          if (DateTime.now().isAfter(deadline)) {
            fail('Host network-disconnection handshake timed out.');
          }
          await Future<void>.delayed(const Duration(milliseconds: 250));
        }
        expect(await disconnected.readAsString(), 'DISCONNECTED');
        // Exercise the normal application save only after the host confirms
        // radios are off. It checks the cached license, commits the queue and
        // starts the real controller sync; no response or error is injected.
        if (resumePending) {
          // Retry the exact already durable queue item. Never recreate it or
          // reset its retry state after a preceding test assertion failure.
          await expectOfflinePending(store, retainedState!);
          await controller.synchronize();
        } else {
          await controller.saveEntry(
            invoice(
              store.tenantId,
              store.userId,
              'replacement_offline_pending',
            ),
          );
        }
        final pending = (await store.listOutbox()).single;
        final draft = (await store.listDrafts()).single;
        expect(draft['id'], 'unfinished_draft');
        final beforeBoot = await _security.platformClock();
        final state =
            retainedState ??
            <String, dynamic>{
              'synthetic': true,
              'campaign': campaign,
              'deviceId': identity.deviceId,
              'tenantId': store.tenantId,
              'uid': store.userId,
              'operation': pending.toOperation(),
              'operationSha256': _digest(pending.toOperation()),
              'cursor': await store.preference('cursor'),
              'draft': draft,
              'draftSha256': _digest(draft),
              'sourceBootCount': beforeBoot.bootCount,
              'savedThroughControllerWhileDisconnected': true,
              'transportFailureObserved': false,
              'rebootVerified': false,
            };
        if (resumePending) {
          state['priorSourceBootCount'] = state['sourceBootCount'];
          state['sourceBootCount'] = beforeBoot.bootCount;
        }
        await expectOfflinePending(store, state);
        await offlineState.writeAsString(jsonEncode(state), flush: true);
        // saveEntry already requested one automatic synchronize(). Waiting on
        // its state avoids waitForSync/synchronize scheduling a second attempt.
        final syncDeadline = DateTime.now().add(const Duration(minutes: 3));
        while (controller.syncing) {
          if (DateTime.now().isAfter(syncDeadline)) {
            fail(
              'Actual offline SDK request did not finish within the budget.',
            );
          }
          await Future<void>.delayed(const Duration(milliseconds: 250));
        }
        expect(controller.store, same(store));
        expect(controller.syncing, isFalse);
        expect(transport.bootstrapCalls, 1);
        expect(transport.successfulBootstraps, 0);
        final failure = transport.bootstrapError;
        state['lastNativeFailureType'] = failure.runtimeType.toString();
        final diagnostic = failure.toString();
        state['lastNativeFailureDiagnostic'] = diagnostic.substring(
          0,
          diagnostic.length.clamp(0, 1024),
        );
        if (failure is FirebaseAuthException) {
          state['lastNativeFailureCode'] = failure.code;
          state['lastNativeFailureMessage'] = (failure.message ?? '').substring(
            0,
            (failure.message ?? '').length.clamp(0, 1024),
          );
        } else if (failure is FirebaseFunctionsException) {
          state['lastNativeFailureCode'] = failure.code;
          state['lastNativeFailureMessage'] = (failure.message ?? '').substring(
            0,
            (failure.message ?? '').length.clamp(0, 1024),
          );
        }
        // Persist bounded diagnostics privately even if classification fails;
        // a future resume must preserve this same operation and draft.
        await offlineState.writeAsString(jsonEncode(state), flush: true);
        final failureCode = _networkFailureCode(failure);
        expect(
          failureCode,
          isNotNull,
          reason: 'The real SDK bootstrap must fail because radios are off.',
        );
        expect(transport.sendCalls, 0);
        expect(transport.pullCalls, 0);
        expect(controller.license?.operationalAllowed, isTrue);
        await expectOfflinePending(store, state);
        state.addAll({
          'transportFailureObserved': true,
          'networkFailureCode': failureCode,
          'controllerBootstrapCalls': transport.bootstrapCalls,
          'controllerSendCalls': transport.sendCalls,
          'queueAttemptsAfterNetworkFailure': 0,
        });
        await offlineState.writeAsString(jsonEncode(state), flush: true);
        result.addAll({
          'savedThroughControllerWhileDisconnected': true,
          'samePendingOperationResumed': resumePending,
          'actualControllerTransportFailedOffline': true,
          'networkFailureCode': failureCode,
          'bootstrapCalls': 1,
          'sendCalls': 0,
          'queueAttempts': 0,
          'operationSha256': state['operationSha256'],
          'cursorAndDraftUnchanged': true,
          'expectedLocalCustomerMinor': 20000,
        });
      } finally {
        detachController(controller);
        await store.close();
      }
    } else if (phase == 'offline_reopen') {
      // No login/bootstrap/pull/send: this phase runs with radios disabled.
      final state = await readOfflineState();
      expect(state['transportFailureObserved'], isTrue);
      expect(state['controllerBootstrapCalls'], 1);
      expect(state['controllerSendCalls'], 0);
      expect(state['queueAttemptsAfterNetworkFailure'], 0);
      final status = await sessionFor('managerA').initialize();
      expect(status.operationalAllowed, isTrue);
      expect(status.role, 'manager');
      final afterBoot = await _security.platformClock();
      expect(afterBoot.bootCount, greaterThan(state['sourceBootCount'] as int));
      final store = await open('managerA');
      try {
        await expectOfflinePending(store, state);
      } finally {
        await store.close();
      }
      final reopened = await open('managerA');
      try {
        await expectOfflinePending(reopened, state);
      } finally {
        await reopened.close();
      }
      state.addAll({
        'rebootVerified': true,
        'rebootBootCount': afterBoot.bootCount,
      });
      await offlineState.writeAsString(jsonEncode(state), flush: true);
      result.addAll({
        'cachedDeviceLicenseAndDatabaseAfterReboot': true,
        'offlineQueuePreserved': true,
        'queueAttempts': 0,
        'operationSha256': state['operationSha256'],
        'cursorAndDraftUnchanged': true,
        'expectedLocalCustomerMinor': 20000,
        'sourceBootCount': state['sourceBootCount'],
        'rebootBootCount': afterBoot.bootCount,
      });
    } else if (phase == 'resume_offline') {
      await login('managerA');
      final state = await readOfflineState();
      expect(state['transportFailureObserved'], isTrue);
      expect(state['rebootVerified'], isTrue);
      final store = await open('managerA');
      final session = sessionFor('managerA');
      final status = await session.initialize();
      expect(status.operationalAllowed, isTrue);
      final transport = _ObservedFirebaseGateway();
      final controller = attachController(store, session, status, transport);
      try {
        await expectOfflinePending(store, state);
        await controller.synchronize();
        expect(controller.store, same(store));
        expect(controller.syncing, isFalse);
        expect(transport.bootstrapCalls, 1);
        expect(transport.successfulBootstraps, 1);
        expect(transport.bootstrapError, isNull);
        expect(transport.sendCalls, 1);
        expect(transport.pullCalls, greaterThanOrEqualTo(1));
        final operation = Map<String, dynamic>.from(state['operation'] as Map);
        final receipt = transport.sendResponse!;
        expect(_digest(transport.sentOperation), state['operationSha256']);
        expect(receipt['id'], operation['id']);
        expect(receipt['status'], 'accepted');
        expect(await store.listOutbox(), isEmpty);
        expect(
          await store.entryState(operation['id'] as String),
          'server_accepted',
        );
        for (var retry = 0; retry < 2; retry++) {
          final duplicate = await transport.send(
            store.tenantId,
            identity.deviceId,
            operation,
          );
          expect(duplicate['id'], operation['id']);
          expect(duplicate, receipt);
        }
        expect(transport.sendCalls, 3);
        expect(await store.listOutbox(), isEmpty);
        final entries = await store.listEntries();
        expect(entries.where((entry) => entry.id == operation['id']).length, 1);
        expect(entries.any((entry) => entry.id == 'lost_only'), isFalse);
        expect(
          _digest((await store.listDrafts()).single),
          state['draftSha256'],
        );
        expect(
          await store.preference('cursor'),
          greaterThan(state['cursor'] as int),
        );
        expect(
          LedgerRules.partyBalance(
            (await store.listParties()).singleWhere(
              (party) => party.id == 'customer',
            ),
            entries,
          ),
          20000,
        );
        expect(LedgerRules.netRecordedCash(entries), -6700);
        state['resumedControllerAccepted'] = true;
        await offlineState.writeAsString(jsonEncode(state), flush: true);
        result.addAll({
          'actualControllerResumeAccepted': true,
          'originalQueuedOperationAcceptedExactlyOnce': true,
          'duplicateReceiptsIdentical': true,
          'sendCallsIncludingTwoDuplicateDeliveries': 3,
          'outboxEmpty': true,
          'operationSha256': state['operationSha256'],
          'draftPreserved': true,
          'expectedCustomerMinor': 20000,
          'expectedRecordedCashMinor': -6700,
        });
      } finally {
        detachController(controller);
        await store.close();
      }
    } else {
      expect(phase, 'identity');
    }
    await File('${directory.path}/commercial-result.json')
        .writeAsString(jsonEncode(result), flush: true);
    // No credentials, invitation codes, recovery passphrase or VM-service URL.
    // ignore: avoid_print
    print('NATIVE_COMMERCIAL_PHASE_PASS $phase');
  }, timeout: const Timeout(Duration(minutes: 8)));
}
