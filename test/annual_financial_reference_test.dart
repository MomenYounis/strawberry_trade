import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';

// Hand-calculated synthetic journal. These expectations do not call the
// application's balance/return/cash formulas to produce their expected values.
const customer = Party(
  id: 'customer',
  tenantId: 'annual-test',
  name: 'عميل',
  kind: 'merchant',
);
const supplier = Party(
  id: 'supplier',
  tenantId: 'annual-test',
  name: 'مورد',
  kind: 'supplier',
);
LedgerEntry event(
  String id,
  String kind,
  String date, {
  Party? party,
  int amount = 0,
  int cash = 0,
  int quantity = 0,
  String original = '',
  String adjustment = '',
}) => LedgerEntry(
  id: id,
  tenantId: 'annual-test',
  creatorUid: 'manager',
  kind: kind,
  date: date,
  partyId: party?.id ?? '',
  partyName: party?.name ?? '',
  totalMinor: amount,
  paidMinor: cash,
  qtyMilli: quantity,
  priceMinor: quantity == 0 ? 0 : 20000,
  grade: quantity == 0 ? '' : 'أ',
  unit: quantity == 0 ? '' : 'كيلو',
  originalId: original,
  adjustmentDirection: adjustment,
  note: 'مرجع مستقل',
);
void main() {
  test('two year boundaries conserve receivable/payable and separate recorded cash', () {
    final entries = [
      event(
        'sale',
        'sale',
        '2027-08-31',
        party: customer,
        quantity: 100000,
        amount: 2000000,
      ),
      event(
        'purchase',
        'purchase',
        '2027-08-31',
        party: supplier,
        quantity: 100000,
        amount: 2000000,
      ),
      event(
        'collect',
        'merchant_payment',
        '2027-09-01',
        party: customer,
        amount: 500000,
        cash: 500000,
      ),
      event(
        'pay',
        'supplier_payment',
        '2027-09-01',
        party: supplier,
        amount: 500000,
        cash: 500000,
      ),
      event(
        'customer-return',
        'sale_return',
        '2028-01-01',
        party: customer,
        quantity: 25000,
        amount: 500000,
        original: 'sale',
      ),
      event(
        'supplier-return',
        'purchase_return',
        '2028-01-01',
        party: supplier,
        quantity: 10000,
        amount: 200000,
        original: 'purchase',
      ),
      event(
        'collect-next',
        'merchant_payment',
        '2028-09-01',
        party: customer,
        amount: 100000,
        cash: 100000,
      ),
    ];
    for (var i = 0; i < entries.length; i++) {
      LedgerRules.validateEntry(
        entries[i],
        entries.take(i),
        [customer, supplier],
        [],
        [],
      );
    }
    for (final party in [customer, supplier]) {
      expect(
        LedgerRules.statementClosingBalance(party, entries, to: '2027-08-31'),
        2000000,
      );
      expect(
        LedgerRules.statementOpeningBalance(party, entries, from: '2027-09-01'),
        2000000,
      );
      expect(
        LedgerRules.statementClosingBalance(party, entries, to: '2027-09-01'),
        1500000,
      );
    }
    expect(
      LedgerRules.statementClosingBalance(customer, entries, to: '2028-08-31'),
      1000000,
    );
    expect(
      LedgerRules.statementClosingBalance(supplier, entries, to: '2028-08-31'),
      1300000,
    );
    expect(LedgerRules.partyBalance(customer, entries), 900000);
    expect(LedgerRules.partyBalance(supplier, entries), 1300000);
    expect(
      LedgerRules.netRecordedCash(
        entries,
        from: '2027-09-01',
        to: '2028-08-31',
      ),
      0,
    );
    expect(LedgerRules.netRecordedCash(entries), 100000);
    expect(LedgerRules.returnTotal(entries.first, 75000, entries), 1500000);
    expect(
      () => LedgerRules.returnTotal(entries.first, 75001, entries),
      throwsA(isA<LedgerException>()),
    );
    // Reading the same historical statement is pure and cannot post another sale.
    for (var i = 0; i < 3; i++) {
      expect(
        LedgerRules.statement(customer, entries).last.balanceMinor,
        900000,
      );
    }
    expect(entries.length, 7);
  });

  test(
    'signed advances and current-period reversal never rewrite prior close',
    () {
      const advance = Party(
        id: 'advance',
        tenantId: 'annual-test',
        name: 'رصيد مقدم',
        kind: 'merchant',
        openingMinor: -20000,
      );
      final adjustment = event(
        'adjust',
        'balance_adjustment',
        '2027-08-31',
        party: advance,
        amount: 50000,
        adjustment: 'increase',
      );
      final reversal = event(
        'reverse',
        'reversal',
        '2027-09-02',
        original: adjustment.id,
      );
      LedgerRules.validateEntry(adjustment, [], [advance], [], []);
      LedgerRules.validateEntry(reversal, [adjustment], [advance], [], []);
      final entries = [adjustment, reversal];
      expect(
        LedgerRules.statementClosingBalance(advance, entries, to: '2027-08-31'),
        30000,
      );
      expect(
        LedgerRules.statementOpeningBalance(
          advance,
          entries,
          from: '2027-09-01',
        ),
        30000,
      );
      expect(LedgerRules.partyBalance(advance, entries), -20000);
      expect(LedgerRules.netRecordedCash(entries), 0);
    },
  );
}
