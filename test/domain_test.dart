import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';

const merchant = Party(
  id: 'm1',
  tenantId: 't1',
  name: 'عميل مرجعي',
  kind: 'merchant',
  openingMinor: 5000,
);
const supplier = Party(
  id: 's1',
  tenantId: 't1',
  name: 'مورد مرجعي',
  kind: 'supplier',
  openingMinor: 3000,
);
const employee = Employee(id: 'e1', tenantId: 't1', name: 'أحمد');
const october = SalaryTerm(
  id: 'salary1',
  tenantId: 't1',
  employeeId: 'e1',
  effectiveMonth: '2026-10',
  monthlyMinor: 300000,
);

LedgerEntry invoice({
  String id = 'invoice',
  String kind = 'sale',
  String partyId = 'm1',
  String partyName = 'عميل مرجعي',
  int qtyMilli = 10000,
  int priceMinor = 2000,
  int? totalMinor,
  int paidMinor = 10000,
  String date = '2026-10-01',
  String grade = 'درجة أ',
  String unit = 'كيلو',
}) => LedgerEntry(
  id: id,
  tenantId: 't1',
  creatorUid: 'u1',
  kind: kind,
  date: date,
  partyId: partyId,
  partyName: partyName,
  qtyMilli: qtyMilli,
  priceMinor: priceMinor,
  totalMinor: totalMinor ?? invoiceTotal(qtyMilli, priceMinor),
  paidMinor: paidMinor,
  grade: grade,
  unit: unit,
);
LedgerEntry payment(
  String id,
  String kind,
  int amount, {
  String partyId = '',
  String partyName = '',
  String employeeId = '',
  String salaryMonth = '',
  String date = '2026-10-05',
}) => LedgerEntry(
  id: id,
  tenantId: 't1',
  creatorUid: 'u1',
  kind: kind,
  date: date,
  partyId: partyId,
  partyName: partyName,
  totalMinor: amount,
  paidMinor: amount,
  employeeId: employeeId,
  salaryMonth: salaryMonth,
);
LedgerEntry returned(
  LedgerEntry original,
  String id,
  int qty,
  Iterable<LedgerEntry> previous, {
  int paid = 0,
  String? grade,
  String? unit,
  int? amount,
}) => LedgerEntry(
  id: id,
  tenantId: 't1',
  creatorUid: 'u1',
  kind: original.kind == 'sale' ? 'sale_return' : 'purchase_return',
  date: '2026-10-06',
  partyId: original.partyId,
  partyName: original.partyName,
  qtyMilli: qty,
  priceMinor: original.priceMinor,
  totalMinor: amount ?? LedgerRules.returnTotal(original, qty, previous),
  paidMinor: paid,
  grade: grade ?? original.grade,
  unit: unit ?? original.unit,
  originalId: original.id,
);
void validate(LedgerEntry e, List<LedgerEntry> existing) =>
    LedgerRules.validateEntry(e, existing, [merchant, supplier], [employee], [
      october,
    ]);

