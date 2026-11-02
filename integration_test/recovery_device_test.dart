import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/services/recovery_backup.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'portable encrypted recovery onto a separate Android Keystore installation',
    (tester) async {
      expect(Platform.isAndroid, isTrue);
      const phase = String.fromEnvironment(
        'RECOVERY_PHASE',
        defaultValue: 'seed',
      );
      const security = DeviceSecurity();
      final identity = await security.installationIdentity();
      final directory = await getApplicationSupportDirectory();
      final file = File('${directory.path}/replacement-recovery.json');
      final password = await security.databasePassword(
        'native-recovery:$phase:t1:u1',
      );
      final store = await LedgerStore.open(
        path: '${directory.path}/recovery-$phase.db',
        tenantId: 't1',
        userId: 'u1',
        password: password,
      );
      const phrase = 'Synthetic separate recovery phrase 2026';
      const merchant = Party(
        id: 'm1',
        tenantId: 't1',
        name: 'Synthetic recovery customer',
        kind: 'merchant',
        openingMinor: 5000,
      );
      LedgerEntry sale(String id) => LedgerEntry(
        id: id,
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'sale',
        date: '2026-10-18',
        partyId: 'm1',
        partyName: merchant.name,
        qtyMilli: 1000,
        priceMinor: 2000,
        totalMinor: 2000,
        paidMinor: 500,
        grade: 'A',
        unit: 'kg',
      );
      if (phase == 'seed') {
        await store.saveParty(merchant);
        await store.acknowledge('m1');
        await store.saveEntry(sale('accepted'));
        await store.acknowledge('accepted');
        await store.saveEntry(sale('backed_pending'));
        await store.fail('backed_pending', 'unavailable', nowMs: 100);
        await store.saveDraft('draft', {
          'id': 'draft',
          'note': 'Synthetic saved draft',
        });
        final backup = await store.exportBackup(
          maxBytes: RecoveryBackup.maxPlaintextBytes,
        );
        await file.writeAsString(
          jsonEncode(await RecoveryBackup.encrypt(backup, phrase)),
          flush: true,
        );
        await store.saveEntry(sale('lost_without_copy'));
        // Public installation digest only; no database/password/key is printed.
        // ignore: avoid_print
        print('RECOVERY_SOURCE_DEVICE_ID=${identity.deviceId}');
      } else {
        const old = String.fromEnvironment('RECOVERY_OLD_DEVICE_ID');
        expect(old, isNotEmpty);
        expect(identity.deviceId, isNot(old));
        final backup = await RecoveryBackup.decrypt(
          Map<String, dynamic>.from(
            jsonDecode(await file.readAsString()) as Map,
          ),
          phrase,
        );
        await store.restoreBackup(backup);
        await store.restoreBackup(backup);
        expect((await store.listEntries()).map((e) => e.id).toSet(), {
          'accepted',
          'backed_pending',
        });
        final pending = (await store.listOutbox()).single;
        expect(pending.id, 'backed_pending');
        expect(pending.attempts, 1);
        expect(pending.status, 'retry');
        expect((await store.listDrafts()).single['id'], 'draft');
        expect(
          LedgerRules.partyBalance(merchant, await store.listEntries()),
          8000,
        );
        expect(await store.preference('licensePackage'), isNull);
        // ignore: avoid_print
        print('RECOVERY_REPLACEMENT_DISTINCT_KEYSTORE_PASS');
      }
      await store.close();
    },
  );
}
