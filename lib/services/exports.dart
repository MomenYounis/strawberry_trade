import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:share_plus/share_plus.dart';

import '../domain/ledger.dart';
import 'archive_statement.dart';

String entryDescription(LedgerEntry e) {
  final label = e.kind == 'balance_adjustment'
      ? 'تسوية رصيد - ${e.adjustmentDirection == 'increase' ? 'زيادة المديونية' : 'تخفيض المديونية'}'
      : kindLabels[e.kind] ?? 'عملية';
  return e.originalBusinessDate.isEmpty
      ? label
      : '$label · تسوية فترة مغلقة\nتاريخ العمل الأصلي: ${e.originalBusinessDate}\nالعملية الأصلية: ${e.correctionOfOperationId}';
}

class ArabicExports {
  static Future<Uint8List> statement({
    required String business,
    required String title,
    required List<LedgerEntry> entries,
    Party? party,
    String? from,
    String? to,
    bool readOnlyArchive = false,
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
      readOnlyArchive: readOnlyArchive,
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
    bool readOnlyArchive = false,
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
    pw.Widget descriptionCell(LedgerEntry entry) => pw.Padding(
      padding: const pw.EdgeInsets.symmetric(vertical: 7, horizontal: 5),
      child: pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.end,
        children: [
          pw.Text(
            '${entryDescription(entry).split('\n').first}${entry.partyName.isNotEmpty ? ' - ${entry.partyName}' : ''}',
            textDirection: pw.TextDirection.rtl,
            style: const pw.TextStyle(fontSize: 10),
          ),
          if (readOnlyArchive) ...[
            pw.Text(
              'معرف القيد:',
              textDirection: pw.TextDirection.rtl,
              style: const pw.TextStyle(fontSize: 9),
            ),
            pw.Text(
              entry.id,
              textDirection: pw.TextDirection.ltr,
              style: const pw.TextStyle(fontSize: 9),
            ),
          ],
          if (entry.originalBusinessDate.isNotEmpty) ...[
            pw.Text(
              'تاريخ العمل الأصلي:',
              textDirection: pw.TextDirection.rtl,
              style: const pw.TextStyle(fontSize: 9),
            ),
            pw.Text(
              entry.originalBusinessDate,
              textDirection: pw.TextDirection.ltr,
              style: const pw.TextStyle(fontSize: 9),
            ),
            pw.Text(
              'العملية الأصلية:',
              textDirection: pw.TextDirection.rtl,
              style: const pw.TextStyle(fontSize: 9),
            ),
            pw.Text(
              entry.correctionOfOperationId,
              textDirection: pw.TextDirection.ltr,
              style: const pw.TextStyle(fontSize: 9),
            ),
          ],
          pw.Text(
            '${entry.isInvoice ? 'الإجمالي: ${formatMoney(entry.totalMinor)} · المدفوع: ${formatMoney(entry.paidMinor)}' : ''}${entry.qtyMilli > 0 ? '\nالصنف: ${entry.grade}\nالكمية: ${formatQuantity(entry.qtyMilli)} ${entry.unit}' : ''}${entry.note.isNotEmpty ? '\n${entry.note}' : ''}',
            textDirection: pw.TextDirection.rtl,
            style: const pw.TextStyle(fontSize: 10),
          ),
        ],
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
            descriptionCell(e),
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
              readOnlyArchive
                  ? 'نسخة مؤرشفة للقراءة فقط - لا تُضاف إلى الأرصدة النشطة'
                  : 'نسخة من السجل المحلي - قد توجد عمليات لم يقبلها الخادم بعد',
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
        'تاريخ العمل الأصلي للتسوية',
        'معرف العملية الأصلية للتسوية',
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
          e.originalBusinessDate,
          e.correctionOfOperationId,
        ],
      ),
    ];
    return '\uFEFF${rows.map((r) => r.map(quote).join(',')).join('\r\n')}';
  }

  /// Uses the verified archive controls and period rows directly. Historical
  /// references and the original directory opening balance are never posted.
  static Future<Uint8List> archivedStatement({
    required String business,
    required ArchivedPartyStatement statement,
  }) async {
    if (!statement.found) {
      invalid('archive_export', 'لا يوجد كشف مؤرشف لهذا الطرف.');
    }
    final regular = await rootBundle.load(
      'assets/fonts/NotoNaskhArabic-Regular.ttf',
    );
    final bold = await rootBundle.load('assets/fonts/NotoNaskhArabic-Bold.ttf');
    final latin = pw.Font.ttf(
      await rootBundle.load('assets/fonts/NotoSans-Regular.ttf'),
    );
    final doc = pw.Document(
      title: 'كشف حساب مؤرشف للقراءة فقط',
      author: business,
    );
    const ink = PdfColor.fromInt(0xff1b4332);
    const pale = PdfColor.fromInt(0xffedf4ef);
    pw.Widget text(
      String value, {
      bool number = false,
      double size = 10,
      bool strong = false,
    }) => pw.Text(
      value,
      textDirection: number ? pw.TextDirection.ltr : pw.TextDirection.rtl,
      textAlign: pw.TextAlign.right,
      style: pw.TextStyle(
        font: number ? latin : null,
        fontSize: size,
        fontWeight: strong ? pw.FontWeight.bold : pw.FontWeight.normal,
      ),
    );
    pw.Widget cell(String value, {bool number = false, bool heading = false}) =>
        pw.Padding(
          padding: const pw.EdgeInsets.symmetric(vertical: 7, horizontal: 5),
          child: text(
            value,
            number: number,
            strong: heading,
            size: number ? 9 : 10,
          ),
        );
    String identifier(String value, {int width = 38}) => [
      for (var i = 0; i < value.length; i += width)
        value.substring(i, i + width > value.length ? value.length : i + width),
    ].join('\n');
    pw.Widget metadata(String label, String value) => pw.Padding(
      padding: const pw.EdgeInsets.only(bottom: 4),
      child: pw.Column(
        crossAxisAlignment: pw.CrossAxisAlignment.start,
        children: [
          text(label, size: 9),
          text(identifier(value, width: 76), number: true, size: 8),
        ],
      ),
    );
    pw.Widget amount(String label, int value) => pw.Expanded(
      child: pw.Container(
        padding: const pw.EdgeInsets.all(8),
        decoration: const pw.BoxDecoration(color: pale),
        child: pw.Column(
          crossAxisAlignment: pw.CrossAxisAlignment.start,
          children: [
            text(label, size: 10),
            pw.SizedBox(height: 3),
            text(formatMoney(value), number: true, size: 12, strong: true),
          ],
        ),
      ),
    );
    final sections = <pw.Widget>[
      pw.SizedBox(height: 8),
      metadata('معرف الطرف', statement.partyId),
      metadata('معرف المنشأة', statement.tenantId),
      metadata('معرف الأرشيف', statement.runId),
      metadata('بصمة بيان الأرشيف', statement.manifestSha256),
      metadata(
        'مؤشر الإقفال / إصدار الإقفال',
        '${statement.closingSequence} / ${statement.closingVersion}',
      ),
      metadata(
        'الفترة - تاريخ النهاية غير شامل',
        '${statement.startDate} / ${statement.endDate}',
      ),
      metadata('المنطقة الزمنية', statement.timeZone),
      pw.SizedBox(height: 8),
      text(
        'الأثر الموجب يزيد المديونية والسالب يخفضها. الرصيد السالب يمثل دفعة مقدمة.',
        size: 9,
      ),
    ];
    for (final account in statement.accounts) {
      final lines = _archivedStatementLines(statement, account);
      sections.addAll([
        pw.SizedBox(height: 18),
        text(
          account.role == 'merchant' ? 'حساب العميل' : 'حساب المورد',
          size: 14,
          strong: true,
        ),
        pw.SizedBox(height: 6),
        pw.Row(
          children: [
            amount('الرصيد الافتتاحي - ج.م', account.openingMinor),
            pw.SizedBox(width: 6),
            amount('حركة الفترة - ج.م', account.periodMinor),
            pw.SizedBox(width: 6),
            amount('الرصيد الختامي - ج.م', account.closingMinor),
          ],
        ),
        pw.SizedBox(height: 10),
        if (lines.isEmpty)
          text('لا توجد حركات لهذا الحساب خلال الفترة.', size: 10),
        if (lines.isNotEmpty)
          pw.Table(
            columnWidths: {
              0: const pw.FlexColumnWidth(1.4),
              1: const pw.FlexColumnWidth(1.3),
              2: const pw.FlexColumnWidth(3.8),
              3: const pw.FlexColumnWidth(1.5),
            },
            border: pw.TableBorder.all(color: PdfColors.grey300, width: .5),
            children: [
              pw.TableRow(
                repeat: true,
                decoration: const pw.BoxDecoration(color: pale),
                children: [
                  cell('الرصيد - ج.م', heading: true),
                  cell('الأثر - ج.م', heading: true),
                  cell('البيان', heading: true),
                  cell('تاريخ القيد', heading: true),
                ],
              ),
              for (final line in lines)
                pw.TableRow(
                  children: [
                    cell(formatMoney(line.balanceMinor), number: true),
                    cell(
                      _signedArchiveMoney(line.row.partyEffectMinor),
                      number: true,
                    ),
                    pw.Padding(
                      padding: const pw.EdgeInsets.symmetric(
                        vertical: 7,
                        horizontal: 5,
                      ),
                      child: pw.Column(
                        crossAxisAlignment: pw.CrossAxisAlignment.start,
                        children: [
                          text(
                            entryDescription(line.row.entry).split('\n').first,
                          ),
                          text('معرف القيد / تسلسله', size: 8),
                          text(
                            identifier(line.row.entry.id),
                            number: true,
                            size: 8,
                          ),
                          text('${line.row.sequence}', number: true, size: 8),
                          if (line.row.entry.originalId.isNotEmpty) ...[
                            text('مرجع القيد الأصلي', size: 8),
                            text(
                              identifier(line.row.entry.originalId),
                              number: true,
                              size: 8,
                            ),
                          ],
                          if (line
                              .row
                              .entry
                              .originalBusinessDate
                              .isNotEmpty) ...[
                            text('تاريخ العمل الأصلي للتسوية', size: 8),
                            text(
                              line.row.entry.originalBusinessDate,
                              number: true,
                              size: 8,
                            ),
                            text('معرف العملية الأصلية للتسوية', size: 8),
                            text(
                              identifier(
                                line.row.entry.correctionOfOperationId,
                              ),
                              number: true,
                              size: 8,
                            ),
                          ],
                          if (line.row.entry.note.isNotEmpty)
                            text(line.row.entry.note, size: 9),
                        ],
                      ),
                    ),
                    cell(line.row.entry.date, number: true),
                  ],
                ),
            ],
          ),
        pw.SizedBox(height: 7),
        text('الرصيد الختامي المعتمد في بيان الأرشيف - ج.م', strong: true),
        text(formatMoney(account.closingMinor), number: true, strong: true),
      ]);
    }
    sections.addAll([
      pw.SizedBox(height: 14),
      text(
        'مراجع تاريخية للتحقق: ${statement.references.length} - لا تضاف إلى حركة الفترة.',
        size: 9,
      ),
      text(
        'هذه النسخة للقراءة فقط ولا تنشئ رصيدا افتتاحيا أو قيدا في السجل النشط.',
        size: 9,
      ),
    ]);
    doc.addPage(
      pw.MultiPage(
        pageFormat: PdfPageFormat.a4,
        margin: const pw.EdgeInsets.all(32),
        maxPages: 1000,
        theme: pw.ThemeData.withFont(
          base: pw.Font.ttf(regular),
          bold: pw.Font.ttf(bold),
          fontFallback: [latin],
        ),
        textDirection: pw.TextDirection.rtl,
        header: (context) => pw.Container(
          width: double.infinity,
          padding: const pw.EdgeInsets.only(bottom: 10),
          decoration: const pw.BoxDecoration(
            border: pw.Border(bottom: pw.BorderSide(color: ink)),
          ),
          child: pw.Column(
            crossAxisAlignment: pw.CrossAxisAlignment.start,
            children: [
              pw.Text(
                business,
                style: pw.TextStyle(
                  color: ink,
                  fontSize: 18,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
              text('كشف حساب مؤرشف للقراءة فقط', size: 14, strong: true),
              text(statement.partyName, size: 12),
              text('السنة المالية ${statement.year}', size: 10),
            ],
          ),
        ),
        footer: (context) => pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          children: [
            text(
              '${context.pageNumber} / ${context.pagesCount}',
              number: true,
              size: 8,
            ),
            text(
              'نسخة مؤرشفة للقراءة فقط - لا تضاف إلى الأرصدة النشطة',
              size: 8,
            ),
          ],
        ),
        build: (context) => sections,
      ),
    );
    return doc.save();
  }

  static String archivedStatementCsv(ArchivedPartyStatement statement) {
    if (!statement.found) {
      invalid('archive_export', 'لا يوجد كشف مؤرشف لهذا الطرف.');
    }
    String quote(String value) {
      // Canonical signed monetary strings remain usable as numbers. Other
      // untrusted leading spreadsheet operators are always escaped as text.
      if (RegExp(r'^[=+@\t\r]').hasMatch(value) ||
          (value.startsWith('-') &&
              !RegExp(r'^-\d+(\.\d+)?$').hasMatch(value))) {
        value = "'$value";
      }
      return '"${value.replaceAll('"', '""')}"';
    }

    final rows = <List<String>>[
      [
        'تصنيف السطر',
        'السنة المالية',
        'معرف المنشأة',
        'معرف الطرف',
        'اسم الطرف',
        'الدور',
        'معرف الأرشيف',
        'بصمة بيان الأرشيف',
        'مؤشر الإقفال',
        'إصدار الإقفال',
        'من',
        'حتى - غير شامل',
        'المنطقة الزمنية',
        'معرف القيد',
        'تسلسل القيد',
        'تاريخ القيد',
        'البيان',
        'الأثر - ج.م',
        'الرصيد - ج.م',
        'الرصيد الافتتاحي - ج.م',
        'حركة الفترة - ج.م',
        'الرصيد الختامي - ج.م',
        'تاريخ العمل الأصلي للتسوية',
        'معرف العملية الأصلية للتسوية',
        'مرجع القيد الأصلي',
        'ملاحظات',
        'وضع المستند',
      ],
    ];
    List<String> prefix(String type, String role) => [
      type,
      '${statement.year}',
      statement.tenantId,
      statement.partyId,
      statement.partyName,
      role,
      statement.runId,
      statement.manifestSha256,
      '${statement.closingSequence}',
      '${statement.closingVersion}',
      statement.startDate,
      statement.endDate,
      statement.timeZone,
    ];
    for (final account in statement.accounts) {
      final lines = _archivedStatementLines(statement, account);
      rows.add([
        ...prefix('أرصدة معتمدة', account.role),
        '',
        '',
        '',
        '',
        '',
        '',
        formatMoney(account.openingMinor),
        formatMoney(account.periodMinor),
        formatMoney(account.closingMinor),
        '',
        '',
        '',
        '',
        'مؤرشف للقراءة فقط',
      ]);
      for (final line in lines) {
        final entry = line.row.entry;
        rows.add([
          ...prefix('حركة فترة', account.role),
          entry.id,
          '${line.row.sequence}',
          entry.date,
          entryDescription(entry).split('\n').first,
          formatMoney(line.row.partyEffectMinor),
          formatMoney(line.balanceMinor),
          formatMoney(account.openingMinor),
          formatMoney(account.periodMinor),
          formatMoney(account.closingMinor),
          entry.originalBusinessDate,
          entry.correctionOfOperationId,
          entry.originalId,
          entry.note,
          'مؤرشف للقراءة فقط',
        ]);
      }
    }
    return '\uFEFF${rows.map((row) => row.map(quote).join(',')).join('\r\n')}';
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

class _ArchivedStatementLine {
  const _ArchivedStatementLine(this.row, this.balanceMinor);
  final ArchivedStatementRow row;
  final int balanceMinor;
}

List<_ArchivedStatementLine> _archivedStatementLines(
  ArchivedPartyStatement statement,
  ArchivedStatementAccount account,
) {
  var balance = BigInt.from(account.openingMinor);
  final lines = <_ArchivedStatementLine>[];
  for (final row in statement.rows.where((row) => row.role == account.role)) {
    balance += BigInt.from(row.partyEffectMinor);
    if (balance < BigInt.from(-9007199254740991) ||
        balance > BigInt.from(9007199254740991)) {
      invalid('archive_export', 'رصيد مؤرشف يتجاوز الدقة الآمنة.');
    }
    lines.add(_ArchivedStatementLine(row, balance.toInt()));
  }
  if (balance != BigInt.from(account.closingMinor) ||
      balance - BigInt.from(account.openingMinor) !=
          BigInt.from(account.periodMinor)) {
    invalid('archive_export', 'الأرصدة المؤرشفة لا تطابق الحركات.');
  }
  return lines;
}

String _signedArchiveMoney(int value) =>
    '${value > 0 ? '+' : ''}${formatMoney(value)}';
