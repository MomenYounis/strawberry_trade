import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/services/exports.dart';
import 'package:strawberry_trade/services/gateway.dart';
import 'package:strawberry_trade/main.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Native identity, offline SQLCipher restart, callable exactly-once ack and bundled Arabic PDF',
    (tester) async {
      expect(Platform.isAndroid, isTrue);
      const security = DeviceSecurity();
      final identity = await security.installationIdentity();
      final client = HttpClient();
      final request = await client.postUrl(
        Uri.parse('http://${FirebaseGateway.emulatorHost}:8008/seed'),
      );
      request.headers.contentType = ContentType.json;
      request.write(
        jsonEncode({
          'deviceId': identity.deviceId,
          'publicKeySpki': identity.publicKeySpki,
        }),
      );
      final response = await request.close();
      final raw = await utf8.decoder.bind(response).join();
      expect(response.statusCode, 200, reason: raw);
      final fixture = Map<String, dynamic>.from(jsonDecode(raw) as Map);
      client.close();
      final gateway = FirebaseGateway(security);
      await gateway.login(
        fixture['email'] as String,
        fixture['password'] as String,
      );
      final bootstrap = await gateway.bootstrap(
        fixture['tenantId'] as String,
        identity,
      );
      final tenant = fixture['tenantId'] as String,
          uid = fixture['uid'] as String;
      final session = LicenseSession(
        security: security,
        verifier: LicenseVerifier.configured(),
        tenantId: tenant,
        uid: uid,
        deviceId: identity.deviceId,
      );
      final license = await session.importPackage(
        jsonEncode(bootstrap['licensePackage']),
        trustedOnline: true,
      );
      expect(license.operationalAllowed, isTrue);
      expect(
        license.license!.expiresAtMs! - license.license!.trialStartMs!,
        trialDurationMs,
      );
      final dir = await getApplicationSupportDirectory();
      final path = p.join(dir.path, 'gateway_${newId()}.db');
      final password = await security.databasePassword(
        'integration-gateway:$tenant:$uid',
      );
      var store = await LedgerStore.open(
        path: path,
        tenantId: tenant,
        userId: uid,
        password: password,
      );
      final party = Party(
        id: newId(),
        tenantId: tenant,
        name: 'عميل اختبار أندرويد',
        kind: 'merchant',
        openingMinor: 5000,
      );
      final entry = LedgerEntry(
        id: newId(),
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
        grade: 'فراولة طازة (سوق محلي)',
        unit: 'كيلو',
      );
      await store.saveParty(party);
      await store.saveEntry(entry);
      final operation = (await store.listOutbox()).last;
      expect(operation.id, entry.id);
      await store.close();
      // This local reopen makes no Firebase call; stable IDs and both queue rows survive.
      store = await LedgerStore.open(
        path: path,
        tenantId: tenant,
        userId: uid,
        password: password,
      );
      expect((await store.listEntries()).single.toJson(), entry.toJson());
      expect((await store.listOutbox()).map((e) => e.id), [party.id, entry.id]);
      final partyOp = (await store.listOutbox()).first;
      final partyAck = await gateway.send(
        tenant,
        identity.deviceId,
        partyOp.toOperation(),
      );
      expect(partyAck['status'], 'accepted');
      await store.acknowledge(party.id);
      final first = await gateway.send(
        tenant,
        identity.deviceId,
        operation.toOperation(),
      );
      final repeated = await gateway.send(
        tenant,
        identity.deviceId,
        operation.toOperation(),
      );
      expect(first['status'], 'accepted');
      expect(repeated['sequence'], first['sequence']);
      await store.acknowledge(
        entry.id,
        sessionTenantId: tenant,
        sessionUserId: uid,
      );
      final changes = await gateway.pull(tenant, identity.deviceId, 0);
      final matching = (changes['changes'] as List)
          .where((c) => c['entity'] == 'entry' && c['id'] == entry.id)
          .toList();
      expect(matching.length, 1);
      expect((await store.listOutbox()), isEmpty);
      final bytes = await ArabicExports.statement(
        business: 'منشأة اختبار أندرويد',
        title: 'كشف حساب عربي دون اتصال',
        entries: await store.listEntries(),
        party: party,
      );
      expect(bytes.length, greaterThan(1000));
      expect(latin1.decode(bytes.sublist(0, 5)), '%PDF-');
      await File(p.join(dir.path, 'android-arabic-statement.pdf'))
          .writeAsBytes(bytes);
      final share = ArabicExports.shareBytes(
        bytes,
        'arabic-statement.pdf',
        'application/pdf',
      );
      // The Android driver only opens and dismisses the chooser; no message is sent.
      // ignore: avoid_print
      print('ANDROID_PDF_SHARE_CHOOSER');
      await share.timeout(const Duration(seconds: 45));
      await store.close();
      // Exercise the real setup path as well: it writes the protected session
      // pointer and opens the normal production database filename. A later
      // force-stop/offline launch must recover this same scope.
      final app = AppController(
        security: security,
        gateway: gateway,
        verifier: LicenseVerifier.configured(),
      );
      app.loading = false;
      app.identity = identity;
      await app.connect(
        tenant: tenant,
        email: fixture['email'] as String,
        password: fixture['password'] as String,
      );
      for (var i = 0; i < 100 && app.syncing; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
      }
      expect(app.syncing, isFalse);
      await app.refresh();
      expect(app.entries.where((e) => e.id == entry.id).length, 1);
      // The external Android driver enables airplane mode at this marker.
      // ignore: avoid_print
      print('ANDROID_OFFLINE_SAVE_READY');
      await Future<void>.delayed(const Duration(seconds: 5));
      final offlineEntry = LedgerEntry(
        id: newId(),
        tenantId: tenant,
        creatorUid: uid,
        kind: 'sale',
        date: '2026-10-19',
        partyId: party.id,
        partyName: party.name,
        qtyMilli: 1000,
        priceMinor: 100,
        totalMinor: 100,
        grade: entry.grade,
        unit: entry.unit,
        note: 'عملية اختبار محفوظة في وضع الطيران قبل الإغلاق والتحديث',
      );
      await app.saveEntry(offlineEntry);
      expect(
        (await app.store!.listOutbox()).any((o) => o.id == offlineEntry.id),
        isTrue,
      );
      await security.writeSecureValue(
        'integration:offline-ui-proof',
        jsonEncode({
          'tenantId': tenant,
          'uid': uid,
          'operationId': offlineEntry.id,
        }),
      );
      // ignore: avoid_print
      print('ANDROID_OFFLINE_OPERATION_COMMITTED');
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appProvider.overrideWith((ref) => app)],
          child: const StrawberryApp(),
        ),
      );
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('عملية جديدة'), findsOneWidget);
      expect(find.text('سجلك المحلي جاهز'), findsOneWidget);
      expect(LedgerRules.partyBalance(party, app.entries), 7100);
      await tester.pumpWidget(const SizedBox.shrink());
      // ProviderScope owns and disposes the controller exactly once.
    },
  );
}
