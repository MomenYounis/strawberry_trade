import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/sync_protocol.dart';

void main() {
  Map<String, dynamic> page() => {
    'changes': <dynamic>[],
    'lastSequence': 10,
    'hasMore': false,
  };
  test(
    'legacy full-history responses remain compatible during protocol rollout',
    () {
      expect(SyncPage.parse(page(), 10).lastSequence, 10);
      expect(syncProtocolVersion, 2);
    },
  );
  test('history gaps and upgrades stop before installing any page', () {
    for (final response in [
      {...page(), 'historyFloor': 11},
      {...page(), 'status': 'resync_required'},
      {...page(), 'status': 'upgrade_required'},
      {...page(), 'syncProtocolVersion': 3},
    ]) {
      expect(
        () => SyncPage.parse(response, 10),
        throwsA(isA<LedgerException>()),
      );
    }
  });
  test(
    'cursor rollback, overflow, malformed and nonprogressing pages fail closed',
    () {
      for (final response in [
        {...page(), 'lastSequence': 9},
        {...page(), 'lastSequence': maxSyncSequence + 1},
        {...page(), 'lastSequence': 10.0},
        {...page(), 'hasMore': true},
        {...page(), 'hasMore': 'false'},
        {
          ...page(),
          'changes': [null],
        },
        {...page(), 'changes': List.filled(1001, {})},
        {...page(), 'historyFloor': -1},
      ]) {
        expect(
          () => SyncPage.parse(response, 10),
          throwsA(isA<LedgerException>()),
        );
      }
    },
  );
  test(
    'strict event sequences prevent silent gaps from malformed page cursors',
    () {
      Map<String, dynamic> event(int sequence) => {
        'sequence': sequence,
        'entity': 'party',
        'payload': {},
      };
      for (final response in [
        {...page(), 'lastSequence': 11},
        {
          ...page(),
          'changes': [event(11)],
        },
        {
          ...page(),
          'lastSequence': 12,
          'changes': [event(12), event(11)],
        },
        {
          ...page(),
          'lastSequence': 11,
          'changes': [event(11), event(11)],
        },
        {
          ...page(),
          'lastSequence': 11,
          'changes': [
            {'entity': 'party', 'payload': {}},
          ],
        },
      ]) {
        expect(
          () => SyncPage.parse(response, 10),
          throwsA(isA<LedgerException>()),
        );
      }
      expect(
        SyncPage.parse({
          ...page(),
          'lastSequence': 14,
          'changes': [event(11), event(14)],
        }, 10).lastSequence,
        14,
      );
    },
  );
}
