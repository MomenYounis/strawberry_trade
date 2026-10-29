import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as hashes;
import 'package:pointycastle/export.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_sqlcipher/sqflite.dart' as cipher;
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/security/device_security.dart';

/// Run on Android; these tests intentionally do not replace platform channels
/// with mocks. `seed`, followed by an APK update without uninstalling, followed
/// by `verify`, proves the same encrypted DB/key/outbox survive the update.
/// See PERSISTENCE_PHASE below. The default roundtrip uses an isolated fixture.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  const security = DeviceSecurity();
  const phase = String.fromEnvironment(
    'PERSISTENCE_PHASE',
    defaultValue: 'roundtrip',
  );

  testWidgets(
    'Android Keystore identity signs challenges and protects isolated scopes',
    (tester) async {
      expect(
        Platform.isAndroid,
        isTrue,
        reason: 'This is an actual Android integration test',
      );
      final identity = await security.installationIdentity();
      final sameIdentity = await security.installationIdentity();
      expect(sameIdentity.deviceId, identity.deviceId);
      expect(sameIdentity.publicKeySpki, identity.publicKeySpki);
      final spki = base64Url.decode(
        base64Url.normalize(identity.publicKeySpki),
      );
      expect(
        identity.deviceId,
        base64Url.encode(hashes.sha256.convert(spki).bytes).replaceAll('=', ''),
      );
      expect(spki.length, 91);
      expect(spki[26], 4); // DER P-256 SPKI, uncompressed point.
      final domain = ECDomainParameters('prime256v1');
      final key = ECPublicKey(
        domain.curve.decodePoint(spki.sublist(26)),
        domain,
      );
      final challenge = Uint8List.fromList(
        List.generate(64, (i) => (i * 37 + 11) % 256),
      );
      final der = await security.signChallenge(challenge);
      final raw = _rawP256Signature(der);
      BigInt integer(List<int> bytes) => BigInt.parse(
        bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
        radix: 16,
      );
      final signature = ECSignature(
        integer(raw.sublist(0, 32)),
        integer(raw.sublist(32)),
      );
      final verifier = ECDSASigner(SHA256Digest())
        ..init(false, PublicKeyParameter<ECPublicKey>(key));
      expect(verifier.verifySignature(challenge, signature), isTrue);
      challenge[0] ^= 1;
      expect(verifier.verifySignature(challenge, signature), isFalse);

      final nonce = newId();
      final scopeA = 'integration:$nonce:tenant_a:user_a';
      final scopeB = 'integration:$nonce:tenant_b:user_a';
      final passwordA = await security.databasePassword(scopeA);
      final passwordB = await security.databasePassword(scopeB);
      expect(passwordA.length, greaterThanOrEqualTo(40));
      expect(passwordA, isNot(passwordB));
      expect(await security.databasePassword(scopeA), passwordA);
      await security.writeSecureValue(scopeA, 'دليل محفوظ $nonce');
      expect(await security.readSecureValue(scopeA), 'دليل محفوظ $nonce');
      expect(await security.readSecureValue(scopeB), isNull);
      final clock1 = await security.platformClock();
      await tester.pump(const Duration(milliseconds: 20));
      final clock2 = await security.platformClock();
      expect(clock2.elapsedMs, greaterThanOrEqualTo(clock1.elapsedMs));
      expect(clock2.bootCount, clock1.bootCount);
      await expectLater(
        DeviceSecurity.channel.invokeMethod<String>('databasePassword', ''),
        throwsA(isA<PlatformException>()),
      );

      // Android's app-private no-backup directory contains AES-GCM envelopes,
      // never either raw SQLCipher password or the stored secure plaintext.
      final support = await getApplicationSupportDirectory();
      final protected = Directory(
        p.join(support.parent.path, 'no_backup', 'protected-v1'),
      );
      expect(await protected.exists(), isTrue);
      for (final file
          in await protected
              .list()
              .where((e) => e is File)
              .cast<File>()
              .toList()) {
        final content = latin1.decode(
          await file.readAsBytes(),
          allowInvalid: true,
        );
        expect(content.contains(passwordA), isFalse);
        expect(content.contains(passwordB), isFalse);
        expect(content.contains(nonce), isFalse);
      }
    },
  );

  testWidgets(
    'SQLCipher commits ledger and outbox then reopens encrypted with the same protected key',
    (tester) async {
      final support = await getApplicationSupportDirectory();
      final persistent = phase == 'seed' || phase == 'verify';
      expect({'roundtrip', 'seed', 'verify'}, contains(phase));
      final fixture = p.join(
        support.path,
        'integration-persistence',
        persistent ? 'apk-update-v1' : newId(),
      );
      final path = p.join(fixture, 'ledger.db');
      const tenant = 'integration_tenant';
      const uid = 'integration_manager';
      final scope = persistent
          ? 'integration:apk-update-v1'
          : 'integration:$fixture';
      final password = await security.databasePassword(scope);
      final identity = await security.installationIdentity();
      final markerScope = '$scope:marker';
      if (phase == 'verify') {
        expect(
          await File(path).exists(),
          isTrue,
          reason: 'Seed the previous APK first and update without uninstalling',
        );
        final raw = await security.readSecureValue(markerScope);
        expect(raw, isNotNull);
        final marker = Map<String, dynamic>.from(jsonDecode(raw!) as Map);
        expect(marker['deviceId'], identity.deviceId);
        expect(
          marker['passwordDigest'],
          hashes.sha256.convert(utf8.encode(password)).toString(),
        );
      } else {
        await Directory(fixture).create(recursive: true);
      }
      var store = await LedgerStore.open(
        path: path,
        tenantId: tenant,
        userId: uid,
        password: password,
      );
      const party = Party(
        id: 'integration_merchant',
        tenantId: tenant,
        name: 'عميل تجربة أندرويد',
        kind: 'merchant',
      );
      const entry = LedgerEntry(
        id: 'integration_stable_operation',
        tenantId: tenant,
        creatorUid: uid,
        kind: 'sale',
        date: '2026-10-18',
        partyId: 'integration_merchant',
        partyName: 'عميل تجربة أندرويد',
        qtyMilli: 1250,
        priceMinor: 2000,
        totalMinor: 2500,
        paidMinor: 500,
        grade: 'فراولة طازجة',
        unit: 'كيلو',
      );
      try {
        if (phase != 'verify') {
          await store.saveParty(party);
          await store.saveEntry(entry);
          if (persistent) {
            final queue = (await store.listOutbox()).singleWhere(
              (o) => o.id == entry.id,
            );
            if (queue.attempts == 0) {
              await store.fail(entry.id, 'unavailable', nowMs: 1000);
            }
            await store.saveDraft('integration_unfinished_draft', {
              'id': 'integration_unfinished_draft',
              'note': 'مسودة قبل إيقاف التطبيق وتحديثه',
              'qtyText': '١٢٫',
            });
          }
          await security.writeSecureValue(
            markerScope,
            jsonEncode({
              'deviceId': identity.deviceId,
              'passwordDigest': hashes.sha256
                  .convert(utf8.encode(password))
                  .toString(),
              'operationId': entry.id,
              'wirePayloadSha256': hashes.sha256
                  .convert(
                    utf8.encode(
                      canonicalJson(
                        (await store.listOutbox())
                            .singleWhere((o) => o.id == entry.id)
                            .payload,
                      ),
                    ),
                  )
                  .toString(),
            }),
          );
        }
        expect((await store.listEntries()).single.toJson(), entry.toJson());
        expect(
          LedgerEntry.fromJson(
            (await store.listOutbox())
                .singleWhere((o) => o.id == entry.id)
                .payload,
          ).toJson(),
          entry.toJson(),
        );
        if (phase == 'verify') {
          final raw = await security.readSecureValue(markerScope);
          final marker = Map<String, dynamic>.from(jsonDecode(raw!) as Map);
          if (marker['wirePayloadSha256'] != null) {
            expect(
              hashes.sha256
                  .convert(
                    utf8.encode(
                      canonicalJson(
                        (await store.listOutbox())
                            .singleWhere((o) => o.id == entry.id)
                            .payload,
                      ),
                    ),
                  )
                  .toString(),
              marker['wirePayloadSha256'],
            );
          }
        }
        if (persistent) {
          final queue = (await store.listOutbox()).singleWhere(
            (o) => o.id == entry.id,
          );
          expect(queue.status, 'retry');
          expect(queue.attempts, 1);
          expect(queue.nextAttemptMs, 3000);
          expect((await store.listDrafts()).single['qtyText'], '١٢٫');
        }
        await store.close();
        final bytes = await File(path).readAsBytes();
        expect(bytes.length, greaterThan(4096));
        expect(
          latin1.decode(bytes.take(16).toList()),
          isNot('SQLite format 3\u0000'),
        );
        expect(latin1.decode(bytes).contains(entry.id), isFalse);
        expect(latin1.decode(bytes).contains('integration_merchant'), isFalse);

        final raw = await cipher.openDatabase(
          path,
          password: password,
          singleInstance: false,
        );
        try {
          final version = await raw.rawQuery('PRAGMA cipher_version');
          expect(version, isNotEmpty);
          expect(version.single.values.single.toString(), startsWith('4.'));
          expect(await raw.getVersion(), LedgerStore.schemaVersion);
        } finally {
          await raw.close();
        }
        await expectLater(
          _readWithWrongKey(
            path,
            'incorrect_database_password_at_least_32_characters',
          ),
          throwsA(anything),
        );

        store = await LedgerStore.open(
          path: path,
          tenantId: tenant,
          userId: uid,
          password: await security.databasePassword(scope),
        );
        expect((await store.listEntries()).single.id, entry.id);
        expect(
          (await store.listOutbox()).where((o) => o.id == entry.id).length,
          1,
        );
        await store.saveEntry(
          entry,
        ); // Repeated save across process/update reuses ID.
        expect((await store.listEntries()).length, 1);
        expect(
          await store.entryState(entry.id),
          persistent ? 'retry' : 'pending',
        );
        if (!persistent) {
          await store.acknowledge(
            entry.id,
            sessionUserId: uid,
            sessionTenantId: tenant,
          );
          await store.acknowledge(
            entry.id,
            sessionUserId: uid,
            sessionTenantId: tenant,
          );
          expect(
            (await store.listOutbox()).where((o) => o.id == entry.id),
            isEmpty,
          );
        }
      } finally {
        await store.close();
        if (!persistent) await Directory(fixture).delete(recursive: true);
      }
    },
  );

  testWidgets(
    'Native encrypted v1 to v2 migration preserves pending payload, retries and draft',
    (tester) async {
      final support = await getApplicationSupportDirectory();
      final folder = Directory(
        p.join(support.path, 'integration-migration', newId()),
      );
      await folder.create(recursive: true);
      final path = p.join(folder.path, 'ledger.db');
      final password = await security.databasePassword(
        'integration:migration:${folder.path}',
      );
      const tenant = 'native_migration_tenant',
          uid = 'native_migration_manager';
      const party = Party(
        id: 'migration_party',
        tenantId: tenant,
        name: 'عميل اختبار الترقية',
        kind: 'merchant',
      );
      const adjustment = LedgerEntry(
        id: 'migration_operation',
        tenantId: tenant,
        creatorUid: uid,
        kind: 'balance_adjustment',
        date: '2026-10-18',
        partyId: 'migration_party',
        partyName: 'عميل اختبار الترقية',
        totalMinor: 9000,
        adjustmentDirection: 'increase',
        note: 'دليل قبل الترقية',
      );
      var store = await LedgerStore.open(
        path: path,
        tenantId: tenant,
        userId: uid,
        password: password,
      );
      try {
        await store.saveParty(party);
        await store.saveEntry(adjustment);
        await store.fail(adjustment.id, 'unavailable', nowMs: 1000);
        await store.saveDraft('migration_draft', {
          'id': 'migration_draft',
          'note': 'مسودة قبل الترقية',
        });
        await store.close();
        final raw = await cipher.openDatabase(
          path,
          password: password,
          singleInstance: false,
        );
        try {
          await raw.execute('DROP INDEX outbox_schedule');
          await raw.execute('ALTER TABLE outbox DROP COLUMN next_attempt_ms');
          await raw.execute('DROP TABLE conflicts');
          await raw.setVersion(1);
        } finally {
          await raw.close();
        }
        store = await LedgerStore.open(
          path: path,
          tenantId: tenant,
          userId: uid,
          password: await security.databasePassword(
            'integration:migration:${folder.path}',
          ),
        );
        expect(
          (await store.listEntries()).single.toJson(),
          adjustment.toJson(),
        );
        final queue = (await store.listOutbox()).singleWhere(
          (o) => o.id == adjustment.id,
        );
        expect(queue.payload, adjustment.toJson());
        expect(queue.attempts, 1);
        expect(queue.status, 'retry');
        expect(queue.nextAttemptMs, 0);
        expect((await store.listDrafts()).single['id'], 'migration_draft');
        expect(await store.listConflicts(), isEmpty);
        expect(
          LedgerRules.partyBalance(party, await store.listEntries()),
          9000,
        );
      } finally {
        await store.close();
        await folder.delete(recursive: true);
      }
    },
  );
}

