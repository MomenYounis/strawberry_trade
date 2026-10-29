import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/exports.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('Arabic PDF uses bundled fonts offline and paginates a long ledger', () async {
    const party = Party(
      id: 'customer',
      tenantId: 'tenant',
      name: 'مؤسسة الأمانة لتجارة الفراولة',
      kind: 'merchant',
      openingMinor: 5000,
    );
    final entries = List.generate(
      240,
      (i) => LedgerEntry(
        id: 'invoice_${i.toString().padLeft(4, '0')}',
        tenantId: 'tenant',
        creatorUid: 'manager',
        kind: 'sale',
        date: '2026-10-${(i % 18 + 1).toString().padLeft(2, '0')}',
        partyId: party.id,
        partyName: party.name,
        qtyMilli: 1250,
        priceMinor: 2000,
        totalMinor: 2500,
        paidMinor: 1000,
        grade: 'فراولة تصدير فرز أول',
        unit: 'كيلو',
        note:
            'شحنة الفراولة رقم ${i + 1} - ملاحظة عربية طويلة لاختبار الالتفاف الصحيح داخل الجدول.',
      ),
    );
    final bytes = await ArabicExports.statement(
      business: 'تجارة الفراولة',
      title: 'كشف حساب مؤسسة الأمانة',
      entries: entries,
      party: party,
    );
    expect(bytes.length, greaterThan(10000));
    expect(String.fromCharCodes(bytes.take(5)), '%PDF-');
    await File('verification/arabic-statement-sample.pdf').writeAsBytes(bytes);
    expect(LedgerRules.partyBalance(party, entries), 365000);
  });
  test('CSV has Arabic headers and prevents spreadsheet formula injection', () {
    final csv = ArabicExports.csv([
      const LedgerEntry(
        id: 'id',
        tenantId: 't',
        creatorUid: 'u',
        kind: 'expense_business',
        date: '2026-10-18',
        totalMinor: 100,
        paidMinor: 100,
        note: '=HYPERLINK("x")',
      ),
    ]);
    expect(csv, contains('التاريخ'));
    expect(csv, contains("'=HYPERLINK"));
    expect(csv.startsWith('\uFEFF'), isTrue);
  });
}
