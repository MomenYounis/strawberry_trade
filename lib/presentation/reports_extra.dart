import 'package:flutter/material.dart';

import '../application/app_controller.dart';
import '../domain/ledger.dart';
import '../services/gateway.dart';

String buildStatementText(
  Party party,
  List<LedgerEntry> entries, {
  String? from,
  String? to,
}) {
  _validatePeriod(from, to);
  if (entries.any((e) => e.tenantId != party.tenantId)) {
    throw const LedgerException(
      'statement_scope',
      'بيانات الكشف لا تخص المنشأة نفسها',
    );
  }
  final lines = LedgerRules.statement(party, entries, from: from, to: to);
  final opening = LedgerRules.statementOpeningBalance(
    party,
    entries,
    from: from,
  );
  final closing = LedgerRules.statementClosingBalance(party, entries, to: to);
  return [
    'كشف حساب ${party.kind == 'supplier' ? 'المورد' : 'العميل'}: ${party.name}',
    'الفترة: ${from ?? 'بداية السجل'} إلى ${to ?? 'نهاية السجل'}',
    'الرصيد أول الفترة: ${formatMoney(opening)} ج.م',
    if (lines.isEmpty) 'لا توجد حركة في الفترة المختارة.',
    for (final line in lines)
      '${line.entry.date} · ${kindLabels[line.entry.kind] ?? 'عملية'}\n'
          'مدين ${formatMoney(line.debitMinor)} · دائن ${formatMoney(line.creditMinor)} · الرصيد ${formatMoney(line.balanceMinor)} ج.م',
    'الرصيد آخر الفترة: ${formatMoney(closing)} ج.م',
    'الكشف من السجل المحلي؛ قد توجد عمليات تنتظر المزامنة أو الاعتماد.',
  ].join('\n\n');
}

void _validatePeriod(String? from, String? to) {
  if ((from != null && !validDate(from)) ||
      (to != null && !validDate(to)) ||
      (from != null && to != null && from.compareTo(to) > 0)) {
    throw const LedgerException('report_period', 'راجع بداية الفترة ونهايتها');
  }
}

class MonthAmounts {
  int salesMinor = 0;
  int purchasesMinor = 0;
  int businessExpenseMinor = 0;
}

/// Uses every documented correction on its own date. Filtering before resolving
/// reversal references would lose corrections of invoices in earlier periods.
class RecordedPeriod {
  RecordedPeriod.fromEntries(
    Iterable<LedgerEntry> entries, {
    String? from,
    String? to,
  }) {
    _validatePeriod(from, to);
    final all = entries.toList();
    final byId = {for (final e in all) e.id: e};
    for (final entry in all) {
      if ((from != null && entry.date.compareTo(from) < 0) ||
          (to != null && entry.date.compareTo(to) > 0)) {
        continue;
      }
      final original = entry.kind == 'reversal'
          ? byId[entry.originalId]
          : entry;
      if (original == null) {
        throw const LedgerException(
          'report_original',
          'يلزم القيد الأصلي لحساب التصحيح',
        );
      }
      final direction = entry.kind == 'reversal' ? -1 : 1;
      final month = months.putIfAbsent(
        entry.date.substring(0, 7),
        MonthAmounts.new,
      );
      if (original.kind == 'sale' || original.kind == 'sale_return') {
        final amount =
            direction *
            (original.kind == 'sale' ? 1 : -1) *
            original.totalMinor;
        salesMinor += amount;
        month.salesMinor += amount;
      } else if (original.kind == 'purchase' ||
          original.kind == 'purchase_return') {
        final amount =
            direction *
            (original.kind == 'purchase' ? 1 : -1) *
            original.totalMinor;
        purchasesMinor += amount;
        month.purchasesMinor += amount;
      } else if (original.kind == 'expense_business' ||
          original.kind == 'payroll') {
        final amount = direction * original.paidMinor;
        businessExpenseMinor += amount;
        month.businessExpenseMinor += amount;
        final category = original.kind == 'payroll'
            ? 'رواتب وأجور'
            : original.category;
        businessCategories.update(
          category,
          (v) => v + amount,
          ifAbsent: () => amount,
        );
      } else if (original.kind == 'expense_home') {
        final amount = direction * original.paidMinor;
        homeExpenseMinor += amount;
        homeCategories.update(
          original.category,
          (v) => v + amount,
          ifAbsent: () => amount,
        );
      }
    }
    cashMinor = LedgerRules.netRecordedCash(all, from: from, to: to);
  }
  int salesMinor = 0;
  int purchasesMinor = 0;
  int businessExpenseMinor = 0;
  int homeExpenseMinor = 0;
  int cashMinor = 0;
  final businessCategories = <String, int>{};
  final homeCategories = <String, int>{};
  final months = <String, MonthAmounts>{};
}