Future<void> _readWithWrongKey(String path, String password) async {
  cipher.Database? db;
  try {
    db = await cipher.openDatabase(
      path,
      password: password,
      singleInstance: false,
      readOnly: true,
    );
    await db.rawQuery('SELECT count(*) FROM sqlite_master');
  } finally {
    await db?.close();
  }
}

/// Android SHA256withECDSA produces ASN.1 DER; cryptography verifies IEEE-P1363.
Uint8List _rawP256Signature(Uint8List der) {
  if (der.length < 8 || der[0] != 0x30 || der[1] != der.length - 2) {
    throw const FormatException('Invalid P-256 signature');
  }
  var index = 2;
  Uint8List integer() {
    if (index + 2 > der.length || der[index++] != 2) {
      throw const FormatException('Invalid ECDSA integer');
    }
    final length = der[index++];
    if (length < 1 || length > 33 || index + length > der.length) {
      throw const FormatException('Invalid ECDSA integer length');
    }
    var data = der.sublist(index, index + length);
    index += length;
    if (data.length == 33) {
      if (data.first != 0) {
        throw const FormatException('Oversized ECDSA integer');
      }
      data = data.sublist(1);
    }
    return Uint8List(32)..setRange(32 - data.length, 32, data);
  }

  final r = integer();
  final s = integer();
  if (index != der.length) {
    throw const FormatException('Trailing signature data');
  }
  return Uint8List.fromList([...r, ...s]);
}
