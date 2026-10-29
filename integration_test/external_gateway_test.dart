import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/services/gateway.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Native explicit callable URL verifies Auth, device/license and 64-bit exactly-once ledger',
    (tester) async {
      expect(Platform.isAndroid, isTrue);
      expect(FirebaseGateway.emulator, isTrue);
      expect(FirebaseGateway.endpoint.baseUrl, 'http://10.0.2.2:18787');
      const security = DeviceSecurity();
      final identity = await security.installationIdentity();
      final client = HttpClient();
      addTearDown(client.close);
      Future<Map<String, dynamic>> jsonRequest(
        String url, {
        Map<String, dynamic>? body,
      }) async {
        final request = body == null
            ? await client.getUrl(Uri.parse(url))
            : await client.postUrl(Uri.parse(url));
        if (body != null) {
          request.headers.contentType = ContentType.json;
          request.write(jsonEncode(body));
        }
        final response = await request.close();
        final text = await utf8.decoder.bind(response).join();
        expect(
          response.statusCode,
          200,
          reason: 'Demo helper must respond successfully',
        );
        return Map<String, dynamic>.from(jsonDecode(text) as Map);
      }

      final before = await jsonRequest('http://10.0.2.2:18787/evidence');
      final fixture = await jsonRequest(
        'http://10.0.2.2:8008/seed',
        body: {
          'deviceId': identity.deviceId,
          'publicKeySpki': identity.publicKeySpki,
        },
      );
      expect(fixture['projectId'], 'demo-strawberry-flutter');
      final gateway = FirebaseGateway(security);
      await gateway.login(
        fixture['email'] as String,
        fixture['password'] as String,
      );
      final tenant = fixture['tenantId'] as String,
          uid = fixture['uid'] as String;
      final bootstrap = await gateway.bootstrap(tenant, identity);
      final session = LicenseSession(
        security: security,
        verifier: LicenseVerifier.configured(),
        tenantId: tenant,
        uid: uid,
        deviceId: identity.deviceId,
      );
      final status = await session.importPackage(
        jsonEncode(bootstrap['licensePackage']),
        trustedOnline: true,
      );
      expect(status.operationalAllowed, isTrue);
      expect(status.role, 'manager');
      expect(
        status.license!.expiresAtMs! - status.license!.trialStartMs!,
        trialDurationMs,
      );
      final directory = await getApplicationSupportDirectory();
      final path = p.join(directory.path, 'external_native_${newId()}.db');
      final password = await security.databasePassword(
        'external-native:$tenant:$uid',
      );
      var store = await LedgerStore.open(
        path: path,
        tenantId: tenant,
        userId: uid,
        password: password,
      );
      addTearDown(() => store.close());
      final party = Party(
        id: newId(),
        tenantId: tenant,
        name: 'عميل نقل أندرويد خارجي تجريبي',
        kind: 'merchant',
      );
      final entry = LedgerEntry(
        id: newId(),
        tenantId: tenant,
        creatorUid: uid,
        kind: 'sale',
        date: '2026-10-19',
        partyId: party.id,
        partyName: party.name,
        qtyMilli: 1000000,
        priceMinor: 3000000,
        totalMinor: 3000000000,
        paidMinor: 0,
        grade: 'فراولة طازة (سوق محلي)',
        unit: 'كيلو',
      );
      await store.saveParty(party);
      await store.saveEntry(entry);
      final queue = await store.listOutbox();
      expect(queue.map((item) => item.id), [party.id, entry.id]);
      await store.close();
      store = await LedgerStore.open(
        path: path,
        tenantId: tenant,
        userId: uid,
        password: password,
      );
      expect((await store.listEntries()).single.totalMinor, 3000000000);
      final restored = await store.listOutbox();
      final partyAck = await gateway.send(
        tenant,
        identity.deviceId,
        restored.first.toOperation(),
      );
      expect(partyAck['status'], 'accepted');
      await store.acknowledge(party.id);
      final operation = restored.last.toOperation();
      final ack = await gateway.send(tenant, identity.deviceId, operation);
      final duplicate = await gateway.send(
        tenant,
        identity.deviceId,
        operation,
      );
      expect(ack['status'], 'accepted');
      expect(duplicate['sequence'], ack['sequence']);
      await store.acknowledge(
        entry.id,
        sessionTenantId: tenant,
        sessionUserId: uid,
      );
      final changes = await gateway.pull(tenant, identity.deviceId, 0);
      final entries = (changes['changes'] as List)
          .where(
            (change) => change['entity'] == 'entry' && change['id'] == entry.id,
          )
          .toList();
      expect(entries.length, 1);
      expect(entries.single['payload']['totalMinor'], 3000000000);
      expect(entries.single['payload']['totalMinor'], isA<int>());
      expect(await store.listOutbox(), isEmpty);
      final evidence = await jsonRequest('http://10.0.2.2:18787/evidence');
      expect(
        evidence['verifiedAuthHeaders'],
        (before['verifiedAuthHeaders'] as int) + 6,
      );
      expect(
        (evidence['requests'] as Map)['bootstrap'],
        greaterThanOrEqualTo(2),
      );
      expect(
        (evidence['requests'] as Map)['syncOperation'],
        greaterThanOrEqualTo(3),
      );
      expect(
        evidence['largeIntegerWireRequests'],
        (before['largeIntegerWireRequests'] as int) + 2,
      );
      expect((evidence['largeIntegerWireKinds'] as List), isNotEmpty);
      expect(
        (evidence['largeIntegerWireKinds'] as List).every(
          const {'json-number', 'int64-tag', 'uint64-tag'}.contains,
        ),
        isTrue,
      );
      expect(evidence['decodedLargeInteger'], isTrue);
      await File(p.join(directory.path, 'external-native-result.json'))
          .writeAsString(
            jsonEncode({
              'externalPort': 18787,
              'verifiedAuthHeaders': evidence['verifiedAuthHeaders'],
              'taggedLargeInteger': evidence['taggedLargeInteger'],
              'largeIntegerWireKinds': evidence['largeIntegerWireKinds'],
              'decodedTotalMinor': 3000000000,
              'exactlyOnce': true,
              'nativeP256Proof': true,
              'signedLicenseVerified': true,
              'sqlCipherReopened': true,
              'productionAttestationTested': false,
            }),
          );
      // ignore: avoid_print
      print('EXTERNAL_NATIVE_CALLABLE_PASSED');
    },
  );
}
