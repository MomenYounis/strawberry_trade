import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/archive_reader.dart';
import 'package:strawberry_trade/services/exports.dart';

import 'domain_test.dart' as reference;

void main() {
  final invoice = reference.invoice(date: '2027-08-31');
  Map<String, dynamic> response() => {
    'status': 'found',
    'archive': {'year': 2026},
    'record': {
      ...invoice.toJson(),
      'archived': true,
      'readOnly': true,
      'archiveYear': 2026,
    },
  };
  ArchiveRecordPage parse(Map<String, dynamic> data) => ArchiveRecordPage.parse(
    data,
    tenantId: 't1',
    year: 2026,
    recordId: invoice.id,
    requestedChunk: 0,
  );
  test('repeated read-only record parsing/export has no financial posting', () {
    for (var i = 0; i < 3; i++) {
      final record = parse(response()).record!;
      expect(record.id, invoice.id);
      expect(ArabicExports.csv([record]), contains(invoice.id));
      expect(record.totalMinor, 20000);
    }
  });
  test('wrong tenant, year, id and writable record fail closed', () {
    for (final override in [
      {'tenantId': 'other'},
      {'id': 'other'},
      {'archiveYear': 2027},
      {'readOnly': false},
      {'date': '2027-09-01'},
      {'totalMinor': -1},
    ]) {
      final data = response();
      data['record'] = {...data['record'] as Map, ...override};
      expect(() => parse(data), throwsA(isA<LedgerException>()));
    }
    expect(
      () => parse({
        ...response(),
        'archive': {'year': 2027},
      }),
      throwsA(isA<LedgerException>()),
    );
  });
  test('bounded scan resumes only on a strictly advancing chunk cursor', () {
    expect(
      parse({
        'status': 'continue',
        'archive': {'year': 2026},
        'nextChunk': 4,
      }).nextChunk,
      4,
    );
    expect(
      () => parse({
        'status': 'continue',
        'archive': {'year': 2026},
        'nextChunk': 0,
      }),
      throwsA(isA<LedgerException>()),
    );
  });
  test('archive catalogue pages move towards older years without repeats', () {
    final page = ArchiveListPage.parse({
      'archives': [
        {'year': 2028},
        {'year': 2027},
      ],
      'nextYear': 2027,
    }, afterYear: 2029);
    expect(page.nextYear, 2027);
    for (final response in [
      {
        'archives': [
          {'year': 2029},
        ],
        'nextYear': null,
      },
      {
        'archives': [
          {'year': 2027},
          {'year': 2028},
        ],
        'nextYear': null,
      },
      {
        'archives': [
          {'year': 2028},
          {'year': 2028},
        ],
        'nextYear': null,
      },
      {
        'archives': [
          {'year': 2028},
        ],
        'nextYear': 2029,
      },
    ]) {
      expect(
        () => ArchiveListPage.parse(response, afterYear: 2029),
        throwsA(isA<LedgerException>()),
      );
    }
  });
  test(
    'CSV distinguishes trusted original business date from posting date',
    () {
      final corrected = LedgerEntry.fromJson({
        ...invoice.toJson(),
        'date': '2027-09-02',
        'originalBusinessDate': '2027-08-31',
        'correctionOfOperationId': 'offline-original',
      });
      final csv = ArabicExports.csv([corrected]);
      expect(csv, contains('2027-09-02'));
      expect(csv, contains('2027-08-31'));
      expect(csv, contains('offline-original'));
      expect(corrected.toJson().containsKey('correctionOfOperationId'), false);
    },
  );
}
