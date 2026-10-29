import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:share_plus/share_plus.dart';

import '../domain/ledger.dart';

String entryDescription(LedgerEntry e) => e.kind == 'balance_adjustment'
    ? 'تسوية رصيد - ${e.adjustmentDirection == 'increase' ? 'زيادة المديونية' : 'تخفيض المديونية'}'
    : kindLabels[e.kind] ?? 'عملية';

class ArabicExports {
  static Future<Uint8List> statement({
    required String business,
    required String title,
    required List<LedgerEntry> entries,
    Party? party,
    String? from,
    String? to,
  }) async {
    final regular = await rootBundle.load(
      'assets/fonts/NotoNaskhArabic-Regular.ttf',
    );
    final bold = await rootBundle.load('assets/fonts/NotoNaskhArabic-Bold.ttf');
    final latin = await rootBundle.load('assets/fonts/NotoSans-Regular.ttf');
    return buildStatement(
      latin: latin,
      regular: regular,
      bold: bold,
      business: business,
      title: title,
      entries: entries,
      party: party,
      from: from,
      to: to,
    );
  }

  static Future<Uint8List> buildStatement({
    required ByteData latin,
    required ByteData regular,
    required ByteData bold,
    required String business,
    required String title,
    required List<LedgerEntry> entries,
    Party? party,
    String? from,
    String? to,
  }) async {
    final font = pw.Font.ttf(regular), fontBold = pw.Font.ttf(bold);
    final doc = pw.Document(title: title, author: business);
    final lines = party == null
        ? <StatementLine>[]
        : LedgerRules.statement(party, entries, from: from, to: to);
    final visible = party == null
        ? entries
              .where(
                (e) =>
                    (from == null || e.date.compareTo(from) >= 0) &&
                    (to == null || e.date.compareTo(to) <= 0),
              )
              .toList()
        : lines.map((l) => l.entry).toList();
    const ink = PdfColor.fromInt(0xff1b4332),
        pale = PdfColor.fromInt(0xffedf4ef);
    pw.Widget cell(String text, {bool heading = false, bool latin = false}) =>
        pw.Padding(
          padding: const pw.EdgeInsets.symmetric(vertical: 7, horizontal: 5),
          child: pw.Text(
            text,
            textDirection: latin ? pw.TextDirection.ltr : pw.TextDirection.rtl,
            textAlign: pw.TextAlign.right,
            style: pw.TextStyle(
              fontSize: 10,
              fontWeight: heading ? pw.FontWeight.bold : pw.FontWeight.normal,
            ),
          ),
        );
    final rows = <pw.TableRow>[
      pw.TableRow(
        repeat: true,
        decoration: const pw.BoxDecoration(color: pale),
        children: [
          cell(party == null ? 'المدفوع' : 'الرصيد', heading: true),
          if (party == null)
            cell('القيمة', heading: true)
          else ...[
            cell('دائن', heading: true),
            cell('مدين', heading: true),
          ],
          cell('البيان', heading: true),
          cell('التاريخ', heading: true),
        ],
      ),
      ...List.generate(visible.length, (i) {
        final e = visible[i];
        return pw.TableRow(
          children: [
            cell(
              formatMoney(party == null ? e.paidMinor : lines[i].balanceMinor),
              latin: true,
            ),
            if (party == null)
              cell(formatMoney(e.totalMinor), latin: true)
            else ...[
              cell(formatMoney(lines[i].creditMinor), latin: true),
              cell(formatMoney(lines[i].debitMinor), latin: true),
            ],
            cell(
              '${entryDescription(e)}${e.partyName.isNotEmpty ? ' - ${e.partyName}' : ''}${e.isInvoice ? '\nالإجمالي: ${formatMoney(e.totalMinor)} · المدفوع: ${formatMoney(e.paidMinor)}' : ''}${e.qtyMilli > 0 ? '\nالصنف: ${e.grade}\nالكمية: ${formatQuantity(e.qtyMilli)} ${e.unit}' : ''}${e.note.isNotEmpty ? '\n${e.note}' : ''}',
            ),
            cell(e.date, latin: true),
          ],
        );
      }),
    ];
    doc.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        margin: const pw.EdgeInsets.all(32),
        maxPages: 1000,
        theme: pw.ThemeData.withFont(
          base: font,
          bold: fontBold,
          fontFallback: [pw.Font.ttf(latin)],
        ),
        textDirection: pw.TextDirection.rtl,
        header: (context) => pw.Container(
          padding: const pw.EdgeInsets.only(bottom: 12),
          decoration: const pw.BoxDecoration(
            border: pw.Border(bottom: pw.BorderSide(color: ink, width: 1)),
          ),
          child: pw.Column(
            crossAxisAlignment: pw.CrossAxisAlignment.end,
            children: [
              pw.Text(
                business,
                style: pw.TextStyle(
                  fontSize: 20,
                  color: ink,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
              pw.Text(title, style: const pw.TextStyle(fontSize: 15)),
              pw.Text(
                'من ${from ?? 'بداية السجل'} إلى ${to ?? 'آخر عملية'}',
                style: const pw.TextStyle(fontSize: 10),
              ),
            ],
          ),
        ),
        footer: (context) => pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          children: [
            pw.Text(
              '${context.pageNumber} / ${context.pagesCount}',
              textDirection: pw.TextDirection.ltr,
              style: const pw.TextStyle(fontSize: 9),
            ),
            pw.Text(
              'نسخة من السجل المحلي - قد توجد عمليات لم يقبلها الخادم بعد',
              style: const pw.TextStyle(fontSize: 8),
            ),
          ],
        ),
        build: (context) => [
          pw.SizedBox(height: 12),
          if (party != null)
            pw.Text(
              'الرصيد الافتتاحي: ${formatMoney(LedgerRules.statementOpeningBalance(party, entries, from: from))} ج.م',
            ),
          pw.Table(
            columnWidths: party == null
                ? {
                    0: const pw.FlexColumnWidth(1.2),
                    1: const pw.FlexColumnWidth(1.2),
                    2: const pw.FlexColumnWidth(3.2),
                    3: const pw.FlexColumnWidth(1.3),
                  }
                : {
                    0: const pw.FlexColumnWidth(1.1),
                    1: const pw.FlexColumnWidth(1),
                    2: const pw.FlexColumnWidth(1),
                    3: const pw.FlexColumnWidth(3.3),
                    4: const pw.FlexColumnWidth(1.4),
                  },
            border: pw.TableBorder.all(color: PdfColors.grey300, width: 0.5),
            children: rows,
          ),
          pw.SizedBox(height: 12),
          if (party != null)
            pw.Text(
              'الرصيد حتى نهاية الفترة: ${formatMoney(LedgerRules.statementClosingBalance(party, entries, to: to))} ج.م',
              style: pw.TextStyle(fontWeight: pw.FontWeight.bold),
            ),
          if (party == null)
            pw.Text(
              'صافي الحركة النقدية المسجلة: ${formatMoney(LedgerRules.netRecordedCash(entries, from: from, to: to))} ج.م',
            ),
          pw.Text(
            'هذه الأرقام لا تمثل جرد المخزون أو الربح الفعلي أو النقدية الفعلية بالخزينة.',
            style: const pw.TextStyle(fontSize: 9),
          ),
        ],
      ),
    );
    return doc.save();
  }

  static String csv(List<LedgerEntry> entries) {
    String quote(String s) {
      if (RegExp(r'^[=+@\-\t\r]').hasMatch(s)) s = "'$s";
      return '"${s.replaceAll('"', '""')}"';
    }

    final rows = [
      [
        'المعرف',
        'التاريخ',
        'النوع',
        'الطرف',
        'معرف الطرف',
        'الكمية',
        'الوحدة',
        'الصنف',
        'القيمة',
        'سعر الوحدة',
        'المدفوع',
        'الفاتورة الأصلية أو التصحيح',
        'الموظف',
        'شهر الراتب',
        'فئة المصروف',
        'اتجاه التسوية',
        'مسؤول الشحن',
        'مرجع الشحنة',
        'حالة الشحنة',
        'ترتيب تحديث الشحنة',
        'معرف المنشئ',
        'ملاحظات',
      ],
      ...entries.map(
        (e) => [
          e.id,
          e.date,
          entryDescription(e),
          e.partyName,
          e.partyId,
          formatQuantity(e.qtyMilli),
          e.unit,
          e.grade,
          formatMoney(e.totalMinor),
          formatMoney(e.priceMinor),
          formatMoney(e.paidMinor),
          e.originalId,
          e.employeeId,
          e.salaryMonth,
          e.category,
          e.adjustmentDirection == 'increase'
              ? 'زيادة المديونية'
              : e.adjustmentDirection == 'decrease'
              ? 'خفض المديونية'
              : '',
          e.shippingEmployeeId,
          e.shipmentRef,
          const {
                'pending': 'قيد التجهيز',
                'in_transit': 'في الطريق',
                'delivered': 'تم التسليم',
              }[e.shipmentStatus] ??
              '',
          e.shipmentOrder == 0 ? '' : e.shipmentOrder.toString(),
          e.creatorUid,
          e.note,
        ],
      ),
    ];
    return '\uFEFF${rows.map((r) => r.map(quote).join(',')).join('\r\n')}';
  }

  static Future<void> shareBytes(
    Uint8List bytes,
    String filename,
    String mime,
  ) async {
    await SharePlus.instance.share(
      ShareParams(
        files: [XFile.fromData(bytes, mimeType: mime)],
        fileNameOverrides: [filename],
        title: 'دفتر الفراولة',
      ),
    );
  }

  static Future<void> shareText(String text, String filename, String mime) =>
      shareBytes(Uint8List.fromList(utf8.encode(text)), filename, mime);
}
