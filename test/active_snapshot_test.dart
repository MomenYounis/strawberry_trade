import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/active_snapshot.dart';

import 'domain_test.dart' as reference;

Map<String, dynamic> record(
  String entity,
  Map<String, dynamic> payload,
  int sequence,
) => {'entity': entity, 'payload': payload, 'sequence': sequence};

class Fixture {
  Fixture(
    List<Map<String, dynamic>> source, {
    String id = 'snapshot1',
    String tenant = 't1',
    String uid = 'u1',
    String role = 'manager',
    int epoch = 7,
    int checkpoint = 100,
    int floor = 50,
    int pageSize = 2,
  }) {
    final records = source.toList()
      ..sort(
        (a, b) =>
            activeSnapshotRecordKey(a).compareTo(activeSnapshotRecordKey(b)),
      );
    pages = [];
    for (var start = 0; start < records.length; start += pageSize) {
      final slice = records.skip(start).take(pageSize).toList();
      pages.add({
        'snapshotId': id,
        'index': pages.length,
        'records': slice,
        'sha256': activeSnapshotHash(slice),
      });
    }
    header = {
      'format': 'active_snapshot',
      'version': 1,
      'syncProtocolVersion': 2,
      'snapshotId': id,
      'tenantId': tenant,
      'uid': uid,
      'role': role,
      'membershipEpoch': epoch,
      'checkpointSequence': checkpoint,
      'historyFloor': floor,
      'pageCount': pages.length,
      'recordCount': records.length,
      'contentSha256': activeSnapshotHash([
        for (final page in pages)
          {
            'index': page['index'],
            'sha256': page['sha256'],
            'recordCount': (page['records'] as List).length,
          },
      ]),
    };
  }
  late Map<String, dynamic> header;
  late List<Map<String, dynamic>> pages;
  Future<ActiveSnapshotStatus> begin(LedgerStore store) =>
      store.stageActiveSnapshotHeader(
        header,
        expectedHeaderSha256: activeSnapshotHash(header),
        expectedMembershipEpoch: header['membershipEpoch'] as int,
      );
  Future<void> stage(LedgerStore store) async {
    await begin(store);
    for (final page in pages.reversed) {
      await store.stageActiveSnapshotPage(
        header['snapshotId'] as String,
        page,
        expectedMembershipEpoch: header['membershipEpoch'] as int,
      );
    }
  }

  Future<void> install(LedgerStore store) => store.installActiveSnapshot(
    header['snapshotId'] as String,
    expectedMembershipEpoch: header['membershipEpoch'] as int,
  );
}

Matcher code(String value) =>
    isA<LedgerException>().having((e) => e.code, 'code', value);
Map<String, dynamic> copy(Map<String, dynamic> value) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);

