import 'dart:convert';
import 'dart:math';

/// All money is in 1/100 EGP, quantity in 1/1000 of the stated unit.
/// Values never pass through a floating-point accounting calculation.
class LedgerException implements Exception {
  const LedgerException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

Never invalid(String code, String message) =>
    throw LedgerException(code, message);

String newId() {
  final random = Random.secure();
  return List.generate(
    20,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

/// JSON member ordering is irrelevant (Firestore can reorder object fields).
String canonicalJson(Object? value) {
  Object? ordered(Object? item) {
    if (item is Map) {
      final keys = item.keys.cast<String>().toList()..sort();
      return {for (final key in keys) key: ordered(item[key])};
    }
    if (item is List) return item.map(ordered).toList();
    return item;
  }

  return jsonEncode(ordered(value));
}

void safeId(String value) {
  if (!RegExp(r'^[A-Za-z0-9_-]{1,120}$').hasMatch(value)) {
    invalid('invalid_id', 'معرّف السجل غير صالح');
  }
}

bool validDate(String value) {
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value)) return false;
  final date = DateTime.tryParse('${value}T12:00:00Z');
  return date != null &&
      date.year > 0 &&
      date.toIso8601String().startsWith(value);
}

bool validMonth(String value) => validDate('$value-01');

int strictInt(Map<String, dynamic> json, String key, [int fallback = 0]) {
  final value = json[key];
  if (value == null) return fallback;
  if (value is! int) invalid('invalid_number', 'قيمة رقمية غير صالحة');
  return value;
}

String strictString(
  Map<String, dynamic> json,
  String key, [
  String fallback = '',
]) {
  final value = json[key];
  if (value == null) return fallback;
  if (value is! String) invalid('invalid_text', 'قيمة نصية غير صالحة');
  return value;
}

/// Parse Western/Arabic/Persian digits, with strict fixed decimal precision.
int parseScaled(String input, int scale) {
  var value = input.trim();
  for (var i = 0; i <= 9; i++) {
    value = value
        .replaceAll('٠١٢٣٤٥٦٧٨٩'[i], '$i')
        .replaceAll('۰۱۲۳۴۵۶۷۸۹'[i], '$i');
  }
  value = value.replaceAll('٫', '.').replaceAll(',', '.');
  if (!RegExp(r'^\d+(\.\d+)?$').hasMatch(value)) {
    invalid('invalid_number', 'أدخل رقماً موجباً صالحاً');
  }
  final places = scale == 100
      ? 2
      : scale == 1000
      ? 3
      : -1;
  if (places == -1) throw ArgumentError.value(scale);
  final parts = value.split('.');
  final decimals = parts.length == 2 ? parts[1] : '';
  if (decimals.length > places) {
    invalid('precision', 'عدد المنازل العشرية أكبر من المسموح');
  }
  // Native Dart integer arithmetic can wrap before a post-multiply bound is
  // checked. Parse untrusted digits without overflow, then narrow only after
  // checking the accounting limit.
  final result =
      BigInt.parse(parts[0]) * BigInt.from(scale) +
      BigInt.parse(decimals.padRight(places, '0'));
  if (result > BigInt.from(1000000000000)) {
    invalid('limit', 'القيمة أكبر من الحد المسموح');
  }
  return result.toInt();
}

String formatMoney(int minor) =>
    '${minor < 0 ? '-' : ''}${minor.abs() ~/ 100}.${(minor.abs() % 100).toString().padLeft(2, '0')}';
String formatQuantity(int milli) =>
    '${milli ~/ 1000}.${(milli % 1000).toString().padLeft(3, '0')}';

int invoiceTotal(int qtyMilli, int priceMinor) {
  if (qtyMilli <= 0 ||
      priceMinor <= 0 ||
      qtyMilli > 1000000000 ||
      priceMinor > 1000000000 ||
      qtyMilli * priceMinor > 9007199254740991) {
    invalid('invalid_amount', 'الكمية والسعر يجب أن يكونا موجبين وضمن الحدود');
  }
  return (qtyMilli * priceMinor + 500) ~/ 1000;
}

const entryKinds = <String>{
  'sale',
  'purchase',
  'merchant_payment',
  'supplier_payment',
  'expense_business',
  'expense_home',
  'sale_return',
  'purchase_return',
  'payroll',
  'reversal',
  'balance_adjustment',
  'shipment_update',
};
const kindLabels = <String, String>{
  'sale': 'بيع',
  'purchase': 'شراء',
  'merchant_payment': 'تحصيل من عميل',
  'supplier_payment': 'دفع لمورد',
  'expense_business': 'مصروف تشغيل',
  'expense_home': 'مصروف منزلي',
  'sale_return': 'مرتجع بيع',
  'purchase_return': 'مرتجع شراء',
  'payroll': 'دفعة راتب',
  'reversal': 'قيد عكسي',
  'balance_adjustment': 'تسوية رصيد موثقة',
  'shipment_update': 'تحديث بيانات شحنة',
};

class Party {
  const Party({
    required this.id,
    required this.tenantId,
    required this.name,
    required this.kind,
    this.openingMinor = 0,
    this.phone = '',
    this.favorite = false,
    this.revision = 1,
  });
  final String id, tenantId, name, kind, phone;
  final int openingMinor, revision;
  final bool favorite;
  void validate() {
    safeId(id);
    safeId(tenantId);
    if (name.trim().isEmpty ||
        name.length > 160 ||
        phone.length > 40 ||
        !{'merchant', 'supplier'}.contains(kind) ||
        openingMinor.abs() > 1000000000000 ||
        revision != 1) {
      invalid('invalid_party', 'بيانات العميل أو المورد غير صالحة');
    }
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'tenantId': tenantId,
    'name': name,
    'kind': kind,
    'openingMinor': openingMinor,
    'phone': phone,
    'favorite': favorite,
    'revision': revision,
  };
  factory Party.fromJson(Map<String, dynamic> j) {
    if (j['favorite'] != null && j['favorite'] is! bool) {
      invalid('invalid_party', 'بيانات التفضيل غير صالحة');
    }
    return Party(
      id: strictString(j, 'id'),
      tenantId: strictString(j, 'tenantId'),
      name: strictString(j, 'name'),
      kind: strictString(j, 'kind'),
      openingMinor: strictInt(j, 'openingMinor'),
      phone: strictString(j, 'phone'),
      favorite: j['favorite'] == true,
      revision: strictInt(j, 'revision', 1),
    );
  }
}

class Employee {
  const Employee({
    required this.id,
    required this.tenantId,
    required this.name,
    this.phone = '',
    this.active = true,
    this.revision = 1,
  });
  final String id, tenantId, name, phone;
  final bool active;
  final int revision;
  void validate() {
    safeId(id);
    safeId(tenantId);
    if (name.trim().isEmpty ||
        name.length > 160 ||
        phone.length > 40 ||
        revision != 1) {
      invalid('invalid_employee', 'بيانات الموظف غير صالحة');
    }
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'tenantId': tenantId,
    'name': name,
    'phone': phone,
    'active': active,
    'revision': revision,
  };
  factory Employee.fromJson(Map<String, dynamic> j) {
    if (j['active'] != null && j['active'] is! bool) {
      invalid('invalid_employee', 'حالة الموظف غير صالحة');
    }
    return Employee(
      id: strictString(j, 'id'),
      tenantId: strictString(j, 'tenantId'),
      name: strictString(j, 'name'),
      phone: strictString(j, 'phone'),
      active: j['active'] != false,
      revision: strictInt(j, 'revision', 1),
    );
  }
}

class SalaryTerm {
  const SalaryTerm({
    required this.id,
    required this.tenantId,
    required this.employeeId,
    required this.effectiveMonth,
    required this.monthlyMinor,
    this.revision = 1,
  });
  final String id, tenantId, employeeId, effectiveMonth;
  final int monthlyMinor, revision;
  void validate() {
    safeId(id);
    safeId(tenantId);
    safeId(employeeId);
    if (!validMonth(effectiveMonth) ||
        monthlyMinor < 0 ||
        monthlyMinor > 1000000000000 ||
        revision != 1) {
      invalid('invalid_salary', 'قيمة الراتب أو شهر بدايته غير صالح');
    }
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'tenantId': tenantId,
    'employeeId': employeeId,
    'effectiveMonth': effectiveMonth,
    'monthlyMinor': monthlyMinor,
    'revision': revision,
  };
  factory SalaryTerm.fromJson(Map<String, dynamic> j) => SalaryTerm(
    id: strictString(j, 'id'),
    tenantId: strictString(j, 'tenantId'),
    employeeId: strictString(j, 'employeeId'),
    effectiveMonth: strictString(j, 'effectiveMonth'),
    monthlyMinor: strictInt(j, 'monthlyMinor'),
    revision: strictInt(j, 'revision', 1),
  );
}

class LedgerEntry {
  const LedgerEntry({
    required this.id,
    required this.tenantId,
    required this.creatorUid,
    required this.kind,
    required this.date,
    this.partyId = '',
    this.partyName = '',
    this.employeeId = '',
    this.salaryMonth = '',
    this.qtyMilli = 0,
    this.priceMinor = 0,
    this.totalMinor = 0,
    this.paidMinor = 0,
    this.grade = '',
    this.unit = '',
    this.originalId = '',
    this.note = '',
    this.revision = 1,
    this.shippingEmployeeId = '',
    this.shipmentRef = '',
    this.shipmentStatus = '',
    this.adjustmentDirection = '',
    this.shipmentOrder = 0,
    String? category,
  }) : category =
           category ??
           ((kind == 'expense_business' || kind == 'expense_home')
               ? 'مصاريف أخرى'
               : '');
  final String id,
      tenantId,
      creatorUid,
      kind,
      date,
      partyId,
      partyName,
      employeeId,
      salaryMonth,
      grade,
      unit,
      originalId,
      note,
      shippingEmployeeId,
      shipmentRef,
      shipmentStatus,
      category;
  final String adjustmentDirection;
  final int qtyMilli,
      priceMinor,
      totalMinor,
      paidMinor,
      revision,
      shipmentOrder;
  bool get isInvoice => kind == 'sale' || kind == 'purchase';
  bool get isReturn => kind == 'sale_return' || kind == 'purchase_return';
  Map<String, dynamic> toJson() => {
    'id': id,
    'tenantId': tenantId,
    'creatorUid': creatorUid,
    'kind': kind,
    'date': date,
    'partyId': partyId,
    'partyName': partyName,
    'employeeId': employeeId,
    'salaryMonth': salaryMonth,
    'qtyMilli': qtyMilli,
    'priceMinor': priceMinor,
    'totalMinor': totalMinor,
    'paidMinor': paidMinor,
    'grade': grade,
    'unit': unit,
    'originalId': originalId,
    'note': note,
    'revision': revision,
    'shippingEmployeeId': shippingEmployeeId,
    'shipmentRef': shipmentRef,
    'shipmentStatus': shipmentStatus,
    'category': category,
    'adjustmentDirection': adjustmentDirection,
    'shipmentOrder': shipmentOrder,
  };
  factory LedgerEntry.fromJson(Map<String, dynamic> j) => LedgerEntry(
    id: strictString(j, 'id'),
    tenantId: strictString(j, 'tenantId'),
    creatorUid: strictString(j, 'creatorUid'),
    kind: strictString(j, 'kind'),
    date: strictString(j, 'date'),
    partyId: strictString(j, 'partyId'),
    partyName: strictString(j, 'partyName'),
    employeeId: strictString(j, 'employeeId'),
    salaryMonth: strictString(j, 'salaryMonth'),
    qtyMilli: strictInt(j, 'qtyMilli'),
    priceMinor: strictInt(j, 'priceMinor'),
    totalMinor: strictInt(j, 'totalMinor'),
    paidMinor: strictInt(j, 'paidMinor'),
    grade: strictString(j, 'grade'),
    unit: strictString(j, 'unit'),
    originalId: strictString(j, 'originalId'),
    note: strictString(j, 'note'),
    revision: strictInt(j, 'revision', 1),
    shippingEmployeeId: strictString(j, 'shippingEmployeeId'),
    shipmentRef: strictString(j, 'shipmentRef'),
    shipmentStatus: strictString(j, 'shipmentStatus'),
    category: j['category'] == null ? null : strictString(j, 'category'),
    adjustmentDirection: strictString(j, 'adjustmentDirection'),
    shipmentOrder: strictInt(j, 'shipmentOrder'),
  );
}

class EmployeeSubmission {
  const EmployeeSubmission({
    required this.id,
    required this.tenantId,
    required this.creatorUid,
    required this.employeeId,
    required this.kind,
    required this.date,
    this.partyId = '',
    this.partyName = '',
    this.qtyMilli = 0,
    this.grade = '',
    this.unit = '',
    this.originalId = '',
    this.amountMinor = 0,
    this.note = '',
    String? category,
  }) : category = category ?? (kind == 'expense_business' ? 'مصاريف أخرى' : '');
  final String id,
      tenantId,
      creatorUid,
      employeeId,
      kind,
      date,
      partyId,
      partyName,
      grade,
      unit,
      originalId,
      note,
      category;
  final int qtyMilli, amountMinor;
  void validate() {
    safeId(id);
    safeId(tenantId);
    safeId(creatorUid);
    safeId(employeeId);
    if (!validDate(date) ||
        !{
          'delivery',
          'purchase_delivery',
          'sale_return',
          'purchase_return',
          'expense_business',
        }.contains(kind) ||
        note.length > 1000 ||
        partyName.length > 160) {
      invalid('invalid_submission', 'بيانات الطلب غير صالحة');
    }
    if (kind == 'expense_business') {
      if (amountMinor <= 0 ||
          category.trim().isEmpty ||
          category.length > 80 ||
          amountMinor > 1000000000000 ||
          qtyMilli != 0 ||
          partyId.isNotEmpty ||
          originalId.isNotEmpty) {
        invalid('invalid_submission', 'بيانات المصروف غير صالحة');
      }
    } else {
      if (category.isNotEmpty) {
        invalid('invalid_category', 'هذا الطلب لا يتضمن بند مصروف');
      }
      safeId(partyId);
      if (qtyMilli <= 0 ||
          qtyMilli > 1000000000 ||
          grade.trim().isEmpty ||
          grade.length > 80 ||
          unit.trim().isEmpty ||
          unit.length > 40 ||
          (kind == 'purchase_delivery'
              ? (amountMinor < 0 || amountMinor > 1000000000)
              : amountMinor != 0)) {
        invalid(
          'invalid_submission',
          'أدخل العميل أو المورد والكمية والصنف والوحدة',
        );
      }
      if (kind.endsWith('_return')) {
        if (originalId.isNotEmpty) safeId(originalId);
      } else if (originalId.isNotEmpty) {
        invalid('invalid_submission', 'مرجع الفاتورة غير متاح لهذا الطلب');
      }
    }
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'tenantId': tenantId,
    'creatorUid': creatorUid,
    'employeeId': employeeId,
    'kind': kind,
    'date': date,
    'partyId': partyId,
    'partyName': partyName,
    'qtyMilli': qtyMilli,
    'grade': grade,
    'unit': unit,
    'originalId': originalId,
    'amountMinor': amountMinor,
    'note': note,
    'category': category,
  };
  factory EmployeeSubmission.fromJson(Map<String, dynamic> j) {
    final allowed = {
      'id',
      'tenantId',
      'creatorUid',
      'employeeId',
      'kind',
      'date',
      'partyId',
      'partyName',
      'qtyMilli',
      'grade',
      'unit',
      'originalId',
      'amountMinor',
      'note',
      'category',
    };
    if (j.keys.any((k) => !allowed.contains(k))) {
      invalid('private_fields', 'طلب الموظف يحتوي حقولاً غير مصرح بها');
    }
    return EmployeeSubmission(
      id: strictString(j, 'id'),
      tenantId: strictString(j, 'tenantId'),
      creatorUid: strictString(j, 'creatorUid'),
      employeeId: strictString(j, 'employeeId'),
      kind: strictString(j, 'kind'),
      date: strictString(j, 'date'),
      partyId: strictString(j, 'partyId'),
      partyName: strictString(j, 'partyName'),
      qtyMilli: strictInt(j, 'qtyMilli'),
      grade: strictString(j, 'grade'),
      unit: strictString(j, 'unit'),
      originalId: strictString(j, 'originalId'),
      amountMinor: strictInt(j, 'amountMinor'),
      note: strictString(j, 'note'),
      category: j['category'] == null ? null : strictString(j, 'category'),
    );
  }
}

class StatementLine {
  const StatementLine(
    this.entry,
    this.debitMinor,
    this.creditMinor,
    this.balanceMinor,
  );
  final LedgerEntry entry;
  final int debitMinor, creditMinor, balanceMinor;
}

class PayrollBalance {
  const PayrollBalance(this.entitlementMinor, this.paidMinor);
  final int? entitlementMinor;
  final int paidMinor;
  int? get remainingMinor =>
      entitlementMinor == null ? null : entitlementMinor! - paidMinor;
}

class LedgerRules {
  static int returnTotal(
    LedgerEntry original,
    int qtyMilli,
    Iterable<LedgerEntry> entries,
  ) {
    final returns = activeEntries(entries)
        .where((e) => e.isReturn && e.originalId == original.id);
    final usedQty = returns.fold(0, (n, e) => n + e.qtyMilli);
    final usedTotal = returns.fold(0, (n, e) => n + e.totalMinor);
    if (qtyMilli <= 0 || qtyMilli > original.qtyMilli - usedQty) {
      invalid('return_limit', 'الكمية تتجاوز المتاح للمرتجع');
    }
    final amount = qtyMilli == original.qtyMilli - usedQty
        ? original.totalMinor - usedTotal
        : invoiceTotal(usedQty + qtyMilli, original.priceMinor) - usedTotal;
    if (amount <= 0 || amount > original.totalMinor - usedTotal) {
      invalid('return_limit', 'قيمة المرتجع تتجاوز المتاح');
    }
    return amount;
  }

