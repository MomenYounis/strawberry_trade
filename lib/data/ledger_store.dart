import 'dart:async';
import 'dart:convert';

import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_sqlcipher/sqflite.dart' as cipher;

import '../domain/ledger.dart';

class OutboxItem {
  const OutboxItem({
    required this.id,
    required this.entity,
    required this.payload,
    required this.status,
    required this.attempts,
    required this.nextAttemptMs,
    required this.error,
  });
  final String id, entity, status, error;
  final int attempts, nextAttemptMs;
  final Map<String, dynamic> payload;
  Map<String, dynamic> toOperation() => {
    'id': id,
    'entity': entity,
    'payload': payload,
    'expectedRevision': 0,
  };
  factory OutboxItem.fromRow(Map<String, Object?> row) => OutboxItem(
    id: row['id']! as String,
    entity: row['entity']! as String,
    payload: Map<String, dynamic>.from(
      jsonDecode(row['payload']! as String) as Map,
    ),
    status: row['status']! as String,
    attempts: row['attempts']! as int,
    nextAttemptMs: row['next_attempt_ms']! as int,
    error: row['error']! as String,
  );
}

/// Transaction-local validation state. Remote pages load these projections once
/// and extend them only after each validated insert succeeds.
class _RemoteProjection {
  _RemoteProjection(this.entries, this.parties, this.employees, this.terms);
  final List<LedgerEntry> entries;
  final List<Party> parties;
  final List<Employee> employees;
  final List<SalaryTerm> terms;
}

/// A store is permanently bound to a tenant, UID, and role. Closing it invalidates
/// asynchronous acknowledgments. A new session always opens its own store.
class LedgerStore {
  LedgerStore._(
    this._db,
    this.tenantId,
    this.userId,
    this.role,
    this.employeeId,
  );
  static const schemaVersion = 2;
  final Database _db;
  final String tenantId, userId, role;
  final String? employeeId;
  final _changes = StreamController<void>.broadcast();
  bool _closed = false;
  bool _revoked = false;
  Stream<void> get changes => _changes.stream;

  /// Invalidates stale route and synchronization handles immediately. Only a
  /// fresh authenticated session may open another store after revocation.
  void revokeAccess() {
    _revoked = true;
  }

  /// Production uses SQLCipher with the Keystore-protected random database key.
  /// Injecting a factory is only for real SQLite disk tests; it is unencrypted.
  static Future<LedgerStore> open({
    required String path,
    required String tenantId,
    required String userId,
    String role = 'manager',
    String? employeeId,
    String? password,
    DatabaseFactory? factory,
  }) async {
    safeId(tenantId);
    safeId(userId);
    if (!{'manager', 'employee'}.contains(role)) {
      invalid('role', 'صلاحية الحساب غير معروفة');
    }
    if (role == 'employee') safeId(employeeId ?? '');
    final options = OpenDatabaseOptions(
      version: schemaVersion,
      onConfigure: (db) async {
        await db.execute('PRAGMA foreign_keys = ON');
        await db.rawQuery('PRAGMA busy_timeout = 5000');
      },
      onCreate: (db, version) async {
        await _createV1(db);
        if (version >= 2) await _upgrade(db, 1, version);
      },
      onUpgrade: _upgrade,
      singleInstance: false,
    );
    final Database db;
    if (factory != null) {
      db = await factory.openDatabase(path, options: options);
    } else {
      if (password == null || password.length < 32) {
        invalid(
          'database_key',
          'مفتاح قاعدة البيانات الآمن غير متاح؛ أعد تسجيل الجهاز',
        );
      }
      db = await cipher.openDatabase(
        path,
        password: password,
        version: schemaVersion,
        onConfigure: options.onConfigure,
        onCreate: options.onCreate,
        onUpgrade: options.onUpgrade,
        singleInstance: false,
      );
      final cipherVersion = await db.rawQuery('PRAGMA cipher_version');
      if (cipherVersion.isEmpty) {
        await db.close();
        invalid('database_encryption', 'تعذر التحقق من تشفير قاعدة البيانات');
      }
    }
    try {
      await db.transaction((tx) async {
        final existing = await tx.query('scope');
        if (existing.isEmpty) {
          await tx.insert('scope', {
            'id': 1,
            'tenant_id': tenantId,
            'user_id': userId,
            'role': role,
            'employee_id': employeeId ?? '',
          });
        } else {
          final row = existing.single;
          if (row['tenant_id'] != tenantId ||
              row['user_id'] != userId ||
              row['role'] != role ||
              row['employee_id'] != (employeeId ?? '')) {
            invalid(
              'scope_mismatch',
              'قاعدة البيانات تخص حساباً أو منشأة أو صلاحية أخرى',
            );
          }
        }
      });
      return LedgerStore._(db, tenantId, userId, role, employeeId);
    } catch (_) {
      await db.close();
      rethrow;
    }
  }

