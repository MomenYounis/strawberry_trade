import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_sqlcipher/sqflite.dart' as cipher;
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/presentation/screens.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart' show LicenseStatus;
import 'package:strawberry_trade/services/active_snapshot.dart';

// A synthetic offline Android capacity fixture, not Firebase/Auth acceptance.
// One DEBUG APK, retained throughout: first launch stages73k then self-SIGKILLs
// in the merge; reboot and relaunch installs73k; relaunch installs80.3k growth;
// reboot and relaunch verifies durability and the real full-domain/UI boundary.
// An explicitly named new campaign preserves every older synthetic database.
const _campaign = String.fromEnvironment(
  'NATIVE_ANNUAL_CAMPAIGN',
  defaultValue: 'v12',
);
// The signer scans this constant in the actual compiled DEBUG kernel.
const _campaignProof = 'NATIVE_ANNUAL_CAMPAIGN=$_campaign;';
const _scope = 'integration:native-annual-$_campaign:t1:u1';
const _markerScope = '$_scope:marker';
const _security = DeviceSecurity();
const _epoch = 17;
const _draft = {
  'id': 'annual_draft',
  'note': 'keep across process death and reboot',
};
const _party = Party(
  id: 'm1',
  tenantId: 't1',
  name: 'عميل اختبار السعة السنوية',
  kind: 'merchant',
  openingMinor: 5000,
);

String _digest(Object? value) =>
    sha256.convert(utf8.encode(canonicalJson(value))).toString();
LedgerEntry _sale(String id, {int day = 0}) => LedgerEntry(
  id: id,
  tenantId: 't1',
  creatorUid: 'u1',
  kind: 'sale',
  date: DateTime.utc(
    2026,
    9,
    1,
  ).add(Duration(days: day % 365)).toIso8601String().substring(0, 10),
  partyId: _party.id,
  partyName: _party.name,
  qtyMilli: 10000,
  priceMinor: 2000,
  totalMinor: 20000,
  paidMinor: 10000,
  grade: 'A',
  unit: 'kg',
);
Map<String, dynamic> _record(
  String entity,
  Map<String, dynamic> payload,
  int sequence,
) => {'entity': entity, 'payload': payload, 'sequence': sequence};

class _Package {
  _Package(this.count);
  final int count;
  String get id => 'native_annual_$count';
  int get pageCount => (count / 60).ceil() + 1;
  List<Map<String, dynamic>> records(int page) {
    if (page == pageCount - 1) {
      return [_record('party', _party.toJson(), count + 1)];
    }
    final first = page * 60 + 1;
    return [
      for (var i = first; i < min(first + 60, count + 1); i++)
        _record(
          'entry',
          _sale('server_${i.toString().padLeft(8, '0')}', day: i - 1).toJson(),
          i,
        ),
    ];
  }

  Map<String, dynamic> page(int index) {
    final rows = records(index);
    return {
      'snapshotId': id,
      'index': index,
      'records': rows,
      'sha256': activeSnapshotHash(rows),
    };
  }

  Map<String, dynamic> header() => {
    'format': 'active_snapshot',
    'version': 1,
    'syncProtocolVersion': 2,
    'snapshotId': id,
    'tenantId': 't1',
    'uid': 'u1',
    'role': 'manager',
    'membershipEpoch': _epoch,
    'checkpointSequence': count + 1,
    'historyFloor': 0,
    'pageCount': pageCount,
    'recordCount': count + 1,
    'contentSha256': activeSnapshotHash([
      for (var i = 0; i < pageCount; i++)
        {
          'index': i,
          'sha256': page(i)['sha256'],
          'recordCount': records(i).length,
        },
    ]),
  };
  Future<void> stage(LedgerStore store) async {
    final value = header();
    final status = await store.stageActiveSnapshotHeader(
      value,
      expectedHeaderSha256: activeSnapshotHash(value),
      expectedMembershipEpoch: _epoch,
    );
    if (status.installed) return;
    for (var i = 0; i < pageCount; i++) {
      if (status.receivedPageIndexes.contains(i)) continue;
      await store.stageActiveSnapshotPage(
        id,
        page(i),
        expectedMembershipEpoch: _epoch,
      );
      if (i % 120 == 0) {
        // ignore: avoid_print
        print('NATIVE_ANNUAL_STAGE count=$count page=$i/$pageCount');
      }
    }
  }
}

