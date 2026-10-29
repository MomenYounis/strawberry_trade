import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:crypto/crypto.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/legacy.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../data/ledger_store.dart';
import '../domain/ledger.dart';
import '../security/device_security.dart';
import '../security/licensing.dart';
import '../security/license_sync.dart';
import '../services/employee_registration.dart';
import '../services/gateway.dart';
import '../services/invitation_code.dart';

final appProvider = ChangeNotifierProvider<AppController>((ref) {
  final app = AppController();
  // ChangeNotifierProvider owns disposal of this controller.
  unawaited(app.initialize());
  return app;
});

class AppController extends ChangeNotifier {
  AppController({
    DeviceSecurity? security,
    SyncGateway? gateway,
    LicenseVerifier? verifier,
  }) : security = security ?? const DeviceSecurity(),
       verifier = verifier ?? LicenseVerifier.configured() {
    this.gateway = gateway ?? FirebaseGateway(this.security);
  }
  final DeviceSecurity security;
  final LicenseVerifier verifier;
  late final SyncGateway gateway;
  InstallationIdentity? identity;
  LedgerStore? store;
  LicenseSession? licenseSession;
  LicenseStatus? license;
  String tenantId = '', uid = '', employeeId = '', business = 'دفتر الفراولة';
  String? error, syncMessage;
  bool loading = true, syncing = false, connecting = false;
  int _generation = 0;
  bool _disposed = false;
  int? _remoteApplyEpoch;
  bool _dataRevoked = false;
  bool _syncAgain = false;
  Future<void>? _activeSync;
  List<LedgerEntry> entries = [];
  List<LedgerEntry> recentEntries = [];
  List<Party> parties = [];
  List<Employee> employees = [];
  List<SalaryTerm> terms = [];
  List<Map<String, dynamic>> pending = [];
  List<Map<String, dynamic>> submissions = [];
  String? lastSync;
  StreamSubscription<void>? _databaseChanges;
  StreamSubscription<List<ConnectivityResult>>? _connectivity;
  bool get manager => license?.role == 'manager';
  bool get ready => store != null && licenseSession != null;
  bool get hasDataAccess =>
      !{'disabled', 'account_disabled'}.contains(license?.code);
  void requireDataAccess() {
    if (!hasDataAccess) {
      throw const LicenseException(
        'data_access',
        'أوقفت صلاحية هذا الحساب؛ تحقق من العضوية عند الاتصال',
      );
    }
  }

  void _enforceRevocation() {
    if (hasDataAccess) return;
    _dataRevoked = true;
    store?.revokeAccess();
    entries = [];
    recentEntries = [];
    parties = [];
    employees = [];
    terms = [];
    submissions = [];
    pending = [];
    notifyListeners();
  }

  String employeeNameById(String id) {
    final clean = id.trim();
    if (clean.isEmpty) return '';
    final emp = employees
        .where((e) => e.id == clean && e.name.trim().isNotEmpty)
        .firstOrNull;
    return emp?.name.trim() ?? clean;
  }

  String submissionEmployeeName(Map<String, dynamic> s) {
    final empId = (s['employeeId'] as String? ?? '').trim();
    final creator = (s['creatorUid'] as String? ?? '').trim();
    if (empId.isNotEmpty) {
      final emp = employees
          .where((e) => e.id == empId && e.name.trim().isNotEmpty)
          .firstOrNull;
      if (emp != null) return emp.name.trim();
    }
    if (creator.isNotEmpty) {
      final emp = employees
          .where((e) => e.id == creator && e.name.trim().isNotEmpty)
          .firstOrNull;
      if (emp != null) return emp.name.trim();
    }
    if (empId.isNotEmpty) return empId;
    if (creator.isNotEmpty) return creator;
    return 'موظف';
  }

  String entryActorLabel(LedgerEntry entry) {
    if (entry.id.startsWith('review_')) {
      final subId = entry.id.substring('review_'.length);
      final sub = submissions.where((s) => s['id'] == subId).firstOrNull;
      if (sub != null) {
        return 'الموظف: ${submissionEmployeeName(sub)}';
      }
    }
    final creator = entry.creatorUid.trim();
    if (creator.isNotEmpty) {
      final emp = employees
          .where((e) => e.id == creator && e.name.trim().isNotEmpty)
          .firstOrNull;
      if (emp != null) return 'الموظف: ${emp.name.trim()}';
      final sub = submissions
          .where((s) => (s['creatorUid'] as String? ?? '').trim() == creator)
          .firstOrNull;
      if (sub != null) {
        return 'الموظف: ${submissionEmployeeName(sub)}';
      }
      if (manager && uid.isNotEmpty && creator != uid) {
        return 'الموظف: $creator';
      }
    }
    return 'المدير';
  }