  static Future<void> _createV1(DatabaseExecutor db) async {
    for (final sql in <String>[
      'CREATE TABLE scope(id INTEGER PRIMARY KEY CHECK(id=1), tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, employee_id TEXT NOT NULL)',
      'CREATE TABLE parties(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN (\'merchant\',\'supplier\')), name TEXT NOT NULL, payload TEXT NOT NULL)',
      'CREATE INDEX parties_name ON parties(kind,name)',
      'CREATE TABLE employees(id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL)',
      'CREATE TABLE salary_terms(id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id), effective_month TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(employee_id,effective_month))',
      'CREATE INDEX salary_employee_month ON salary_terms(employee_id,effective_month)',
      'CREATE TABLE entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL, date TEXT NOT NULL, party_id TEXT REFERENCES parties(id), employee_id TEXT REFERENCES employees(id), original_id TEXT REFERENCES entries(id), payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT \'pending\')',
      'CREATE INDEX entries_date ON entries(date,id)',
      'CREATE INDEX entries_party ON entries(party_id,date,id)',
      'CREATE INDEX entries_original ON entries(original_id)',
      'CREATE TABLE submissions(id TEXT PRIMARY KEY, creator_uid TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT \'pending\', review TEXT)',
      'CREATE INDEX submissions_creator ON submissions(creator_uid,state)',
      'CREATE TABLE outbox(id TEXT PRIMARY KEY, entity TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), error TEXT NOT NULL DEFAULT \'\', created_ms INTEGER NOT NULL)',
      'CREATE TABLE drafts(id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_ms INTEGER NOT NULL)',
      'CREATE TABLE preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      'CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, actor_uid TEXT NOT NULL, action TEXT NOT NULL, created_ms INTEGER NOT NULL)',
    ]) {
      await db.execute(sql);
    }
  }

  static Future<void> _upgrade(
    Database db,
    int oldVersion,
    int newVersion,
  ) async {
    if (oldVersion < 2 && newVersion >= 2) {
      await db.execute(
        'ALTER TABLE outbox ADD COLUMN next_attempt_ms INTEGER NOT NULL DEFAULT 0',
      );
      await db.execute(
        'CREATE INDEX outbox_schedule ON outbox(status,next_attempt_ms,created_ms)',
      );
      await db.execute(
        'CREATE TABLE conflicts(id TEXT PRIMARY KEY, entity TEXT NOT NULL, local_payload TEXT NOT NULL, remote_payload TEXT NOT NULL, reason TEXT NOT NULL, created_ms INTEGER NOT NULL, resolution TEXT)',
      );
    }
  }

  void _ready() {
    if (_closed) invalid('closed', 'تم إغلاق جلسة الحساب');
    if (_revoked) {
      invalid('access_revoked', 'أُلغيت صلاحية هذه الجلسة؛ أعد تسجيل الدخول');
    }
  }

  Future<T> _transaction<T>(Future<T> Function(Transaction) action) =>
      _db.transaction((tx) async {
        _ready();
        final result = await action(tx);
        // If revocation arrived while the action awaited SQLite, abort the
        // transaction before commit, including its outbox and audit writes.
        _ready();
        return result;
      });

  void _manager() {
    _ready();
    if (role != 'manager') {
      invalid('forbidden', 'هذه البيانات متاحة للمدير فقط');
    }
  }

  void _scope(String tenant) {
    if (tenant != tenantId) {
      invalid('tenant_mismatch', 'البيانات لا تخص هذه المنشأة');
    }
  }

  void _notify() {
    if (!_closed) _changes.add(null);
  }

  static Map<String, dynamic> _payload(Map<String, Object?> row) =>
      Map<String, dynamic>.from(jsonDecode(row['payload']! as String) as Map);
  static Map<String, dynamic> _normalized(
    String table,
    Map<String, dynamic> payload,
  ) => switch (table) {
    'entries' => LedgerEntry.fromJson(payload).toJson(),
    'parties' => Party.fromJson(payload).toJson(),
    'employees' => Employee.fromJson(payload).toJson(),
    'salary_terms' => SalaryTerm.fromJson(payload).toJson(),
    'submissions' => EmployeeSubmission.fromJson(payload).toJson(),
    _ => payload,
  };
  Future<void> _audit(Transaction tx, String id, String action) async {
    await tx.insert('audit', {
      'operation_id': id,
      'actor_uid': userId,
      'action': action,
      'created_ms': DateTime.now().millisecondsSinceEpoch,
    });
  }

  Future<void> _enqueue(
    Transaction tx,
    String id,
    String entity,
    Map<String, dynamic> payload,
  ) async {
    await tx.insert('outbox', {
      'id': id,
      'entity': entity,
      'payload': jsonEncode(payload),
      'created_ms': DateTime.now().millisecondsSinceEpoch,
    });
    await _audit(tx, id, 'local_$entity');
  }

  Future<List<LedgerEntry>> _entries(DatabaseExecutor db) async =>
      (await db.query(
        'entries',
        orderBy: 'date ASC,id ASC',
      )).map((r) => LedgerEntry.fromJson(_payload(r))).toList();
  Future<List<Party>> _parties(DatabaseExecutor db) async => (await db.query(
    'parties',
    orderBy: 'name ASC',
  )).map((r) => Party.fromJson(_payload(r))).toList();
  Future<List<Employee>> _employees(DatabaseExecutor db) async =>
      (await db.query(
        'employees',
        orderBy: 'name ASC',
      )).map((r) => Employee.fromJson(_payload(r))).toList();
  Future<List<SalaryTerm>> _terms(DatabaseExecutor db) async => (await db.query(
    'salary_terms',
    orderBy: 'effective_month ASC,id ASC',
  )).map((r) => SalaryTerm.fromJson(_payload(r))).toList();

  Future<List<LedgerEntry>> listEntries({
    String? partyId,
    String? from,
    String? to,
    int? limit,
    int offset = 0,
  }) async {
    _manager();
    final conditions = <String>[];
    final args = <Object?>[];
    if (partyId != null) {
      conditions.add('party_id=?');
      args.add(partyId);
    }
    if (from != null) {
      conditions.add('date>=?');
      args.add(from);
    }
    if (to != null) {
      conditions.add('date<=?');
      args.add(to);
    }
    return (await _db.query(
      'entries',
      where: conditions.isEmpty ? null : conditions.join(' AND '),
      whereArgs: args,
      orderBy: limit == null ? 'date ASC,rowid ASC,id ASC' : 'date ASC,id ASC',
      limit: limit,
      offset: offset,
    )).map((r) => LedgerEntry.fromJson(_payload(r))).toList();
  }

  Future<List<LedgerEntry>> listRecentEntries({int limit = 10}) async {
    _manager();
    return (await _db.query(
      'entries',
      orderBy: 'rowid DESC',
      limit: limit,
    )).map((r) => LedgerEntry.fromJson(_payload(r))).toList();
  }

  Future<List<Party>> listParties({String? kind, String search = ''}) async {
    _ready();
    // Employees receive a separate redacted directory; opening balances never leave this method.
    final rows = await _db.query(
      'parties',
      where: kind == null ? null : 'kind=?',
      whereArgs: kind == null ? null : [kind],
      orderBy: 'name ASC',
    );
    return rows
        .map((r) => Party.fromJson(_payload(r)))
        .where((p) => p.name.contains(search) || p.phone.contains(search))
        .map(
          (p) => role == 'manager'
              ? p
              : Party(
                  id: p.id,
                  tenantId: p.tenantId,
                  name: p.name,
                  kind: p.kind,
                  phone: p.phone,
                  favorite: p.favorite,
                ),
        )
        .toList();
  }

  Future<List<Employee>> listEmployees() async {
    _manager();
    return _employees(_db);
  }

  Future<List<SalaryTerm>> listSalaryTerms() async {
    _manager();
    return _terms(_db);
  }

  Future<bool> _identicalOrAbsent(
    Transaction tx,
    String table,
    String id,
    Map<String, dynamic> desired,
  ) async {
    final rows = await tx.query(table, where: 'id=?', whereArgs: [id]);
    if (rows.isEmpty) return false;
    if (canonicalJson(_normalized(table, _payload(rows.single))) ==
        canonicalJson(_normalized(table, desired))) {
      return true;
    }
    invalid(
      'immutable',
      'السجل محفوظ بالفعل؛ استخدم قيداً عكسياً موثقاً للتصحيح',
    );
  }

  Future<void> saveParty(Party party) async {
    _manager();
    _scope(party.tenantId);
    party.validate();
    await _transaction((tx) async {
      if (await _identicalOrAbsent(tx, 'parties', party.id, party.toJson())) {
        return;
      }
      await tx.insert('parties', {
        'id': party.id,
        'kind': party.kind,
        'name': party.name,
        'payload': jsonEncode(party.toJson()),
      });
      await _enqueue(tx, party.id, 'party', party.toJson());
    });
    _notify();
  }

  Future<void> saveEmployee(Employee employee) async {
    _manager();
    _scope(employee.tenantId);
    employee.validate();
    await _transaction((tx) async {
      if (await _identicalOrAbsent(
        tx,
        'employees',
        employee.id,
        employee.toJson(),
      )) {
        return;
      }
      await tx.insert('employees', {
        'id': employee.id,
        'name': employee.name,
        'payload': jsonEncode(employee.toJson()),
      });
      await _enqueue(tx, employee.id, 'employee', employee.toJson());
    });
    _notify();
  }

  Future<void> saveSalaryTerm(SalaryTerm term) async {
    _manager();
    _scope(term.tenantId);
    term.validate();
    await _transaction((tx) async {
      if (await _identicalOrAbsent(
        tx,
        'salary_terms',
        term.id,
        term.toJson(),
      )) {
        return;
      }
      if (!(await _employees(tx)).any((e) => e.id == term.employeeId)) {
        invalid('invalid_employee', 'الموظف غير موجود');
      }
      // Adding a retroactive term must not silently change a paid historical month.
      final later =
          (await _terms(tx))
              .where(
                (t) =>
                    t.employeeId == term.employeeId &&
                    t.effectiveMonth.compareTo(term.effectiveMonth) > 0,
              )
              .map((t) => t.effectiveMonth)
              .toList()
            ..sort();
      if ((await _entries(tx)).any(
        (e) =>
            e.kind == 'payroll' &&
            e.employeeId == term.employeeId &&
            e.salaryMonth.compareTo(term.effectiveMonth) >= 0 &&
            (later.isEmpty || e.salaryMonth.compareTo(later.first) < 0),
      )) {
        invalid(
          'historical_salary',
          'لا يمكن تعديل راتب شهر صُرفت منه دفعة؛ احتفظ بالمستند التاريخي',
        );
      }
      await tx.insert('salary_terms', {
        'id': term.id,
        'employee_id': term.employeeId,
        'effective_month': term.effectiveMonth,
        'payload': jsonEncode(term.toJson()),
      });
      await _enqueue(tx, term.id, 'salary_term', term.toJson());
    });
    _notify();
  }

  Future<void> _insertEntry(
    Transaction tx,
    LedgerEntry entry, {
    bool enqueue = true,
    String state = 'pending',
  }) async {
    await tx.insert('entries', {
      'id': entry.id,
      'kind': entry.kind,
      'date': entry.date,
      'party_id': entry.partyId.isEmpty ? null : entry.partyId,
      'employee_id': entry.employeeId.isEmpty ? null : entry.employeeId,
      'original_id': entry.originalId.isEmpty ? null : entry.originalId,
      'payload': jsonEncode(entry.toJson()),
      'state': state,
    });
    if (enqueue) await _enqueue(tx, entry.id, 'entry', entry.toJson());
  }

  Future<void> saveEntry(LedgerEntry entry) async {
    _manager();
    _scope(entry.tenantId);
    if (entry.creatorUid != userId) {
      invalid('creator', 'لا يمكن تسجيل عملية باسم حساب آخر');
    }
    await _transaction((tx) async {
      if (await _identicalOrAbsent(tx, 'entries', entry.id, entry.toJson())) {
        return;
      }
      LedgerRules.validateEntry(
        entry,
        await _entries(tx),
        await _parties(tx),
        await _employees(tx),
        await _terms(tx),
      );
      await _insertEntry(tx, entry);
      await tx.delete('drafts', where: 'id=?', whereArgs: [entry.id]);
    });
    _notify();
  }

  Future<void> saveSubmission(EmployeeSubmission submission) async {
    _ready();
    _scope(submission.tenantId);
    submission.validate();
    if (role != 'employee' ||
        submission.creatorUid != userId ||
        submission.employeeId != employeeId) {
      invalid('creator', 'لا يمكن إرسال طلب باسم موظف آخر');
    }
    await _transaction((tx) async {
      if (await _identicalOrAbsent(
        tx,
        'submissions',
        submission.id,
        submission.toJson(),
      )) {
        return;
      }
      if (submission.partyId.isNotEmpty &&
          !(await _parties(tx)).any(
            (p) =>
                p.id == submission.partyId &&
                p.name == submission.partyName &&
                p.kind ==
                    ((submission.kind == 'delivery' ||
                            submission.kind == 'sale_return')
                        ? 'merchant'
                        : 'supplier'),
          )) {
        invalid('invalid_party', 'اختر العميل أو المورد الصحيح');
      }
      await tx.insert('submissions', {
        'id': submission.id,
        'creator_uid': userId,
        'payload': jsonEncode(submission.toJson()),
      });
      await _enqueue(tx, submission.id, 'submission', submission.toJson());
      await tx.delete('drafts', where: 'id=?', whereArgs: [submission.id]);
    });
    _notify();
  }

  Future<List<Map<String, dynamic>>> listSubmissions() async {
    _ready();
    final rows = await _db.query(
      'submissions',
      where: role == 'employee' ? 'creator_uid=?' : null,
      whereArgs: role == 'employee' ? [userId] : null,
      orderBy: 'id DESC',
    );
    return rows
        .map(
          (r) => {
            ..._payload(r),
            'state': r['state'],
            'review': r['review'] == null
                ? null
                : jsonDecode(r['review']! as String),
          },
        )
        .toList();
  }

  Future<void> saveReview({
    required String id,
    required String submissionId,
    required bool approved,
    LedgerEntry? entry,
    String note = '',
  }) async {
    _manager();
    safeId(id);
    safeId(submissionId);
    if (note.length > 1000 ||
        (!approved && note.trim().isEmpty) ||
        approved != (entry != null)) {
      invalid('review', 'أدخل قرار المراجعة وسببه أو بيانات الاعتماد');
    }
    final payload = <String, dynamic>{
      'submissionId': submissionId,
      'decision': approved ? 'approved' : 'rejected',
      'note': note,
      if (entry != null) 'entry': entry.toJson(),
    };
    await _transaction((tx) async {
      final queued = await tx.query('outbox', where: 'id=?', whereArgs: [id]);
      if (queued.isNotEmpty) {
        if (queued.single['entity'] == 'review' &&
            canonicalJson(_payload(queued.single)) == canonicalJson(payload)) {
          return;
        }
        invalid('review_duplicate', 'معرّف المراجعة محفوظ بمحتوى مختلف');
      }
      final rows = await tx.query(
        'submissions',
        where: 'id=?',
        whereArgs: [submissionId],
      );
      if (rows.isEmpty) invalid('submission_missing', 'طلب الموظف غير موجود');
      final row = rows.single;
      if (!{
        'pending',
        'awaiting_approval',
        'server_accepted',
      }.contains(row['state'])) {
        invalid(
          'already_reviewed',
          'هذا الطلب قيد المراجعة أو سبق اتخاذ قرار بشأنه',
        );
      }
      if (entry != null) {
        _scope(entry.tenantId);
        final original = EmployeeSubmission.fromJson(_payload(row));
        final expectedKind =
            {
              'delivery': 'sale',
              'purchase_delivery': 'purchase',
            }[original.kind] ??
            original.kind;
        if (entry.creatorUid != original.creatorUid ||
            entry.kind != expectedKind ||
            entry.date != original.date ||
            entry.partyId != original.partyId ||
            entry.partyName != original.partyName ||
            entry.qtyMilli != original.qtyMilli ||
            entry.grade != original.grade ||
            entry.unit != original.unit ||
            entry.originalId != original.originalId ||
            entry.employeeId.isNotEmpty ||
            entry.salaryMonth.isNotEmpty ||
            (original.kind == 'expense_business' &&
                (entry.totalMinor != original.amountMinor ||
                    entry.category != original.category))) {
          invalid(
            'submission_changed',
            'لا يمكن تغيير حقائق طلب الموظف أثناء الاعتماد',
          );
        }
        LedgerRules.validateEntry(
          entry,
          await _entries(tx),
          await _parties(tx),
          await _employees(tx),
          await _terms(tx),
        );
        // Provisional approval has no ledger effect until atomic server acceptance.
      }
      await tx.update(
        'submissions',
        {'state': 'review_pending', 'review': jsonEncode(payload)},
        where: 'id=?',
        whereArgs: [submissionId],
      );
      await _enqueue(tx, id, 'review', payload);
    });
    _notify();
  }

  Future<List<OutboxItem>> listOutbox({
    bool dueOnly = false,
    int? nowMs,
  }) async {
    _ready();
    final rows = await _db.query(
      'outbox',
      where: dueOnly
          ? "status IN ('pending','retry') AND next_attempt_ms<=?"
          : null,
      whereArgs: dueOnly
          ? [nowMs ?? DateTime.now().millisecondsSinceEpoch]
          : null,
      orderBy: 'created_ms ASC,rowid ASC',
    );
    return rows.map(OutboxItem.fromRow).toList();
  }

  Future<String?> entryState(String id) async {
    _manager();
    final rows = await _db.query(
      'entries',
      columns: ['state'],
      where: 'id=?',
      whereArgs: [id],
    );
    return rows.firstOrNull?['state'] as String?;
  }

  Future<void> acknowledge(
    String id, {
    String? sessionUserId,
    String? sessionTenantId,
    Map<String, dynamic>? serverEntry,
  }) async {
    _ready();
    if ((sessionUserId != null && sessionUserId != userId) ||
        (sessionTenantId != null && sessionTenantId != tenantId)) {
      invalid('stale_session', 'تم تجاهل استجابة تخص جلسة أخرى');
    }
    await _transaction((tx) async {
      final rows = await tx.query('outbox', where: 'id=?', whereArgs: [id]);
      if (rows.isEmpty) return;
      final item = OutboxItem.fromRow(rows.single);
      if (item.entity == 'entry') {
        await tx.update(
          'entries',
          {'state': 'server_accepted'},
          where: 'id=?',
          whereArgs: [id],
        );
      }
      if (item.entity == 'submission') {
        await tx.update(
          'submissions',
          {'state': 'awaiting_approval'},
          where: 'id=?',
          whereArgs: [id],
        );
      }
      if (item.entity == 'review') {
        final approved = item.payload['decision'] == 'approved';
        if (approved) {
          if (serverEntry == null) {
            invalid('ack_incomplete', 'اعتماد الخادم لا يحتوي القيد النهائي');
          }
          final entry = LedgerEntry.fromJson(serverEntry);
          _scope(entry.tenantId);
          final desired = Map<String, dynamic>.from(
            item.payload['entry'] as Map,
          );
          if (canonicalJson(entry.toJson()) !=
              canonicalJson(LedgerEntry.fromJson(desired).toJson())) {
            invalid('ack_mismatch', 'القيد المقبول مختلف؛ يلزم حل التعارض');
          }
          if (!await _identicalOrAbsent(
            tx,
            'entries',
            entry.id,
            entry.toJson(),
          )) {
            LedgerRules.validateEntry(
              entry,
              await _entries(tx),
              await _parties(tx),
              await _employees(tx),
              await _terms(tx),
            );
            await _insertEntry(
              tx,
              entry,
              enqueue: false,
              state: 'server_accepted',
            );
          }
        }
        await tx.update(
          'submissions',
          {'state': approved ? 'approved' : 'rejected'},
          where: 'id=?',
          whereArgs: [item.payload['submissionId']],
        );
      }
      await tx.delete('outbox', where: 'id=?', whereArgs: [id]);
      await _audit(tx, id, 'server_accepted');
    });
    _notify();
  }

  Future<void> fail(
    String id,
    String code, {
    bool conflict = false,
    int? nowMs,
  }) async {
    _ready();
    await _transaction((tx) async {
      final rows = await tx.query('outbox', where: 'id=?', whereArgs: [id]);
      if (rows.isEmpty) return;
      final item = OutboxItem.fromRow(rows.single);
      final attempts = item.attempts + 1;
      final delay = 1000 * (1 << attempts.clamp(0, 12));
      final status = conflict
          ? 'conflict'
          : ({
                  'permission-denied',
                  'unauthenticated',
                  'license_expired',
                  'license-expired',
                }.contains(code)
                ? 'blocked'
                : 'retry');
      await tx.update(
        'outbox',
        {
          'attempts': attempts,
          'error': code.length > 160 ? 'server_error' : code,
          'status': status,
          'next_attempt_ms':
              (nowMs ?? DateTime.now().millisecondsSinceEpoch) + delay,
        },
        where: 'id=?',
        whereArgs: [id],
      );
      if (item.entity == 'entry') {
        await tx.update(
          'entries',
          {'state': status},
          where: 'id=?',
          whereArgs: [id],
        );
      }
      if (conflict) {
        await tx.insert('conflicts', {
          'id': id,
          'entity': item.entity,
          'local_payload': jsonEncode(item.payload),
          'remote_payload': '{}',
          'reason': code.length > 160 ? 'server_conflict' : code,
          'created_ms': DateTime.now().millisecondsSinceEpoch,
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
      }
    });
    _notify();
  }

  Future<void> retry(String id) async {
    _ready();
    await _transaction((tx) async {
      final rows = await tx.query('outbox', where: 'id=?', whereArgs: [id]);
      if (rows.isEmpty) return;
      if (rows.single['status'] == 'conflict') {
        invalid('resolve_conflict', 'راجع التعارض قبل إعادة الإرسال');
      }
      await tx.update(
        'outbox',
        {'status': 'pending', 'next_attempt_ms': 0, 'error': ''},
        where: 'id=?',
        whereArgs: [id],
      );
    });
    _notify();
  }

  Future<List<Map<String, Object?>>> listConflicts() async {
    _ready();
    return _db.query('conflicts', orderBy: 'created_ms ASC');
  }

  /// An explicit manager choice can accept the preserved server version only
  /// after revalidating the complete resulting ledger and all dependent returns.
  /// The original local facts and both versions remain in the conflict evidence.
  Future<void> resolveConflict(
    String id, {
    required String note,
    bool acceptRemote = false,
  }) async {
    _manager();
    if (note.trim().isEmpty || note.length > 1000) {
      invalid('resolution', 'أدخل وصفاً واضحاً لتسوية التعارض');
    }
    await _transaction((tx) async {
      final rows = await tx.query('conflicts', where: 'id=?', whereArgs: [id]);
      if (rows.isEmpty) invalid('conflict_missing', 'التعارض غير موجود');
      if (acceptRemote) {
        final conflict = rows.single;
        if (conflict['entity'] != 'entry') {
          invalid('resolution_entity', 'هذه التسوية متاحة للقيود المالية فقط');
        }
        final remote = LedgerEntry.fromJson(
          Map<String, dynamic>.from(
            jsonDecode(conflict['remote_payload']! as String) as Map,
          ),
        );
        _scope(remote.tenantId);
        if (remote.id != id) {
          invalid(
            'resolution_remote',
            'نسخة الخادم غير متاحة أو لا تطابق القيد',
          );
        }
        final all = await _entries(tx);
        final pending = [
          for (final e in all)
            if (e.id == id) remote else e,
        ];
        final validated = <LedgerEntry>[];
        while (pending.isNotEmpty) {
          final index = pending.indexWhere(
            (e) =>
                e.originalId.isEmpty ||
                validated.any((v) => v.id == e.originalId),
          );
          if (index < 0) {
            invalid(
              'resolution_relationship',
              'تعذر التحقق من العلاقات؛ راجع المرتجعات أولاً',
            );
          }
          final e = pending.removeAt(index);
          LedgerRules.validateEntry(
            e,
            validated,
            await _parties(tx),
            await _employees(tx),
            await _terms(tx),
          );
          validated.add(e);
        }
        await tx.update(
          'entries',
          {
            'kind': remote.kind,
            'date': remote.date,
            'party_id': remote.partyId.isEmpty ? null : remote.partyId,
            'employee_id': remote.employeeId.isEmpty ? null : remote.employeeId,
            'original_id': remote.originalId.isEmpty ? null : remote.originalId,
            'payload': jsonEncode(remote.toJson()),
            'state': 'server_accepted',
          },
          where: 'id=?',
          whereArgs: [id],
        );
        await tx.delete('outbox', where: 'id=?', whereArgs: [id]);
      }
      await tx.update(
        'conflicts',
        {'resolution': note},
        where: 'id=?',
        whereArgs: [id],
      );
      if (!acceptRemote) {
        await tx.update(
          'outbox',
          {'status': 'blocked', 'error': 'resolved_requires_correction'},
          where: 'id=?',
          whereArgs: [id],
        );
      }
      await _audit(
        tx,
        id,
        acceptRemote
            ? 'conflict_explicit_accept_remote'
            : 'conflict_resolution_recorded',
      );
    });
    _notify();
  }

  /// Only pass server-confirmed snapshots from the session's trusted endpoint.
  /// Conflicting immutable facts are retained side by side, never overwritten.
  Future<void> applyRemote(String entity, Map<String, dynamic> payload) =>
      applyRemoteBatch([
        {'entity': entity, 'payload': payload},
      ]);

  static const maxRemoteBatchSize = 1000;

  /// One trusted cursor page is committed atomically and emits one notification.
  /// A failed event rolls back the whole page, including its audit evidence.
  Future<void> applyRemoteBatch(List<Map<String, dynamic>> changes) async {
    _ready();
    if (changes.length > maxRemoteBatchSize) {
      invalid('remote_batch_size', 'دفعة المزامنة أكبر من الحد المسموح');
    }
    if (changes.isEmpty) return;
    await _transaction((tx) async {
      final projection = _RemoteProjection(
        await _entries(tx),
        await _parties(tx),
        await _employees(tx),
        await _terms(tx),
      );
      for (final change in changes) {
        final entity = strictString(change, 'entity');
        final payload = change['payload'];
        if (payload is! Map) {
          invalid('remote_payload', 'بيانات دفعة المزامنة غير صالحة');
        }
        await _applyRemote(
          tx,
          entity,
          Map<String, dynamic>.from(payload),
          projection,
        );
      }
    });
    _notify();
  }

  Future<void> _applyRemote(
    Transaction tx,
    String entity,
    Map<String, dynamic> payload,
    _RemoteProjection projection,
  ) async {
    _ready();
    _scope(strictString(payload, 'tenantId'));
    final id = strictString(payload, 'id');
    safeId(id);
    String? submissionState;
    String? submissionReviewJson;
    if (entity == 'submission') {
      const fields = {
        'id',
        'tenantId',
        'creatorUid',
        'employeeId',
        'kind',
        'date',
        'partyId',
        'partyName',
        'qtyMilli',
        'grade',
        'unit',
        'originalId',
        'amountMinor',
        'note',
        'category',
      };
      const metadata = {
        'status',
        'recordedByUid',
        'recordedAtMs',
        'approvedUnitMinor',
        'reviewNote',
      };
      if (payload.keys.any(
        (key) => !fields.contains(key) && !metadata.contains(key),
      )) {
        invalid('private_data', 'طلب الخادم يحتوي حقولاً غير مصرح بها');
      }
      final status = payload['status'] ?? 'pending';
      if (!{'pending', 'approved', 'rejected'}.contains(status)) {
        invalid('submission_state', 'حالة طلب الخادم غير صالحة');
      }
      final approvedUnitMinor = payload['approvedUnitMinor'];
      if (approvedUnitMinor != null &&
          (approvedUnitMinor is! int ||
              approvedUnitMinor < 0 ||
              approvedUnitMinor > 1000000000)) {
        invalid('private_data', 'سعر الاعتماد غير صالح');
      }
      final reviewNote = payload['reviewNote'];
      if (reviewNote != null &&
          (reviewNote is! String || reviewNote.length > 1000)) {
        invalid('private_data', 'ملاحظة المراجعة غير صالحة');
      }
      if (approvedUnitMinor is int ||
          (reviewNote is String && reviewNote.isNotEmpty)) {
        submissionReviewJson = jsonEncode({
          'decision': status,
          if (approvedUnitMinor is int) 'approvedUnitMinor': approvedUnitMinor,
          if (reviewNote is String && reviewNote.isNotEmpty) 'note': reviewNote,
        });
      }
      submissionState = status == 'pending'
          ? 'awaiting_approval'
          : status as String;
      payload = EmployeeSubmission.fromJson({
        for (final key in fields)
          if (payload.containsKey(key)) key: payload[key],
      }).toJson();
    } else if (entity == 'entry') {
      payload = LedgerEntry.fromJson(payload).toJson();
    } else if (entity == 'party') {
      payload = Party.fromJson(payload).toJson();
    } else if (entity == 'employee') {
      payload = Employee.fromJson(payload).toJson();
    } else if (entity == 'salary_term') {
      payload = SalaryTerm.fromJson(payload).toJson();
    }
    if (entity == 'review') {
      final submissionId = strictString(payload, 'submissionId');
      safeId(submissionId);
      if (!{'approved', 'rejected'}.contains(payload['decision'])) {
        invalid('review', 'قرار المراجعة غير صالح');
      }
      final rows = await tx.query(
        'submissions',
        where: 'id=?',
        whereArgs: [submissionId],
      );
      if (rows.isEmpty) {
        invalid('submission_missing', 'يلزم تنزيل طلب الموظف قبل مراجعته');
      }
      if (role == 'employee' && rows.single['creator_uid'] != userId) {
        invalid('private_data', 'المراجعة تخص موظفاً آخر');
      }
      await tx.update(
        'submissions',
        {
          'state': payload['decision'],
          'review': jsonEncode({
            'decision': payload['decision'],
            'note': strictString(payload, 'note'),
          }),
        },
        where: 'id=?',
        whereArgs: [submissionId],
      );
      await _audit(tx, id, 'remote_review');
      return;
    }
    if (!{
      'party',
      'employee',
      'salary_term',
      'entry',
      'submission',
    }.contains(entity)) {
      invalid('entity', 'نوع البيانات غير معروف');
    }
    if (role == 'employee' &&
        (!{'party', 'submission'}.contains(entity) ||
            (entity == 'submission' && payload['creatorUid'] != userId) ||
            (entity == 'party' && strictInt(payload, 'openingMinor') != 0))) {
      invalid('private_data', 'رفض تنزيل بيانات غير مصرح بها إلى جهاز الموظف');
    }
    final table = {
      'party': 'parties',
      'employee': 'employees',
      'salary_term': 'salary_terms',
      'entry': 'entries',
      'submission': 'submissions',
    }[entity]!;
    final existing = await tx.query(table, where: 'id=?', whereArgs: [id]);
    if (existing.isNotEmpty) {
      if (canonicalJson(_normalized(table, _payload(existing.single))) ==
          canonicalJson(payload)) {
        if (entity == 'entry') {
          await tx.update(
            'entries',
            {'state': 'server_accepted'},
            where: 'id=?',
            whereArgs: [id],
          );
        }
        if (entity == 'submission' &&
            (submissionState != 'awaiting_approval' ||
                !{
                  'review_pending',
                  'approved',
                  'rejected',
                }.contains(existing.single['state']))) {
          await tx.update(
            'submissions',
            {
              'state': submissionState,
              if (submissionReviewJson != null) 'review': submissionReviewJson,
            },
            where: 'id=?',
            whereArgs: [id],
          );
        }
        return;
      }
      await tx.insert('conflicts', {
        'id': id,
        'entity': entity,
        'local_payload': existing.single['payload'],
        'remote_payload': jsonEncode(payload),
        'reason': 'immutable_remote_conflict',
        'created_ms': DateTime.now().millisecondsSinceEpoch,
      }, conflictAlgorithm: ConflictAlgorithm.ignore);
      await tx.update(
        'outbox',
        {'status': 'conflict', 'error': 'immutable_remote_conflict'},
        where: 'id=?',
        whereArgs: [id],
      );
      if (entity == 'entry') {
        await tx.update(
          'entries',
          {'state': 'conflict'},
          where: 'id=?',
          whereArgs: [id],
        );
      }
      return;
    }
    switch (entity) {
      case 'party':
        final p = Party.fromJson(payload);
        p.validate();
        await tx.insert(table, {
          'id': id,
          'kind': p.kind,
          'name': p.name,
          'payload': jsonEncode(p.toJson()),
        });
        projection.parties.add(p);
      case 'employee':
        final e = Employee.fromJson(payload);
        e.validate();
        await tx.insert(table, {
          'id': id,
          'name': e.name,
          'payload': jsonEncode(e.toJson()),
        });
        projection.employees.add(e);
      case 'salary_term':
        final t = SalaryTerm.fromJson(payload);
        t.validate();
        await tx.insert(table, {
          'id': id,
          'employee_id': t.employeeId,
          'effective_month': t.effectiveMonth,
          'payload': jsonEncode(t.toJson()),
        });
        projection.terms.add(t);
      case 'entry':
        final e = LedgerEntry.fromJson(payload);
        LedgerRules.validateEntry(
          e,
          projection.entries,
          projection.parties,
          projection.employees,
          projection.terms,
        );
        await _insertEntry(tx, e, enqueue: false, state: 'server_accepted');
        projection.entries.add(e);
      case 'submission':
        final s = EmployeeSubmission.fromJson(payload);
        s.validate();
        await tx.insert(table, {
          'id': id,
          'creator_uid': s.creatorUid,
          'payload': jsonEncode(s.toJson()),
          'state': submissionState ?? 'awaiting_approval',
          if (submissionReviewJson != null) 'review': submissionReviewJson,
        });
    }
    await _audit(tx, id, 'remote_$entity');
  }

  Future<void> saveDraft(String id, Map<String, dynamic> draft) async {
    _ready();
    safeId(id);
    if (jsonEncode(draft).length > 32000) {
      invalid('draft_size', 'المسودة أكبر من الحد المسموح');
    }
    if (role == 'employee') {
      const allowed = {
        'id',
        'tenantId',
        'creatorUid',
        'employeeId',
        'kind',
        'date',
        'partyId',
        'partyName',
        'qtyMilli',
        'grade',
        'unit',
        'originalId',
        'amountMinor',
        'note',
        'qtyText',
        'priceText',
        'amountText',
        'category',
      };
      if (draft.keys.any(
            (k) =>
                !allowed.contains(k) ||
                (k == 'priceText' && draft['kind'] != 'purchase_delivery'),
          ) ||
          draft.values.any((v) => v is! String && v is! int)) {
        invalid('draft_fields', 'المسودة تحتوي حقولاً غير مصرح بها');
      }
      if (draft['creatorUid'] != userId ||
          draft['employeeId'] != employeeId ||
          draft['tenantId'] != tenantId ||
          draft['id'] != id) {
        invalid('draft_scope', 'المسودة لا تخص هذا الحساب');
      }
    }
    await _db.insert('drafts', {
      'id': id,
      'payload': jsonEncode(draft),
      'updated_ms': DateTime.now().millisecondsSinceEpoch,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    _notify();
  }

  Future<List<Map<String, dynamic>>> listDrafts() async {
    _ready();
    return (await _db.query(
      'drafts',
      orderBy: 'updated_ms DESC',
    )).map(_payload).toList();
  }

  Future<void> deleteDraft(String id) async {
    _ready();
    await _db.delete('drafts', where: 'id=?', whereArgs: [id]);
    _notify();
  }

  static const backupPreferenceKeys = <String>{
    'grade',
    'unit',
    'favoritePartyIds',
    'recentPartyIds',
    'budgetBusinessMinor',
    'budgetHomeMinor',
  };
  static void validateBackupPreference(String key, Object? value) {
    if (!backupPreferenceKeys.contains(key)) {
      invalid('backup_authority', 'إعداد غير مسموح في النسخة');
    }
    if (key.startsWith('budget')) {
      if (value is! int || value < 0 || value > 1000000000000) {
        invalid('backup_preference', 'قيمة الميزانية غير صالحة');
      }
    } else if (key.endsWith('PartyIds')) {
      if (value is! List ||
          value.length > 100 ||
          value.any(
            (v) =>
                v is! String || !RegExp(r'^[A-Za-z0-9_-]{1,120}$').hasMatch(v),
          )) {
        invalid('backup_preference', 'قائمة التفضيلات غير صالحة');
      }
    } else if (value is! String || value.length > 160) {
      invalid('backup_preference', 'نص التفضيل غير صالح');
    }
  }

  Future<void> setPreference(String key, Object? value) async {
    _ready();
    if (!{
          'grade',
          'unit',
          'favoritePartyIds',
          'recentPartyIds',
          'lastSyncMs',
          'syncCursor',
          'cursor',
          'budgetBusinessMinor',
          'budgetHomeMinor',
        }.contains(key) ||
        jsonEncode(value).length > 8192) {
      invalid('preference', 'إعداد غير مسموح');
    }
    if (backupPreferenceKeys.contains(key)) {
      validateBackupPreference(key, value);
    }
    await _db.insert('preferences', {
      'key': key,
      'value': jsonEncode(value),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    _notify();
  }

  Future<Object?> preference(String key) async {
    _ready();
    final rows = await _db.query(
      'preferences',
      where: 'key=?',
      whereArgs: [key],
    );
    return rows.isEmpty ? null : jsonDecode(rows.single['value']! as String);
  }

  Future<Map<String, dynamic>> exportBackup() async {
    _manager();
    return _transaction(
      (tx) async => {
        'format': 'strawberry-ledger',
        'version': 2,
        'tenantId': tenantId,
        'userId': userId,
        'exportedAt': DateTime.now().toUtc().toIso8601String(),
        'parties': (await _parties(tx)).map((p) => p.toJson()).toList(),
        'employees': (await _employees(tx)).map((e) => e.toJson()).toList(),
        'salaryTerms': (await _terms(tx)).map((t) => t.toJson()).toList(),
        'entries': await tx.query('entries', columns: ['payload', 'state']),
        'submissions': await tx.query(
          'submissions',
          columns: ['payload', 'state', 'review'],
        ),
        'outbox': await tx.query('outbox'),
        'drafts': await tx.query('drafts'),
        'conflicts': await tx.query('conflicts'),
        'audit': await tx.query('audit'),
        'preferences': await tx.query(
          'preferences',
          where:
              'key IN (${List.filled(backupPreferenceKeys.length, '?').join(',')})',
          whereArgs: backupPreferenceKeys.toList(),
        ),
        // No membership, entitlement, device key, credentials or authority settings.
      },
    );
  }

  /// Restores into the same authenticated tenant and UID, including stable queue
  /// IDs. Trusted enrollment is still required on a new device. Existing data is
  /// merged only when byte-identical; mismatches abort the entire transaction.
  Future<void> restoreBackup(Map<String, dynamic> backup) async {
    _manager();
    if (jsonEncode(backup).length > 50000000 ||
        backup['format'] != 'strawberry-ledger' ||
        backup['version'] != 2 ||
        backup['tenantId'] != tenantId ||
        backup['userId'] != userId) {
      invalid('backup_scope', 'النسخة غير صالحة أو تخص حساباً أو منشأة أخرى');
    }
    final allowed = {
      'format',
      'version',
      'tenantId',
      'userId',
      'exportedAt',
      'preferences',
      'parties',
      'employees',
      'salaryTerms',
      'entries',
      'submissions',
      'outbox',
      'drafts',
      'conflicts',
      'audit',
    };
    if (backup.keys.any((k) => !allowed.contains(k))) {
      invalid('backup_authority', 'النسخة تحتوي إعدادات صلاحية غير مسموحة');
    }
    List<Map<String, dynamic>> rows(String key) {
      final value = backup[key];
      if (value is! List || value.length > 200000) {
        invalid('backup_shape', 'بنية ملف النسخة غير صالحة');
      }
      return value.map((e) {
        if (e is! Map) invalid('backup_shape', 'سجل غير صالح في النسخة');
        return Map<String, dynamic>.from(e);
      }).toList();
    }

    final parties = rows('parties').map(Party.fromJson).toList();
    final employees = rows('employees').map(Employee.fromJson).toList();
    final terms = rows('salaryTerms').map(SalaryTerm.fromJson).toList();
    final entryRows = rows('entries');
    final submissionRows = rows('submissions');
    final outbox = rows('outbox');
    final drafts = rows('drafts');
    final conflicts = rows('conflicts');
    final audits = rows('audit');
    final preferences = backup.containsKey('preferences')
        ? rows('preferences')
        : <Map<String, dynamic>>[];
    final preferenceKeys = <String>{};
    for (final item in preferences) {
      if (item.keys.any((key) => !{'key', 'value'}.contains(key))) {
        invalid('backup_authority', 'حقول إعدادات غير مسموحة');
      }
      final key = strictString(item, 'key'),
          encoded = strictString(item, 'value');
      if (!preferenceKeys.add(key) || encoded.length > 8192) {
        invalid('backup_preference', 'إعدادات مكررة أو أكبر من المسموح');
      }
      validateBackupPreference(key, jsonDecode(encoded));
    }
    Map<String, dynamic> decodePayload(Map<String, dynamic> row) {
      final raw = row['payload'];
      if (raw is! String || raw.length > 32000) {
        invalid('backup_payload', 'سجل النسخة غير صالح');
      }
      final decoded = jsonDecode(raw);
      if (decoded is! Map) invalid('backup_payload', 'سجل النسخة غير صالح');
      return Map<String, dynamic>.from(decoded);
    }

    final entries = entryRows
        .map((r) => LedgerEntry.fromJson(decodePayload(r)))
        .toList();
    final submissions = submissionRows
        .map((r) => EmployeeSubmission.fromJson(decodePayload(r)))
        .toList();
    final allIds = <String>{};
    for (final p in parties) {
      p.validate();
      _scope(p.tenantId);
      if (!allIds.add(p.id)) {
        invalid('backup_duplicate', 'معرّفات مكررة في النسخة');
      }
    }
    for (final e in employees) {
      e.validate();
      _scope(e.tenantId);
      if (!allIds.add(e.id)) {
        invalid('backup_duplicate', 'معرّفات مكررة في النسخة');
      }
    }
    final monthKeys = <String>{};
    for (final t in terms) {
      t.validate();
      _scope(t.tenantId);
      if (!allIds.add(t.id) ||
          !monthKeys.add('${t.employeeId}:${t.effectiveMonth}') ||
          !employees.any((e) => e.id == t.employeeId)) {
        invalid('backup_salary', 'علاقات الراتب غير صالحة');
      }
    }
    final pending = entries.toList();
    final validated = <LedgerEntry>[];
    // Dependencies may arrive in any file order. Preserve order among returns,
    // whose rounding allocations are part of the immutable accounting evidence.
    while (pending.isNotEmpty) {
      final index = pending.indexWhere(
        (e) =>
            e.originalId.isEmpty || validated.any((v) => v.id == e.originalId),
      );
      if (index < 0) {
        invalid('backup_relationship', 'فاتورة أصلية مفقودة أو علاقة دائرية');
      }
      final e = pending.removeAt(index);
      _scope(e.tenantId);
      if (!allIds.add(e.id)) {
        invalid('backup_duplicate', 'معرّفات مكررة في النسخة');
      }
      LedgerRules.validateEntry(e, validated, parties, employees, terms);
      validated.add(e);
    }
    for (final s in submissions) {
      s.validate();
      _scope(s.tenantId);
      if (!allIds.add(s.id)) {
        invalid('backup_duplicate', 'معرّفات مكررة في النسخة');
      }
    }
    final queueIds = <String>{};
    for (final o in outbox) {
      final id = strictString(o, 'id');
      safeId(id);
      final entity = strictString(o, 'entity');
      final payload = decodePayload(o);
      if (!queueIds.add(id) ||
          !{'pending', 'retry', 'blocked', 'conflict'}.contains(o['status']) ||
          strictInt(o, 'attempts') < 0 ||
          strictInt(o, 'next_attempt_ms') < 0 ||
          strictInt(o, 'created_ms') < 0 ||
          strictString(o, 'error').length > 160) {
        invalid('backup_queue', 'طابور النسخة غير صالح');
      }
      final expected = switch (entity) {
        'entry' => entries.where((e) => e.id == id).firstOrNull?.toJson(),
        'party' => parties.where((e) => e.id == id).firstOrNull?.toJson(),
        'employee' => employees.where((e) => e.id == id).firstOrNull?.toJson(),
        'salary_term' => terms.where((e) => e.id == id).firstOrNull?.toJson(),
        'submission' =>
          submissions
              .where((e) => e.id == id && e.creatorUid == userId)
              .firstOrNull
              ?.toJson(),
        'review' => payload,
        _ => null,
      };
      final table = {
        'entry': 'entries',
        'party': 'parties',
        'employee': 'employees',
        'salary_term': 'salary_terms',
        'submission': 'submissions',
      }[entity];
      final normalized = table == null ? payload : _normalized(table, payload);
      if (expected == null ||
          canonicalJson(expected) != canonicalJson(normalized)) {
        invalid('backup_queue', 'الطابور لا يطابق السجلات المحفوظة');
      }
      if (entity == 'entry' && payload['creatorUid'] != userId) {
        invalid('backup_creator', 'طلب الإرسال لا يخص منشئ النسخة');
      }
      if (entity == 'review') {
        final submissionId = strictString(payload, 'submissionId');
        if (!submissions.any((s) => s.id == submissionId) ||
            !{'approved', 'rejected'}.contains(payload['decision'])) {
          invalid('backup_review', 'مراجعة غير مرتبطة بطلب');
        }
        // Do not let an imported provisional approval assert ledger authority.
        if (payload['decision'] == 'approved') {
          final entry = LedgerEntry.fromJson(
            Map<String, dynamic>.from(payload['entry'] as Map),
          );
          _scope(entry.tenantId);
          LedgerRules.validateEntry(
            entry,
            validated,
            parties,
            employees,
            terms,
          );
        }
      }
    }
    const states = {
      'pending',
      'retry',
      'blocked',
      'conflict',
      'server_accepted',
      'awaiting_approval',
      'review_pending',
      'approved',
      'rejected',
    };
    for (final r in [...entryRows, ...submissionRows]) {
      if (!states.contains(r['state'])) {
        invalid('backup_state', 'حالة سجل غير صالحة');
      }
    }
    for (final d in drafts) {
      safeId(strictString(d, 'id'));
      decodePayload(d);
      if (strictInt(d, 'updated_ms') < 0) {
        invalid('backup_draft', 'مسودة غير صالحة');
      }
    }
    for (final c in conflicts) {
      safeId(strictString(c, 'id'));
      for (final field in ['local_payload', 'remote_payload']) {
        if (c[field] is! String ||
            (c[field] as String).length > 32000 ||
            jsonDecode(c[field] as String) is! Map) {
          invalid('backup_conflict', 'تعارض غير صالح');
        }
      }
    }
    await _transaction((tx) async {
      for (final p in parties) {
        if (!await _identicalOrAbsent(tx, 'parties', p.id, p.toJson())) {
          await tx.insert('parties', {
            'id': p.id,
            'kind': p.kind,
            'name': p.name,
            'payload': jsonEncode(p.toJson()),
          });
        }
      }
      for (final e in employees) {
        if (!await _identicalOrAbsent(tx, 'employees', e.id, e.toJson())) {
          await tx.insert('employees', {
            'id': e.id,
            'name': e.name,
            'payload': jsonEncode(e.toJson()),
          });
        }
      }
      for (final t in terms) {
        if (!await _identicalOrAbsent(tx, 'salary_terms', t.id, t.toJson())) {
          await tx.insert('salary_terms', {
            'id': t.id,
            'employee_id': t.employeeId,
            'effective_month': t.effectiveMonth,
            'payload': jsonEncode(t.toJson()),
          });
        }
      }
      final combined = await _entries(tx);
      for (final e in validated) {
        if (await _identicalOrAbsent(tx, 'entries', e.id, e.toJson())) continue;
        LedgerRules.validateEntry(
          e,
          combined,
          await _parties(tx),
          await _employees(tx),
          await _terms(tx),
        );
        // Restore is locally provisional until authoritative synchronization.
        await _insertEntry(tx, e, enqueue: false, state: 'pending');
        combined.add(e);
      }
      for (final s in submissions) {
        if (!await _identicalOrAbsent(tx, 'submissions', s.id, s.toJson())) {
          await tx.insert('submissions', {
            'id': s.id,
            'creator_uid': s.creatorUid,
            'payload': jsonEncode(s.toJson()),
            'state': 'pending',
          });
        }
      }
      for (final o in outbox) {
        final existing = await tx.query(
          'outbox',
          where: 'id=?',
          whereArgs: [o['id']],
        );
        if (existing.isNotEmpty) {
          if (canonicalJson(
                    jsonDecode(existing.single['payload']! as String),
                  ) !=
                  canonicalJson(jsonDecode(o['payload'] as String)) ||
              existing.single['entity'] != o['entity']) {
            invalid('backup_conflict', 'طابور موجود بمحتوى مختلف');
          }
          continue;
        }
        await tx.insert('outbox', {
          'id': o['id'],
          'entity': o['entity'],
          'payload': o['payload'],
          'status': o['status'],
          'attempts': o['attempts'],
          'error': o['error'],
          'created_ms': o['created_ms'],
          'next_attempt_ms': 0,
        });
      }
      for (final d in drafts) {
        await tx.insert('drafts', {
          'id': d['id'],
          'payload': d['payload'],
          'updated_ms': d['updated_ms'],
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
      }
      for (final c in conflicts) {
        await tx.insert('conflicts', {
          'id': c['id'],
          'entity': c['entity'],
          'local_payload': c['local_payload'],
          'remote_payload': c['remote_payload'],
          'reason': c['reason'],
          'created_ms': c['created_ms'],
          'resolution': c['resolution'],
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
      }
      for (final item in preferences) {
        await tx.insert('preferences', {
          'key': item['key'],
          'value': item['value'],
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      }
      // Imported audit is evidence, never authentication or permission.
      for (final a in audits) {
        final actor = strictString(a, 'actor_uid');
        safeId(actor);
        safeId(strictString(a, 'operation_id'));
        if (strictString(a, 'action').length > 80 ||
            strictInt(a, 'created_ms') < 0) {
          invalid('backup_audit', 'سجل المراجعة غير صالح');
        }
        await tx.insert('audit', {
          'operation_id': a['operation_id'],
          'actor_uid': actor,
          'action': 'imported:${a['action']}',
          'created_ms': a['created_ms'],
        });
      }
      await _audit(tx, newId(), 'backup_restored_untrusted_authority');
    });
    _notify();
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _db.close();
    await _changes.close();
  }
}