  static void validateEntry(
    LedgerEntry e,
    Iterable<LedgerEntry> existing,
    Iterable<Party> parties,
    Iterable<Employee> employees,
    Iterable<SalaryTerm> terms,
  ) {
    safeId(e.id);
    safeId(e.tenantId);
    safeId(e.creatorUid);
    if (!entryKinds.contains(e.kind) ||
        !validDate(e.date) ||
        e.revision != 1 ||
        e.note.length > 1000 ||
        e.category.length > 80 ||
        e.partyName.length > 160 ||
        e.grade.length > 80 ||
        e.unit.length > 40 ||
        e.shipmentOrder < 0 ||
        e.shipmentOrder > 1000000000 ||
        [
          e.qtyMilli,
          e.priceMinor,
          e.totalMinor,
          e.paidMinor,
        ].any((v) => v < 0 || v > 1000000000000)) {
      invalid(
        'invalid_entry',
        'بيانات العملية أو التاريخ أو المبالغ غير صالحة',
      );
    }
    if (existing.any((x) => x.id == e.id)) {
      invalid('duplicate_id', 'هذا المعرّف محفوظ بالفعل');
    }
    final active = activeEntries(existing).toList();
    if (e.kind != 'shipment_update' && e.shipmentOrder != 0) {
      invalid('shipment_order', 'ترتيب الشحنة غير متاح لهذا النوع من العمليات');
    }
    if (e.kind == 'balance_adjustment') {
      if (!{'increase', 'decrease'}.contains(e.adjustmentDirection) ||
          e.note.trim().isEmpty) {
        invalid('adjustment', 'حدد اتجاه التسوية وسببها الموثق');
      }
    } else if (e.adjustmentDirection.isNotEmpty) {
      invalid('adjustment', 'اتجاه تسوية الرصيد غير متاح لهذا النوع');
    }
    if ({'expense_business', 'expense_home'}.contains(e.kind)) {
      if (e.category.trim().isEmpty) invalid('category', 'اختر بند المصروف');
    } else if (e.category.isNotEmpty &&
        !(e.kind == 'payroll' && e.category == 'رواتب وأجور')) {
      invalid('category', 'بند المصروف غير متاح لهذا النوع من العمليات');
    }
    if (e.kind == 'shipment_update') {
      final original = active.where((x) => x.id == e.originalId).firstOrNull;
      if (original == null ||
          e.shipmentOrder < 1 ||
          !original.isInvoice ||
          original.tenantId != e.tenantId ||
          e.date.compareTo(original.date) < 0 ||
          e.note.trim().isEmpty ||
          [
            e.qtyMilli,
            e.priceMinor,
            e.totalMinor,
            e.paidMinor,
          ].any((v) => v != 0) ||
          [
            e.partyId,
            e.partyName,
            e.employeeId,
            e.salaryMonth,
            e.grade,
            e.unit,
          ].any((v) => v.isNotEmpty) ||
          e.shipmentRef.length > 120 ||
          !{'pending', 'in_transit', 'delivered'}.contains(e.shipmentStatus) ||
          (e.shippingEmployeeId.isNotEmpty &&
              !employees.any(
                (x) =>
                    x.id == e.shippingEmployeeId &&
                    x.tenantId == e.tenantId &&
                    x.active,
              ))) {
        invalid(
          'shipment_update',
          'اختر فاتورة سارية وحالة الشحنة والموظف الفعّال وأدخل سبب التحديث؛ بيانات الشحنة لا تتضمن مبالغ مالية',
        );
      }
      return;
    }
    if (e.shippingEmployeeId.isNotEmpty ||
        e.shipmentRef.isNotEmpty ||
        e.shipmentStatus.isNotEmpty) {
      if (!e.isInvoice ||
          e.shipmentRef.length > 120 ||
          !{
            '',
            'pending',
            'in_transit',
            'delivered',
          }.contains(e.shipmentStatus) ||
          (e.shippingEmployeeId.isNotEmpty &&
              !employees.any(
                (x) => x.id == e.shippingEmployeeId && x.tenantId == e.tenantId,
              ))) {
        invalid('shipment', 'بيانات الشحنة أو الموظف المسؤول غير صالحة');
      }
    }
    if (e.kind == 'reversal') {
      final target = existing.where((x) => x.id == e.originalId).firstOrNull;
      if (target == null ||
          target.kind == 'reversal' ||
          target.kind == 'shipment_update' ||
          target.tenantId != e.tenantId ||
          e.date.compareTo(target.date) < 0 ||
          e.note.trim().isEmpty ||
          [
            e.qtyMilli,
            e.priceMinor,
            e.totalMinor,
            e.paidMinor,
          ].any((v) => v != 0) ||
          e.partyId.isNotEmpty ||
          e.employeeId.isNotEmpty ||
          e.salaryMonth.isNotEmpty ||
          !active.any((x) => x.id == target.id) ||
          active.any((x) => x.isReturn && x.originalId == target.id)) {
        invalid(
          'invalid_reversal',
          'لا يمكن عكس العملية أو توجد مرتجعات مرتبطة بها؛ أدخل سبب التصحيح',
        );
      }
      return;
    }
    if (e.kind.startsWith('sale') ||
        e.kind == 'merchant_payment' ||
        e.kind.startsWith('purchase') ||
        e.kind == 'supplier_payment' ||
        e.kind == 'balance_adjustment') {
      final party = parties
          .where((p) => p.id == e.partyId && p.tenantId == e.tenantId)
          .firstOrNull;
      final kind = e.kind.startsWith('sale') || e.kind == 'merchant_payment'
          ? 'merchant'
          : 'supplier';
      if (party == null ||
          (e.kind != 'balance_adjustment' && party.kind != kind) ||
          e.partyName != party.name) {
        invalid('invalid_party', 'اختر العميل أو المورد الصحيح');
      }
    } else if (e.partyId.isNotEmpty || e.partyName.isNotEmpty) {
      invalid('invalid_party', 'هذه العملية لا تتعلق بعميل أو مورد');
    }
    if (e.isInvoice || e.isReturn) {
      if (e.grade.trim().isEmpty ||
          e.unit.trim().isEmpty ||
          e.paidMinor > e.totalMinor ||
          e.totalMinor <= 0 ||
          e.employeeId.isNotEmpty ||
          e.salaryMonth.isNotEmpty) {
        invalid(
          'invalid_invoice',
          'الصنف والوحدة مطلوبان والمدفوع لا يتجاوز قيمة العملية',
        );
      }
      if (e.isInvoice) {
        if (e.originalId.isNotEmpty ||
            e.totalMinor != invoiceTotal(e.qtyMilli, e.priceMinor)) {
          invalid('invoice_total', 'إجمالي الفاتورة لا يطابق الكمية والسعر');
        }
      } else if (e.originalId.isEmpty) {
        if (e.totalMinor != invoiceTotal(e.qtyMilli, e.priceMinor)) {
          invalid('return_total', 'قيمة المرتجع لا تطابق الكمية والسعر');
        }
      } else {
        final original = active.where((x) => x.id == e.originalId).firstOrNull;
        if (original == null ||
            original.kind != (e.kind == 'sale_return' ? 'sale' : 'purchase') ||
            original.tenantId != e.tenantId ||
            original.partyId != e.partyId ||
            original.grade != e.grade ||
            original.unit != e.unit ||
            original.priceMinor != e.priceMinor ||
            e.date.compareTo(original.date) < 0) {
          invalid(
            'return_original',
            'المرتجع يجب أن يطابق الفاتورة الأصلية والعميل والصنف والوحدة',
          );
        }
        if (e.totalMinor != returnTotal(original, e.qtyMilli, existing)) {
          invalid('return_total', 'قيمة المرتجع لا تطابق القيمة المستحقة');
        }
      }
    } else {
      if (e.qtyMilli != 0 ||
          e.priceMinor != 0 ||
          e.grade.isNotEmpty ||
          e.unit.isNotEmpty ||
          e.originalId.isNotEmpty ||
          e.totalMinor <= 0 ||
          (e.kind == 'balance_adjustment'
              ? e.paidMinor != 0
              : e.totalMinor != e.paidMinor)) {
        invalid('invalid_payment', 'أدخل مبلغاً موجباً مساوياً للمدفوع');
      }
      if (e.kind == 'payroll') {
        final employee = employees
            .where((x) => x.id == e.employeeId && x.tenantId == e.tenantId)
            .firstOrNull;
        if (employee == null ||
            !validMonth(e.salaryMonth) ||
            !terms.any(
              (t) =>
                  t.employeeId == e.employeeId &&
                  t.tenantId == e.tenantId &&
                  t.effectiveMonth.compareTo(e.salaryMonth) <= 0,
            )) {
          invalid(
            'payroll_history',
            'اختر الموظف وشهر الراتب؛ يلزم توثيق الراتب التاريخي أولاً',
          );
        }
      } else if (e.employeeId.isNotEmpty || e.salaryMonth.isNotEmpty) {
        invalid(
          'payroll_recipient',
          'مصروف التشغيل لا يمثل راتباً أو سلفة للموظف',
        );
      }
    }
  }