  List<LedgerEntry> get displayRecentEntries {
    final existingIds = {for (final e in entries) e.id};
    final provisional = <LedgerEntry>[];
    for (final s in submissions) {
      if (s['state'] == 'review_pending' && s['review'] is Map) {
        final rev = Map<String, dynamic>.from(s['review'] as Map);
        if (rev['decision'] == 'approved' && rev['entry'] is Map) {
          try {
            final entryJson = Map<String, dynamic>.from(rev['entry'] as Map);
            final entry = LedgerEntry.fromJson(entryJson);
            if (!existingIds.contains(entry.id)) {
              provisional.add(entry);
              existingIds.add(entry.id);
            }
          } catch (_) {}
        }
      }
    }
    final seen = {for (final e in provisional) e.id};
    final result = <LedgerEntry>[...provisional];
    for (final e in recentEntries) {
      if (seen.add(e.id)) result.add(e);
    }
    for (final e in entries.reversed) {
      if (seen.add(e.id)) result.add(e);
    }
    return result;
  }

  bool get allowed => ready && license?.operationalAllowed == true;
  @override
  void notifyListeners() {
    if (!_disposed) super.notifyListeners();
  }

  Future<void> initialize() async {
    try {
      identity = await security.installationIdentity();
      final scope = await security.readSecureValue('last-session');
      if (scope != null && scope.isNotEmpty) {
        final j = Map<String, dynamic>.from(jsonDecode(scope) as Map);
        await _open(
          j['tenantId'] as String,
          j['uid'] as String,
          j['employeeId'] as String? ?? '',
          j['business'] as String? ?? 'دفتر الفراولة',
        );
      }
      _connectivity = Connectivity().onConnectivityChanged.listen((states) {
        if (!states.contains(ConnectivityResult.none)) unawaited(synchronize());
      });
    } catch (e) {
      error = arabicError(e);
    } finally {
      loading = false;
      notifyListeners();
    }
    if (ready) unawaited(synchronize());
  }

  Future<void> _open(
    String tenant,
    String user,
    String employee,
    String name, {
    String? package,
  }) async {
    safeId(tenant);
    safeId(user);
    final session = LicenseSession(
      security: security,
      verifier: verifier,
      tenantId: tenant,
      uid: user,
      deviceId: identity!.deviceId,
    );
    var status = await session.initialize();
    if (package != null) {
      status = await session.importPackage(package, trustedOnline: true);
    }
    if (session.verifiedPackage == null) {
      throw const LicenseException(
        'setup',
        'يلزم استلام حزمة عضوية موثوقة قبل فتح السجل',
      );
    }
    final role = session.verifiedPackage!.membership.role;
    await _databaseChanges?.cancel();
    await store?.close();
    _generation++;
    _remoteApplyEpoch = null;
    tenantId = tenant;
    uid = user;
    employeeId = employee;
    business = name;
    licenseSession = session;
    license = status;
    final dir = await getApplicationSupportDirectory();
    final scope = jsonEncode([tenant, user]);
    final filename = 'ledger_${sha256.convert(utf8.encode(scope))}.db';
    store = await LedgerStore.open(
      path: p.join(dir.path, filename),
      tenantId: tenant,
      userId: user,
      role: role,
      employeeId: employee,
      password: await security.databasePassword(scope),
    );
    _dataRevoked = false;
    syncing = false;
    _databaseChanges = store!.changes.listen((_) {
      if (_remoteApplyEpoch == _generation) return;
      unawaited(refresh());
    });
    await security.writeSecureValue(
      'last-session',
      jsonEncode({
        'tenantId': tenant,
        'uid': user,
        'employeeId': employee,
        'business': name,
      }),
    );
    _enforceRevocation();
    if (hasDataAccess) await refresh();
  }

  Future<void> connect({
    required String tenant,
    required String email,
    required String password,
    String invitationToken = '',
  }) => _runConnection(() async {
    final remote = gateway as FirebaseGateway;
    await remote.login(email, password);
    final user = FirebaseAuth.instance.currentUser!;
    if (invitationToken.trim().isNotEmpty) {
      await remote.acceptInvitation(tenant, invitationToken.trim(), identity!);
    }
    await _openConnectedAccount(tenant, user.uid);
  });

  EmployeeRegistrationAuth get employeeRegistrationAuth {
    if (gateway is! FirebaseGateway || ready) {
      invalid(
        'session_open',
        'اخرج من الحساب المفتوح أولاً قبل إعداد حساب آخر',
      );
    }
    return gateway as FirebaseGateway;
  }