void main() {
  test(
    'Documented balance adjustments change debt but never create cash movement',
    () {
      const up = LedgerEntry(
        id: 'adjust-up',
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'balance_adjustment',
        date: '2026-10-01',
        partyId: 'm1',
        partyName: 'عميل مرجعي',
        totalMinor: 1200,
        adjustmentDirection: 'increase',
        note: 'إثبات مديونية سابقة',
      );
      validate(up, []);
      const down = LedgerEntry(
        id: 'adjust-down',
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'balance_adjustment',
        date: '2026-10-02',
        partyId: 'm1',
        partyName: 'عميل مرجعي',
        totalMinor: 500,
        adjustmentDirection: 'decrease',
        note: 'تسوية معتمدة',
      );
      validate(down, [up]);
      expect(LedgerRules.partyBalance(merchant, [up, down]), 5700);
      expect(LedgerRules.netRecordedCash([up, down]), 0);
      expect(
        LedgerRules.statement(merchant, [up, down]).map((l) => l.balanceMinor),
        [6200, 5700],
      );
      const reverse = LedgerEntry(
        id: 'adjust-void',
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'reversal',
        date: '2026-10-03',
        originalId: 'adjust-up',
        note: 'تصحيح تسوية',
      );
      validate(reverse, [up, down]);
      expect(LedgerRules.partyBalance(merchant, [up, down, reverse]), 4500);
      final bad = up.toJson()..['paidMinor'] = 100;
      expect(
        () => validate(LedgerEntry.fromJson(bad), []),
        throwsA(isA<LedgerException>()),
      );
      bad['paidMinor'] = 0;
      bad['note'] = '';
      expect(
        () => validate(LedgerEntry.fromJson(bad), []),
        throwsA(isA<LedgerException>()),
      );
    },
  );
  test('Adjustment evidence round-trips and both party kinds support signed debt corrections', () {
    final increase = LedgerEntry.fromJson({
      ...invoice().toJson(),
      'id': 'supplier-adjust',
      'kind': 'balance_adjustment',
      'partyId': supplier.id,
      'partyName': supplier.name,
      'totalMinor': 7000,
      'qtyMilli': 0,
      'priceMinor': 0,
      'paidMinor': 0,
      'grade': '',
      'unit': '',
      'adjustmentDirection': 'increase',
      'note': 'مطابقة مستند رصيد المورد',
    });
    validate(increase, []);
    expect(LedgerEntry.fromJson(increase.toJson()).toJson(), increase.toJson());
    final decrease = LedgerEntry.fromJson({
      ...increase.toJson(),
      'id': 'supplier-decrease',
      'date': '2026-10-02',
      'adjustmentDirection': 'decrease',
      'totalMinor': 2000,
    });
    validate(decrease, [increase]);
    const reversal = LedgerEntry(
      id: 'supplier-void',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-03',
      originalId: 'supplier-decrease',
      note: 'عكس التخفيض بناء على المستند الصحيح',
    );
    validate(reversal, [increase, decrease]);
    final lines = LedgerRules.statement(supplier, [
      increase,
      decrease,
      reversal,
    ]);
    expect(lines.map((l) => l.balanceMinor), [10000, 8000, 10000]);
    expect(lines.last.debitMinor, 2000);
    expect(
      LedgerRules.partyBalance(supplier, [increase, decrease, reversal]),
      10000,
    );
    expect(LedgerRules.netRecordedCash([increase, decrease, reversal]), 0);
    for (final mutation in <Map<String, dynamic>>[
      {'totalMinor': 0},
      {'paidMinor': 1},
      {'qtyMilli': 1},
      {'priceMinor': 1},
      {'adjustmentDirection': ''},
      {'adjustmentDirection': 'negative'},
      {'note': '  '},
      {'partyId': ''},
      {'partyName': 'اسم آخر'},
      {'employeeId': 'e1'},
      {'salaryMonth': '2026-10'},
      {'shippingEmployeeId': 'e1'},
      {'category': 'مصاريف أخرى'},
    ]) {
      expect(
        () => validate(
          LedgerEntry.fromJson({...increase.toJson(), ...mutation}),
          [],
        ),
        throwsA(isA<LedgerException>()),
        reason: mutation.toString(),
      );
    }
    expect(
      () => validate(
        LedgerEntry.fromJson({
          ...invoice().toJson(),
          'adjustmentDirection': 'increase',
        }),
        [],
      ),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Period statements and cash preserve historical facts and dated corrections', () {
    final sale = invoice(date: '2026-09-30');
    const reversal = LedgerEntry(
      id: 'october-correction',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-05',
      originalId: 'invoice',
      note: 'تصحيح مستند الشهر السابق',
    );
    validate(reversal, [sale]);
    final facts = [sale, reversal];
    expect(
      LedgerRules.statementOpeningBalance(merchant, facts, from: '2026-10-01'),
      15000,
    );
    expect(
      LedgerRules.statementClosingBalance(merchant, facts, to: '2026-10-02'),
      15000,
    );
    expect(
      LedgerRules.statement(
        merchant,
        facts,
        from: '2026-10-01',
        to: '2026-10-02',
      ),
      isEmpty,
    );
    expect(
      LedgerRules.statementClosingBalance(merchant, facts, to: '2026-10-05'),
      5000,
    );
    expect(
      LedgerRules.statementOpeningBalance(merchant, facts, from: '2026-10-06'),
      5000,
    );
    expect(LedgerRules.netRecordedCash(facts, to: '2026-09-30'), 10000);
    expect(
      LedgerRules.netRecordedCash(facts, from: '2026-10-01', to: '2026-10-31'),
      -10000,
    );
    expect(LedgerRules.netRecordedCash(facts), 0);
    expect(
      () => LedgerRules.netRecordedCash([reversal]),
      throwsA(isA<LedgerException>()),
    );
  });
  test(
    'Expense categories are preserved independently of payroll attribution',
    () {
      final expense = LedgerEntry(
        id: 'categorized',
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'expense_business',
        date: '2026-10-03',
        totalMinor: 1000,
        paidMinor: 1000,
        category: 'شحن ونقل ونولون',
      );
      validate(expense, []);
      expect(
        LedgerEntry.fromJson(expense.toJson()).category,
        'شحن ونقل ونولون',
      );
      expect(
        payment('default-category', 'expense_business', 100).category,
        'مصاريف أخرى',
      );
    },
  );
  test('Arabic/Persian and Western decimal parsing is exact; malformed/NaN/negative fail', () {
    expect(parseScaled('١٢٣٫٤٥', 100), 12345);
    expect(parseScaled('۱۲٫۳۴۵', 1000), 12345);
    expect(parseScaled('12,30', 100), 1230);
    for (final v in [
      'NaN',
      'Infinity',
      '-1',
      '1e3',
      '1.234',
      '1,2.3',
      '١٬٠٠٠',
      '',
    ]) {
      expect(
        () => parseScaled(v, 100),
        throwsA(isA<LedgerException>()),
        reason: v,
      );
    }
  });
  test('Half-up rounding uses integer currency and quantity', () {
    expect(invoiceTotal(1001, 500), 501);
    expect(invoiceTotal(1, 500), 1);
    expect(() => invoiceTotal(-1, 100), throwsA(isA<LedgerException>()));
    expect(
      () => invoiceTotal(1000000000, 1000000000),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Decimal input cannot overflow into an accepted small amount', () {
    expect(parseScaled('10000000000.00', 100), 1000000000000);
    expect(parseScaled('1000000000.000', 1000), 1000000000000);
    expect(parseScaled('00000000000000000000012.34', 100), 1234);
    for (final input in [
      '10000000000.01',
      '184467440737095516.16',
      '١٨٤٤٦٧٤٤٠٧٣٧٠٩٥٥١٦٫١٦',
      '9223372036854775807',
      List.filled(200, '9').join(),
    ]) {
      expect(
        () => parseScaled(input, 100),
        throwsA(
          isA<LedgerException>().having((error) => error.code, 'code', 'limit'),
        ),
        reason: input,
      );
    }
  });
  test('Reference partial sale, collection, cash-refunded return and opening balance', () {
    final sale = invoice();
    validate(sale, []);
    final collect = payment(
      'collect',
      'merchant_payment',
      4000,
      partyId: merchant.id,
      partyName: merchant.name,
    );
    validate(collect, [sale]);
    final back = returned(sale, 'return', 2000, [sale, collect], paid: 1000);
    validate(back, [sale, collect]);
    final entries = [sale, collect, back];
    expect(
      LedgerRules.partyBalance(merchant, entries),
      8000,
    ); // 50 + 200 - 100 - 40 - 40 + 10 = 80 EGP.
    expect(LedgerRules.netRecordedCash(entries), 13000);
    final lines = LedgerRules.statement(merchant, entries);
    expect(lines.map((l) => l.balanceMinor), [15000, 11000, 8000]);
    expect(
      LedgerRules.statement(
        merchant,
        entries,
        from: '2026-10-05',
      ).first.balanceMinor,
      11000,
    );
  });
  test('Reference purchase, supplier payment, return, expenses and payroll cash agree', () {
    final buy = invoice(
      id: 'purchase',
      kind: 'purchase',
      partyId: supplier.id,
      partyName: supplier.name,
      qtyMilli: 5000,
      priceMinor: 3000,
      paidMinor: 5000,
    );
    validate(buy, []);
    final pay = payment(
      'pay',
      'supplier_payment',
      2000,
      partyId: supplier.id,
      partyName: supplier.name,
    );
    validate(pay, [buy]);
    final back = returned(buy, 'back', 1000, [buy, pay], paid: 1000);
    validate(back, [buy, pay]);
    final expense = payment('expense', 'expense_business', 1000);
    validate(expense, [buy, pay, back]);
    final home = payment('home', 'expense_home', 500);
    validate(home, [buy, pay, back, expense]);
    final payroll = payment(
      'salary',
      'payroll',
      5000,
      employeeId: employee.id,
      salaryMonth: '2026-10',
    );
    validate(payroll, [buy, pay, back, expense, home]);
    final entries = [buy, pay, back, expense, home, payroll];
    expect(LedgerRules.partyBalance(supplier, entries), 9000);
    expect(LedgerRules.netRecordedCash(entries), -12500);
  });
  test('Legacy inconsistent total=1 and paid=500 for 10×20 is rejected', () {
    expect(
      () => validate(invoice(totalMinor: 100, paidMinor: 50000), []),
      throwsA(isA<LedgerException>()),
    );
    expect(
      () => validate(invoice(totalMinor: 20000, paidMinor: 20001), []),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Return cannot change grade, unit, date, party or exceed quantity', () {
    final sale = invoice();
    expect(
      () =>
          validate(returned(sale, 'r1', 1000, [sale], grade: 'درجة ب'), [sale]),
      throwsA(isA<LedgerException>()),
    );
    expect(
      () => validate(returned(sale, 'r1', 1000, [sale], unit: 'طن'), [sale]),
      throwsA(isA<LedgerException>()),
    );
    expect(
      () => returned(sale, 'r1', 11000, [sale]),
      throwsA(isA<LedgerException>()),
    );
    final r1 = returned(sale, 'r1', 8000, [sale]);
    validate(r1, [sale]);
    expect(
      () => returned(sale, 'r2', 3000, [sale, r1]),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Cumulative return rounding allocates exact final invoice cents', () {
    final sale = invoice(qtyMilli: 3000, priceMinor: 33, paidMinor: 0);
    final entries = [sale];
    final amounts = <int>[];
    for (var i = 0; i < 3; i++) {
      final r = returned(sale, 'r$i', 1000, entries);
      validate(r, entries);
      entries.add(r);
      amounts.add(r.totalMinor);
    }
    expect(amounts, [33, 33, 33]);
    final fractional = invoice(
      id: 'tiny',
      qtyMilli: 3000,
      priceMinor: 1,
      paidMinor: 0,
    );
    final fractionalEntries = [fractional];
    for (final qty in [500, 1000, 1500]) {
      final r = returned(fractional, 'f$qty', qty, fractionalEntries);
      validate(r, fractionalEntries);
      fractionalEntries.add(r);
    }
    expect(fractionalEntries.skip(1).map((e) => e.totalMinor), [1, 1, 1]);
    expect(
      LedgerRules.partyBalance(merchant, fractionalEntries),
      merchant.openingMinor,
    );
  });
  test(
    'Tiny zero-value return is rejected and full residual remains available',
    () {
      final sale = invoice(qtyMilli: 3000, priceMinor: 1, paidMinor: 0);
      expect(
        () => returned(sale, 'tiny', 1, [sale]),
        throwsA(isA<LedgerException>()),
      );
    },
  );
  test('Historical payroll follows effective terms and never fabricates missing months', () {
    const next = SalaryTerm(
      id: 'salary2',
      tenantId: 't1',
      employeeId: 'e1',
      effectiveMonth: '2026-11',
      monthlyMinor: 400000,
    );
    final p = payment(
      'salary',
      'payroll',
      100000,
      employeeId: 'e1',
      salaryMonth: '2026-10',
    );
    validate(p, []);
    expect(
      LedgerRules.payroll('e1', '2026-10', [october, next], [p]).remainingMinor,
      200000,
    );
    expect(
      LedgerRules.payroll('e1', '2026-11', [october, next], [p]).remainingMinor,
      400000,
    );
    expect(
      LedgerRules.payroll(
        'e1',
        '2026-09',
        [october, next],
        [p],
      ).entitlementMinor,
      isNull,
    );
    expect(
      () => validate(
        payment(
          'bad',
          'expense_business',
          100,
          employeeId: 'e1',
          salaryMonth: '2026-10',
        ),
        [],
      ),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Posted corrections preserve reversal evidence and prohibit duplicate/dependent reversal', () {
    final sale = invoice();
    const reversal = LedgerEntry(
      id: 'reverse',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-07',
      originalId: 'invoice',
      note: 'تصحيح موثق',
    );
    validate(reversal, [sale]);
    expect(LedgerRules.partyBalance(merchant, [sale, reversal]), 5000);
    expect(LedgerRules.netRecordedCash([sale, reversal]), 0);
    expect(
      LedgerRules.statement(merchant, [sale, reversal]).last.creditMinor,
      10000,
    );
    const again = LedgerEntry(
      id: 'again',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-08',
      originalId: 'invoice',
      note: 'ثانٍ',
    );
    expect(
      () => validate(again, [sale, reversal]),
      throwsA(isA<LedgerException>()),
    );
    final back = returned(sale, 'r', 1000, [sale]);
    expect(
      () => validate(reversal, [sale, back]),
      throwsA(isA<LedgerException>()),
    );
  });
  test('Import parser rejects numeric strings and nonfinite values', () {
    final j = invoice().toJson();
    j['totalMinor'] = '20000';
    expect(() => LedgerEntry.fromJson(j), throwsA(isA<LedgerException>()));
    j['totalMinor'] = double.nan;
    expect(() => LedgerEntry.fromJson(j), throwsA(isA<LedgerException>()));
    expect(validDate('2026-02-30'), isFalse);
    expect(validDate('2024-02-29'), isTrue);
  });
  test(
    'Employee submission parser rejects private accounting and payroll fields',
    () {
      const submission = EmployeeSubmission(
        id: 'submission',
        tenantId: 't1',
        creatorUid: 'u1',
        employeeId: 'e1',
        kind: 'delivery',
        date: '2026-10-01',
        partyId: 'm1',
        partyName: 'عميل مرجعي',
        qtyMilli: 1000,
        grade: 'درجة أ',
        unit: 'كيلو',
      );
      submission.validate();
      final malicious = {...submission.toJson(), 'priceMinor': 1000};
      expect(
        () => EmployeeSubmission.fromJson(malicious),
        throwsA(isA<LedgerException>()),
      );
    },
  );
  test('Shipment updates append auditable metadata while preserving financial and original invoice facts', () {
    final original = invoice();
    final update = LedgerEntry(
      id: 'shipment-change-a',
      shipmentOrder: 1,
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'shipment_update',
      date: '2026-10-02',
      originalId: original.id,
      shippingEmployeeId: 'e1',
      shipmentRef: 'شحنة أكتوبر',
      shipmentStatus: 'in_transit',
      note: 'استلام السائق للمستند',
    );
    validate(update, [original]);
    final completed = LedgerEntry.fromJson({
      ...update.toJson(),
      'id': 'shipment-change-b',
      'shipmentOrder': 2,
      'date': '2026-10-03',
      'shipmentStatus': 'delivered',
      'note': 'استلام العميل للشحنة',
    });
    validate(completed, [original, update]);
    final facts = [completed, original, update];
    expect(LedgerRules.latestShipment(original, facts).id, completed.id);
    expect(LedgerRules.latestShipment(original, [original]).id, original.id);
    expect(original.shipmentStatus, isEmpty);
    expect(LedgerRules.partyBalance(merchant, facts), 15000);
    expect(LedgerRules.netRecordedCash(facts), 10000);
    expect(LedgerRules.statement(merchant, facts).length, 1);
    for (final mutation in <Map<String, dynamic>>[
      {'shipmentOrder': 0},
      {'shipmentOrder': -1},
      {'totalMinor': 1},
      {'paidMinor': 1},
      {'qtyMilli': 1},
      {'priceMinor': 1},
      {'partyId': 'm1'},
      {'partyName': merchant.name},
      {'employeeId': 'e1'},
      {'salaryMonth': '2026-10'},
      {'category': 'مصاريف أخرى'},
      {'adjustmentDirection': 'increase'},
      {'grade': 'درجة أ'},
      {'unit': 'كيلو'},
      {'note': ' '},
      {'shipmentStatus': ''},
      {'shipmentStatus': 'unknown'},
      {'shippingEmployeeId': 'unknown'},
      {'date': '2026-09-30'},
      {'originalId': 'missing'},
      {'shipmentRef': List.filled(121, 'a').join()},
    ]) {
      expect(
        () => validate(
          LedgerEntry.fromJson({...update.toJson(), ...mutation}),
          [original],
        ),
        throwsA(isA<LedgerException>()),
        reason: mutation.toString(),
      );
    }
    expect(
      () => LedgerRules.validateEntry(
        update,
        [original],
        [merchant, supplier],
        [
          const Employee(
            id: 'e1',
            tenantId: 't1',
            name: 'موظف متوقف',
            active: false,
          ),
        ],
        [october],
      ),
      throwsA(isA<LedgerException>()),
    );
    const reversal = LedgerEntry(
      id: 'void-update',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-04',
      originalId: 'shipment-change-a',
      note: 'محاولة عكس',
    );
    expect(
      () => validate(reversal, [original, update]),
      throwsA(isA<LedgerException>()),
    );
    const voidInvoice = LedgerEntry(
      id: 'void-original',
      tenantId: 't1',
      creatorUid: 'u1',
      kind: 'reversal',
      date: '2026-10-02',
      originalId: 'invoice',
      note: 'عكس الفاتورة',
    );
    expect(
      () => validate(update, [original, voidInvoice]),
      throwsA(isA<LedgerException>()),
    );
    expect(LedgerRules.shipmentHasOrderConflict(original, facts), isFalse);
    final tied = LedgerEntry.fromJson({
      ...completed.toJson(),
      'id': 'shipment-change-c',
    });
    expect(
      LedgerRules.latestShipment(original, [original, tied, completed]).id,
      tied.id,
    );
    expect(
      LedgerRules.shipmentHasOrderConflict(original, [
        original,
        tied,
        completed,
      ]),
      isTrue,
    );
    final next = LedgerEntry.fromJson({
      ...completed.toJson(),
      'id': 'aaa-lexically-earlier',
      'shipmentOrder': 3,
    });
    validate(next, [original, update, completed]);
    expect(
      LedgerRules.latestShipment(original, [original, completed, next]).id,
      next.id,
    );
    expect(
      () => validate(
        LedgerEntry.fromJson({...original.toJson(), 'shipmentOrder': 1}),
        [],
      ),
      throwsA(isA<LedgerException>()),
    );
  });
  test(
    'Shipment references require a known same-tenant employee and an invoice',
    () {
      final data = invoice().toJson()
        ..addAll({
          'shippingEmployeeId': 'unknown',
          'shipmentRef': 'شحنة ١',
          'shipmentStatus': 'delivered',
        });
      expect(
        () => validate(LedgerEntry.fromJson(data), []),
        throwsA(isA<LedgerException>()),
      );
      data['shippingEmployeeId'] = 'e1';
      validate(LedgerEntry.fromJson(data), []);
    },
  );
}