Future<Map<String, dynamic>> _measure(
  String name,
  Future<void> Function() action,
) async {
  final before = ProcessInfo.currentRss;
  var peak = before;
  final timer = Timer.periodic(
    const Duration(milliseconds: 25),
    (_) => peak = max(peak, ProcessInfo.currentRss),
  );
  final watch = Stopwatch()..start();
  try {
    await action();
  } finally {
    timer.cancel();
    peak = max(peak, ProcessInfo.currentRss);
  }
  return {
    'name': name,
    'elapsedMs': watch.elapsedMilliseconds,
    'rssBeforeBytes': before,
    'rssPeakBytes': peak,
    'incrementalRssBytes': peak - before,
  };
}

Future<Map<String, Object?>> _sqlControls(String path, String password) async {
  final db = await cipher.openDatabase(
    path,
    password: password,
    singleInstance: false,
    readOnly: true,
  );
  try {
    expect(await db.rawQuery('PRAGMA cipher_version'), isNotEmpty);
    return (await db.rawQuery(
      "SELECT count(*) AS records,coalesce(sum(json_extract(payload,'\$.totalMinor')-json_extract(payload,'\$.paidMinor')),0) AS debt,coalesce(sum(json_extract(payload,'\$.paidMinor')),0) AS cash FROM entries",
    )).single;
  } finally {
    await db.close();
  }
}

Future<void> _assertRetained(
  LedgerStore store,
  Map<String, dynamic> marker,
) async {
  final queue = (await store.listOutbox()).single;
  expect(queue.id, 'pending_local');
  expect(queue.status, 'retry');
  expect(queue.attempts, 1);
  expect(_digest(queue.toOperation()), marker['queueSha256']);
  expect(queue.nextAttemptMs, marker['nextAttemptMs']);
  final draft = (await store.listDrafts()).single;
  expect(draft, _draft);
  if (marker.containsKey('draftSha256')) {
    expect(_digest(draft), marker['draftSha256']);
  }
}

Future<void> _write(File file, Map<String, dynamic> value) async {
  final encoded = jsonEncode(value);
  expect(utf8.encode(encoded).length, lessThanOrEqualTo(128 * 1024));
  final temporary = File('${file.path}.next');
  await temporary.writeAsString(encoded, flush: true);
  await temporary.rename(file.path);
}

Future<void> _guardCampaignStorage(Directory support) async {
  var datasets = 0;
  var files = 0;
  var bytes = 0;
  var children = 0;
  await for (final child in support.list(followLinks: false)) {
    expect(++children, lessThanOrEqualTo(1024));
    final name = child.path.split('/').last;
    if (!name.startsWith('native-annual-')) continue;
    expect(
      child,
      isA<Directory>(),
      reason: 'ordinary annual fixture directory',
    );
    expect(
      ++datasets,
      lessThanOrEqualTo(2),
      reason: 'retain at most historical v12 and one fresh synthetic campaign',
    );
    var datasetBytes = 0;
    await for (final item in (child as Directory).list(followLinks: false)) {
      expect(item, isA<File>(), reason: 'flat ordinary fixture files only');
      expect(++files, lessThanOrEqualTo(256));
      datasetBytes += (await item.stat()).size;
      expect(datasetBytes, lessThanOrEqualTo(1024 * 1024 * 1024));
    }
    bytes += datasetBytes;
    expect(bytes, lessThanOrEqualTo(2 * 1024 * 1024 * 1024));
  }
}

