import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/presentation/screens.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/services/exports.dart';

const party = Party(
  id: 'customer',
  tenantId: 'tenant',
  name: 'عميل اختبار الفترة',
  kind: 'merchant',
);

LedgerEntry sale(String id, String date, int total) => LedgerEntry(
  id: id,
  tenantId: party.tenantId,
  creatorUid: 'manager',
  kind: 'sale',
  date: date,
  partyId: party.id,
  totalMinor: total,
);

AppController controller() => AppController()
  ..license = const LicenseStatus(
    operationalAllowed: false,
    role: 'manager',
    message: 'Synthetic period test',
  )
  ..parties = [party]
  ..entries = [
    sale('prior', '2026-01-01', 10000),
    sale('inside', '2026-02-01', 20000),
    sale('later', '2026-03-01', 30000),
  ];

void main() {
  testWidgets(
    'report refuses partial, impossible and reversed dates before showing totals or enabling export',
    (tester) async {
      final app = controller();
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: ReportsScreen(app: app)),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('600.00 ج.م'), findsOneWidget);
        final from = find.byKey(const ValueKey('report-from'));
        final to = find.byKey(const ValueKey('report-to'));
        final pdf = find.widgetWithText(FilledButton, 'مشاركة تقرير عربي');
        final csv = find.widgetWithText(OutlinedButton, 'تصدير جدول العمليات');
        for (final invalid in ['2026-02', '2026-02-30']) {
          await tester.enterText(from, invalid);
          await tester.pumpAndSettle();
          expect(find.text('تاريخ غير صالح'), findsOneWidget);
          expect(find.text('مؤشرات الفترة'), findsNothing);
          expect(find.text('600.00 ج.م'), findsNothing);
          expect(tester.widget<FilledButton>(pdf).onPressed, isNull);
          expect(tester.widget<OutlinedButton>(csv).onPressed, isNull);
        }
        await tester.enterText(from, '2026-02-01');
        await tester.enterText(to, '2026-02-28');
        await tester.pumpAndSettle();
        expect(find.text('200.00 ج.م'), findsOneWidget);
        expect(find.text('600.00 ج.م'), findsNothing);
        await tester.enterText(to, '2026-01-31');
        await tester.pumpAndSettle();
        expect(find.text('مؤشرات الفترة'), findsNothing);
        expect(tester.widget<FilledButton>(pdf).onPressed, isNull);
        expect(tester.widget<OutlinedButton>(csv).onPressed, isNull);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        app.dispose();
      }
    },
  );

  testWidgets(
    'oversized clipboard statement shows period guidance and keeps the complete ledger',
    (tester) async {
      final app = controller()
        ..entries = [
          for (var i = 0; i <= ArabicExports.maxTextRows; i++)
            sale('invoice_$i', '2026-02-01', 100),
        ];
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: StatementScreen(app: app, party: party),
          ),
        );
        await tester.pumpAndSettle();
        final copy = find.widgetWithText(
          OutlinedButton,
          'نسخ كشف الحساب للمشاركة',
        );
        await tester.ensureVisible(copy);
        await tester.tap(copy);
        await tester.pumpAndSettle();
        expect(
          find.textContaining('حجم التصدير أكبر من الحد الآمن'),
          findsOneWidget,
        );
        expect(app.entries.length, ArabicExports.maxTextRows + 1);
        expect(app.entries.last.id, 'invoice_${ArabicExports.maxTextRows}');
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        app.dispose();
      }
    },
  );

  testWidgets(
    'revoked account hides an already open statement and its export actions',
    (tester) async {
      final app = controller();
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: StatementScreen(app: app, party: party),
          ),
        );
        await tester.pumpAndSettle();
        app.license = const LicenseStatus(
          operationalAllowed: false,
          role: 'manager',
          code: 'account_disabled',
          message: 'Synthetic revoked account',
        );
        app.notifyListeners();
        await tester.pumpAndSettle();
        expect(
          find.text('الصلاحية غير متاحة لعرض كشف الحساب.'),
          findsOneWidget,
        );
        expect(find.text('مشاركة كشف حساب عربي'), findsNothing);
        expect(find.textContaining(party.name), findsNothing);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        app.dispose();
      }
    },
  );

  testWidgets(
    'employee and changed-tenant routes cannot display cached manager financial records',
    (tester) async {
      for (final employee in [true, false]) {
        final app = controller()
          ..tenantId = employee ? party.tenantId : 'another_tenant'
          ..license = LicenseStatus(
            operationalAllowed: false,
            role: employee ? 'employee' : 'manager',
            message: 'Synthetic scope change',
          );
        try {
          await tester.pumpWidget(
            MaterialApp(
              home: StatementScreen(app: app, party: party),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.textContaining(party.name), findsNothing);
          expect(find.text('مشاركة كشف حساب عربي'), findsNothing);
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(body: ReportsScreen(app: app)),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('مؤشرات الفترة'), findsNothing);
          expect(find.text('تصدير جدول العمليات'), findsNothing);
          expect(find.text('600.00 ج.م'), findsNothing);
          expect(tester.takeException(), isNull);
        } finally {
          await tester.pumpWidget(const SizedBox.shrink());
          app.dispose();
        }
      }
    },
  );
}
