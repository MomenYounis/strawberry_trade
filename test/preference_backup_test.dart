import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/data/ledger_store.dart';

void main() {
  setUpAll(sqfliteFfiInit);
  test('Backup restores only scoped non-authority preferences and never a sync cursor or entitlement', () async {
    final dir = await Directory.systemTemp.createTemp('strawberry_prefs_');
    final first = await LedgerStore.open(
      path: '${dir.path}/a.db',
      tenantId: 'tenant',
      userId: 'manager',
      factory: databaseFactoryFfi,
    );
    final second = await LedgerStore.open(
      path: '${dir.path}/b.db',
      tenantId: 'tenant',
      userId: 'manager',
      factory: databaseFactoryFfi,
    );
    try {
      await first.setPreference('budgetBusinessMinor', 3000000);
      await first.setPreference('grade', 'فرز أول');
      await first.setPreference('recentPartyIds', ['recent_a']);
      await first.setPreference('cursor', 999);
      final backup = await first.exportBackup();
      expect(
        (backup['preferences'] as List).any((p) => p['key'] == 'cursor'),
        isFalse,
      );
      await second.restoreBackup(backup);
      expect(await second.preference('budgetBusinessMinor'), 3000000);
      expect(await second.preference('grade'), 'فرز أول');
      expect(await second.preference('cursor'), isNull);
      final bad = Map<String, dynamic>.from(
        jsonDecode(jsonEncode(backup)) as Map,
      );
      (bad['preferences'] as List).add({'key': 'isActivated', 'value': 'true'});
      await expectLater(second.restoreBackup(bad), throwsA(anything));
      expect(await second.preference('budgetBusinessMinor'), 3000000);
      expect(await second.preference('isActivated'), isNull);
      await expectLater(
        first.setPreference('budgetHomeMinor', -1),
        throwsA(anything),
      );
    } finally {
      await first.close();
      await second.close();
      await dir.delete(recursive: true);
    }
  });
}