void main() {
  setUpAll(sqfliteFfiInit);
  late Directory dir;
  late LedgerStore store;
  Future<LedgerStore> open({String role = 'manager', String uid = 'u1'}) =>
      LedgerStore.open(
        path: '${dir.path}/$role.db',
        tenantId: 't1',
        userId: uid,
        role: role,
        employeeId: role == 'employee' ? 'e1' : null,
        factory: databaseFactoryFfi,
      );
  setUp(() async {
    dir = await Directory.systemTemp.createTemp('active_snapshot_test_');
    store = await open();
  });
  tearDown(() async {
    await store.close();
    await dir.delete(recursive: true);
  });

  test('interrupted any-order staging survives reopen and leaves active readers unchanged until atomic install', () async {
    final sale = reference.invoice();
    final returned = reference.returned(sale, 'a_return', 1000, [sale]);
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      record('entry', sale.toJson(), 2),
      record('entry', returned.toJson(), 3),
      record('employee', reference.employee.toJson(), 4),
      record('salary_term', reference.october.toJson(), 5),
    ]);
    await store.setPreference('cursor', 9);
    await fixture.begin(store);
    await store.stageActiveSnapshotPage(
      'snapshot1',
      fixture.pages.last,
      expectedMembershipEpoch: 7,
    );
    expect(await store.listEntries(), isEmpty);
    expect(await store.preference('cursor'), 9);
    await store.close();
    store = await open();
    final partial = (await store.activeSnapshotStatus(
      'snapshot1',
      expectedMembershipEpoch: 7,
    ))!;
    expect(partial.receivedPageIndexes, [2]);
    expect(partial.complete, isFalse);
    await expectLater(
      fixture.install(store),
      throwsA(code('snapshot_incomplete')),
    );
    for (final page in fixture.pages) {
      await store.stageActiveSnapshotPage(
        'snapshot1',
        page,
        expectedMembershipEpoch: 7,
      );
    }
    var notices = 0;
    final subscription = store.changes.listen((_) => notices++);
    await fixture.install(store);
    await Future<void>.delayed(Duration.zero);
    expect(notices, 1);
    await subscription.cancel();
    expect((await store.listEntries()).map((e) => e.id).toSet(), {
      'invoice',
      'a_return',
    });
    expect((await store.listSalaryTerms()).single.id, 'salary1');
    expect(await store.preference('cursor'), 100);
    expect(await store.preference('syncCursor'), 100);
    expect(await store.preference('historyFloor'), 50);
    expect(
      (await store.activeSnapshotStatus(
        'snapshot1',
        expectedMembershipEpoch: 7,
      ))!.installed,
      isTrue,
    );
    await fixture.install(store); // No duplicate financial postings.
    expect((await store.listEntries()).length, 2);
    expect(
      LedgerRules.partyBalance(reference.merchant, await store.listEntries()),
      13000,
    );
  });

  test('queued accepted IDs, provisional facts, retries, drafts and conflicts survive byte-for-byte', () async {
    await store.saveParty(reference.merchant);
    final sale = reference.invoice();
    await store.saveEntry(sale);
    await store.fail(sale.id, 'network', nowMs: 1234);
    final local = reference.payment(
      'local_receipt',
      'merchant_payment',
      100,
      partyId: 'm1',
      partyName: reference.merchant.name,
    );
    await store.saveEntry(local);
    await store.fail(
      local.id,
      'synthetic_conflict',
      conflict: true,
      nowMs: 999,
    );
    await store.saveDraft('draft1', {'note': 'مسودة محفوظة', 'quantity': '١٠'});
    final before = await store.exportBackup();
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      record('entry', sale.toJson(), 2),
      record(
        'entry',
        reference
            .payment(
              'server_receipt',
              'merchant_payment',
              50,
              partyId: 'm1',
              partyName: reference.merchant.name,
            )
            .toJson(),
        3,
      ),
    ]);
    await fixture.stage(store);
    await fixture.install(store);
    final after = await store.exportBackup();
    for (final key in ['outbox', 'drafts', 'conflicts']) {
      expect(after[key], before[key], reason: key);
    }
    expect((await store.listOutbox()).map((item) => item.id).toSet(), {
      'm1',
      'invoice',
      'local_receipt',
    });
    expect(await store.entryState('invoice'), 'retry');
    expect(await store.entryState('local_receipt'), 'conflict');
    expect(await store.entryState('server_receipt'), 'server_accepted');
    expect((await store.listEntries()).length, 3);
  });

  test('immutable collision aborts every installed row and cursor without adding conflicts or touching staging', () async {
    await store.saveParty(reference.merchant);
    await store.saveEntry(reference.invoice());
    await store.setPreference('cursor', 4);
    final before = await store.exportBackup();
    final fixture = Fixture([
      record('party', reference.supplier.toJson(), 1),
      record('entry', reference.invoice(priceMinor: 3000).toJson(), 2),
    ]);
    await fixture.stage(store);
    await expectLater(
      fixture.install(store),
      throwsA(code('snapshot_immutable_conflict')),
    );
    final after = await store.exportBackup();
    for (final key in ['parties', 'entries', 'outbox', 'conflicts', 'audit']) {
      expect(after[key], before[key], reason: key);
    }
    expect(await store.preference('cursor'), 4);
    expect(
      (await store.activeSnapshotStatus(
        'snapshot1',
        expectedMembershipEpoch: 7,
      ))!.complete,
      isTrue,
    );
    expect(
      (await store.activeSnapshotStatus(
        'snapshot1',
        expectedMembershipEpoch: 7,
      ))!.installed,
      isFalse,
    );
  });

  test(
    'last invalid accounting event rolls back dependencies and cursor',
    () async {
      final bad = {...reference.invoice(id: 'bad').toJson(), 'totalMinor': 1};
      final fixture = Fixture([
        record('party', reference.merchant.toJson(), 1),
        record('entry', reference.invoice().toJson(), 2),
        record('entry', bad, 3),
      ]);
      await fixture.stage(store);
      await expectLater(
        fixture.install(store),
        throwsA(isA<LedgerException>()),
      );
      expect(await store.listParties(), isEmpty);
      expect(await store.listEntries(), isEmpty);
      expect(await store.preference('cursor'), isNull);
      expect((await store.exportBackup())['audit'], isEmpty);
    },
  );

  test('scope, epoch and authenticated header digest are required for all stages and install', () async {
    for (final mutation in [
      {'tenantId': 't2'},
      {'uid': 'other'},
      {'role': 'employee'},
      {'membershipEpoch': 8},
    ]) {
      final header = {...Fixture([]).header, ...mutation};
      await expectLater(
        store.stageActiveSnapshotHeader(
          header,
          expectedHeaderSha256: activeSnapshotHash(header),
          expectedMembershipEpoch: 7,
        ),
        throwsA(code('snapshot_scope')),
      );
    }
    final fixture = Fixture([record('party', reference.merchant.toJson(), 1)]);
    await expectLater(
      store.stageActiveSnapshotHeader(
        fixture.header,
        expectedHeaderSha256: '0' * 64,
        expectedMembershipEpoch: 7,
      ),
      throwsA(code('snapshot_header_integrity')),
    );
    await fixture.stage(store);
    await expectLater(
      store.stageActiveSnapshotPage(
        'snapshot1',
        fixture.pages.single,
        expectedMembershipEpoch: 8,
      ),
      throwsA(code('snapshot_scope')),
    );
    await expectLater(
      store.installActiveSnapshot('snapshot1', expectedMembershipEpoch: 8),
      throwsA(code('snapshot_scope')),
    );
    expect(await store.listParties(), isEmpty);
  });

  test('fresh epoch-bound header resumes matching content without copying unverified or other-scope bytes', () async {
    final records = [
      record('party', reference.merchant.toJson(), 1),
      record('party', reference.supplier.toJson(), 2),
    ];
    final old = Fixture(records, pageSize: 1);
    await old.begin(store);
    await store.stageActiveSnapshotPage(
      'snapshot1',
      old.pages.first,
      expectedMembershipEpoch: 7,
    );
    final next = Fixture(records, id: 'rebound', epoch: 8, pageSize: 1);
    final status = await next.begin(store);
    expect(status.receivedPageIndexes, [0]);
    expect(
      await store.activeSnapshotStatus('snapshot1', expectedMembershipEpoch: 7),
      isNull,
    );
    expect(await store.listParties(), isEmpty);
    await store.stageActiveSnapshotPage(
      'rebound',
      next.pages.last,
      expectedMembershipEpoch: 8,
    );
    await next.install(store);
    expect((await store.listParties()).length, 2);
    final different = Fixture(
      records,
      id: 'different',
      epoch: 9,
      pageSize: 1,
      checkpoint: 101,
    );
    expect((await different.begin(store)).receivedPageIndexes, isEmpty);
  });

  test('page tamper, immutable page/header replacement, descriptor digest and duplicate records reject', () async {
    final fixture = Fixture([record('party', reference.merchant.toJson(), 1)]);
    await fixture.begin(store);
    final tampered = copy(fixture.pages.single);
    (tampered['records'] as List).first['payload']['name'] = 'changed';
    await expectLater(
      store.stageActiveSnapshotPage(
        'snapshot1',
        tampered,
        expectedMembershipEpoch: 7,
      ),
      throwsA(code('snapshot_page_integrity')),
    );
    await store.stageActiveSnapshotPage(
      'snapshot1',
      fixture.pages.single,
      expectedMembershipEpoch: 7,
    );
    tampered['sha256'] = activeSnapshotHash(tampered['records']);
    await expectLater(
      store.stageActiveSnapshotPage(
        'snapshot1',
        tampered,
        expectedMembershipEpoch: 7,
      ),
      throwsA(code('snapshot_immutable_page')),
    );
    final changed = {...fixture.header, 'historyFloor': 49};
    await expectLater(
      store.stageActiveSnapshotHeader(
        changed,
        expectedHeaderSha256: activeSnapshotHash(changed),
        expectedMembershipEpoch: 7,
      ),
      throwsA(code('snapshot_immutable_header')),
    );
    final wrongDigest = Fixture([
      record('party', reference.supplier.toJson(), 2),
    ], id: 'wrong_digest');
    wrongDigest.header['contentSha256'] = '0' * 64;
    await wrongDigest.stage(store);
    await expectLater(
      wrongDigest.install(store),
      throwsA(code('snapshot_content_integrity')),
    );
    expect(await store.listParties(), isEmpty);
    final duplicates = Fixture(
      [
        record('party', reference.merchant.toJson(), 1),
        record('party', reference.merchant.toJson(), 2),
      ],
      id: 'duplicates',
      pageSize: 1,
    );
    await duplicates.stage(store);
    await expectLater(
      duplicates.install(store),
      throwsA(code('snapshot_record_order')),
    );
  });

  test('cross-page order and duplicate authoritative sequence reject before any active write', () async {
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      record('employee', reference.employee.toJson(), 1),
    ], pageSize: 1);
    await fixture.stage(store);
    await expectLater(
      fixture.install(store),
      throwsA(code('snapshot_record_order')),
    );
    expect(await store.listParties(), isEmpty);
    final ordered = Fixture(
      [
        record('party', reference.merchant.toJson(), 1),
        record('party', reference.supplier.toJson(), 2),
      ],
      id: 'cross_page',
      pageSize: 1,
    );
    final records = ordered.pages.first['records'];
    ordered.pages.first['records'] = ordered.pages.last['records'];
    ordered.pages.last['records'] = records;
    for (final page in ordered.pages) {
      page['sha256'] = activeSnapshotHash(page['records']);
    }
    ordered.header['contentSha256'] = activeSnapshotHash([
      for (final page in ordered.pages)
        {'index': page['index'], 'sha256': page['sha256'], 'recordCount': 1},
    ]);
    await ordered.stage(store);
    await expectLater(
      ordered.install(store),
      throwsA(code('snapshot_record_order')),
    );
  });

  test(
    'employee snapshot stores only sanitized directory and own submissions',
    () async {
      await store.close();
      store = await open(role: 'employee', uid: 'staff');
      final party = {...reference.merchant.toJson()}..remove('openingMinor');
      const own = EmployeeSubmission(
        id: 'own',
        tenantId: 't1',
        creatorUid: 'staff',
        employeeId: 'e1',
        kind: 'expense_business',
        date: '2026-10-03',
        amountMinor: 500,
        category: 'وقود',
      );
      final fixture = Fixture(
        [
          record('party', party, 1),
          record('submission', {...own.toJson(), 'status': 'approved'}, 2),
        ],
        uid: 'staff',
        role: 'employee',
      );
      await fixture.stage(store);
      await fixture.install(store);
      expect((await store.listParties()).single.openingMinor, 0);
      expect((await store.listSubmissions()).single['state'], 'approved');
      for (final forbidden in [
        record('party', reference.merchant.toJson(), 3),
        record('entry', reference.invoice().toJson(), 3),
        record('submission', {...own.toJson(), 'creatorUid': 'other'}, 3),
      ]) {
        final bad = Fixture(
          [forbidden],
          id: 'forbidden',
          uid: 'staff',
          role: 'employee',
        );
        await bad.begin(store);
        await expectLater(
          store.stageActiveSnapshotPage(
            'forbidden',
            bad.pages.single,
            expectedMembershipEpoch: 7,
          ),
          throwsA(isA<LedgerException>()),
        );
        await store.discardActiveSnapshot(
          'forbidden',
          expectedMembershipEpoch: 7,
        );
      }
    },
  );

  test('persisted page corruption and revoked store abort install without active changes', () async {
    final fixture = Fixture([record('party', reference.merchant.toJson(), 1)]);
    await fixture.stage(store);
    final db = await databaseFactoryFfi.openDatabase(
      '${dir.path}/manager.db',
      options: OpenDatabaseOptions(singleInstance: false),
    );
    try {
      final records = copy(fixture.pages.single)['records'] as List;
      records.first['payload']['name'] = 'corrupt';
      await db.update(
        'active_snapshot_pages',
        {'records_json': canonicalJson(records)},
        where: 'snapshot_id=?',
        whereArgs: ['snapshot1'],
      );
    } finally {
      await db.close();
    }
    await expectLater(
      fixture.install(store),
      throwsA(code('snapshot_page_integrity')),
    );
    expect(await store.listParties(), isEmpty);
    store.revokeAccess();
    await expectLater(fixture.install(store), throwsA(code('access_revoked')));
  });

  test(
    'empty retained snapshot is valid and cannot rewind a newer cursor',
    () async {
      final empty = Fixture([]);
      await empty.stage(store);
      await empty.install(store);
      expect(await store.preference('cursor'), 100);
      expect(await store.listEntries(), isEmpty);
      await store.setPreference('cursor', 101);
      final stale = Fixture([], id: 'older');
      await stale.stage(store);
      await expectLater(stale.install(store), throwsA(code('snapshot_stale')));
      expect(await store.preference('cursor'), 101);
    },
  );

  test('oversized valid snapshots remain resumably staged and fail install before loading projections', () async {
    // 20,001 retained rows, all valid pages. The install cap counts even rows
    // whose IDs would match existing local facts rather than hiding peak memory.
    final records = [
      for (var i = 1; i <= 20001; i++)
        record('party', {...reference.merchant.toJson(), 'id': 'party_$i'}, i),
    ];
    final fixture = Fixture(records, checkpoint: 30000, floor: 0, pageSize: 80);
    await fixture.stage(store);
    await expectLater(
      fixture.install(store),
      throwsA(code('snapshot_install_budget')),
    );
    expect(await store.listParties(), isEmpty);
    final status = (await store.activeSnapshotStatus(
      'snapshot1',
      expectedMembershipEpoch: 7,
    ))!;
    expect(status.complete, isTrue);
    expect(status.installed, isFalse);
  });

  test(
    'strict JSON, safe integers, schema and page byte limits are enforced',
    () async {
      final fixture = Fixture([
        record('party', reference.merchant.toJson(), 1),
      ]);
      for (final mutation in [
        {'membershipEpoch': 0},
        {'checkpointSequence': 9007199254740992},
        {'pageCount': 4097},
        {'extra': true},
        {'syncProtocolVersion': 1},
      ]) {
        final header = {...fixture.header, ...mutation};
        expect(
          () => ActiveSnapshotHeader.parse(header),
          throwsA(isA<LedgerException>()),
        );
      }
      expect(
        () => validateActiveSnapshotJson({'number': 1.25}),
        throwsA(code('snapshot_json')),
      );
      expect(
        () => validateActiveSnapshotJson({'constructor': 0}),
        throwsA(code('snapshot_json')),
      );
      final big = Fixture([
        record('party', {
          ...reference.merchant.toJson(),
          'name': 'x' * 25000,
        }, 1),
      ], id: 'big');
      await big.begin(store);
      await expectLater(
        store.stageActiveSnapshotPage(
          'big',
          big.pages.single,
          expectedMembershipEpoch: 7,
        ),
        throwsA(isA<LedgerException>()),
      );
    },
  );

  test('captured immutable review ID cannot change through normal feed or full snapshot', () async {
    const submission = EmployeeSubmission(
      id: 'reviewed-submission',
      tenantId: 't1',
      creatorUid: 'staff',
      employeeId: 'e1',
      kind: 'expense_business',
      date: '2026-10-03',
      amountMinor: 500,
      category: 'وقود',
    );
    await store.applyRemote('submission', submission.toJson());
    final review = {
      'id': 'immutable-review',
      'tenantId': 't1',
      'submissionId': submission.id,
      'decision': 'rejected',
      'note': 'القرار الأصلي',
      'reviewerUid': 'u1',
      'reviewedAtMs': 1000,
    };
    await store.applyRemote('review', review);
    final before = await store.exportBackup();
    await expectLater(
      store.applyRemote('review', {...review, 'note': 'تغيير ثابت'}),
      throwsA(code('remote_review_conflict')),
    );
    final fixture = Fixture([
      record('party', reference.merchant.toJson(), 1),
      record('submission', {...submission.toJson(), 'status': 'rejected'}, 2),
      record('review', {...review, 'decision': 'approved'}, 3),
    ]);
    await fixture.stage(store);
    await expectLater(
      fixture.install(store),
      throwsA(code('remote_review_conflict')),
    );
    expect(await store.listParties(), isEmpty);
    expect(await store.preference('cursor'), isNull);
    expect((await store.exportBackup())['submissions'], before['submissions']);
    expect((await store.exportBackup())['audit'], before['audit']);
  });

  test('snapshot compares queued review IDs while preserving matching local review payload and provisional state', () async {
    const submission = EmployeeSubmission(
      id: 'pending-review-submission',
      tenantId: 't1',
      creatorUid: 'staff',
      employeeId: 'e1',
      kind: 'expense_business',
      date: '2026-10-03',
      amountMinor: 500,
      category: 'وقود',
    );
    await store.applyRemote('submission', submission.toJson());
    await store.saveReview(
      id: 'queued-review',
      submissionId: submission.id,
      approved: false,
      note: 'قرار محلي محفوظ',
    );
    final before = await store.exportBackup();
    final remoteReview = {
      'id': 'queued-review',
      'tenantId': 't1',
      'submissionId': submission.id,
      'decision': 'rejected',
      'note': 'قرار محلي محفوظ',
      'reviewerUid': 'u1',
      'reviewedAtMs': 1000,
    };
    final bad = Fixture([
      record('submission', {...submission.toJson(), 'status': 'rejected'}, 1),
      record('review', {
        ...remoteReview,
        'note': 'محتوى مختلف لنفس المعرّف',
      }, 2),
    ], id: 'review-collision');
    await bad.stage(store);
    await expectLater(
      bad.install(store),
      throwsA(code('remote_review_conflict')),
    );
    expect(await store.preference('cursor'), isNull);
    final good = Fixture([
      record('submission', {...submission.toJson(), 'status': 'rejected'}, 1),
      record('review', remoteReview, 2),
    ], id: 'review-match');
    await good.stage(store);
    await good.install(store);
    final after = await store.exportBackup();
    expect(after['outbox'], before['outbox']);
    expect(after['submissions'], before['submissions']);
    expect((await store.listOutbox()).single.id, 'queued-review');
    expect((await store.listSubmissions()).single['state'], 'review_pending');
    expect(await store.preference('cursor'), 100);
  });

  test('snapshot compares full provisional approval entry bytes before installing the accepted entry ID', () async {
    const submission = EmployeeSubmission(
      id: 'approval-submission',
      tenantId: 't1',
      creatorUid: 'staff',
      employeeId: 'e1',
      kind: 'expense_business',
      date: '2026-10-03',
      amountMinor: 500,
      category: 'وقود',
    );
    await store.applyRemote('submission', submission.toJson());
    const entry = LedgerEntry(
      id: 'approval-entry',
      tenantId: 't1',
      creatorUid: 'staff',
      kind: 'expense_business',
      date: '2026-10-03',
      totalMinor: 500,
      paidMinor: 500,
      category: 'وقود',
      note: 'حقائق اعتماد محلية',
    );
    await store.saveReview(
      id: 'approval-review',
      submissionId: submission.id,
      approved: true,
      entry: entry,
      note: 'اعتماد محفوظ',
    );
    await store.setPreference('cursor', 1);
    final before = await store.exportBackup();
    final review = {
      'id': 'approval-review',
      'tenantId': 't1',
      'submissionId': submission.id,
      'decision': 'approved',
      'note': 'اعتماد محفوظ',
      'reviewerUid': 'u1',
      'reviewedAtMs': 1000,
      'entryId': entry.id,
    };
    Fixture fixture(String id, Map<String, dynamic> entryPayload) => Fixture([
      record('submission', {...submission.toJson(), 'status': 'approved'}, 2),
      record('entry', entryPayload, 3),
      record('review', review, 4),
    ], id: id);
    final collision = fixture('approval-collision', {
      ...entry.toJson(),
      'note': 'حقائق مختلفة لنفس القيد',
    });
    await collision.stage(store);
    await expectLater(
      collision.install(store),
      throwsA(code('snapshot_immutable_conflict')),
    );
    expect(await store.listEntries(), isEmpty);
    expect(await store.preference('cursor'), 1);
    for (final key in ['submissions', 'outbox', 'conflicts', 'audit']) {
      expect((await store.exportBackup())[key], before[key], reason: key);
    }
    final matching = fixture('approval-matching', entry.toJson());
    await matching.stage(store);
    await matching.install(store);
    expect((await store.listEntries()).single.toJson(), entry.toJson());
    expect((await store.exportBackup())['outbox'], before['outbox']);
    expect((await store.listSubmissions()).single['state'], 'review_pending');
    expect(await store.preference('cursor'), 100);
  });
}
