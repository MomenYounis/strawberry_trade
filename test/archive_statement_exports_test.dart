import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/archive_statement.dart';
import 'package:strawberry_trade/services/exports.dart';

import 'archive_statement_test.dart' as fixture;

const syntheticCorrectionId =
    'synthetic_correction_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

ArchivedPartyStatement exportFixture({
  String note = 'بيانات اصطناعية - تسوية لفترة مغلقة',
  String name = 'عميل ومورد اصطناعي لتجارة الفراولة',
}) => fixture.parse(
  fixture.page(
    accounts: [
      fixture.account('merchant', 2000000, -550000),
      fixture.account('supplier', -100000, -50000),
    ],
    parties: [
      {
        'id': 'party',
        'tenantId': 'tenant',
        'kind': 'merchant',
        'name': name,
        'openingMinor': 987654,
      },
    ],
    references: [
      fixture.row(
        1,
        fixture.invoice('synthetic_prior_invoice', date: '2027-08-31'),
        'merchant',
        2000000,
      ),
    ],
    entries: [
      fixture.row(
        2,
        fixture.payment('synthetic_customer_receipt'),
        'merchant',
        -500000,
      ),
      fixture.row(
        3,
        fixture.payment(
          'synthetic_supplier_advance',
          kind: 'supplier_payment',
          amount: 50000,
        ),
        'supplier',
        -50000,
      ),
      fixture.row(
        4,
        {
          ...fixture.payment(syntheticCorrectionId, amount: 50000),
          'originalBusinessDate': '2027-08-31',
          'correctionOfOperationId': 'synthetic_offline_operation',
          'note': note,
        },
        'merchant',
        -50000,
      ),
      fixture.row(
        5,
        fixture.invoice(
          'synthetic_current_return',
          kind: 'sale_return',
          total: 500000,
          qty: 2500,
          original: 'synthetic_prior_invoice',
        ),
        'merchant',
        -500000,
      ),
    ],
    reversals: [
      {
        'sequence': 6,
        'entry': fixture.reversal(
          'synthetic_return_reversal',
          'synthetic_current_return',
        ),
      },
    ],
  ),
);

