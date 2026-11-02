import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';

import '../../test/active_snapshot_test.dart' show Fixture, record;
import '../../test/domain_test.dart' as reference;

void main() {
  test('process death during SQL snapshot merge leaves original ledger/outbox and resumable pages', () async {
    sqfliteFfiInit();
    final root = Platform.environment['STRAWBERRY_CRASH_PROBE_ROOT'] ?? '';
    if (!root.startsWith('/tmp/strawberry-snapshot-crash-')) {
      throw StateError('synthetic-private-path-required');
    }
    final store = await LedgerStore.open(
      path: '$root/ledger.db',
      tenantId: 't1',
      userId: 'u1',
      factory: databaseFactoryFfi,
    );
    if (Platform.environment['STRAWBERRY_CRASH_PHASE'] == 'kill') {
      await store.saveParty(reference.merchant);
      await store.saveEntry(reference.invoice(id: 'pending_local'));
      await store.fail('pending_local', 'unavailable', nowMs: 100);
      await store.setPreference('cursor', 7);
      final fixture = Fixture(
        [
          record('party', reference.merchant.toJson(), 1),
          for (var i = 2; i <= 3001; i++)
            record('entry', reference.invoice(id: 'server_$i').toJson(), i),
        ],
        checkpoint: 4000,
        floor: 0,
        pageSize: 60,
      );
      await fixture.stage(store);
      await store.installActiveSnapshot(
        'snapshot1',
        expectedMembershipEpoch: 7,
        onProgress: (n) async {
          if (n > 1000) {
            await File(
              '$root/kill-marker',
            ).writeAsString('SIGKILL after $n validated records', flush: true);
            Process.killPid(pid, ProcessSignal.sigkill);
          }
        },
      );
      fail('Process must terminate inside the uncommitted merge');
    } else {
      expect(File('$root/kill-marker').existsSync(), isTrue);
      expect((await store.listEntries()).single.id, 'pending_local');
      expect(await store.preference('cursor'), 7);
      final queue = await store.listOutbox();
      expect(queue.map((o) => o.id).toSet(), {'m1', 'pending_local'});
      expect(queue.firstWhere((o) => o.id == 'pending_local').attempts, 1);
      final staged = await store.activeSnapshotStatus(
        'snapshot1',
        expectedMembershipEpoch: 7,
      );
      expect(staged!.complete, isTrue);
      expect(staged.installed, isFalse);
      await store.installActiveSnapshot(
        'snapshot1',
        expectedMembershipEpoch: 7,
      );
      expect((await store.listEntries()).length, 3001);
      expect(await store.preference('cursor'), 4000);
      expect(
        (await store.listOutbox()).map((o) => o.toOperation()),
        queue.map((o) => o.toOperation()),
      );
      await store.close();
    }
  });
}