class BudgetAndCharts extends StatefulWidget {
  const BudgetAndCharts({super.key, required this.app, this.from, this.to});
  final AppController app;
  final String? from, to;
  @override
  State<BudgetAndCharts> createState() => _BudgetAndChartsState();
}

class _BudgetAndChartsState extends State<BudgetAndCharts> {
  int businessBudget = 0, homeBudget = 0;
  bool loading = true, busy = false;
  String? message;
  Object? _loadedStore, _loadingStore;

  @override
  void initState() {
    super.initState();
    widget.app.addListener(_onAppChanged);
    _load();
  }

  @override
  void didUpdateWidget(BudgetAndCharts oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      oldWidget.app.removeListener(_onAppChanged);
      widget.app.addListener(_onAppChanged);
      _loadedStore = null;
      _load();
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_onAppChanged);
    super.dispose();
  }

  void _onAppChanged() {
    final db = widget.app.store;
    if (db != _loadedStore && db != _loadingStore) _load();
  }

  Future<void> _load() async {
    final app = widget.app, db = widget.app.store;
    if (!app.manager || !app.hasDataAccess || db == null) return;
    _loadingStore = db;
    if (mounted) setState(() => loading = true);
    try {
      final values = await Future.wait([
        db.preference('budgetBusinessMinor'),
        db.preference('budgetHomeMinor'),
      ]);
      if (!mounted ||
          app != widget.app ||
          db != app.store ||
          !app.manager ||
          !app.hasDataAccess) {
        return;
      }
      setState(() {
        _loadedStore = db;
        _loadingStore = null;
        businessBudget = values[0] is int && (values[0] as int) >= 0
            ? values[0] as int
            : 0;
        homeBudget = values[1] is int && (values[1] as int) >= 0
            ? values[1] as int
            : 0;
        loading = false;
      });
    } catch (e) {
      if (mounted && app == widget.app && db == app.store) {
        setState(() {
          _loadingStore = null;
          loading = false;
          message = arabicError(e);
        });
      }
    }
  }

  Future<void> _editBudget(bool home) async {
    if (busy) return;
    final boundApp = widget.app, boundStore = widget.app.store;
    final boundTenant = boundApp.tenantId, boundUid = boundApp.uid;
    setState(() => busy = true);
    final controller = TextEditingController(
      text: formatMoney(home ? homeBudget : businessBudget),
    );
    final form = GlobalKey<FormState>();
    String? saveError;
    var saving = false;
    final route = DialogRoute<void>(
      context: context,
      builder: (dialogContext) => _BudgetDialogGuard(
        app: boundApp,
        store: boundStore,
        child: StatefulBuilder(
          builder: (context, update) => Directionality(
            textDirection: TextDirection.rtl,
            child: AlertDialog(
              scrollable: true,
              title: Text(
                home ? 'الميزانية الشهرية للبيت' : 'الميزانية الشهرية للتشغيل',
              ),
              content: Form(
                key: form,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'هدف شهري حالي للمقارنة؛ لا يُنشئ حركة نقدية. أدخل صفراً لإلغاء الهدف.',
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: controller,
                      textDirection: TextDirection.ltr,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      decoration: const InputDecoration(
                        labelText: 'الهدف الشهري بالجنيه',
                      ),
                      validator: (value) {
                        try {
                          parseScaled(value ?? '', 100);
                          return null;
                        } catch (_) {
                          return 'أدخل مبلغاً صحيحاً غير سالب';
                        }
                      },
                    ),
                    if (saveError != null)
                      Text(
                        saveError!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : () => Navigator.pop(dialogContext),
                  child: const Text('إلغاء'),
                ),
                FilledButton(
                  onPressed: saving
                      ? null
                      : () async {
                          if (!form.currentState!.validate()) return;
                          update(() => saving = true);
                          final app = boundApp, db = boundStore;
                          try {
                            await app.requireAllowed();
                            app.requireDataAccess();
                            if (app != widget.app ||
                                !app.manager ||
                                db == null ||
                                db != app.store ||
                                app.tenantId != boundTenant ||
                                app.uid != boundUid) {
                              throw const LedgerException(
                                'budget_role',
                                'تعديل الميزانية متاح للمدير صاحب السجل فقط',
                              );
                            }
                            final value = parseScaled(controller.text, 100);
                            await db.setPreference(
                              home ? 'budgetHomeMinor' : 'budgetBusinessMinor',
                              value,
                            );
                            if (mounted &&
                                db == app.store &&
                                app.hasDataAccess &&
                                app.manager) {
                              setState(() {
                                if (home) {
                                  homeBudget = value;
                                } else {
                                  businessBudget = value;
                                }
                              });
                            }
                            if (dialogContext.mounted) {
                              Navigator.pop(dialogContext);
                            }
                          } catch (e) {
                            if (dialogContext.mounted) {
                              update(() {
                                saving = false;
                                saveError = arabicError(e);
                              });
                            }
                          }
                        },
                  child: Text(saving ? 'جارٍ الحفظ' : 'حفظ الهدف'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await Navigator.of(context, rootNavigator: true).push(route);
    // A popped dialog keeps its fields alive during the exit animation.
    await route.completed;
    controller.dispose();
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.app,
    builder: (context, _) {
      final app = widget.app;
      if (!app.manager || !app.hasDataAccess || !app.ready) {
        return const SizedBox.shrink();
      }
      if (loading || _loadedStore != app.store) {
        return const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        );
      }
      try {
        final period = RecordedPeriod.fromEntries(
          app.entries,
          from: widget.from,
          to: widget.to,
        );
        final now = DateTime.now();
        final today =
            '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
        final selectedMonth = (widget.to ?? today).substring(0, 7);
        final monthStart = '$selectedMonth-01';
        final year = int.parse(selectedMonth.substring(0, 4)),
            month = int.parse(selectedMonth.substring(5));
        final days = DateTime(year, month + 1, 0).day;
        final monthEnd = '$selectedMonth-${days.toString().padLeft(2, '0')}';
        var cutoff = widget.to ?? monthEnd;
        if (cutoff.compareTo(monthEnd) > 0) cutoff = monthEnd;
        if (selectedMonth == today.substring(0, 7) &&
            cutoff.compareTo(today) > 0) {
          cutoff = today;
        }
        final monthly = RecordedPeriod.fromEntries(
          app.entries,
          from: monthStart,
          to: cutoff,
        );
        final elapsedDays = int.parse(cutoff.substring(8));
        final current = selectedMonth == today.substring(0, 7);
        final sortedMonths = period.months.keys.toList()..sort();
        final values = [
          for (final m in period.months.values) ...[
            m.salesMinor.abs(),
            m.purchasesMinor.abs(),
            m.businessExpenseMinor.abs(),
          ],
        ];
        final max = values.fold<int>(1, (n, value) => value > n ? value : n);
        return Directionality(
          textDirection: TextDirection.rtl,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 20),
              Text(
                'الميزانيات الشهرية',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              Text('شهر المقارنة: $selectedMonth · المصروفات حتى $cutoff'),
              const Text(
                'الأهداف الحالية للمقارنة، وليست سجلاً لتغييرات ميزانيات الأشهر السابقة. اختيار الفترة أعلاه يغيّر الرسوم؛ الميزانية تخص شهر نهايتها.',
              ),
              _budgetCard(
                context,
                home: false,
                spent: monthly.businessExpenseMinor,
                days: days,
                elapsedDays: elapsedDays,
                forecast: current,
              ),
              _budgetCard(
                context,
                home: true,
                spent: monthly.homeExpenseMinor,
                days: days,
                elapsedDays: elapsedDays,
                forecast: current,
              ),
              if (message != null) Text(message!),
              const SizedBox(height: 20),
              Text(
                'حركة الأشهر في الفترة المختارة',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const Text(
                'المبيعات والمشتريات إجماليات الفواتير بعد المرتجعات وتصحيحاتها في تاريخها. مصروفات التشغيل تشمل الرواتب المدفوعة. هذه مقارنة حركة مسجلة وليست حساب ربح أو جرد نقدية.',
              ),
              if (sortedMonths.isEmpty)
                const Text('لا توجد حركة مسجلة في الفترة المختارة.'),
              for (final month in sortedMonths)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          month,
                          style: const TextStyle(fontWeight: FontWeight.bold),
                        ),
                        _bar(
                          'المبيعات بعد المرتجعات',
                          period.months[month]!.salesMinor,
                          max,
                          const Color(0xff235b42),
                        ),
                        _bar(
                          'المشتريات بعد المرتجعات',
                          period.months[month]!.purchasesMinor,
                          max,
                          const Color(0xff326b9c),
                        ),
                        _bar(
                          'مصروفات التشغيل والرواتب',
                          period.months[month]!.businessExpenseMinor,
                          max,
                          const Color(0xffb26329),
                        ),
                      ],
                    ),
                  ),
                ),
              Text(
                'صافي الحركة النقدية المسجلة للفترة: ${formatMoney(period.cashMinor)} ج.م',
              ),
              _categories(
                context,
                'بنود التشغيل والرواتب في الفترة',
                period.businessCategories,
              ),
              _categories(
                context,
                'بنود مصروفات البيت في الفترة',
                period.homeCategories,
              ),
            ],
          ),
        );
      } catch (e) {
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Text(arabicError(e)),
        );
      }
    },
  );

  Widget _budgetCard(
    BuildContext context, {
    required bool home,
    required int spent,
    required int days,
    required int elapsedDays,
    required bool forecast,
  }) {
    final target = home ? homeBudget : businessBudget;
    final remaining = target - spent;
    final estimate = spent < 0
        ? null
        : (spent * days + elapsedDays ~/ 2) ~/ elapsedDays;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              home ? 'مصروفات البيت' : 'التشغيل والرواتب المدفوعة',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
            Text(
              target == 0
                  ? 'لم تحدد هدفاً شهرياً'
                  : 'الهدف الشهري الحالي: ${formatMoney(target)} ج.م',
            ),
            Text('صافي المصروفات المسجلة: ${formatMoney(spent)} ج.م'),
            if (target > 0)
              Text(
                '${remaining < 0 ? 'تجاوز الهدف' : 'المتبقي من الهدف'}: ${formatMoney(remaining.abs())} ج.م',
              ),
            if (forecast && estimate != null)
              Text(
                'تقدير نهاية الشهر: ${formatMoney(estimate)} ج.م؛ تقدير على متوسط $elapsedDays يوم من السجل، وليس مصروفاً مؤكداً.',
              ),
            if (!forecast)
              const Text('لا يُعرض توقع للأشهر التاريخية أو المستقبلية.'),
            if (forecast && estimate == null)
              const Text(
                'لا يُقدّر نهاية الشهر عندما يكون صافي المصروفات سالباً بسبب التصحيحات.',
              ),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton.icon(
                onPressed: widget.app.allowed && !busy
                    ? () => _editBudget(home)
                    : null,
                icon: const Icon(Icons.edit_outlined),
                label: const Text('تعديل الهدف الشهري'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bar(String label, int value, int max, Color color) => Semantics(
    label: '$label: ${formatMoney(value)} جنيه مصري',
    child: ExcludeSemantics(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('$label: ${formatMoney(value)} ج.م'),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: value.abs() / max,
                minHeight: 10,
                color: value < 0 ? Colors.red.shade700 : color,
                backgroundColor: color.withValues(alpha: 0.12),
              ),
            ),
            if (value < 0)
              const Text('قيمة سالبة نتيجة المرتجعات أو القيود العكسية'),
          ],
        ),
      ),
    ),
  );

  Widget _categories(
    BuildContext context,
    String title,
    Map<String, int> values,
  ) {
    final categories = values.entries.toList()
      ..sort((a, b) => b.value.abs().compareTo(a.value.abs()));
    final max = categories.fold<int>(
      1,
      (n, e) => e.value.abs() > n ? e.value.abs() : n,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 18),
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        if (categories.isEmpty) const Text('لا توجد مصروفات مسجلة في الفترة.'),
        for (final category in categories)
          _bar(category.key, category.value, max, const Color(0xff794c80)),
      ],
    );
  }
}

class _BudgetDialogGuard extends StatelessWidget {
  const _BudgetDialogGuard({
    required this.app,
    required this.store,
    required this.child,
  });
  final AppController app;
  final Object? store;
  final Widget child;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: app,
    builder: (context, _) =>
        app.manager && app.hasDataAccess && app.ready && store == app.store
        ? child
        : Directionality(
            textDirection: TextDirection.rtl,
            child: AlertDialog(
              title: const Text('توقفت صلاحية هذه النافذة'),
              content: const Text(
                'أغلق النافذة وتحقق من الحساب قبل تعديل الميزانية.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إغلاق'),
                ),
              ],
            ),
          ),
  );
}