Future<void> _assertInstalled(
  LedgerStore store,
  String path,
  String password,
  int count,
) async {
  final package = _Package(count);
  final status = await store.activeSnapshotStatus(
    package.id,
    expectedMembershipEpoch: _epoch,
  );
  expect(status, isNotNull);
  expect(
    status!.header.toJson(),
    package.header(),
    reason: 'exact independently regenerated snapshot header and content hash',
  );
  expect(status.installed, isTrue);
  expect(status.complete, isTrue);
  expect(status.receivedPageIndexes, isEmpty);
  expect(await store.preference('cursor'), count + 1);
  expect(await store.preference('historyFloor'), 0);
  expect(await _sqlControls(path, password), {
    'records': count + 1,
    'debt': (count + 1) * 10000,
    'cash': (count + 1) * 10000,
  });
  final db = await cipher.openDatabase(
    path,
    password: password,
    singleInstance: false,
    readOnly: true,
  );
  try {
    final party = (await db.query('parties')).single;
    expect(
      _digest(jsonDecode(party['payload']! as String)),
      _digest(_party.toJson()),
    );
    final invalid = (await db.rawQuery(
      r"""
SELECT count(*) AS invalid FROM entries WHERE
 json_extract(payload,'$.id') IS NOT id OR
 json_extract(payload,'$.tenantId') IS NOT 't1' OR
 json_extract(payload,'$.creatorUid') IS NOT 'u1' OR
 json_extract(payload,'$.kind') IS NOT 'sale' OR
 json_extract(payload,'$.partyId') IS NOT 'm1' OR
 json_extract(payload,'$.partyName') IS NOT ? OR
 json_extract(payload,'$.qtyMilli') IS NOT 10000 OR
 json_extract(payload,'$.priceMinor') IS NOT 2000 OR
 json_extract(payload,'$.totalMinor') IS NOT 20000 OR
 json_extract(payload,'$.paidMinor') IS NOT 10000 OR
 json_extract(payload,'$.grade') IS NOT 'A' OR
 json_extract(payload,'$.unit') IS NOT 'kg' OR NOT (
  (id='pending_local' AND json_extract(payload,'$.date')='2026-09-01') OR
  (id=printf('server_%08d',CAST(substr(id,8) AS INTEGER)) AND
   CAST(substr(id,8) AS INTEGER) BETWEEN 1 AND ? AND
   json_extract(payload,'$.date')=date('2026-09-01','+' ||
     ((CAST(substr(id,8) AS INTEGER)-1)%365) || ' days')))
""",
      [_party.name, count],
    )).single;
    expect(
      invalid['invalid'],
      0,
      reason: 'independent per-row financial/date/ID controls',
    );
  } finally {
    await db.close();
  }
}

bool _hasFreshRollbackProof(Map<String, dynamic> marker) {
  final proof = marker['rollbackVerified'];
  return marker['fixtureVersion'] == 2 &&
      marker['hardKill'] == true &&
      marker['killValidatedRecords'] is int &&
      (marker['killValidatedRecords'] as int) >= 4096 &&
      proof is Map &&
      proof['kind'] == 'observed_native_sqlcipher_rollback' &&
      proof['cursor'] == null &&
      proof['records'] == 1 &&
      proof['retainedQueueSha256'] == marker['queueSha256'] &&
      proof['retainedDraftSha256'] == marker['draftSha256'] &&
      proof['observedBootCount'] is int &&
      (proof['observedBootCount'] as int) > (marker['bootCount'] as int);
}

Future<void> _persistMarker(Map<String, dynamic> marker) =>
    _security.writeSecureValue(_markerScope, jsonEncode(marker));