  static List<LedgerEntry> activeEntries(Iterable<LedgerEntry> entries) {
    final all = entries.toList();
    final reversed = all
        .where((e) => e.kind == 'reversal')
        .map((e) => e.originalId)
        .toSet();
    return all
        .where((e) => e.kind != 'reversal' && !reversed.contains(e.id))
        .toList();
  }

  static int partyEffect(LedgerEntry e) {
    if (e.kind == 'balance_adjustment') {
      return e.adjustmentDirection == 'increase' ? e.totalMinor : -e.totalMinor;
    }
    if (e.kind == 'sale' || e.kind == 'purchase') {
      return e.totalMinor - e.paidMinor;
    }
    if (e.kind == 'merchant_payment' || e.kind == 'supplier_payment') {
      return -e.paidMinor;
    }
    if (e.isReturn) return -e.totalMinor + e.paidMinor;
    return 0;
  }

  static LedgerEntry latestShipment(
    LedgerEntry invoice,
    Iterable<LedgerEntry> entries,
  ) {
    if (!invoice.isInvoice) {
      invalid('shipment_invoice', 'اختر فاتورة بيع أو شراء');
    }
    final updates =
        activeEntries(entries)
            .where(
              (e) =>
                  e.kind == 'shipment_update' &&
                  e.originalId == invoice.id &&
                  e.tenantId == invoice.tenantId,
            )
            .toList()
          ..sort((a, b) {
            final order = b.shipmentOrder.compareTo(a.shipmentOrder);
            if (order != 0) return order;
            final date = b.date.compareTo(a.date);
            return date == 0 ? b.id.compareTo(a.id) : date;
          });
    return updates.firstOrNull ?? invoice;
  }

