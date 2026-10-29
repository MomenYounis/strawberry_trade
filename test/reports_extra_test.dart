import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/presentation/reports_extra.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart' hide canonicalJson;

class FixtureSecurity extends DeviceSecurity {
  FixtureSecurity(this.time);
  final int time;
  final values = <String, String>{};
  @override
  Future<String?> readSecureValue(String scope) async => values[scope];
  @override
  Future<void> writeSecureValue(String scope, String value) async {
    values[scope] = value;
  }

  @override
  Future<ClockSample> platformClock() async =>
      ClockSample(wallMs: time, elapsedMs: 1000, bootCount: 1);
}

const customer = Party(
  id: 'c1',
  tenantId: 't1',
  name: 'عميل مرجعي',
  kind: 'merchant',
  openingMinor: 5000,
);
LedgerEntry entry(
  String id,
  String kind,
  String date, {
  int total = 0,
  int paid = 0,
  String party = '',
  String original = '',
  String category = '',
}) => LedgerEntry(
  id: id,
  tenantId: 't1',
  creatorUid: 'u1',
  kind: kind,
  date: date,
  totalMinor: total,
  paidMinor: paid,
  partyId: party,
  originalId: original,
  category: category,
);
List<LedgerEntry> referenceLedger() => [
  entry('sale', 'sale', '2026-01-15', total: 20000, paid: 5000, party: 'c1'),
  entry(
    'old-expense',
    'expense_business',
    '2026-01-20',
    total: 1000,
    paid: 1000,
    category: 'نقل',
  ),
  entry(
    'purchase',
    'purchase',
    '2026-01-25',
    total: 10000,
    paid: 4000,
    party: 's1',
  ),
  entry(
    'collection',
    'merchant_payment',
    '2026-02-02',
    total: 2000,
    paid: 2000,
    party: 'c1',
  ),
  entry('expense-reversal', 'reversal', '2026-02-04', original: 'old-expense'),
  entry(
    'expense',
    'expense_business',
    '2026-02-05',
    total: 3000,
    paid: 3000,
    category: 'نقل',
  ),
  entry('salary', 'payroll', '2026-02-07', total: 7000, paid: 7000),
  entry(
    'home',
    'expense_home',
    '2026-02-08',
    total: 2000,
    paid: 2000,
    category: 'البيت',
  ),
  entry(
    'return',
    'sale_return',
    '2026-02-10',
    total: 4000,
    paid: 1000,
    party: 'c1',
    original: 'sale',
  ),
  entry(
    'purchase-return',
    'purchase_return',
    '2026-02-20',
    total: 1000,
    paid: 500,
    party: 's1',
    original: 'purchase',
  ),
  // A sale with a live return cannot be reversed: correct that return first.
  entry('return-reversal', 'reversal', '2026-03-01', original: 'return'),
  entry('sale-reversal', 'reversal', '2026-03-02', original: 'sale'),
];

