import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';

const _tenant = 'storage_acceptance_tenant';
const _uid = 'storage_acceptance_manager';

/// Real native SQLite, configured with a small physical pager limit. It
/// delegates every operation to FFI; no read/write or exception is mocked.
class _PageLimitedFactory extends DatabaseFactory {
  _PageLimitedFactory(this.delegate);
  final DatabaseFactory delegate;
  late Database connection;

  @override
  Future<Database> openDatabase(
    String path, {
    OpenDatabaseOptions? options,
  }) async {
    final original = options!;
    return connection = await delegate.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: original.version,
        onConfigure: (db) async {
          await original.onConfigure?.call(db);
          await db.execute('PRAGMA page_size=1024');
          final limit = await db.rawQuery('PRAGMA max_page_count=128');
          expect(limit.single.values.single, 128);
        },
        onCreate: original.onCreate,
        onUpgrade: original.onUpgrade,
        onDowngrade: original.onDowngrade,
        onOpen: original.onOpen,
        readOnly: original.readOnly,
        singleInstance: original.singleInstance,
      ),
    );
  }

  @override
  Future<bool> databaseExists(String path) => delegate.databaseExists(path);
  @override
  Future<void> deleteDatabase(String path) => delegate.deleteDatabase(path);
  @override
  Future<String> getDatabasesPath() => delegate.getDatabasesPath();
  @override
  Future<Uint8List> readDatabaseBytes(String path) =>
      delegate.readDatabaseBytes(path);
  @override
  Future<void> setDatabasesPath(String path) => delegate.setDatabasesPath(path);
  @override
  Future<void> writeDatabaseBytes(String path, Uint8List bytes) =>
      delegate.writeDatabaseBytes(path, bytes);
}

Future<LedgerStore> _open(String path, {DatabaseFactory? factory}) =>
    LedgerStore.open(
      path: path,
      tenantId: _tenant,
      userId: _uid,
      factory: factory ?? databaseFactoryFfi,
    );

LedgerEntry _invoice(
  Party party,
  String id, {
  String date = '2026-10-18',
  String note = '',
}) => LedgerEntry(
  id: id,
  tenantId: _tenant,
  creatorUid: _uid,
  kind: 'sale',
  date: date,
  partyId: party.id,
  partyName: party.name,
  qtyMilli: 1000,
  priceMinor: 10000,
  totalMinor: 10000,
  paidMinor: 2500,
  grade: 'فراولة طازجة',
  unit: 'كيلو',
  note: note,
);