  static bool shipmentHasOrderConflict(
    LedgerEntry invoice,
    Iterable<LedgerEntry> entries,
  ) {
    final updates = activeEntries(entries)
        .where(
          (e) =>
              e.kind == 'shipment_update' &&
              e.originalId == invoice.id &&
              e.tenantId == invoice.tenantId,
        )
        .toList();
    if (updates.isEmpty) return false;
    final latestOrder = updates.fold(0, (n, e) => max(n, e.shipmentOrder));
    return updates.where((e) => e.shipmentOrder == latestOrder).length > 1;
  }

  static List<StatementLine> statement(
    Party party,
    Iterable<LedgerEntry> entries, {
    String? from,
    String? to,
  }) {
    final all = entries.toList();
    final byId = {for (final e in all) e.id: e};
    final sorted =
        all
            .where(
              (e) =>
                  e.partyId == party.id ||
                  (e.kind == 'reversal' &&
                      byId[e.originalId]?.partyId == party.id),
            )
            .toList()
          ..sort((a, b) {
            final d = a.date.compareTo(b.date);
            return d == 0 ? a.id.compareTo(b.id) : d;
          });
    var balance = party.openingMinor;
    final result = <StatementLine>[];
    for (final e in sorted) {
      if (to != null && e.date.compareTo(to) > 0) continue;
      final delta = e.kind == 'reversal'
          ? -partyEffect(byId[e.originalId]!)
          : partyEffect(e);
      balance += delta;
      if (from == null || e.date.compareTo(from) >= 0) {
        result.add(
          StatementLine(
            e,
            delta > 0 ? delta : 0,
            delta < 0 ? -delta : 0,
            balance,
          ),
        );
      }
    }
    return result;
  }

