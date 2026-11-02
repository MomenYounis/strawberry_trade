import 'package:flutter/material.dart';

import '../application/app_controller.dart';
import '../domain/ledger.dart';
import '../services/archive_reader.dart';
import '../services/archive_statement.dart';
import '../services/exports.dart';
import '../services/gateway.dart';

class ArchiveScreen extends StatefulWidget {
  const ArchiveScreen({super.key, required this.app});
  final AppController app;
  @override
  State<ArchiveScreen> createState() => _ArchiveScreenState();
}

class _ArchiveScreenState extends State<ArchiveScreen> {
  final recordId = TextEditingController();
  final partyId = TextEditingController();
  ArchiveStatementAssembler? statementScan;
  ArchivedPartyStatement? statement;
  final archives = <Map<String, dynamic>>[];
  bool loading = false;
  String message =
      'عرض أرشيف للقراءة فقط؛ لا يضيف العرض أو التصدير أي قيد إلى الأرصدة.';
  int? year, afterYear, nextChunk;
  LedgerEntry? record;
  String? scanningId;
  String? _scope;
  int _scopeVersion = 0;

  String? _currentScope() => widget.app.manager && widget.app.hasDataAccess
      ? '${widget.app.tenantId}/${widget.app.uid}/${widget.app.identity?.deviceId}'
      : null;

  @override
  void initState() {
    super.initState();
    _scope = _currentScope();
    widget.app.addListener(_accessChanged);
  }

