import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/data/ledger_store.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/main.dart';
import 'package:strawberry_trade/presentation/screens.dart';
import 'package:strawberry_trade/presentation/shipments.dart';
import 'package:strawberry_trade/security/licensing.dart';

class FormController extends AppController {
  FormController({this.managerRole = true})
    : super(verifier: LicenseVerifier({})) {
    loading = false;
    tenantId = 'widget_tenant';
    uid = managerRole ? 'widget_manager' : 'widget_staff';
    employeeId = managerRole ? '' : 'widget_employee';
  }
  final bool managerRole;
  bool initialized = false, permission = true, failSave = false;
  int saveCalls = 0;
  Completer<void>? saveGate;
  @override
  bool get manager => managerRole;
  @override
  bool get ready => store != null;
  @override
  bool get allowed => ready && permission;
  @override
  Future<void> initialize() async {
    initialized = true;
  }

  @override
  Future<void> requireAllowed() async {
    if (!allowed) {
      throw const LedgerException(
        'locked',
        'انتهت صلاحية التشغيل؛ فعّل المنشأة أولاً',
      );
    }
  }

  @override
  Future<void> synchronize() async {}
  @override
  Future<void> saveEntry(LedgerEntry entry) async {
    saveCalls++;
    await saveGate?.future;
    if (failSave) {
      throw const LedgerException(
        'storage_failure',
        'تعذر الحفظ في الجهاز؛ لم تُسجّل العملية',
      );
    }
    await store!.saveEntry(entry);
    entries = await store!.listEntries();
  }

  @override
  Future<void> saveSubmission(EmployeeSubmission submission) async {
    saveCalls++;
    await store!.saveSubmission(submission);
    submissions = await store!.listSubmissions();
  }
}

Widget formHost(Widget child) => MaterialApp(
  locale: const Locale('ar'),
  supportedLocales: const [Locale('ar')],
  localizationsDelegates: GlobalMaterialLocalizations.delegates,
  home: child,
);
Finder field(String label) => find.ancestor(
  of: find.byWidgetPredicate(
    (w) => w is TextField && w.decoration?.labelText == label,
  ),
  matching: find.byType(TextFormField),
);

Future<void> drain(WidgetTester tester, {int cycles = 15}) async {
  for (var i = 0; i < cycles; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 20));
  }
}