  static int partyBalance(Party party, Iterable<LedgerEntry> entries) =>
      party.openingMinor +
      activeEntries(entries)
          .where((e) => e.partyId == party.id)
          .fold(0, (n, e) => n + partyEffect(e));

  static int statementOpeningBalance(
    Party party,
    Iterable<LedgerEntry> entries, {
    String? from,
  }) => from == null
      ? party.openingMinor
      : statement(party, entries)
                .where((line) => line.entry.date.compareTo(from) < 0)
                .lastOrNull
                ?.balanceMinor ??
            party.openingMinor;

  static int statementClosingBalance(
    Party party,
    Iterable<LedgerEntry> entries, {
    String? to,
  }) =>
      statement(party, entries, to: to).lastOrNull?.balanceMinor ??
      party.openingMinor;

  /// Include the full ledger so a correction inside this period can negate
  /// cash recorded before the period. A later correction must not rewrite a
  /// historical period that ended before its documented date.
  static int netRecordedCash(
    Iterable<LedgerEntry> entries, {
    String? from,
    String? to,
  }) {
    final all = entries.toList();
    final byId = {for (final e in all) e.id: e};
    int effect(LedgerEntry e) =>
        {'sale', 'merchant_payment', 'purchase_return'}.contains(e.kind)
        ? e.paidMinor
        : -e.paidMinor;
    return all
        .where(
          (e) =>
              (from == null || e.date.compareTo(from) >= 0) &&
              (to == null || e.date.compareTo(to) <= 0),
        )
        .fold(0, (n, e) {
          if (e.kind != 'reversal') return n + effect(e);
          final original = byId[e.originalId];
          if (original == null) {
            invalid(
              'cash_original',
              'يلزم السجل الكامل لحساب أثر القيد العكسي',
            );
          }
          return n - effect(original);
        });
  }

  static PayrollBalance payroll(
    String employeeId,
    String month,
    Iterable<SalaryTerm> terms,
    Iterable<LedgerEntry> entries,
  ) {
    if (!validMonth(month)) invalid('invalid_month', 'شهر الراتب غير صالح');
    final applicable =
        terms
            .where(
              (t) =>
                  t.employeeId == employeeId &&
                  t.effectiveMonth.compareTo(month) <= 0,
            )
            .toList()
          ..sort((a, b) => b.effectiveMonth.compareTo(a.effectiveMonth));
    final paid = activeEntries(entries)
        .where(
          (e) =>
              e.kind == 'payroll' &&
              e.employeeId == employeeId &&
              e.salaryMonth == month,
        )
        .fold(0, (n, e) => n + e.paidMinor);
    return PayrollBalance(applicable.firstOrNull?.monthlyMinor, paid);
  }
}