  Future<void> connectEmployeeInvitation({
    required String invitationToken,
    required String expectedUid,
  }) => _runConnection(() async {
    final code = EmployeeInvitationCode.parse(invitationToken);
    final remote = gateway as FirebaseGateway;
    final account = await remote.reloadAccount(expectedUid);
    if (!account.emailVerified) {
      invalid('email_unverified', 'أكد بريدك الإلكتروني أولاً ثم اضغط متابعة');
    }
    await remote.acceptInvitation(code.tenantId, code.token, identity!);
    await _openConnectedAccount(code.tenantId, account.uid);
  });

  Future<void> _openConnectedAccount(String tenant, String expectedUid) async {
    final result = await gateway.bootstrap(tenant, identity!);
    if (FirebaseAuth.instance.currentUser?.uid != expectedUid) {
      invalid(
        'session_changed',
        'تغيّر حساب الدخول؛ سجّل دخولك بالحساب الصحيح',
      );
    }
    final member = Map<String, dynamic>.from(result['member'] as Map);
    final package = result['licensePackage'];
    await _open(
      tenant,
      expectedUid,
      member['employeeId'] as String? ?? '',
      member['businessName'] as String? ?? 'دفتر الفراولة',
      package: package is String ? package : jsonEncode(package),
    );
    unawaited(synchronize());
  }

  Future<void> _runConnection(Future<void> Function() action) async {
    if (connecting) return;
    if (ready) {
      invalid(
        'session_open',
        'اخرج من الحساب المفتوح أولاً قبل إعداد حساب آخر',
      );
    }
    connecting = true;
    error = null;
    notifyListeners();
    try {
      if (gateway is! FirebaseGateway) throw StateError('unsupported');
      if (identity == null) {
        invalid('device_identity', 'انتظر تجهيز هوية الجهاز ثم أعد المحاولة');
      }
      await action();
    } catch (e) {
      error = arabicError(e);
      rethrow;
    } finally {
      connecting = false;
      notifyListeners();
    }
  }

  Future<void> refresh() async {
    final db = store;
    if (db == null || !hasDataAccess) return;
    final epoch = _generation;
    final data = await Future.wait<dynamic>([
      manager ? db.listEntries() : Future.value(<LedgerEntry>[]),
      db.listParties(),
      manager ? db.listEmployees() : Future.value(<Employee>[]),
      manager ? db.listSalaryTerms() : Future.value(<SalaryTerm>[]),
      db.listOutbox(),
      db.listSubmissions(),
      db.preference('lastSyncMs'),
    ]);
    if (epoch != _generation || !hasDataAccess) return;
    entries = List<LedgerEntry>.from(data[0] as List);
    parties = List<Party>.from(data[1] as List);
    employees = List<Employee>.from(data[2] as List);
    terms = List<SalaryTerm>.from(data[3] as List);
    pending = (data[4] as List)
        .map(
          (e) => e is Map
              ? Map<String, dynamic>.from(e)
              : {
                  ...(e as OutboxItem).toOperation(),
                  'state': e.status,
                  'attempts': e.attempts,
                  'error': e.error,
                  'nextAttemptMs': e.nextAttemptMs,
                },
        )
        .toList();
    submissions = (data[5] as List)
        .map(
          (e) => e is Map
              ? Map<String, dynamic>.from(e)
              : Map<String, dynamic>.from((e as dynamic).toJson() as Map),
        )
        .toList();
    lastSync = data[6] is int
        ? DateTime.fromMillisecondsSinceEpoch(data[6] as int).toIso8601String()
        : null;
    recentEntries = entries.reversed.toList();
    notifyListeners();
  }

  Future<void> requireAllowed() async {
    if (!ready) {
      throw const LedgerException(
        'loading',
        'انتظر حتى يكتمل فتح السجل المحلي',
      );
    }
    license = await licenseSession!.check();
    _enforceRevocation();
    notifyListeners();
    if (!allowed) throw LicenseException('locked', license!.message);
  }

  Future<void> saveEntry(LedgerEntry entry) async {
    await requireAllowed();
    await store!.saveEntry(entry);
    try {
      await refresh();
    } catch (_) {
      syncMessage = 'حُفظت العملية محلياً؛ تعذر تحديث العرض مؤقتاً';
    }
    unawaited(synchronize());
  }

  Future<void> saveParty(Party party) async {
    await requireAllowed();
    await store!.saveParty(party);
    try {
      await refresh();
    } catch (_) {
      syncMessage = 'حُفظت العملية محلياً؛ تعذر تحديث العرض مؤقتاً';
    }
    unawaited(synchronize());
  }

