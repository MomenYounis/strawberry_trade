import 'package:flutter/material.dart';

import '../application/app_controller.dart';
import '../domain/ledger.dart';
import '../services/gateway.dart';

String shipmentStatusText(String status) =>
    const {
      'pending': 'قيد التجهيز',
      'in_transit': 'في الطريق',
      'delivered': 'تم التسليم',
    }[status] ??
    'لم تُحدّد الحالة';

/// Shipment changes append independent evidence without changing an invoice's
/// financial facts or its original immutable synchronization message.
class ShipmentEditor extends StatefulWidget {
  const ShipmentEditor({super.key, required this.app, required this.invoice});
  final AppController app;
  final LedgerEntry invoice;
  @override
  State<ShipmentEditor> createState() => _ShipmentEditorState();
}

class _ShipmentEditorState extends State<ShipmentEditor> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _reference, _date;
  final _note = TextEditingController();
  late String _status, _employeeId;
  bool _saving = false;
  String? _error;
  String _operationId = newId();
  int _operationOrder = 0;

  Set<String> get _rejectedIds => widget.app.pending
      .where(
        (operation) =>
            operation['state'] == 'conflict' ||
            operation['error'] == 'resolved_requires_correction',
      )
      .map((operation) => operation['id'] as String)
      .toSet();
  Iterable<LedgerEntry> get _projectedEntries {
    final rejected = _rejectedIds;
    return widget.app.entries.where((entry) => !rejected.contains(entry.id));
  }

  @override
  void initState() {
    super.initState();
    final current = LedgerRules.latestShipment(
      widget.invoice,
      _projectedEntries,
    );
    _reference = TextEditingController(text: current.shipmentRef);
    _date = TextEditingController(
      text: DateTime.now().toIso8601String().substring(0, 10),
    );
    _status = current.shipmentStatus.isEmpty
        ? 'pending'
        : current.shipmentStatus;
    _employeeId =
        widget.app.employees.any(
          (e) => e.id == current.shippingEmployeeId && e.active,
        )
        ? current.shippingEmployeeId
        : '';
  }

  @override
  void dispose() {
    _reference.dispose();
    _date.dispose();
    _note.dispose();
    super.dispose();
  }

  String _employeeName(String id) => id.isEmpty
      ? 'غير مسندة إلى موظف'
      : widget.app.employees.where((e) => e.id == id).firstOrNull?.name ??
            'موظف سابق';

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.app,
    builder: (context, _) {
      final current = LedgerRules.latestShipment(
        widget.invoice,
        _projectedEntries,
      );
      final ambiguous = LedgerRules.shipmentHasOrderConflict(
        widget.invoice,
        _projectedEntries,
      );
      final history =
          widget.app.entries
              .where(
                (e) =>
                    e.kind == 'shipment_update' &&
                    e.originalId == widget.invoice.id,
              )
              .toList()
            ..sort((a, b) {
              final order = b.shipmentOrder.compareTo(a.shipmentOrder);
              if (order != 0) return order;
              final d = b.date.compareTo(a.date);
              return d == 0 ? b.id.compareTo(a.id) : d;
            });
      return Scaffold(
        appBar: AppBar(title: const Text('بيانات الشحنة')),
        body: ListView(
          padding: const EdgeInsets.all(18),
          children: [
            Text(
              '${kindLabels[widget.invoice.kind]} · ${widget.invoice.partyName}',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            Text(
              'الفاتورة: ${widget.invoice.date} · ${widget.invoice.id}',
              textDirection: TextDirection.rtl,
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (ambiguous)
                      const Text(
                        'توجد تحديثات متعارضة للشحنة؛ راجع قائمة التعارضات وحالة قبول الخادم قبل اعتماد الحالة.',
                      ),
                    Text(
                      '${ambiguous ? 'حالة تحتاج مراجعة' : 'الحالة الحالية'}: ${shipmentStatusText(current.shipmentStatus)}',
                    ),
                    Text(
                      'المسؤول: ${_employeeName(current.shippingEmployeeId)}',
                    ),
                    Text(
                      'مرجع الشحنة: ${current.shipmentRef.isEmpty ? 'غير محدد' : current.shipmentRef}',
                    ),
                  ],
                ),
              ),
            ),
            const Text(
              'يُحفظ التحديث كسجل مستقل. تظل الفاتورة ومبالغها محفوظة، ويظهر قبول الخادم في المزامنة.',
            ),
            const SizedBox(height: 16),
            Form(
              key: _form,
              child: Column(
                children: [
                  TextFormField(
                    controller: _date,
                    enabled: !_saving,
                    textDirection: TextDirection.ltr,
                    decoration: const InputDecoration(
                      labelText: 'تاريخ تحديث الشحنة',
                      hintText: 'YYYY-MM-DD',
                    ),
                    validator: (value) => validDate(value?.trim() ?? '')
                        ? null
                        : 'أدخل تاريخاً صحيحاً',
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _status,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'حالة الشحنة'),
                    items: ['pending', 'in_transit', 'delivered']
                        .map(
                          (status) => DropdownMenuItem(
                            value: status,
                            child: Text(shipmentStatusText(status)),
                          ),
                        )
                        .toList(),
                    onChanged: _saving
                        ? null
                        : (value) =>
                              setState(() => _status = value ?? 'pending'),
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue: _employeeId,
                    isExpanded: true,
                    decoration: const InputDecoration(
                      labelText: 'الموظف المسؤول عن الشحنة',
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: '',
                        child: Text('غير مسندة إلى موظف'),
                      ),
                      ...widget.app.employees
                          .where((e) => e.active)
                          .map(
                            (e) => DropdownMenuItem(
                              value: e.id,
                              child: Text(
                                e.name,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ),
                    ],
                    onChanged: _saving
                        ? null
                        : (value) => setState(() => _employeeId = value ?? ''),
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _reference,
                    enabled: !_saving,
                    maxLength: 120,
                    decoration: const InputDecoration(labelText: 'مرجع الشحنة'),
                  ),
                  TextFormField(
                    controller: _note,
                    enabled: !_saving,
                    maxLength: 1000,
                    maxLines: 3,
                    decoration: const InputDecoration(
                      labelText: 'سبب التحديث أو مستند التسليم',
                    ),
                    validator: (value) => (value?.trim().isEmpty ?? true)
                        ? 'أدخل سبب تحديث الشحنة'
                        : null,
                  ),
                  if (_error != null)
                    Text(
                      _error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed:
                          _saving || !widget.app.allowed || !widget.app.manager
                          ? null
                          : _save,
                      icon: Icon(
                        _saving
                            ? Icons.hourglass_empty
                            : Icons.local_shipping_outlined,
                      ),
                      label: Text(
                        _saving
                            ? 'جارٍ حفظ تحديث الشحنة'
                            : 'حفظ تحديث الشحنة محلياً',
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            Text(
              'سجل تغييرات الشحنة',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            ListTile(
              title: const Text('عند تسجيل الفاتورة'),
              subtitle: Text(
                '${widget.invoice.date} · ${shipmentStatusText(widget.invoice.shipmentStatus)}\n${_employeeName(widget.invoice.shippingEmployeeId)} · ${widget.invoice.shipmentRef}',
              ),
            ),
            ...history.map(
              (event) => Card(
                child: ListTile(
                  title: Text(
                    '${_rejectedIds.contains(event.id) ? 'تحديث متعارض يحتاج تصحيحاً' : 'تحديث ${event.shipmentOrder}'} · ${event.date} · ${shipmentStatusText(event.shipmentStatus)}',
                  ),
                  subtitle: Text(
                    '${_employeeName(event.shippingEmployeeId)} · ${event.shipmentRef}\n${event.note}',
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    },
  );

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.app.requireAllowed();
      if (!widget.app.manager) {
        invalid('shipment_role', 'تحديث بيانات الشحنات متاح للمدير فقط');
      }
      if (_operationOrder == 0) {
        _operationOrder =
            _projectedEntries
                .where(
                  (e) =>
                      e.kind == 'shipment_update' &&
                      e.originalId == widget.invoice.id,
                )
                .fold(
                  0,
                  (int highest, e) =>
                      highest > e.shipmentOrder ? highest : e.shipmentOrder,
                ) +
            1;
      }
      await widget.app.saveEntry(
        LedgerEntry(
          id: _operationId,
          tenantId: widget.app.tenantId,
          creatorUid: widget.app.uid,
          kind: 'shipment_update',
          date: _date.text.trim(),
          originalId: widget.invoice.id,
          shipmentOrder: _operationOrder,
          shippingEmployeeId: _employeeId,
          shipmentRef: _reference.text.trim(),
          shipmentStatus: _status,
          note: _note.text.trim(),
        ),
      );
      if (!mounted) return;
      _operationId = newId();
      _operationOrder = 0;
      _note.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'حُفظ تحديث الشحنة محلياً؛ راجع حالة قبوله في المزامنة',
          ),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = arabicError(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }
}
