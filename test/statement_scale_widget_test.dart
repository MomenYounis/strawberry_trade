import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/presentation/screens.dart';
import 'package:strawberry_trade/security/licensing.dart';

void main() {
  testWidgets(
    'statement date edits never broaden an invalid period and keep prior balances',
    (tester) async {
      const party = Party(
        id: 'm1',
        tenantId: 't1',
        name: 'عميل فترة الاختبار',
        kind: 'merchant',
        openingMinor: 5000,
      );
      LedgerEntry sale(String id, String date, int total) => LedgerEntry(
        id: id,
        tenantId: 't1',
        creatorUid: 'u1',
        kind: 'sale',
        date: date,
        partyId: party.id,
        totalMinor: total,
      );
      final app = AppController()
        ..license = const LicenseStatus(
          operationalAllowed: false,
          message: 'Synthetic display period',
          role: 'manager',
        )
        ..parties = [party]
        ..entries = [
          sale('prior', '2026-01-01', 10000),
          sale('inside', '2026-02-01', 20000),
          sale('later', '2026-03-01', 30000),
        ];
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: Directionality(
              textDirection: TextDirection.rtl,
              child: StatementScreen(app: app, party: party),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final from = find.byKey(const ValueKey('statement-from'));
        final to = find.byKey(const ValueKey('statement-to'));
        await tester.enterText(from, '2026-02');
        await tester.pumpAndSettle();
        expect(find.text('تاريخ غير صالح'), findsOneWidget);
        final pdf = find.widgetWithText(FilledButton, 'مشاركة كشف حساب عربي');
        await tester.ensureVisible(pdf);
        await tester.pumpAndSettle();
        expect(tester.widget<FilledButton>(pdf).onPressed, isNull);
        final csv = find.widgetWithText(OutlinedButton, 'مشاركة كشف حساب CSV');
        await tester.ensureVisible(csv);
        await tester.pumpAndSettle();
        expect(tester.widget<OutlinedButton>(csv).onPressed, isNull);
        await tester.ensureVisible(from);
        await tester.enterText(from, '2026-02-01');
        await tester.enterText(to, '2026-02-28');
        await tester.pumpAndSettle();
        expect(
          tester.widget<TextFormField>(from).controller!.text,
          '2026-02-01',
        );
        expect(tester.widget<TextFormField>(to).controller!.text, '2026-02-28');
        expect(find.text('رصيد أول الفترة: 150.00 ج.م'), findsOneWidget);
        await tester.ensureVisible(csv);
        expect(tester.widget<OutlinedButton>(csv).onPressed, isNotNull);
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('statement-line:inside')),
          500,
          scrollable: find
              .descendant(
                of: find.byType(ListView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        expect(
          find.byKey(const ValueKey('statement-line:prior')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('statement-line:later')),
          findsNothing,
        );
        await tester.drag(find.byType(ListView), const Offset(0, -500));
        await tester.pumpAndSettle();
        expect(
          find.text('الرصيد حتى نهاية الفترة: 350.00 ج.م'),
          findsOneWidget,
        );
        await tester.drag(find.byType(ListView), const Offset(0, 3000));
        await tester.pumpAndSettle();
        final fromField = tester.widget<TextFormField>(from);
        final toField = tester.widget<TextFormField>(to);
        expect(fromField.controller!.text, '2026-02-01');
        expect(toField.controller!.text, '2026-02-28');
        await tester.enterText(to, '2026-01-31');
        await tester.pumpAndSettle();
        await tester.ensureVisible(pdf);
        expect(tester.widget<FilledButton>(pdf).onPressed, isNull);
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        app.dispose();
      }
    },
  );

  testWidgets(
    'large statement keeps complete balances and first/last rows while building only visible movements',
    (tester) async {
      const count = 10000;
      const party = Party(
        id: 'm1',
        tenantId: 't1',
        name: 'عميل اختبار السعة',
        kind: 'merchant',
        openingMinor: 5000,
      );
      final app = AppController()
        ..license = const LicenseStatus(
          operationalAllowed: false,
          message: 'Synthetic display capacity',
          role: 'manager',
        )
        ..parties = [party]
        ..entries = [
          for (var i = 0; i < count; i++)
            LedgerEntry(
              id: 'line_${i.toString().padLeft(5, '0')}',
              tenantId: 't1',
              creatorUid: 'u1',
              kind: 'sale',
              date: '2026-10-01',
              partyId: party.id,
              partyName: party.name,
              qtyMilli: 10000,
              priceMinor: 2000,
              totalMinor: 20000,
              paidMinor: 10000,
              grade: 'A',
              unit: 'kg',
            ),
        ];
      try {
        await tester.pumpWidget(
          MaterialApp(
            home: Directionality(
              textDirection: TextDirection.rtl,
              child: StatementScreen(app: app, party: party),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(ListTile).evaluate().length, lessThan(40));
        final scrollable = find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first;
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('statement-line:line_00000')),
          500,
          scrollable: scrollable,
        );
        expect(
          find.byKey(const ValueKey('statement-line:line_00000')),
          findsOneWidget,
        );
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('statement-line:line_09999')),
          5000,
          maxScrolls: 300,
          scrollable: scrollable,
        );
        expect(
          find.byKey(const ValueKey('statement-line:line_09999')),
          findsOneWidget,
        );
        await tester.drag(find.byType(ListView), const Offset(0, -500));
        await tester.pumpAndSettle();
        expect(
          find.text(
            'الرصيد حتى نهاية الفترة: ${formatMoney(5000 + count * 10000)} ج.م',
          ),
          findsOneWidget,
        );
        expect(find.byType(ListTile).evaluate().length, lessThan(40));
        expect(tester.takeException(), isNull);
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        app.dispose();
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
