import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/exports.dart';

import 'archive_statement_test.dart' as archive;

const party = Party(
  id: 'customer',
  tenantId: 'tenant',
  name: 'عميل اختبار الحدود',
  kind: 'merchant',
  openingMinor: 5000,
);

LedgerEntry entry(
  int index, {
  String date = '2026-01-01',
  String kind = 'sale',
  int total = 100,
  int paid = 0,
  String original = '',
  String note = '',
  String tenant = 'tenant',
}) => LedgerEntry(
  id: 'entry_$index',
  tenantId: tenant,
  creatorUid: 'manager',
  partyId: kind == 'reversal' ? '' : party.id,
  partyName: party.name,
  kind: kind,
  date: date,
  totalMinor: total,
  paidMinor: paid,
  originalId: original,
  note: note,
);

Matcher limitError = isA<LedgerException>().having(
  (error) => error.code,
  'code',
  'export_limit',
);

Future<Uint8List> withoutFonts(
  List<LedgerEntry> entries, {
  String? from,
  String? to,
}) => ArabicExports.buildStatement(
  latin: ByteData(0),
  regular: ByteData(0),
  bold: ByteData(0),
  business: 'اختبار',
  title: 'كشف',
  entries: entries,
  party: party,
  from: from,
  to: to,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'PDF rejects excess rows and pathological text before parsing fonts',
    () async {
      await expectLater(
        withoutFonts([
          for (var i = 0; i <= ArabicExports.maxPdfRows; i++) entry(i),
        ]),
        throwsA(limitError),
      );
      await expectLater(
        withoutFonts([entry(0, note: '\n' * 13)]),
        throwsA(limitError),
      );
      await expectLater(
        withoutFonts([
          entry(0, note: 'ن' * (ArabicExports.maxPdfRowCodeUnits + 1)),
        ]),
        throwsA(limitError),
      );
      await expectLater(
        withoutFonts([
          for (var i = 0; i < 150; i++) entry(i, note: 'ن' * 1000),
        ]),
        throwsA(limitError),
      );
    },
  );

  test(
    'PDF accepts the row boundary without truncation and bounds its output',
    () async {
      final bytes = await ArabicExports.statement(
        business: 'منشأة اختبار الحدود',
        title: 'بيانات اصطناعية',
        entries: [for (var i = 0; i < ArabicExports.maxPdfRows; i++) entry(i)],
        party: party,
      );
      expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
      expect(bytes.length, lessThanOrEqualTo(ArabicExports.maxPdfOutputBytes));
    },
  );

  test('a narrow period retains all prior history and an out-of-period reversal source', () async {
    final entries = [
      for (var i = 0; i <= ArabicExports.maxPdfRows; i++) entry(i),
      entry(501, date: '2026-02-01', kind: 'merchant_payment', paid: 1000),
      entry(502, date: '2026-02-02', kind: 'reversal', original: 'entry_0'),
      entry(503, date: '2026-03-01', total: 9900),
    ];
    final csv = ArabicExports.statementCsv(
      party: party,
      entries: entries,
      from: '2026-02-01',
      to: '2026-02-28',
    );
    // Independent integer oracle: 5000 + 501*100 - 1000 - 100 = 54000.
    expect(csv, contains('"الرصيد الافتتاحي","551.00"'));
    expect(csv, contains('"الرصيد الختامي","540.00"'));
    expect(csv, contains('"entry_501"'));
    expect(csv, contains('"entry_502"'));
    expect(csv, isNot(contains('"entry_0","2026-01-01"')));
    expect(csv, contains('"القيد الأصلي"'));
    expect(csv, isNot(contains('"entry_503"')));
    final bytes = await ArabicExports.statement(
      business: 'اختبار',
      title: 'فترة محددة',
      entries: entries,
      party: party,
      from: '2026-02-01',
      to: '2026-02-28',
    );
    expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    final empty = ArabicExports.statementCsv(
      party: party,
      entries: entries,
      from: '2026-02-15',
      to: '2026-02-19',
    );
    expect(empty, contains('"الرصيد الافتتاحي","540.00"'));
    expect(empty, contains('"الرصيد الختامي","540.00"'));
    expect(empty, isNot(contains('"entry_')));
  });

  test('statement export refuses invalid dates, scope mixing, duplicate IDs and missing originals', () async {
    for (final dates in [
      ['2026-02', '2026-02-28'],
      ['2026-02-30', '2026-03-01'],
      ['2026-03-01', '2026-02-01'],
    ]) {
      expect(
        () => ArabicExports.statementCsv(
          party: party,
          entries: [entry(0)],
          from: dates[0],
          to: dates[1],
        ),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(
        withoutFonts([entry(0)], from: dates[0], to: dates[1]),
        throwsA(isA<LedgerException>()),
      );
    }
    for (final entries in [
      [entry(0), entry(1, tenant: 'another')],
      [entry(0), entry(0)],
      [entry(1, kind: 'reversal', original: 'missing')],
    ]) {
      expect(
        () => ArabicExports.statementCsv(party: party, entries: entries),
        throwsA(isA<LedgerException>()),
      );
      await expectLater(withoutFonts(entries), throwsA(isA<LedgerException>()));
    }
    expect(
      () => ArabicExports.csv([entry(0), entry(1, tenant: 'another')]),
      throwsA(isA<LedgerException>()),
    );
  });

  test('CSV row boundary includes the final row and rejects overflow without a partial file', () {
    final entries = [
      for (var i = 0; i < ArabicExports.maxCsvRows; i++) entry(i),
    ];
    final csv = ArabicExports.csv(entries);
    expect(csv.split('\r\n').length, ArabicExports.maxCsvRows + 1);
    expect(csv, contains('"entry_${ArabicExports.maxCsvRows - 1}"'));
    expect(
      utf8.encode(csv).length,
      lessThanOrEqualTo(ArabicExports.maxCsvBytes),
    );
    expect(
      () => ArabicExports.csv([...entries, entry(ArabicExports.maxCsvRows)]),
      throwsA(limitError),
    );
    expect(
      () => ArabicExports.csv([entry(0, note: 'x' * 32769)]),
      throwsA(limitError),
    );
    expect(
      () => ArabicExports.csv([
        for (var i = 0; i < ArabicExports.maxCsvRows; i++)
          entry(i, note: 'ن' * 1000),
      ]),
      throwsA(limitError),
    );
  });

  test('CSV escapes whitespace-prefixed formulas and preserves exact signed amounts', () {
    final csv = ArabicExports.csv([
      entry(0, note: '  =SUM(1,1)'),
      entry(1, note: '\n@SUM(1,1)'),
      entry(2, note: '-cmd|test'),
    ]);
    expect(csv, contains('"\'  =SUM(1,1)"'));
    expect(csv, contains('"\'\n@SUM(1,1)"'));
    expect(csv, contains('"\'-cmd|test"'));
  });

  test('clipboard text includes the complete boundary and refuses an oversized request', () {
    final entries = [
      for (var i = 0; i < ArabicExports.maxTextRows; i++) entry(i),
    ];
    final text = ArabicExports.statementText(party: party, entries: entries);
    expect(
      text,
      contains(
        'الرصيد آخر الفترة: ${formatMoney(5000 + 100 * entries.length)} ج.م',
      ),
    );
    expect(
      utf8.encode(text).length,
      lessThanOrEqualTo(ArabicExports.maxTextBytes),
    );
    expect(text.split('2026-01-01 ·').length - 1, ArabicExports.maxTextRows);
    expect(
      () => ArabicExports.statementText(
        party: party,
        entries: [...entries, entry(ArabicExports.maxTextRows)],
      ),
      throwsA(limitError),
    );
  });

  test('archive PDF uses the same preflight boundary while CSV preserves all verified rows', () async {
    final count = ArabicExports.maxPdfRows + 1;
    final response = archive.page(
      accounts: [archive.account('merchant', 10000, -count)],
      entries: [
        for (var i = 0; i < count; i++)
          archive.row(
            i + 1,
            archive.payment('payment_$i', amount: 1),
            'merchant',
            -1,
          ),
      ],
    );
    (response['statement'] as Map)['closingSequence'] = count;
    final statement = archive.parse(response);
    await expectLater(
      ArabicExports.archivedStatement(business: 'اختبار', statement: statement),
      throwsA(limitError),
    );
    final csv = ArabicExports.archivedStatementCsv(statement);
    expect(csv, contains('"payment_500"'));
    expect(statement.rows.length, count);
    expect(statement.accounts.single.closingMinor, 10000 - count);
  });

  test('archive text budget rejects excessive PDF text without mutating verified rows', () async {
    const count = 150;
    final response = archive.page(
      accounts: [archive.account('merchant', 10000, -count)],
      entries: [
        for (var i = 0; i < count; i++)
          archive.row(
            i + 1,
            {...archive.payment('payment_$i', amount: 1), 'note': 'ن' * 1000},
            'merchant',
            -1,
          ),
      ],
    );
    (response['statement'] as Map)['closingSequence'] = count;
    final statement = archive.parse(response);
    await expectLater(
      ArabicExports.archivedStatement(business: 'اختبار', statement: statement),
      throwsA(limitError),
    );
    expect(statement.rows.length, count);
    expect(
      ArabicExports.archivedStatementCsv(statement),
      contains('"payment_149"'),
    );
  });

  test('standalone archived reversal is a document with its reference, never a cash-period calculation', () async {
    final bytes = await ArabicExports.statement(
      business: 'منشأة اختبار',
      title: 'مستند مؤرشف للقراءة فقط',
      entries: [entry(1, kind: 'reversal', original: 'earlier_year_operation')],
      readOnlyArchive: true,
    );
    expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
  });

  test(
    'a non-advancing oversized layout hits the runtime page guard',
    () async {
      await expectLater(
        ArabicExports.statement(
          business: '${'أ\n' * 12}أ',
          title: '${'أ\n' * 12}أ',
          entries: [entry(0, note: '${'W' * 70}\n' * 12)],
          party: party,
        ),
        throwsA(limitError),
      );
    },
  );
}