List<List<String>> readCsv(String value) {
  final rows = <List<String>>[];
  var row = <String>[], field = StringBuffer(), quoted = false;
  final input = value.startsWith('\uFEFF') ? value.substring(1) : value;
  for (var i = 0; i < input.length; i++) {
    final character = input[i];
    if (character == '"') {
      if (quoted && i + 1 < input.length && input[i + 1] == '"') {
        field.write('"');
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character == ',') {
      row.add(field.toString());
      field = StringBuffer();
    } else if (!quoted &&
        character == '\r' &&
        i + 1 < input.length &&
        input[i + 1] == '\n') {
      row.add(field.toString());
      rows.add(row);
      row = [];
      field = StringBuffer();
      i++;
    } else {
      field.write(character);
    }
  }
  expect(quoted, false);
  row.add(field.toString());
  rows.add(row);
  return rows;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('CSV exports authoritative role controls and signed running balances without posting references', () {
    final statement = exportFixture();
    final before = canonicalJson(
      statement.rows.map((r) => r.entry.toJson()).toList(),
    );
    final csv = ArabicExports.archivedStatementCsv(statement);
    final rows = readCsv(csv);
    expect(csv.startsWith('\uFEFF'), true);
    expect(rows.every((r) => r.length == 27), true);
    expect(rows.length, 8);
    final controls = rows.where((r) => r[0] == 'أرصدة معتمدة').toList();
    expect(controls.map((r) => [r[5], r[19], r[20], r[21]]), [
      ['merchant', '20000.00', '-5500.00', '14500.00'],
      ['supplier', '-1000.00', '-500.00', '-1500.00'],
    ]);
    final movements = rows.where((r) => r[0] == 'حركة فترة').toList();
    expect(movements.map((r) => r[13]), [
      'synthetic_customer_receipt',
      syntheticCorrectionId,
      'synthetic_current_return',
      'synthetic_return_reversal',
      'synthetic_supplier_advance',
    ]);
    expect(movements.map((r) => [r[17], r[18]]), [
      ['-5000.00', '15000.00'],
      ['-500.00', '14500.00'],
      ['-5000.00', '9500.00'],
      ['5000.00', '14500.00'],
      ['-500.00', '-1500.00'],
    ]);
    expect(movements.where((r) => r[13] == 'synthetic_prior_invoice'), isEmpty);
    expect(csv, isNot(contains('9876.54')));
    final corrected = movements.singleWhere(
      (r) => r[13] == syntheticCorrectionId,
    );
    expect(corrected[15], '2027-09-02');
    expect(corrected[22], '2027-08-31');
    expect(corrected[23], 'synthetic_offline_operation');
    expect(
      rows
          .skip(1)
          .every(
            (r) =>
                r[7] == 'a' * 64 &&
                r[8] == '100' &&
                r[9] == '2' &&
                r[26] == 'مؤرشف للقراءة فقط',
          ),
      true,
    );
    expect(
      canonicalJson(statement.rows.map((r) => r.entry.toJson()).toList()),
      before,
    );
  });

  test('CSV escapes formulas, quoted multiline notes and preserves canonical negative amounts', () {
    final rows = readCsv(
      ArabicExports.archivedStatementCsv(
        exportFixture(name: '=SUM(1,1)', note: '=2+2,"اختبار"\r\nسطر عربي ثان'),
      ),
    );
    final corrected = rows.singleWhere((r) => r[13] == syntheticCorrectionId);
    expect(corrected[4], "'=SUM(1,1)");
    expect(corrected[25], "'=2+2,\"اختبار\"\r\nسطر عربي ثان");
    expect(corrected[17], '-500.00');
    expect(corrected[18], '14500.00');
    expect(rows.every((r) => r.length == 27), true);
  });

  test('unknown party cannot export a partial or invented statement', () async {
    final statement = fixture.parse(
      fixture.page(accounts: [], openings: [], to: 0, total: 1)
        ..['status'] = 'not_found'
        ..['nextChunk'] = null,
    );
    expect(
      () => ArabicExports.archivedStatementCsv(statement),
      throwsA(isA<LedgerException>()),
    );
    await expectLater(
      ArabicExports.archivedStatement(business: 'اختبار', statement: statement),
      throwsA(isA<LedgerException>()),
    );
  });

  test('Arabic PDF exports parser-derived positive and negative balances with correction evidence', () async {
    final statement = exportFixture();
    final before = ArabicExports.archivedStatementCsv(statement);
    final bytes = await ArabicExports.archivedStatement(
      business: 'منشأة اختبار اصطناعية',
      statement: statement,
    );
    expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    expect(bytes.length, greaterThan(10000));
    expect(ArabicExports.archivedStatementCsv(statement), before);
    final requested = Platform.environment['STRAWBERRY_ARCHIVE_PDF_QA_DIR'];
    final directory = requested == null
        ? await Directory.systemTemp.createTemp(
            'strawberry-archive-export-test-',
          )
        : Directory(requested);
    await directory.create(recursive: true);
    if (requested == null) {
      addTearDown(() => directory.delete(recursive: true));
    }
    await File('${directory.path}/archived-statement-synthetic.pdf')
        .writeAsBytes(bytes);
    await File('${directory.path}/archived-statement-synthetic.csv')
        .writeAsString(before);
  });

  test(
    'long Arabic archive rows paginate with repeated role table headers',
    () async {
      final statement = fixture.parse(
        fixture.page(
          accounts: [fixture.account('merchant', 2000000, -70000)],
          parties: [
            {
              'id': 'party',
              'tenantId': 'tenant',
              'kind': 'merchant',
              'name': 'مؤسسة اصطناعية لتجارة الفراولة',
              'openingMinor': 987654,
            },
          ],
          entries: [
            for (var i = 0; i < 70; i++)
              fixture.row(
                i + 1,
                {
                  ...fixture.payment(
                    'synthetic_long_receipt_${i.toString().padLeft(3, '0')}',
                    amount: 1000,
                  ),
                  'note': 'ملاحظة عربية اصطناعية طويلة للتحقق من التفاف النص وعدم تداخل القيم والأرصدة داخل الجدول.',
                },
                'merchant',
                -1000,
              ),
          ],
        ),
      );
      final bytes = await ArabicExports.archivedStatement(
        business: 'اختبار تنسيق كشف طويل',
        statement: statement,
      );
      final pages = RegExp(r'/Type\s*/Page\b')
          .allMatches(String.fromCharCodes(bytes))
          .length;
      expect(pages, greaterThan(1));
      final requested = Platform.environment['STRAWBERRY_ARCHIVE_PDF_QA_DIR'];
      if (requested != null) {
        await File('$requested/archived-statement-long-synthetic.pdf')
            .writeAsBytes(bytes);
      }
      expect(statement.accounts.single.closingMinor, 1930000);
    },
  );
}