void main() {
  setUpAll(sqfliteFfiInit);

  test('Ten seasons and 10000 immutable facts remain queryable with stable pending IDs after disk reopen', () async {
    final directory = await Directory.systemTemp.createTemp(
      'strawberry_10000_',
    );
    final path = '${directory.path}/ledger.db';
    var store = await _open(path);
    final metrics = <String, Object?>{
      'entryCount': 10000,
      'partyCount': 20,
      'seasons': 10,
    };
    try {
      final parties = List.generate(
        20,
        (i) => Party(
          id: 'scale_party_$i',
          tenantId: _tenant,
          name: 'عميل موسم ${i.toString().padLeft(2, '0')}',
          kind: 'merchant',
          phone: '010${i.toString().padLeft(8, '0')}',
          openingMinor: i * 10000,
        ),
      );
      final facts = List.generate(10000, (i) {
        final date = DateTime.utc(
          2017 + i ~/ 1000,
          i % 12 + 1,
          i % 28 + 1,
        ).toIso8601String().substring(0, 10);
        return _invoice(
          parties[i % parties.length],
          'season_fact_${i.toString().padLeft(5, '0')}',
          date: date,
        );
      });
      final queuedIds = {
        for (var i = 0; i < 64; i++) facts[i * 157 % facts.length].id,
      };
      final backup = <String, dynamic>{
        'format': 'strawberry-ledger',
        'version': 2,
        'tenantId': _tenant,
        'userId': _uid,
        'exportedAt': '2026-10-18T00:00:00Z',
        'parties': parties.map((p) => p.toJson()).toList(),
        'employees': <Object?>[],
        'salaryTerms': <Object?>[],
        'entries': facts
            .map(
              (e) => {
                'payload': jsonEncode(e.toJson()),
                'state': queuedIds.contains(e.id) ? 'retry' : 'server_accepted',
              },
            )
            .toList(),
        'submissions': <Object?>[],
        'outbox': facts
            .where((e) => queuedIds.contains(e.id))
            .map(
              (e) => {
                'id': e.id,
                'entity': 'entry',
                'payload': jsonEncode(e.toJson()),
                'status': 'retry',
                'attempts': 2,
                'error': 'unavailable',
                'created_ms': 1,
                'next_attempt_ms': 0,
              },
            )
            .toList(),
        'drafts': [
          {
            'id': 'scale_unfinished_draft',
            'payload': jsonEncode({
              'id': 'scale_unfinished_draft',
              'qtyText': '١٢٫',
            }),
            'updated_ms': 1,
          },
        ],
        'conflicts': <Object?>[],
        'audit': <Object?>[],
      };
      var timer = Stopwatch()..start();
      await store.restoreBackup(backup);
      metrics['validatedImportMs'] = timer.elapsedMilliseconds;
      await store.close();
      timer = Stopwatch()..start();
      store = await _open(path);
      metrics['reopenMs'] = timer.elapsedMilliseconds;
      timer = Stopwatch()..start();
      final all = await store.listEntries();
      metrics['read10000Ms'] = timer.elapsedMilliseconds;
      expect(all.length, 10000);
      expect(all.map((e) => e.id).toSet().length, 10000);
      expect(all.map((e) => e.date.substring(0, 4)).toSet(), {
        for (var year = 2017; year <= 2026; year++) '$year',
      });
      final queue = await store.listOutbox();
      expect(queue.map((o) => o.id).toSet(), queuedIds);
      expect(
        queue.every((o) => o.status == 'retry' && o.attempts == 2),
        isTrue,
      );
      expect((await store.listDrafts()).single['qtyText'], '١٢٫');

      final historical =
          facts
              .where(
                (e) =>
                    e.date.compareTo('2019-01-01') >= 0 &&
                    e.date.compareTo('2021-12-31') <= 0,
              )
              .toList()
            ..sort((a, b) {
              final d = a.date.compareTo(b.date);
              return d == 0 ? a.id.compareTo(b.id) : d;
            });
      timer = Stopwatch()..start();
      final paged = <LedgerEntry>[];
      for (var offset = 0; offset < historical.length; offset += 137) {
        paged.addAll(
          await store.listEntries(
            from: '2019-01-01',
            to: '2021-12-31',
            limit: 137,
            offset: offset,
          ),
        );
      }
      metrics['historicalPaginationMs'] = timer.elapsedMilliseconds;
      expect(paged.map((e) => e.id), historical.map((e) => e.id));
      expect(paged.length, 3000);
      expect(paged.map((e) => e.id).toSet().length, 3000);

      timer = Stopwatch()..start();
      final found = await store.listParties(search: 'عميل موسم 07');
      expect(found.single.id, 'scale_party_7');
      expect(
        (await store.listParties(search: found.single.phone)).single.id,
        found.single.id,
      );
      expect(await store.listParties(search: "' OR 1=1 --"), isEmpty);
      final accountFacts = await store.listEntries(partyId: found.single.id);
      final lines = LedgerRules.statement(found.single, accountFacts);
      metrics['accountSearchAndStatementMs'] = timer.elapsedMilliseconds;
      expect(accountFacts.length, 500);
      expect(lines.length, 500);
      expect(lines.first.balanceMinor, 77500);
      expect(
        lines.last.balanceMinor,
        3820000,
      ); // 70000 opening + 500 × 7500 debt.
      expect(LedgerRules.partyBalance(found.single, all), 3820000);
      expect(LedgerRules.netRecordedCash(all), 25000000);
      expect(
        await store.listEntries(from: '2010-01-01', to: '2011-12-31'),
        isEmpty,
      );
      metrics['fileBytes'] = await File(path).length();
      expect(metrics['fileBytes'] as int, greaterThan(4096));
      // ignore: avoid_print
      print('STORAGE_SCALE_VERIFICATION ${jsonEncode(metrics)}');
    } finally {
      await store.close();
      await directory.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(minutes: 5)));

  test('Actual SQLITE_FULL rolls back financial and queue writes and preserves saved drafts through reopen', () async {
    final directory = await Directory.systemTemp.createTemp(
      'strawberry_sqlite_full_',
    );
    final path = '${directory.path}/ledger.db';
    final limited = _PageLimitedFactory(databaseFactoryFfi);
    var store = await _open(path, factory: limited);
    const party = Party(
      id: 'full_party',
      tenantId: _tenant,
      name: 'عميل قبل امتلاء التخزين',
      kind: 'merchant',
    );
    final previous = _invoice(party, 'already_committed');
    final rejected = _invoice(
      party,
      'full_operation',
      note: List.filled(1000, 'س').join(),
    );
    try {
      await store.saveParty(party);
      await store.saveEntry(previous);
      await store.saveDraft(rejected.id, {
        'id': rejected.id,
        'amountText': '١٠٠٫٠٠',
        'note': 'مسودة محفوظة قبل امتلاء التخزين',
      });
      final connection = limited.connection;
      await connection.execute(
        'CREATE TABLE disk_pressure(id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
      );
      DatabaseException? full;
      var filled = 0;
      for (; filled < 128; filled++) {
        try {
          await connection.rawInsert(
            'INSERT INTO disk_pressure(data) VALUES (zeroblob(1024))',
          );
        } on DatabaseException catch (error) {
          full = error;
          break;
        }
      }
      expect(
        full,
        isNotNull,
        reason: 'SQLite must really exhaust its configured page budget',
      );
      expect(
        full!.getResultCode(),
        13,
        reason: 'SQLITE_FULL, not a simulated exception',
      );
      Object? writeFailure;
      try {
        await store.saveEntry(rejected);
      } catch (error) {
        writeFailure = error;
      }
      expect(writeFailure, isA<DatabaseException>());
      expect((writeFailure as DatabaseException).getResultCode(), 13);
      expect((await store.listEntries()).single.id, previous.id);
      expect(
        (await store.listOutbox()).any((o) => o.id == rejected.id),
        isFalse,
      );
      expect((await store.listDrafts()).single['amountText'], '١٠٠٫٠٠');
      expect(
        await connection.query(
          'audit',
          where: 'operation_id=?',
          whereArgs: [rejected.id],
        ),
        isEmpty,
      );
      expect(
        (await connection.rawQuery('PRAGMA integrity_check'))
            .single
            .values
            .single,
        'ok',
      );
      final bytes = await File(path).length();
      await store.close();
      store = await _open(path, factory: limited);
      expect((await store.listEntries()).single.toJson(), previous.toJson());
      expect(
        (await store.listOutbox()).any((o) => o.id == previous.id),
        isTrue,
      );
      expect(
        (await store.listOutbox()).any((o) => o.id == rejected.id),
        isFalse,
      );
      expect((await store.listDrafts()).single['id'], rejected.id);
      await limited.connection.delete('disk_pressure');
      await store.saveEntry(rejected);
      expect((await store.listEntries()).length, 2);
      expect(
        (await store.listOutbox()).where((o) => o.id == rejected.id).length,
        1,
      );
      expect(await store.listDrafts(), isEmpty);
      // ignore: avoid_print
      print(
        'SQLITE_FULL_VERIFICATION ${jsonEncode({'resultCode': 13, 'pageLimit': 128, 'pageSize': 1024, 'fileBytes': bytes, 'pressureRows': filled, 'recoverySucceeded': true})}',
      );
    } finally {
      await store.close();
      await directory.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(minutes: 2)));
}