  Future<void> saveEmployee(Employee employee) async {
    await requireAllowed();
    await store!.saveEmployee(employee);
    try {
      await refresh();
    } catch (_) {
      syncMessage = 'حُفظت العملية محلياً؛ تعذر تحديث العرض مؤقتاً';
    }
    unawaited(synchronize());
  }

  Future<void> saveSalaryTerm(SalaryTerm term) async {
    await requireAllowed();
    await store!.saveSalaryTerm(term);
    try {
      await refresh();
    } catch (_) {
      syncMessage = 'حُفظت العملية محلياً؛ تعذر تحديث العرض مؤقتاً';
    }
    unawaited(synchronize());
  }

  Future<void> saveSubmission(EmployeeSubmission submission) async {
    await requireAllowed();
    await store!.saveSubmission(submission);
    try {
      await refresh();
    } catch (_) {
      syncMessage = 'حُفظت العملية محلياً؛ تعذر تحديث العرض مؤقتاً';
    }
    unawaited(synchronize());
  }

  Future<void> onResume() async {
    if (ready) {
      license = await licenseSession!.check();
      _enforceRevocation();
      notifyListeners();
      unawaited(synchronize());
    }
  }

  Future<void> importLicense(String text) async {
    if (licenseSession == null) {
      throw const LicenseException('setup', 'أكمل إعداد الحساب الموثوق أولاً');
    }
    license = await licenseSession!.importPackage(text);
    notifyListeners();
    unawaited(synchronize());
  }

  Future<void> synchronize() async {
    final db = store;
    if (db == null) return;
    if (syncing) {
      _syncAgain = true;
      return;
    }
    do {
      _syncAgain = false;
      final run = _runSynchronize(db);
      _activeSync = run;
      await run;
    } while (_syncAgain && store == db && !_disposed && hasDataAccess);
  }

  Future<void> waitForSync({String? resetRetryId}) async {
    while (syncing && _activeSync != null) {
      await _activeSync;
    }
    if (resetRetryId != null && store != null) {
      final outbox = await store!.listOutbox();
      for (final item in outbox) {
        if (item.id == resetRetryId && item.status == 'retry') {
          await store!.retry(item.id);
        }
      }
    }
    await synchronize();
    while (syncing && _activeSync != null) {
      await _activeSync;
    }
  }

  Future<void> synchronizeNow() async {
    if (store != null) {
      final outbox = await store!.listOutbox();
      for (final item in outbox) {
        if (item.status == 'retry') {
          await store!.retry(item.id);
        }
      }
    }
    await waitForSync();
  }