void main() {
  setUpAll(sqfliteFfiInit);
  testWidgets(
    'English device still opens Arabic RTL setup and Arabic validation',
    (tester) async {
      tester.platformDispatcher.localeTestValue = const Locale('en', 'US');
      addTearDown(tester.platformDispatcher.clearLocaleTestValue);
      final app = FormController();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [appProvider.overrideWith((ref) => app)],
          child: const StrawberryApp(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('إعداد الحساب والجهاز'), findsOneWidget);
      expect(
        Directionality.of(tester.element(find.text('إعداد الحساب والجهاز'))),
        TextDirection.rtl,
      );
      expect(
        tester.widget<MaterialApp>(find.byType(MaterialApp)).locale,
        const Locale('ar'),
      );
      final email = field('البريد الإلكتروني');
      expect(email, findsOneWidget);
      final emailEditable = find.descendant(
        of: email,
        matching: find.byType(EditableText),
      );
      expect(
        tester.widget<EditableText>(emailEditable).textDirection,
        TextDirection.ltr,
      );
      await tester.ensureVisible(find.text('إعداد آمن وفتح السجل'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('إعداد آمن وفتح السجل'));
      await tester.pump();
      expect(find.text('أدخل معرّف المنشأة'), findsOneWidget);
      expect(find.text('أدخل بريداً إلكترونياً صحيحاً'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets('Cold startup exposes loading until durable store is ready', (
    tester,
  ) async {
    final app = FormController()..loading = true;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appProvider.overrideWith((ref) => app)],
        child: const StrawberryApp(),
      ),
    );
    await tester.pump();
    expect(find.text('جارٍ فتح السجل المحلي بأمان'), findsOneWidget);
    expect(find.text('إعداد الحساب والجهاز'), findsNothing);
    expect(find.text('عملية جديدة'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Ending the account removes its open private statement route', (
    tester,
  ) async {
    final app = FormController();
    late Directory directory;
    late LedgerStore db;
    final party = Party(
      id: 'private_customer',
      tenantId: app.tenantId,
      name: 'عميل الحساب السابق',
      kind: 'merchant',
      openingMinor: 98765,
    );
    await tester.runAsync(() async {
      directory = await Directory.systemTemp.createTemp('strawberry_route_');
      db = await LedgerStore.open(
        path: '${directory.path}/ledger.db',
        tenantId: app.tenantId,
        userId: app.uid,
        factory: databaseFactoryFfi,
      );
      await db.saveParty(party);
      app.store = db;
      app.parties = await db.listParties();
    });
    addTearDown(() async {
      await db.close();
      await directory.delete(recursive: true);
    });
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appProvider.overrideWith((ref) => app)],
        child: const StrawberryApp(),
      ),
    );
    await tester.pumpAndSettle();
    final previousNavigator = tester.state<NavigatorState>(
      find.byType(Navigator),
    );
    unawaited(
      previousNavigator.push(
        MaterialPageRoute<void>(
          builder: (_) => StatementScreen(app: app, party: party),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('كشف حساب عميل الحساب السابق'), findsOneWidget);
    expect(find.textContaining('987.65'), findsWidgets);

    app.store = null;
    app.notifyListeners();
    await tester.pumpAndSettle();
    expect(find.text('إعداد الحساب والجهاز'), findsOneWidget);
    expect(find.text('كشف حساب عميل الحساب السابق'), findsNothing);
    expect(find.textContaining('987.65'), findsNothing);
    expect(previousNavigator.mounted, isFalse);
    expect(
      tester.state<NavigatorState>(find.byType(Navigator)).canPop(),
      isFalse,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  group('Real SQLite backed entry forms', () {
    late Directory directory;
    late LedgerStore db;
    late FormController app;
    Future<void> setup(WidgetTester tester, {bool manager = true}) async {
      await tester.runAsync(() async {
        directory = await Directory.systemTemp.createTemp('strawberry_widget_');
        app = FormController(managerRole: manager);
        db = await LedgerStore.open(
          path: '${directory.path}/ledger.db',
          tenantId: app.tenantId,
          userId: app.uid,
          role: manager ? 'manager' : 'employee',
          employeeId: manager ? null : app.employeeId,
          factory: databaseFactoryFfi,
        );
        app.store = db;
      });
      tester.view.physicalSize = const Size(420, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(() async {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
        await db.close();
        app.store = null;
        app.dispose();
        await directory.delete(recursive: true);
      });
    }

    testWidgets(
      'Reports reject a reversed date range without exposing metrics or exporting',
      (tester) async {
        await setup(tester);
        await tester.pumpWidget(
          formHost(Scaffold(body: ReportsScreen(app: app))),
        );
        await drain(tester);
        Finder dateField(String label) => find.byWidgetPredicate(
          (w) => w is TextField && w.decoration?.labelText == label,
        );
        await tester.enterText(dateField('من تاريخ'), '2026-03-01');
        await tester.enterText(dateField('إلى تاريخ'), '2026-02-28');
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(
          find.text(
            'يجب أن يكون تاريخ النهاية بعد تاريخ البداية أو مساوياً له',
          ),
          findsOneWidget,
        );
        expect(find.text('مؤشرات الفترة'), findsNothing);
        expect(find.text('الميزانيات الشهرية'), findsNothing);
        expect(
          tester
              .widget<FilledButton>(
                find.ancestor(
                  of: find.text('مشاركة تقرير عربي'),
                  matching: find.byType(FilledButton),
                ),
              )
              .onPressed,
          isNull,
        );
        expect(
          tester
              .widget<OutlinedButton>(
                find.ancestor(
                  of: find.text('تصدير جدول العمليات'),
                  matching: find.byType(OutlinedButton),
                ),
              )
              .onPressed,
          isNull,
        );
        await tester.enterText(dateField('إلى تاريخ'), '2026-03-31');
        await drain(tester);
        expect(tester.takeException(), isNull);
        expect(find.text('مؤشرات الفترة'), findsOneWidget);
        await tester.runAsync(() async {
          await db.saveEntry(
            LedgerEntry(
              id: 'synced_expense',
              tenantId: app.tenantId,
              creatorUid: app.uid,
              kind: 'expense_business',
              date: '2026-03-15',
              totalMinor: 5000,
              paidMinor: 5000,
              category: 'نقل',
            ),
          );
          app.entries = await db.listEntries();
        });
        app.notifyListeners();
        await tester.pump();
        expect(
          find.descendant(
            of: find.ancestor(
              of: find.text('مصروفات التشغيل والرواتب'),
              matching: find.byType(Card),
            ),
            matching: find.text('50.00 ج.م'),
          ),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );

    testWidgets(
      'Statement period keeps prior invoice balance and blocks reversed-range sharing',
      (tester) async {
        await setup(tester);
        final party = Party(
          id: 'period_customer',
          tenantId: app.tenantId,
          name: 'عميل رصيد الفترة',
          kind: 'merchant',
          openingMinor: 5000,
        );
        await tester.runAsync(() async {
          await db.saveParty(party);
          await db.saveEntry(
            LedgerEntry(
              id: 'prior_invoice',
              tenantId: app.tenantId,
              creatorUid: app.uid,
              kind: 'sale',
              date: '2026-01-15',
              partyId: party.id,
              partyName: party.name,
              qtyMilli: 1000,
              priceMinor: 20000,
              totalMinor: 20000,
              paidMinor: 5000,
              grade: 'فراولة',
              unit: 'كيلو',
            ),
          );
          app.entries = await db.listEntries();
        });
        await tester.pumpWidget(
          formHost(StatementScreen(app: app, party: party)),
        );
        await tester.pumpAndSettle();
        await tester.enterText(field('من تاريخ'), '2026-02-01');
        await tester.enterText(field('إلى تاريخ'), '2026-02-28');
        await tester.pump();
        expect(find.text('رصيد أول الفترة: 200.00 ج.م'), findsOneWidget);
        expect(
          find.text('الرصيد حتى نهاية الفترة: 200.00 ج.م'),
          findsOneWidget,
        );
        expect(find.text('لا توجد حركة في الفترة المختارة'), findsOneWidget);
        await tester.runAsync(() async {
          await db.saveEntry(
            LedgerEntry(
              id: 'synced_collection',
              tenantId: app.tenantId,
              creatorUid: app.uid,
              kind: 'merchant_payment',
              date: '2026-02-10',
              partyId: party.id,
              partyName: party.name,
              totalMinor: 2000,
              paidMinor: 2000,
            ),
          );
          app.entries = await db.listEntries();
        });
        app.notifyListeners();
        await tester.pump();
        expect(find.text('رصيد أول الفترة: 200.00 ج.م'), findsOneWidget);
        expect(
          find.text('الرصيد حتى نهاية الفترة: 180.00 ج.م'),
          findsOneWidget,
        );
        expect(find.text('لا توجد حركة في الفترة المختارة'), findsNothing);
        await tester.enterText(field('من تاريخ'), '2026-03-01');
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(
          find.text(
            'يجب أن يكون تاريخ النهاية بعد تاريخ البداية أو مساوياً له',
          ),
          findsOneWidget,
        );
        expect(find.text('رصيد أول الفترة: 200.00 ج.م'), findsNothing);
        expect(
          tester
              .widget<FilledButton>(
                find.ancestor(
                  of: find.text('مشاركة كشف حساب عربي'),
                  matching: find.byType(FilledButton),
                ),
              )
              .onPressed,
          isNull,
        );
        expect(
          tester
              .widget<OutlinedButton>(
                find.ancestor(
                  of: find.text('نسخ كشف الحساب للمشاركة'),
                  matching: find.byType(OutlinedButton),
                ),
              )
              .onPressed,
          isNull,
        );
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );

    testWidgets(
      'Shipment editor keeps invoice immutable and orders repeated same-day updates',
      (tester) async {
        await setup(tester);
        final party = Party(
          id: 'shipment_party',
          tenantId: app.tenantId,
          name: 'عميل الشحنة',
          kind: 'merchant',
        );
        final invoice = LedgerEntry(
          id: 'shipment_invoice',
          tenantId: app.tenantId,
          creatorUid: app.uid,
          kind: 'sale',
          date: '2026-10-01',
          partyId: party.id,
          partyName: party.name,
          qtyMilli: 1000,
          priceMinor: 10000,
          totalMinor: 10000,
          paidMinor: 2500,
          grade: 'فراولة',
          unit: 'كيلو',
        );
        await tester.runAsync(() async {
          await db.saveParty(party);
          await db.saveEntry(invoice);
          app.entries = await db.listEntries();
        });
        await tester.pumpWidget(
          formHost(ShipmentEditor(app: app, invoice: invoice)),
        );
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('حفظ تحديث الشحنة محلياً'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('حفظ تحديث الشحنة محلياً'));
        await tester.pump();
        expect(find.text('أدخل سبب تحديث الشحنة'), findsOneWidget);
        expect(app.saveCalls, 0);
        for (final note in ['استلام السائق', 'تأكيد حالة الشحنة']) {
          await tester.enterText(field('سبب التحديث أو مستند التسليم'), note);
          await tester.ensureVisible(find.text('حفظ تحديث الشحنة محلياً'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('حفظ تحديث الشحنة محلياً'));
          await drain(tester);
        }
        await tester.runAsync(() async {
          final facts = await db.listEntries();
          expect(
            facts.singleWhere((e) => e.id == invoice.id).toJson(),
            invoice.toJson(),
          );
          final metadata =
              facts.where((e) => e.kind == 'shipment_update').toList()
                ..sort((a, b) => a.shipmentOrder.compareTo(b.shipmentOrder));
          expect(metadata.map((e) => e.shipmentOrder), [1, 2]);
          expect(metadata.map((e) => e.date).toSet().length, 1);
          expect(
            LedgerRules.latestShipment(invoice, facts).id,
            metadata.last.id,
          );
          expect(
            metadata.every((e) => e.totalMinor == 0 && e.paidMinor == 0),
            isTrue,
          );
          expect(
            (await db.listOutbox()).where((o) => o.entity == 'entry').length,
            3,
          );
        });
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );
    testWidgets(
      'Arabic numeric validation prevents NaN and negative amounts with no write',
      (tester) async {
        await setup(tester);
        await tester.pumpWidget(
          formHost(EntryForm(app: app, kind: 'expense_business')),
        );
        await tester.pumpAndSettle();
        final amount = field('المبلغ بالجنيه');
        await tester.enterText(amount, 'NaN');
        await tester.ensureVisible(find.text('حفظ في السجل المحلي'));
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await tester.pump();
        expect(find.text('أدخل رقماً موجباً صالحاً'), findsOneWidget);
        expect(app.saveCalls, 0);
        await tester.enterText(amount, '-١');
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await tester.pump();
        expect(app.saveCalls, 0);
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );
    testWidgets(
      'Failed durable save retains input and draft and never announces success',
      (tester) async {
        await setup(tester);
        app.failSave = true;
        await tester.pumpWidget(
          formHost(EntryForm(app: app, kind: 'expense_business')),
        );
        await tester.pumpAndSettle();
        final amount = field('المبلغ بالجنيه');
        await tester.enterText(amount, '١٢٣٫٤٥');
        await tester.ensureVisible(find.text('حفظ في السجل المحلي'));
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await drain(tester);
        expect(
          find.text('تعذر الحفظ في الجهاز؛ لم تُسجّل العملية'),
          findsOneWidget,
        );
        expect(tester.widget<TextFormField>(amount).controller!.text, '١٢٣٫٤٥');
        expect(find.textContaining('حُفظت العملية محلياً'), findsNothing);
        await tester.runAsync(() async {
          expect(await db.listEntries(), isEmpty);
          expect((await db.listDrafts()).single['amountText'], '١٢٣٫٤٥');
        });
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );
    testWidgets(
      'Repeated taps commit one operation and save-another clears amounts with a fresh ID',
      (tester) async {
        await setup(tester);
        app.saveGate = Completer<void>();
        await tester.pumpWidget(
          formHost(EntryForm(app: app, kind: 'expense_business')),
        );
        await tester.pumpAndSettle();
        await tester.enterText(field('المبلغ بالجنيه'), '١٢٫٣٤');
        await tester.ensureVisible(find.text('حفظ وإضافة عملية أخرى'));
        await tester.tap(find.text('حفظ وإضافة عملية أخرى'));
        await tester.pump();
        await tester.ensureVisible(find.text('حفظ في السجل المحلي'));
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await tester.pump();
        final button = tester.widget<FilledButton>(
          find.ancestor(
            of: find.text('جارٍ الحفظ في الجهاز'),
            matching: find.byType(FilledButton),
          ),
        );
        expect(button.onPressed, isNull);
        expect(app.saveCalls, 1);
        await tester.tap(find.text('جارٍ الحفظ في الجهاز'));
        await tester.pump();
        expect(app.saveCalls, 1);
        app.saveGate!.complete();
        await drain(tester, cycles: 25);
        expect(find.textContaining('حُفظت العملية محلياً'), findsOneWidget);
        expect(
          tester
              .widget<TextFormField>(field('المبلغ بالجنيه'))
              .controller!
              .text,
          isEmpty,
        );
        await tester.runAsync(() async {
          final entries = await db.listEntries();
          expect(entries.length, 1);
          expect(entries.single.totalMinor, 1234);
          expect(
            (await db.listOutbox()).where((q) => q.entity == 'entry').length,
            1,
          );
        });
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );
    testWidgets(
      'Direct form access still enforces entitlement and employee delivery omits financial fields',
      (tester) async {
        await setup(tester, manager: false);
        app.permission = false;
        await tester.pumpWidget(
          formHost(EntryForm(app: app, kind: 'expense_business')),
        );
        await tester.pumpAndSettle();
        await tester.enterText(field('المبلغ بالجنيه'), '١٠');
        await tester.ensureVisible(find.text('حفظ في السجل المحلي'));
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await drain(tester);
        expect(
          find.text('انتهت صلاحية التشغيل؛ فعّل المنشأة أولاً'),
          findsOneWidget,
        );
        expect(app.saveCalls, 0);
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
        await tester.pumpWidget(
          formHost(EntryForm(app: app, kind: 'delivery')),
        );
        await tester.pumpAndSettle();
        expect(field('سعر الوحدة بالجنيه'), findsNothing);
        expect(field('المدفوع بالجنيه'), findsNothing);
        expect(
          find.text('التسجيل محلي أولاً · طلب لاعتماد المدير'),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );
    testWidgets(
      'Employee return without original invoice and purchase unit price review flow',
      (tester) async {
        await setup(tester, manager: false);
        const merchant = Party(
          id: 'cust_return',
          tenantId: 'widget_tenant',
          name: 'عميل المرتجع',
          kind: 'merchant',
          openingMinor: 0,
        );
        const supplier = Party(
          id: 'supp_purchase',
          tenantId: 'widget_tenant',
          name: 'مورد الفراولة',
          kind: 'supplier',
          openingMinor: 0,
        );
        await tester.runAsync(() async {
          await db.applyRemote('party', merchant.toJson());
          await db.applyRemote('party', supplier.toJson());
          app.parties = await db.listParties();
        });
        // 1. Employee opens sale_return: no originalId field required
        await tester.pumpWidget(
          formHost(
            EntryForm(
              app: app,
              kind: 'sale_return',
              draft: {
                'id': 'ret_sub_1',
                'kind': 'sale_return',
                'partyId': merchant.id,
                'date': '2026-10-28',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('مرجع الفاتورة الأصلية من المدير'), findsNothing);
        await tester.enterText(field('الكمية (حتى ٣ منازل عشرية)'), '10');
        await tester.ensureVisible(find.text('حفظ في السجل المحلي'));
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await drain(tester);
        expect(app.submissions.any((s) => s['id'] == 'ret_sub_1'), isTrue);
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);

        // 2. Employee opens purchase_delivery: unit price field is shown
        await tester.pumpWidget(
          formHost(
            EntryForm(
              app: app,
              kind: 'purchase_delivery',
              draft: {
                'id': 'pur_sub_1',
                'kind': 'purchase_delivery',
                'partyId': supplier.id,
                'date': '2026-10-28',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(field('سعر الوحدة بالجنيه'), findsOneWidget);
        await tester.enterText(field('الكمية (حتى ٣ منازل عشرية)'), '20');
        await tester.enterText(field('سعر الوحدة بالجنيه'), '15');
        await tester.ensureVisible(find.text('حفظ في السجل المحلي'));
        await tester.tap(find.text('حفظ في السجل المحلي'));
        await drain(tester);
        final purSub = app.submissions.singleWhere(
          (s) => s['id'] == 'pur_sub_1',
        );
        expect(purSub['amountMinor'], 1500);
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);

        // 3. Manager modified price appears in employee's SubmissionScreen
        await tester.runAsync(() async {
          await db.applyRemote('submission', {
            ...purSub..remove('state')..remove('review'),
            'status': 'approved',
            'approvedUnitMinor': 1800,
          });
          app.submissions = await db.listSubmissions();
        });
        await tester.pumpWidget(
          formHost(Scaffold(body: SubmissionScreen(app: app))),
        );
        await tester.pumpAndSettle();
        expect(
          find.textContaining(
            'سعر الموظف: 15.00 ج.م · السعر المعتمد من المدير: 18.00 ج.م',
          ),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await drain(tester, cycles: 2);
      },
    );
  });
}