  @override
  void didUpdateWidget(ArchiveScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      oldWidget.app.removeListener(_accessChanged);
      widget.app.addListener(_accessChanged);
      _scope = null;
      _accessChanged();
    }
  }

  void _accessChanged() {
    if (!mounted) return;
    final scope = _currentScope();
    setState(() {
      if (scope != _scope) {
        _scopeVersion++;
        _scope = scope;
        archives.clear();
        record = null;
        recordId.clear();
        partyId.clear();
        statementScan = null;
        statement = null;
        year = afterYear = nextChunk = null;
        scanningId = null;
        loading = false;
        message = 'عرض الأرشيف للمدير المصرح له فقط؛ أعد تحميل القائمة.';
      }
    });
  }

  @override
  void dispose() {
    widget.app.removeListener(_accessChanged);
    recordId.dispose();
    partyId.dispose();
    super.dispose();
  }

  Future<void> run(Future<void> Function(ArchiveGateway) action) async {
    if (loading) return;
    final scopeVersion = _scopeVersion;
    setState(() => loading = true);
    try {
      widget.app.requireDataAccess();
      if (!widget.app.manager || widget.app.gateway is! ArchiveGateway) {
        invalid('archive_access', 'الأرشيف متاح للمدير عبر اتصال مصرح به فقط.');
      }
      await action(widget.app.gateway as ArchiveGateway);
    } catch (error) {
      if (mounted && scopeVersion == _scopeVersion) {
        setState(() => message = arabicError(error));
      }
    } finally {
      if (mounted && scopeVersion == _scopeVersion) {
        setState(() => loading = false);
      }
    }
  }

  Future<void> list() => run((gateway) async {
    final boundTenant = widget.app.tenantId, boundUid = widget.app.uid;
    final boundVersion = _scopeVersion;
    final response = await gateway.listArchives(
      widget.app.tenantId,
      widget.app.identity!.deviceId,
      afterYear: afterYear,
    );
    if (!mounted ||
        boundVersion != _scopeVersion ||
        !widget.app.hasDataAccess ||
        !widget.app.manager ||
        widget.app.tenantId != boundTenant ||
        widget.app.uid != boundUid) {
      return;
    }
    final page = ArchiveListPage.parse(response, afterYear: afterYear);
    setState(() {
      for (final parsed in page.archives) {
        if (!archives.any((a) => a['year'] == parsed['year'])) {
          archives.add(parsed);
        }
      }
      afterYear = page.nextYear;
      year ??= archives.isEmpty ? null : archives.first['year'] as int;
      message = archives.isEmpty ? 'لا توجد أرشيفات منشورة متاحة لهذا الحساب.' : 'اختر السنة وأدخل المعرف الأصلي للمستند. العرض لا يستورد أي بيانات إلى السجل.';
    });
  });

  Future<void> read() => run((gateway) async {
    final id = recordId.text.trim();
    safeId(id);
    final selected = year;
    if (selected == null) invalid('archive_year', 'اختر سنة الأرشيف أولاً.');
    final chunk = scanningId == '$selected:$id' ? nextChunk ?? 0 : 0;
    final boundTenant = widget.app.tenantId, boundUid = widget.app.uid;
    final boundVersion = _scopeVersion;
    final response = await gateway.readArchiveRecord(
      widget.app.tenantId,
      widget.app.identity!.deviceId,
      year: selected,
      recordId: id,
      nextChunk: chunk,
    );
    if (!mounted ||
        boundVersion != _scopeVersion ||
        !widget.app.hasDataAccess ||
        !widget.app.manager ||
        widget.app.tenantId != boundTenant ||
        widget.app.uid != boundUid) {
      return;
    }
    final page = ArchiveRecordPage.parse(
      response,
      tenantId: widget.app.tenantId,
      year: selected,
      recordId: id,
      requestedChunk: chunk,
    );
    setState(() {
      record = page.record;
      nextChunk = page.nextChunk;
      scanningId = '$selected:$id';
      message = page.status == 'continue'
          ? 'اكتمل جزء من البحث؛ اضغط متابعة البحث لقراءة الجزء التالي.'
          : page.status == 'not_found'
          ? 'لم يوجد المستند في الأرشيف المختار.'
          : 'مؤرشف — للقراءة فقط. تاريخ المستند لا يغير الفترة المحاسبية النشطة.';
    });
  });

  Future<void> readStatement() => run((gateway) async {
    final id = partyId.text.trim(), selected = year;
    safeId(id);
    if (selected == null) invalid('archive_year', 'اختر سنة الأرشيف أولاً.');
    var scan = statementScan;
    if (scan == null ||
        scan.partyId != id ||
        scan.year != selected ||
        scan.complete) {
      scan = ArchiveStatementAssembler(
        tenantId: widget.app.tenantId,
        year: selected,
        partyId: id,
      );
      statementScan = scan;
      statement = null;
    }
    final boundVersion = _scopeVersion;
    final response = await gateway.readArchiveStatement(
      widget.app.tenantId,
      widget.app.identity!.deviceId,
      year: selected,
      partyId: id,
      nextChunk: scan.nextChunk ?? 0,
      manifestSha256: scan.manifestSha256,
    );
    if (!mounted ||
        boundVersion != _scopeVersion ||
        !widget.app.hasDataAccess ||
        !widget.app.manager) {
      return;
    }
    try {
      scan.addPage(response);
      final result = scan.complete ? scan.finish() : null;
      setState(() {
        statement = result;
        message = result == null
            ? 'حُفظ جزء من كشف الأرشيف؛ اضغط متابعة الكشف لاستكمال التحقق.'
            : result.found
            ? 'كشف مؤرشف للقراءة فقط؛ الأرصدة من نقطة الإقفال المنشورة.'
            : 'لا يوجد حساب للطرف في الأرشيف المختار.';
      });
    } catch (_) {
      statementScan = null;
      statement = null;
      rethrow;
    }
  });

  Future<void> exportStatement(bool pdf) => run((_) async {
    final value = statement;
    if (value == null || !value.found) return;
    final boundVersion = _scopeVersion;
    final bytes = pdf
        ? await ArabicExports.archivedStatement(
            business: widget.app.business,
            statement: value,
          )
        : null;
    widget.app.requireDataAccess();
    if (!mounted || boundVersion != _scopeVersion || !widget.app.manager) {
      invalid('archive_access', 'الصلاحية غير متاحة.');
    }
    final name = 'archived-statement-${value.year}-${value.partyId}';
    if (bytes != null) {
      await ArabicExports.shareBytes(bytes, '$name.pdf', 'application/pdf');
    } else {
      await ArabicExports.shareText(
        ArabicExports.archivedStatementCsv(value),
        '$name.csv',
        'text/csv',
      );
    }
  });

  @override
  Widget build(BuildContext context) {
    if (!widget.app.manager || !widget.app.hasDataAccess) {
      return const Center(
        child: Text('عرض الأرشيف متاح للمدير المصرح له فقط.'),
      );
    }
    final entry = record;
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        Text(message),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: loading ? null : list,
          icon: const Icon(Icons.history),
          label: Text(
            archives.isEmpty
                ? 'تحميل السنوات المؤرشفة'
                : afterYear == null
                ? 'تحديث قائمة الأرشيف'
                : 'تحميل سنوات أخرى',
          ),
        ),
        if (loading) const LinearProgressIndicator(),
        if (archives.isNotEmpty)
          DropdownButtonFormField<int>(
            initialValue: year,
            decoration: const InputDecoration(
              labelText: 'السنة المالية المؤرشفة',
            ),
            items: archives
                .map(
                  (a) => DropdownMenuItem(
                    value: a['year'] as int,
                    child: Text(
                      'سبتمبر ${a['year']} — أغسطس ${(a['year'] as int) + 1}',
                    ),
                  ),
                )
                .toList(),
            onChanged: loading
                ? null
                : (value) => setState(() {
                    year = value;
                    record = null;
                    nextChunk = null;
                    statementScan = null;
                    statement = null;
                  }),
          ),
        TextField(
          controller: recordId,
          textDirection: TextDirection.ltr,
          decoration: const InputDecoration(
            labelText: 'المعرف الأصلي للفاتورة أو القيد',
          ),
        ),
        const SizedBox(height: 12),
        OutlinedButton(
          onPressed: loading || year == null ? null : read,
          child: Text(
            nextChunk == null ? 'عرض المستند المؤرشف' : 'متابعة البحث',
          ),
        ),
        const Divider(),
        TextField(
          controller: partyId,
          textDirection: TextDirection.ltr,
          decoration: const InputDecoration(
            labelText: 'المعرف الأصلي للطرف لكشف الحساب المؤرشف',
          ),
        ),
        OutlinedButton(
          onPressed: loading || year == null ? null : readStatement,
          child: Text(
            statementScan != null && !statementScan!.complete
                ? 'متابعة الكشف المؤرشف'
                : 'عرض كشف حساب مؤرشف',
          ),
        ),
        if (statement case final value? when value.found) ...[
          Text(
            'كشف مؤرشف — ${value.partyName} — سبتمبر ${value.year} إلى أغسطس ${value.year + 1}',
          ),
          SelectableText(
            'معرف الطرف: ${value.partyId}\nنقطة الإقفال: ${value.closingSequence} / ${value.closingVersion}',
          ),
          for (final account in value.accounts)
            Text(
              '${account.role == 'merchant' ? 'مديونية العميل' : 'مستحقات المورد'}: افتتاحي ${formatMoney(account.openingMinor)} · حركة الفترة ${formatMoney(account.periodMinor)} · ختامي ${formatMoney(account.closingMinor)} ج.م',
            ),
          Text(
            'قيود الفترة: ${value.rows.length} · مراجع سابقة للقراءة فقط: ${value.references.length}',
          ),
          for (final row in value.rows.take(100))
            ListTile(
              dense: true,
              title: Text(entryDescription(row.entry)),
              subtitle: Text('${row.entry.date} · ${row.entry.id}'),
              trailing: Text('${formatMoney(row.partyEffectMinor)} ج.م'),
            ),
          if (value.rows.length > 100)
            const Text(
              'يُعرض أول ١٠٠ قيد؛ التصدير يتضمن الكشف الكامل الذي تم التحقق منه.',
            ),
          OutlinedButton.icon(
            onPressed: loading ? null : () => exportStatement(true),
            icon: const Icon(Icons.picture_as_pdf),
            label: const Text('تصدير كشف مؤرشف PDF'),
          ),
          OutlinedButton.icon(
            onPressed: loading ? null : () => exportStatement(false),
            icon: const Icon(Icons.table_view),
            label: const Text('تصدير كشف مؤرشف CSV'),
          ),
        ],
        if (entry != null) ...[
          const Divider(),
          Text(entryDescription(entry)),
          SelectableText(
            'المعرف: ${entry.id}\nالتاريخ: ${entry.date}\nالطرف: ${entry.partyName}\nالقيمة: ${formatMoney(entry.totalMinor)} ج.م\nالمدفوع: ${formatMoney(entry.paidMinor)} ج.م\nالكمية: ${formatQuantity(entry.qtyMilli)} ${entry.unit}\nالأصل المرتبط: ${entry.originalId}\n${entry.note}',
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            icon: const Icon(Icons.picture_as_pdf),
            label: const Text('تصدير مستند مؤرشف PDF'),
            onPressed: loading
                ? null
                : () => run((_) async {
                    final boundTenant = widget.app.tenantId,
                        boundUid = widget.app.uid;
                    final bytes = await ArabicExports.statement(
                      business: widget.app.business,
                      title: 'مستند مؤرشف للقراءة فقط — $year',
                      entries: [entry],
                      readOnlyArchive: true,
                    );
                    widget.app.requireDataAccess();
                    if (!widget.app.manager ||
                        widget.app.tenantId != boundTenant ||
                        widget.app.uid != boundUid) {
                      invalid('archive_access', 'الصلاحية غير متاحة.');
                    }
                    await ArabicExports.shareBytes(
                      bytes,
                      'archived-${entry.id}.pdf',
                      'application/pdf',
                    );
                  }),
          ),
          OutlinedButton.icon(
            icon: const Icon(Icons.table_view),
            label: const Text('تصدير CSV للقراءة فقط'),
            onPressed: loading
                ? null
                : () => run((_) async {
                    await ArabicExports.shareText(
                      ArabicExports.csv([entry]),
                      'archived-${entry.id}.csv',
                      'text/csv',
                    );
                  }),
          ),
        ],
      ],
    );
  }
}