  Future<void> _runSynchronize(LedgerStore db) async {
    syncing = true;
    syncMessage = 'جارٍ محاولة الاتصال بالخادم';
    notifyListeners();
    final epoch = _generation;
    try {
      final boundUid = uid, boundTenant = tenantId;
      final currentSession = licenseSession!;
      if (gateway is FirebaseGateway) {
        await FirebaseGateway.initialize();
        if (epoch != _generation) return;
      }
      if (gateway is FirebaseGateway &&
          FirebaseAuth.instance.currentUser?.uid != boundUid) {
        throw const LicenseException(
          'account_session',
          'سجل الدخول بالحساب صاحب العمليات المحفوظة لاستئناف المزامنة.',
        );
      }
      final status = await synchronizeLicense(
        session: currentSession,
        bootstrap: () async {
          final response = await gateway.bootstrap(boundTenant, identity!);
          if (epoch != _generation) throw StateError('session_changed');
          final raw = response['licensePackage'];
          return raw is String ? raw : jsonEncode(raw);
        },
        activate: (package) async {
          if (epoch != _generation) throw StateError('session_changed');
          await gateway.activateLicense(
            boundTenant,
            identity!.deviceId,
            package,
          );
        },
      );
      if (epoch != _generation) return;
      license = status;
      _enforceRevocation();
      notifyListeners();
      if (!status.operationalAllowed) {
        syncMessage = status.message;
        return;
      }
      if (_dataRevoked) {
        await _open(
          boundTenant,
          boundUid,
          employeeId,
          business,
          package: currentSession.exportPackage(),
        );
        syncing = false;
        unawaited(synchronize());
        return;
      }
      // Server decides expiry on receipt. An expired queue is retained until renewal.
      final queue = await db.listOutbox();
      for (final raw in queue) {
        if (epoch != _generation) return;
        final retryAfterRenewal =
            raw.status == 'blocked' &&
            {'license_expired', 'license-expired'}.contains(raw.error);
        if (retryAfterRenewal) {
          // This fresh authenticated bootstrap confirmed current entitlement.
          // Only license-expiry blocks are automatically retried; permission
          // denials and accounting conflicts still require explicit review.
          await db.retry(raw.id);
        }
        final item = {
          ...raw.toOperation(),
          'state': retryAfterRenewal ? 'pending' : raw.status,
          'nextAttemptMs': retryAfterRenewal ? 0 : raw.nextAttemptMs,
        };
        if (item['state'] == 'conflict' || item['state'] == 'blocked') continue;
        final next = item['nextAttemptMs'];
        if (next is int && next > DateTime.now().millisecondsSinceEpoch) {
          continue;
        }
        try {
          final response = await gateway.send(tenantId, identity!.deviceId, {
            'id': item['id'],
            'entity': item['entity'],
            'payload': item['payload'],
            'expectedRevision': item['expectedRevision'] ?? 0,
          });
          if (epoch != _generation) return;
          final expectedStatus = item['entity'] == 'submission'
              ? 'awaiting_approval'
              : 'accepted';
          if (response['id'] != item['id'] ||
              (response['status'] != 'conflict' &&
                  response['status'] != expectedStatus)) {
            throw const LedgerException(
              'sync_response',
              'تعذر تأكيد قبول العملية؛ حُفظت لإعادة المحاولة دون تكرار.',
            );
          }
          if (response['status'] == 'conflict') {
            await db.fail(
              item['id'] as String,
              response['reason'] as String? ?? 'server_conflict',
              conflict: true,
            );
          } else {
            await db.acknowledge(
              item['id'] as String,
              sessionUserId: uid,
              sessionTenantId: tenantId,
              serverEntry: response['entry'] == null
                  ? null
                  : Map<String, dynamic>.from(response['entry'] as Map),
            );
          }
        } catch (e) {
          if (epoch != _generation) return;
          final code = e is FirebaseFunctionsException
              ? (e.details is Map
                    ? (e.details as Map)['reason'] as String? ?? e.code
                    : e.code)
              : e is FirebaseAuthException
              ? e.code
              : 'server_error';
          await db.fail(item['id'] as String, code);
          rethrow;
        }
      }
      var cursor = (await db.preference('cursor') as int?) ?? 0;
      var pages = 0;
      do {
        final response = await gateway.pull(
          tenantId,
          identity!.deviceId,
          cursor,
        );
        if (epoch != _generation) return;
        _remoteApplyEpoch = epoch;
        try {
          await db.applyRemoteBatch([
            for (final change in (response['changes'] as List).cast<Map>())
              {
                'entity': change['entity'],
                'payload': Map<String, dynamic>.from(change['payload'] as Map),
              },
          ]);
          if (epoch != _generation) return;
          cursor = response['lastSequence'] as int;
          await db.setPreference('cursor', cursor);
        } finally {
          if (_remoteApplyEpoch == epoch) _remoteApplyEpoch = null;
        }
        if (epoch != _generation) return;
        // Show each committed page once instead of materializing the entire
        // ledger again for every remote row during multi-season initial sync.
        await refresh();
        if (response['hasMore'] != true) break;
      } while (++pages < 200);
      await db.setPreference(
        'lastSyncMs',
        DateTime.now().millisecondsSinceEpoch,
      );
      syncMessage = 'اكتملت المزامنة مع الخادم';
      error = null;
    } catch (e) {
      if (epoch == _generation &&
          e is FirebaseAuthException &&
          e.code == 'user-disabled' &&
          licenseSession != null) {
        license = await licenseSession!.recordAccountDisabled();
        _enforceRevocation();
      }
      syncMessage = arabicError(e);
    } finally {
      if (epoch == _generation) {
        syncing = false;
        if (hasDataAccess) await refresh();
        notifyListeners();
      }
    }
  }

  Future<void> retry(String id) async {
    await store!.retry(id);
    unawaited(synchronize());
  }

  Future<void> signOut() async {
    _generation++;
    store?.revokeAccess();
    await _databaseChanges?.cancel();
    await store?.close();
    store = null;
    licenseSession = null;
    license = null;
    entries = [];
    recentEntries = [];
    parties = [];
    employees = [];
    terms = [];
    pending = [];
    submissions = [];
    syncing = false;
    await security.writeSecureValue('last-session', '');
    if (Firebase.apps.isNotEmpty) await FirebaseAuth.instance.signOut();
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    store?.revokeAccess();
    unawaited(_connectivity?.cancel());
    unawaited(_databaseChanges?.cancel());
    unawaited(store?.close());
    super.dispose();
  }
}
