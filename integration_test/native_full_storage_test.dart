import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_sqlcipher/sqflite.dart' as cipher;
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/device_security.dart';

/// Real Android SQLCipher with a bounded native pager. This configures the exact
/// connection used by LedgerStore, forwarding every read, write and transaction
/// to the native plugin. It never fakes an exception or replaces a channel.
/// The cap exhausts this isolated database's page budget, not the phone's disk.
class _NativePageLimitedFactory extends DatabaseFactory {
  _NativePageLimitedFactory(this.password);
  final String password;
  static const pageLimit = 128;
  late Database connection;

  @override
  Future<Database> openDatabase(
    String path, {
    OpenDatabaseOptions? options,
  }) async {
    final original = options!;
    return connection = await cipher.databaseFactory.openDatabase(
      path,
      options: cipher.SqlCipherOpenDatabaseOptions(
        password: password,
        version: original.version,
        onConfigure: (db) async {
          await original.onConfigure?.call(db);
          final cipherVersion = await db.rawQuery('PRAGMA cipher_version');
          expect(
            cipherVersion.single.values.single.toString(),
            startsWith('4.'),
          );
          final limit = await db.rawQuery('PRAGMA max_page_count=$pageLimit');
          expect(limit.single.values.single, pageLimit);
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
  Future<bool> databaseExists(String path) =>
      cipher.databaseFactory.databaseExists(path);
  @override
  Future<void> deleteDatabase(String path) =>
      cipher.databaseFactory.deleteDatabase(path);
  @override
  Future<String> getDatabasesPath() =>
      cipher.databaseFactory.getDatabasesPath();
  @override
  Future<void> setDatabasesPath(String path) =>
      cipher.databaseFactory.setDatabasesPath(path);
  @override
  Future<Uint8List> readDatabaseBytes(String path) =>
      cipher.databaseFactory.readDatabaseBytes(path);
  @override
  Future<void> writeDatabaseBytes(String path, Uint8List bytes) =>
      cipher.databaseFactory.writeDatabaseBytes(path, bytes);
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'Native SQLCipher SQLITE_FULL rolls back ledger outbox audit and keeps the draft for the same-ID retry',
    (tester) async {
      expect(Platform.isAndroid, isTrue);
      const security = DeviceSecurity();
      final directory = Directory(
        p.join(
          (await getApplicationSupportDirectory()).path,
          'integration-native-full',
          newId(),
        ),
      );
      await directory.create(recursive: true);
      final path = p.join(directory.path, 'ledger.db');
      final scope = 'integration:native-full:${directory.path}';
      final password = await security.databasePassword(scope);
      const tenant = 'native_full_tenant', uid = 'native_full_manager';
      final party = Party(
        id: 'native_full_party',
        tenantId: tenant,
        name: List.filled(160, 'ع').join(),
        kind: 'merchant',
      );
      LedgerEntry invoice(String id, {String note = ''}) => LedgerEntry(
        id: id,
        tenantId: tenant,
        creatorUid: uid,
        kind: 'sale',
        date: '2026-10-18',
        partyId: party.id,
        partyName: party.name,
        qtyMilli: 1250,
        priceMinor: 2000,
        totalMinor: 2500,
        paidMinor: 500,
        grade: List.filled(80, 'ص').join(),
        unit: List.filled(40, 'و').join(),
        note: note,
      );

      final previous = invoice('native_before_full');
      // A valid maximum-length note needs overflow pages. If the pager has one
      // page left after a failed pressure insert, the ledger/outbox transaction
      // still cannot fit. This is genuine SQLITE_FULL from native SQLCipher.
      final rejected = invoice(
        'native_full_stable_operation',
        note: List.filled(1000, '証').join(),
      );
      const draft = {
        'id': 'native_full_stable_operation',
        'qtyText': '١٢٫',
        'amountText': '٢٥٫٠٠',
        'note': 'مسودة محفوظة قبل امتلاء قاعدة الاختبار',
      };
      LedgerStore? store;
      try {
        // First create/open through the unmodified production SQLCipher path.
        store = await LedgerStore.open(
          path: path,
          tenantId: tenant,
          userId: uid,
          password: password,
        );
        await store.saveParty(party);
        await store.saveEntry(previous);
        await store.saveDraft(rejected.id, draft);
        final originalQueueIds = (await store.listOutbox())
            .map((operation) => operation.id)
            .toSet();
        await store.close();
        store = null;

        final limited = _NativePageLimitedFactory(password);
        store = await LedgerStore.open(
          path: path,
          tenantId: tenant,
          userId: uid,
          factory: limited,
        );
        final db = limited.connection;
        final pageSize = int.parse(
          (await db.rawQuery('PRAGMA page_size')).single.values.single
              .toString(),
        );
        expect(pageSize, greaterThanOrEqualTo(4096));
        await db.execute(
          'CREATE TABLE native_disk_pressure(id INTEGER PRIMARY KEY, data BLOB NOT NULL)',
        );
        DatabaseException? full;
        var pressureRows = 0;
        for (; pressureRows < 512; pressureRows++) {
          try {
            await db.rawInsert(
              'INSERT INTO native_disk_pressure(data) VALUES (zeroblob(?))',
              [pageSize],
            );
          } on DatabaseException catch (error) {
            full = error;
            break;
          }
        }
        expect(
          full,
          isNotNull,
          reason: 'Native SQLCipher must hit its pager cap',
        );
        expect(full!.getResultCode(), 13, reason: 'SQLITE_FULL');
        Object? writeFailure;
        try {
          await store.saveEntry(rejected);
        } catch (error) {
          writeFailure = error;
        }
        expect(writeFailure, isA<DatabaseException>());
        final transactionFailure = writeFailure as DatabaseException;
        // SQLITE_FULL can automatically roll back the transaction. The native
        // plugin then attempts ROLLBACK again and replaces the original failure
        // with this exact secondary error. The separate pressure insert above
        // must already have proved code 13; every atomicity assertion below is
        // still mandatory. No other code-1 failure is accepted here.
        final rollbackMaskedFull =
            transactionFailure.getResultCode() == 1 &&
            transactionFailure.toString() ==
                "DatabaseException(cannot rollback - no transaction is active (code 1)) sql 'ROLLBACK' args []";
        expect(
          transactionFailure.getResultCode() == 13 || rollbackMaskedFull,
          isTrue,
          reason: 'Require native SQLITE_FULL or its exact proven secondary ROLLBACK error',
        );
        expect((await store.listEntries()).single.toJson(), previous.toJson());
        expect(
          (await store.listOutbox()).map((operation) => operation.id).toSet(),
          originalQueueIds,
        );
        expect((await store.listDrafts()).single, draft);
        expect(
          await db.query(
            'audit',
            where: 'operation_id=?',
            whereArgs: [rejected.id],
          ),
          isEmpty,
        );
        expect(
          (await db.rawQuery('PRAGMA integrity_check')).single.values.single,
          'ok',
        );
        await store.close();
        store = null;

        final bytes = await File(path).readAsBytes();
        expect(
          latin1.decode(bytes.take(16).toList()),
          isNot('SQLite format 3\u0000'),
        );
        expect(latin1.decode(bytes).contains(rejected.id), isFalse);
        expect(await security.databasePassword(scope), password);
        final reopened = _NativePageLimitedFactory(
          await security.databasePassword(scope),
        );
        store = await LedgerStore.open(
          path: path,
          tenantId: tenant,
          userId: uid,
          factory: reopened,
        );
        expect((await store.listEntries()).single.id, previous.id);
        expect(
          (await store.listOutbox()).map((operation) => operation.id).toSet(),
          originalQueueIds,
        );
        expect((await store.listDrafts()).single, draft);
        final restoredCap = await reopened.connection.rawQuery(
          'PRAGMA max_page_count=256',
        );
        expect(restoredCap.single.values.single, 256);
        // Raising only this fixture's pager budget provides space; pressure
        // rows remain. Retrying and tapping again use the same immutable ID.
        await store.saveEntry(rejected);
        await store.saveEntry(rejected);
        expect((await store.listEntries()).length, 2);
        expect(
          (await store.listOutbox())
              .where((operation) => operation.id == rejected.id)
              .length,
          1,
        );
        expect(await store.listDrafts(), isEmpty);
        expect(
          (await reopened.connection.query(
            'audit',
            where: 'operation_id=?',
            whereArgs: [rejected.id],
          )).length,
          1,
        );
        expect(
          (await reopened.connection.rawQuery('PRAGMA integrity_check'))
              .single
              .values
              .single,
          'ok',
        );
        // Only synthetic fixture metrics are logged. Never log protected keys,
        // identifiers from a live tenant, credentials or customer data.
        // ignore: avoid_print
        print(
          'ANDROID_SQLCIPHER_FULL_VERIFICATION ${jsonEncode({'capacityResultCode': full.getResultCode(), 'transactionExceptionCode': transactionFailure.getResultCode(), 'rollbackMaskedFull': rollbackMaskedFull, 'pageLimit': _NativePageLimitedFactory.pageLimit, 'pageSize': pageSize, 'boundedDatabaseBytes': bytes.length, 'pressureRows': pressureRows, 'draftSurvivedReopen': true, 'sameIdRecoverySucceeded': true})}',
        );
      } finally {
        await store?.close();
        if (await directory.exists()) await directory.delete(recursive: true);
      }
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
