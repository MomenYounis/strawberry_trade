import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/exports.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'synthetic archived correction exports Arabic read-only evidence',
    () async {
      const entry = LedgerEntry(
        id: 'synthetic_archived_correction',
        tenantId: 'synthetic_pdf_only',
        creatorUid: 'synthetic_manager',
        kind: 'sale',
        date: '2027-09-02',
        partyId: 'synthetic_customer',
        partyName: 'عميل اختبار اصطناعي',
        qtyMilli: 100000,
        priceMinor: 20000,
        totalMinor: 2000000,
        paidMinor: 500000,
        grade: 'صنف أول',
        unit: 'كيلوجرام',
        note: 'بيانات اصطناعية لا تمثل معاملة حقيقية',
        originalBusinessDate: '2027-08-31',
        correctionOfOperationId: 'synthetic_original_operation',
      );
      final pdf = await ArabicExports.statement(
        business: 'منشأة اختبار اصطناعية',
        title: 'مستند مؤرشف للقراءة فقط - السنة المالية 2027',
        entries: [entry],
        readOnlyArchive: true,
      );
      final out = Directory('output/pdf');
      await out.create(recursive: true);
      await File('${out.path}/archived-invoice-synthetic.pdf')
          .writeAsBytes(pdf);
      await File('${out.path}/archived-invoice-synthetic.csv')
          .writeAsString(ArabicExports.csv([entry]));
      expect(pdf.length, greaterThan(1000));
    },
  );
}
