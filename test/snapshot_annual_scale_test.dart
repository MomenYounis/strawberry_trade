import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/services/active_snapshot.dart';
import 'package:strawberry_trade/services/recovery_backup.dart';

import 'active_snapshot_test.dart' show record;
import 'domain_test.dart' as reference;

void main() {
  setUpAll(sqfliteFfiInit);
  test('73000 annual financial facts, interrupted install and 10 percent growth reconcile without full projection loading', () async {
    final dir = await Directory.systemTemp.createTemp('annual-snapshot-scale-');
    final path = '${dir.path}/replacement.db';
    var store = await LedgerStore.open(
      path: path,
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    final results = <Map<String, dynamic>>[];
    try {
      await store.saveDraft('surviving_draft', {
        'id': 'surviving_draft',
        'note': 'preserve',
      });
      for (final count in [73000, 80300]) {
        final id = 'annual_$count';
        List<Map<String, dynamic>> records(int start) => [
          for (var i = start; i < min(start + 60, count + 1); i++)
            i == 0
                ? record('party', reference.merchant.toJson(), count + 1)
                : record(
                    'entry',
                    reference.invoice(id: 'sale_$i', paidMinor: 10000).toJson(),
                    i,
                  ),
        ];
        // Server pages are ordered by entity then sequence: entries precede the
        // party. Installation must reorder on disk, not weaken dependencies.
        List<Map<String, dynamic>> pageRecords(int index) {
          final start = 1 + index * 60;
          if (start > count) {
            return [record('party', reference.merchant.toJson(), count + 1)];
          }
          return records(start);
        }

        final pages = (count / 60).ceil() + 1;
        Map<String, dynamic> page(int index) {
          final rows = pageRecords(index);
          return {
            'snapshotId': id,
            'index': index,
            'records': rows,
            'sha256': activeSnapshotHash(rows),
          };
        }

        final descriptors = [
          for (var i = 0; i < pages; i++)
            {
              'index': i,
              'sha256': page(i)['sha256'],
              'recordCount': pageRecords(i).length,
            },
        ];
        final header = {
          'format': 'active_snapshot',
          'version': 1,
          'syncProtocolVersion': 2,
          'snapshotId': id,
          'tenantId': 't1',
          'uid': 'u1',
          'role': 'manager',
          'membershipEpoch': 7,
          'checkpointSequence': count + 1,
          'historyFloor': 0,
          'pageCount': pages,
          'recordCount': count + 1,
          'contentSha256': activeSnapshotHash(descriptors),
        };
        await store.stageActiveSnapshotHeader(
          header,
          expectedHeaderSha256: activeSnapshotHash(header),
          expectedMembershipEpoch: 7,
        );
        for (var i = 0; i < pages; i++) {
          await store.stageActiveSnapshotPage(
            id,
            page(i),
            expectedMembershipEpoch: 7,
          );
        }
        if (count == 73000) {
          await expectLater(
            store.installActiveSnapshot(
              id,
              expectedMembershipEpoch: 7,
              onProgress: (n) async {
                if (n > 4000) throw StateError('interruption');
              },
            ),
            throwsStateError,
          );
          expect(await store.preference('cursor'), isNull);
          await store.close();
          store = await LedgerStore.open(
            path: path,
            tenantId: 't1',
            userId: 'u1',
            factory: databaseFactoryFfi,
          );
        }
        final before = ProcessInfo.currentRss;
        var peak = before;
        final watch = Stopwatch()..start();
        await store.installActiveSnapshot(
          id,
          expectedMembershipEpoch: 7,
          onProgress: (n) async {
            peak = max(peak, ProcessInfo.currentRss);
          },
        );
        final read = await databaseFactoryFfi.openDatabase(
          path,
          options: OpenDatabaseOptions(readOnly: true, singleInstance: false),
        );
        final financial = (await read.rawQuery(
          "SELECT count(*) AS records,sum(json_extract(payload,'\$.totalMinor')-json_extract(payload,'\$.paidMinor')) AS debt,sum(json_extract(payload,'\$.paidMinor')) AS cash FROM entries",
        )).single;
        await read.close();
        expect(financial, {
          'records': count,
          'debt': count * 10000,
          'cash': count * 10000,
        });
        expect(await store.preference('cursor'), count + 1);
        expect((await store.listDrafts()).single['id'], 'surviving_draft');
        expect(
          peak - before,
          lessThan(160 * 1024 * 1024),
          reason: 'bounded incremental installer memory',
        );
        results.add({
          'records': count,
          'pages': pages,
          'elapsedMs': watch.elapsedMilliseconds,
          'rssBeforeBytes': before,
          'rssPeakBytes': peak,
          'incrementalRssBytes': peak - before,
          'merchantClosingMinor': 5000 + count * 10000,
          'recordedCashMinor': count * 10000,
        });
      }
      // A large accepted ledger is never serialized into the portable pending
      // copy. Merge only the saved queue onto the recovered history, then apply
      // a post-checkpoint delta using indexed dependencies and bounded memory.
      final source = await LedgerStore.open(
        path: '${dir.path}/old-device.db',
        tenantId: 't1',
        userId: 'u1',
        factory: databaseFactoryFfi,
      );
      final beforeMerge = ProcessInfo.currentRss;
      try {
        await source.saveParty(reference.merchant);
        await source.acknowledge('m1');
        await source.saveEntry(reference.invoice(id: 'backed_pending'));
        await source.fail('backed_pending', 'unavailable', nowMs: 1234);
        final saved = await source.exportPendingBackup();
        await store.restoreBackup(saved);
        expect(
          (await store.listOutbox()).single.toOperation(),
          (await source.listOutbox()).single.toOperation(),
        );
        final portable = await store.exportPendingBackup();
        expect((portable['entries'] as List).length, 1);
        expect(utf8.encode(jsonEncode(portable)).length, lessThan(32768));
        final envelope = await RecoveryBackup.encrypt(
          portable,
          'Separate recovery phrase 2026',
        );
        expect(
          (await RecoveryBackup.decrypt(
            envelope,
            'Separate recovery phrase 2026',
          ))['coverage'],
          'pending-and-dependencies',
        );
        await store.applyRemoteBatch(
          [
            record(
              'entry',
              reference.invoice(id: 'accepted_after_snapshot').toJson(),
              80302,
            ),
          ],
          expectedCursor: 80301,
          lastSequence: 80302,
        );
        expect(await store.preference('cursor'), 80302);
        expect((await store.listOutbox()).single.id, 'backed_pending');
        expect(
          ProcessInfo.currentRss - beforeMerge,
          lessThan(64 * 1024 * 1024),
        );
        results.add({
          'scenario': 'pending-copy-plus-post-snapshot-delta',
          'acceptedRecords': 80301,
          'pendingRecords': 1,
          'portableBytes': utf8.encode(jsonEncode(portable)).length,
          'incrementalRssBytes': ProcessInfo.currentRss - beforeMerge,
        });
      } finally {
        await source.close();
      }
      final out = File(
        'verification/continuation-2026-11-02/snapshot-annual-scale.json',
      );
      await out.parent.create(recursive: true);
      await out.writeAsString(
        jsonEncode({
          'status': 'PASS',
          'synthetic': true,
          'native': false,
          'results': results,
        }),
        flush: true,
      );
    } finally {
      await store.close();
      await dir.delete(recursive: true);
    }
  }, timeout: const Timeout(Duration(minutes: 15)));
}