Future<void> _installMeasured(
  LedgerStore store,
  _Package package,
  Directory support,
  Map<String, dynamic> data,
) async {
  var nextReport = 4096;
  (data['measurements'] as List).add(
    await _measure(
      'install${package.count}',
      () => store.installActiveSnapshot(
        package.id,
        expectedMembershipEpoch: _epoch,
        onProgress: (count) async {
          if (count < nextReport) return;
          nextReport = ((count ~/ 4096) + 1) * 4096;
          await _guardCampaignStorage(support);
          // Counts and RSS only: no key, identity or financial payload is logged.
          // ignore: avoid_print
          print(
            'NATIVE_ANNUAL_INSTALL_PROGRESS package=${package.count} '
            'validatedRecords=$count rssBytes=${ProcessInfo.currentRss}',
          );
        },
      ),
    ),
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native SQLCipher annual capacity, hard process death, reboot resume and full UI memory',
    (tester) async {
      expect(Platform.isAndroid, isTrue);
      const hardKill = bool.fromEnvironment(
        'NATIVE_ANNUAL_HARD_KILL',
        defaultValue: true,
      );
      expect(RegExp(r'^[a-z0-9][a-z0-9-]{0,31}$').hasMatch(_campaign), isTrue);
      // ignore: avoid_print
      print('NATIVE_ANNUAL_CAMPAIGN $_campaignProof');
      final support = await getApplicationSupportDirectory();
      await _guardCampaignStorage(support);
      final directory = Directory('${support.path}/native-annual-$_campaign');
      await directory.create(recursive: true);
      await _guardCampaignStorage(support);
      final results = File('${directory.path}/results.json');
      final path = '${directory.path}/ledger.db';
      final password = await _security.databasePassword(_scope);
      final identity = await _security.installationIdentity();
      final clock = await _security.platformClock();
      final rawMarker = await _security.readSecureValue(_markerScope);
      var marker = rawMarker == null
          ? null
          : Map<String, dynamic>.from(jsonDecode(rawMarker) as Map);
      final store = await LedgerStore.open(
        path: path,
        tenantId: 't1',
        userId: 'u1',
        password: password,
      );
      if (results.existsSync()) {
        expect(await results.length(), lessThanOrEqualTo(128 * 1024));
      }
      final data = results.existsSync()
          ? Map<String, dynamic>.from(
              jsonDecode(await results.readAsString()) as Map,
            )
          : <String, dynamic>{
              'synthetic': true,
              'native': true,
              'productionNetworkUsed': false,
              'authenticationAcceptance': false,
              'campaign': _campaign,
              'measurements': <dynamic>[],
            };
      expect(data['measurements'], isA<List>());
      expect((data['measurements'] as List).length, lessThanOrEqualTo(128));
      try {
        if (marker == null) {
          await store.saveParty(_party);
          await store.acknowledge(_party.id);
          await store.saveEntry(_sale('pending_local'));
          if ((await store.listOutbox()).single.attempts == 0) {
            await store.fail('pending_local', 'unavailable', nowMs: 1234);
          }
          await store.saveDraft('annual_draft', _draft);
          final queue = (await store.listOutbox()).single;
          final next = <String, dynamic>{
            'phase': 'resume',
            'fixtureVersion': 2,
            'campaign': _campaign,
            'bootCount': clock.bootCount,
            'deviceId': identity.deviceId,
            'passwordSha256': sha256.convert(utf8.encode(password)).toString(),
            'queueSha256': _digest(queue.toOperation()),
            'draftSha256': _digest(_draft),
            'nextAttemptMs': queue.nextAttemptMs,
            'hardKill': hardKill,
          };
          final package = _Package(73000);
          (data['measurements'] as List).add(
            await _measure('stage73000', () => package.stage(store)),
          );
          await _write(results, data);
          await expectLater(
            store.installActiveSnapshot(
              package.id,
              expectedMembershipEpoch: _epoch,
              onProgress: (count) async {
                if (count < 4096) return;
                next['killValidatedRecords'] = count;
                await _persistMarker(next);
                // ignore: avoid_print
                print('NATIVE_ANNUAL_KILL_READY validatedRecords=$count');
                if (hardKill) {
                  await Future<void>.delayed(const Duration(milliseconds: 150));
                  Process.killPid(pid, ProcessSignal.sigkill);
                  fail('native fixture self-SIGKILL failed');
                }
                throw StateError('synthetic-interruption-no-SIGKILL');
              },
            ),
            throwsStateError,
          );
          expect(await store.preference('cursor'), isNull);
          expect((await _sqlControls(path, password))['records'], 1);
          await _assertRetained(store, next);
          data['status'] = 'INTERRUPTED_SOFTWARE_ONLY';
          await _write(results, data);
        } else {
          expect(marker['campaign'] ?? 'v12', _campaign);
          expect(marker['deviceId'], identity.deviceId);
          expect(
            marker['passwordSha256'],
            sha256.convert(utf8.encode(password)).toString(),
          );
          expect(
            clock.bootCount,
            greaterThan(marker['bootCount']! as int),
            reason: 'reboot this owned disposable Android between launches',
          );
          await _assertRetained(store, marker);
          final cursor = await store.preference('cursor');
          if (marker['phase'] == 'resume') {
            if (cursor == null) {
              expect(
                (await _sqlControls(path, password))['records'],
                1,
                reason: 'killed uncommitted merge must roll back',
              );
              final staged = await store.activeSnapshotStatus(
                'native_annual_73000',
                expectedMembershipEpoch: _epoch,
              );
              expect(staged, isNotNull);
              expect(staged!.header.toJson(), _Package(73000).header());
              expect(staged.complete, isTrue);
              expect(staged.installed, isFalse);
              marker = {
                ...marker,
                'phase': 'install73000',
                'rollbackVerified': {
                  'kind': 'observed_native_sqlcipher_rollback',
                  'cursor': null,
                  'records': 1,
                  'observedBootCount': clock.bootCount,
                  'retainedQueueSha256': marker['queueSha256'],
                  'retainedDraftSha256': _digest(_draft),
                  'stagedHeaderSha256': activeSnapshotHash(
                    staged.header.toJson(),
                  ),
                },
              };
              // Persist the observation before starting a potentially long merge.
              await _persistMarker(marker);
              data['rollbackVerified'] = marker['rollbackVerified'];
              await _write(results, data);
              // ignore: avoid_print
              print('NATIVE_ANNUAL_ROLLBACK_VERIFIED records=1 cursor=null');
            } else {
              expect(
                cursor,
                anyOf(73001, 80301),
                reason: 'no arbitrary old cursor/state can be adopted',
              );
              final count = (cursor as int) - 1;
              await _assertInstalled(store, path, password, count);
              (data.putIfAbsent(
                'committedStateAdoptions',
                () => <dynamic>[],
              ) as List).add({
                'count': count,
                'exactInstalledHeaderAndSqlControlsVerified': true,
                'timingMeasurementRecorded': false,
                'legacyRollbackProofUnavailable': !_hasFreshRollbackProof(
                  marker,
                ),
              });
              marker = {
                ...marker,
                'phase': count == 73000 ? 'growth80300' : 'verify',
                if (count == 80300) 'verificationBootCount': clock.bootCount,
              };
              await _persistMarker(marker);
              data['status'] = count == 73000
                  ? 'BASE_INSTALLED_GROWTH_PENDING'
                  : 'INSTALLED_REBOOT_VERIFICATION_PENDING';
              await _write(results, data);
              // Adoption is evidence preservation, never a fresh timing or
              // rollback claim. A later final result remains blocked if needed.
              // ignore: avoid_print
              print('NATIVE_ANNUAL_COMMITTED_STATE_ADOPTED count=$count');
              return;
            }
          }
          if (marker['phase'] == 'install73000') {
            if (cursor == 73001) {
              // The SQL transaction may commit immediately before process loss,
              // while the separate secure phase marker still names this step.
              await _assertInstalled(store, path, password, 73000);
              (data.putIfAbsent(
                'committedStateAdoptions',
                () => <dynamic>[],
              ) as List).add({
                'count': 73000,
                'exactInstalledHeaderAndSqlControlsVerified': true,
                'timingMeasurementRecorded': false,
                'legacyRollbackProofUnavailable': !_hasFreshRollbackProof(
                  marker,
                ),
              });
            } else {
              expect(cursor, isNull);
              expect((await _sqlControls(path, password))['records'], 1);
              await _installMeasured(store, _Package(73000), support, data);
              await _assertInstalled(store, path, password, 73000);
            }
            await _assertRetained(store, marker);
            // Results first, phase second. Either crash window can be verified
            // through the exact committed proof without repeating a timed merge.
            data['status'] = 'BASE_INSTALLED_GROWTH_PENDING';
            await _write(results, data);
            marker = {...marker, 'phase': 'growth80300'};
            await _persistMarker(marker);
            // ignore: avoid_print
            print('NATIVE_ANNUAL_BASE_INSTALL_PASS');
          } else if (marker['phase'] == 'growth80300') {
            if (cursor == 80301) {
              await _assertInstalled(store, path, password, 80300);
              (data.putIfAbsent(
                'committedStateAdoptions',
                () => <dynamic>[],
              ) as List).add({
                'count': 80300,
                'exactInstalledHeaderAndSqlControlsVerified': true,
                'timingMeasurementRecorded': false,
                'legacyRollbackProofUnavailable': !_hasFreshRollbackProof(
                  marker,
                ),
              });
            } else {
              await _assertInstalled(store, path, password, 73000);
              final package = _Package(80300);
              (data['measurements'] as List).add(
                await _measure('stage80300', () => package.stage(store)),
              );
              await _write(results, data);
              await _installMeasured(store, package, support, data);
              await _assertInstalled(store, path, password, 80300);
            }
            await _assertRetained(store, marker);
            data['status'] = 'INSTALLED_REBOOT_VERIFICATION_PENDING';
            await _write(results, data);
            marker = {
              ...marker,
              'phase': 'verify',
              'verificationBootCount': clock.bootCount,
            };
            await _persistMarker(marker);
            // ignore: avoid_print
            print('NATIVE_ANNUAL_INSTALL_GROWTH_PASS');
          } else {
            expect(marker['phase'], 'verify');
            expect(
              clock.bootCount,
              greaterThan(
                marker['verificationBootCount'] as int? ??
                    marker['bootCount'] as int,
              ),
              reason: 'growth commit needs a subsequent real Android reboot',
            );
            await _assertInstalled(store, path, password, 80300);
            final app = AppController()
              ..store = store
              ..license = const LicenseStatus(
                operationalAllowed: false,
                message: 'Synthetic capacity fixture, not licensing acceptance',
                role: 'manager',
              );
            try {
              (data['measurements'] as List).add(
                await _measure('fullAppControllerRefresh', () => app.refresh()),
              );
              expect(app.entries.length, 80301);
              expect(app.pending.single['id'], 'pending_local');
              (data['measurements'] as List).add(
                await _measure('fullDomainFinancialReports', () async {
                  expect(
                    LedgerRules.partyBalance(_party, app.entries),
                    803015000,
                  );
                  expect(LedgerRules.netRecordedCash(app.entries), 803010000);
                  final lines = LedgerRules.statement(_party, app.entries);
                  expect(lines.length, 80301);
                  expect(lines.last.balanceMinor, 803015000);
                }),
              );
              Widget host(Widget child) => MaterialApp(
                home: Directionality(
                  textDirection: TextDirection.rtl,
                  child: Scaffold(body: child),
                ),
              );
              (data['measurements'] as List).add(
                await _measure('homeScreenPump', () async {
                  await tester.pumpWidget(host(HomeScreen(app: app)));
                  await tester.pumpAndSettle();
                  expect(tester.takeException(), isNull);
                }),
              );
              (data['measurements'] as List).add(
                await _measure('statementScreenPump', () async {
                  await tester.pumpWidget(
                    host(StatementScreen(app: app, party: _party)),
                  );
                  await tester.pumpAndSettle();
                  expect(tester.takeException(), isNull);
                  expect(find.byType(ListTile).evaluate().length, lessThan(40));
                }),
              );
              await tester.pumpWidget(const SizedBox.shrink());
            } finally {
              app.store = null;
              app.dispose();
            }
            data['status'] = _hasFreshRollbackProof(marker)
                ? 'PASS'
                : 'BLOCKED_ROLLBACK_EVIDENCE';
            data['freshControlledKillAndRollbackProof'] =
                _hasFreshRollbackProof(marker);
            if (!_hasFreshRollbackProof(marker)) {
              data['blocker'] = 'Legacy committed state is preserved, but no fresh durable controlled-kill rollback proof exists. Use a new named synthetic campaign; do not reset this database.';
            }
            data['verifiedFinancialRecords'] = 80301;
            data['merchantClosingMinor'] = 803015000;
            data['cashMinor'] = 803010000;
            data['hardKill'] = marker['hardKill'];
            data['rollbackVerified'] = marker['rollbackVerified'];
            data['campaign'] = _campaign;
            await _write(results, data);
            binding.reportData = {'nativeAnnualCapacity': data};
            // ignore: avoid_print
            print('NATIVE_ANNUAL_FINAL ${jsonEncode(data)}');
          }
        }
      } finally {
        await store.close();
        await _guardCampaignStorage(support);
      }
    },
    timeout: const Timeout(Duration(minutes: 45)),
  );
}