void main() {
  setUpAll(sqfliteFfiInit);
  test('historical chart and cash totals exclude later corrections but include prior original records', () {
    final january = RecordedPeriod.fromEntries(
      referenceLedger(),
      from: '2026-01-01',
      to: '2026-01-31',
    );
    expect(january.salesMinor, 20000);
    expect(january.purchasesMinor, 10000);
    expect(january.businessExpenseMinor, 1000);
    expect(january.cashMinor, 0);
    final february = RecordedPeriod.fromEntries(
      referenceLedger(),
      from: '2026-02-01',
      to: '2026-02-28',
    );
    expect(february.salesMinor, -4000);
    expect(february.purchasesMinor, -1000);
    expect(february.businessExpenseMinor, 9000);
    expect(february.homeExpenseMinor, 2000);
    expect(february.cashMinor, -9500);
    expect(february.businessCategories, {'نقل': 2000, 'رواتب وأجور': 7000});
    expect(february.homeCategories, {'البيت': 2000});
    expect(february.months.keys, ['2026-02']);
    expect(february.months['2026-02']!.businessExpenseMinor, 9000);
    final march = RecordedPeriod.fromEntries(
      referenceLedger(),
      from: '2026-03-01',
      to: '2026-03-31',
    );
    expect(march.salesMinor, -16000);
    expect(march.cashMinor, -4000);
  });
  test('whole ledger totals equal dated periods and zero-cash metadata never changes cash', () {
    final records = [
      ...referenceLedger(),
      entry('shipment', 'shipment_update', '2026-02-12', original: 'sale'),
      const LedgerEntry(
        id: 'adjustment',
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'balance_adjustment',
        date: '2026-02-13',
        partyId: 'c1',
        totalMinor: 900,
        adjustmentDirection: 'increase',
      ),
    ];
    final totals = RecordedPeriod.fromEntries(records);
    final months = [
      RecordedPeriod.fromEntries(records, from: '2026-01-01', to: '2026-01-31'),
      RecordedPeriod.fromEntries(records, from: '2026-02-01', to: '2026-02-28'),
      RecordedPeriod.fromEntries(records, from: '2026-03-01', to: '2026-03-31'),
    ];
    expect(totals.salesMinor, 0);
    expect(totals.purchasesMinor, 9000);
    expect(totals.businessExpenseMinor, 10000);
    expect(totals.homeExpenseMinor, 2000);
    expect(totals.cashMinor, -13500);
    expect(months.fold<int>(0, (v, m) => v + m.cashMinor), totals.cashMinor);
    expect(months.fold<int>(0, (v, m) => v + m.salesMinor), totals.salesMinor);
    expect(
      months.fold<int>(0, (v, m) => v + m.businessExpenseMinor),
      totals.businessExpenseMinor,
    );
  });
  test('copied statement carries opening and running balances from before the selected period', () {
    final text = buildStatementText(
      customer,
      referenceLedger(),
      from: '2026-02-01',
      to: '2026-02-28',
    );
    expect(text, contains('الرصيد أول الفترة: 200.00 ج.م'));
    expect(text, contains('الرصيد 180.00 ج.م'));
    expect(text, contains('الرصيد 150.00 ج.م'));
    expect(text, contains('الرصيد آخر الفترة: 150.00 ج.م'));
    expect(text, contains('2026-02-02'));
    expect(text, isNot(contains('2026-03-01')));
    expect(text, isNot(contains('رواتب')));
  });
  test('empty statement period preserves prior balance and never falls back to original opening', () {
    final text = buildStatementText(
      customer,
      referenceLedger(),
      from: '2026-02-15',
      to: '2026-02-19',
    );
    expect(text, contains('لا توجد حركة في الفترة المختارة'));
    expect(text, contains('الرصيد أول الفترة: 150.00 ج.م'));
    expect(text, contains('الرصيد آخر الفترة: 150.00 ج.م'));
  });
  test('statement tenant mixing, invalid range and missing reversal source fail explicitly', () {
    expect(
      () => buildStatementText(customer, [
        const LedgerEntry(
          id: 'foreign',
          tenantId: 'another',
          creatorUid: 'u',
          kind: 'sale',
          date: '2026-01-01',
        ),
      ]),
      throwsA(isA<LedgerException>()),
    );
    expect(
      () => buildStatementText(
        customer,
        referenceLedger(),
        from: '2026-03-01',
        to: '2026-02-01',
      ),
      throwsA(isA<LedgerException>()),
    );
    expect(
      () => RecordedPeriod.fromEntries([
        entry('orphan', 'reversal', '2026-02-01', original: 'missing'),
      ]),
      throwsA(isA<LedgerException>()),
    );
  });
  testWidgets(
    'budget editor stores Arabic amount on disk and revocation hides manager charts',
    (tester) async {
      late Directory folder;
      late AppController app;
      late LedgerStore db;
      await tester.runAsync(() async {
        folder = await Directory.systemTemp.createTemp('strawberry_budget_');
        final fixture = jsonDecode(
          File('test/fixtures/license_package.json').readAsStringSync(),
        ) as Map<String, dynamic>;
        final verifier = LicenseVerifier(
          (fixture['publicKeys'] as Map).cast<String, String>(),
        );
        final raw = jsonEncode(fixture['package']);
        final verified = await verifier.verifyPackage(
          raw,
          tenantId: 'tenant-test-only',
          uid: 'manager-test-only',
          deviceId: 'device-test-only',
        );
        final security = FixtureSecurity(verified.issuedAtMs);
        final session = LicenseSession(
          security: security,
          verifier: verifier,
          tenantId: 'tenant-test-only',
          uid: 'manager-test-only',
          deviceId: 'device-test-only',
        );
        app = AppController(security: security, verifier: verifier);
        db = await LedgerStore.open(
          path: '${folder.path}/ledger.db',
          tenantId: 'tenant-test-only',
          userId: 'manager-test-only',
          factory: databaseFactoryFfi,
        );
        app.tenantId = 'tenant-test-only';
        app.uid = 'manager-test-only';
        app.store = db;
        app.licenseSession = session;
        app.license = await session.importPackage(raw, trustedOnline: true);
        await db.setPreference('budgetBusinessMinor', 50000);
        await db.saveEntry(
          const LedgerEntry(
            id: 'budget-expense',
            tenantId: 'tenant-test-only',
            creatorUid: 'manager-test-only',
            kind: 'expense_business',
            date: '2026-02-05',
            totalMinor: 3000,
            paidMinor: 3000,
            category: 'نقل',
          ),
        );
        await app.refresh();
      });
      Future<void> drain() async {
        for (var i = 0; i < 12; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump();
        }
      }

      addTearDown(() async {
        await db.close();
        app.store = null;
        app.dispose();
        await folder.delete(recursive: true);
      });
      await tester.pumpWidget(
        MaterialApp(
          locale: const Locale('ar'),
          supportedLocales: const [Locale('ar')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: Scaffold(
            body: SingleChildScrollView(
              child: BudgetAndCharts(
                app: app,
                from: '2026-02-01',
                to: '2026-02-28',
              ),
            ),
          ),
        ),
      );
      await drain();
      expect(find.text('الهدف الشهري الحالي: 500.00 ج.م'), findsOneWidget);
      expect(find.text('صافي المصروفات المسجلة: 30.00 ج.م'), findsOneWidget);
      await tester.tap(find.text('تعديل الهدف الشهري').first);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), '-١');
      await tester.tap(find.text('حفظ الهدف'));
      await tester.pump();
      expect(find.text('أدخل مبلغاً صحيحاً غير سالب'), findsOneWidget);
      await tester.enterText(find.byType(TextFormField), '٦٠٠٫٥٠');
      await tester.tap(find.text('حفظ الهدف'));
      await drain();
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        expect(await db.preference('budgetBusinessMinor'), 60050);
      });
      expect(find.text('الهدف الشهري الحالي: 600.50 ج.م'), findsOneWidget);
      await tester.tap(find.text('تعديل الهدف الشهري').first);
      await tester.pumpAndSettle();
      app.license = const LicenseStatus(
        operationalAllowed: false,
        role: 'manager',
        code: 'account_disabled',
        message: 'أوقف الحساب',
      );
      app.notifyListeners();
      await tester.pump();
      expect(find.text('الميزانيات الشهرية'), findsNothing);
      expect(find.textContaining('600.50'), findsNothing);
      expect(find.byType(TextFormField), findsNothing);
      expect(find.text('توقفت صلاحية هذه النافذة'), findsOneWidget);
      await tester.tap(find.text('إغلاق'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
