import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/presentation/enrollment.dart';
import 'package:strawberry_trade/presentation/screens.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/services/employee_registration.dart';
import 'package:strawberry_trade/services/gateway.dart';

final code =
    'v2.${base64UrlEncode(utf8.encode('farm_1')).replaceAll('=', '')}.${'A' * 43}';

class OnboardingAuth implements EmployeeRegistrationAuth {
  int creates = 0, signIns = 0, deliveries = 0;
  bool verified = false, failDelivery = false;
  EmployeeAccount snapshot() => EmployeeAccount(
    uid: 'staff_1',
    email: 'staff@example.test',
    emailVerified: verified,
  );
  @override
  Future<EmployeeAccount> createAccount(String email, String password) async {
    creates++;
    return snapshot();
  }

  @override
  Future<EmployeeAccount> signIn(String email, String password) async {
    signIns++;
    return snapshot();
  }

  @override
  Future<EmployeeAccount> reloadAccount(String expectedUid) async => snapshot();
  @override
  Future<void> sendVerification(String expectedUid) async {
    deliveries++;
    if (failDelivery) throw StateError('delivery_unavailable');
  }
}

class EnrollmentGateway extends FirebaseGateway {
  EnrollmentGateway() : super(const DeviceSecurity());
  String? invitedEmployee, invitedUid, changedEmployee, changedUid;
  bool? changedActive;
  @override
  Future<Map<String, dynamic>> createEmployeeInvitation(
    String tenantId,
    String deviceId, {
    required String employeeId,
    String? uid,
  }) async {
    invitedEmployee = employeeId;
    invitedUid = uid;
    return {'invitationToken': code, 'expiresAtMs': 1800000000000};
  }

  @override
  Future<void> setMemberActive(
    String tenantId,
    String deviceId, {
    String? uid,
    String? employeeId,
    required bool active,
  }) async {
    changedEmployee = employeeId;
    changedUid = uid;
    changedActive = active;
  }
}

class OnboardingController extends AppController {
  OnboardingController({this.managerRole = false, EnrollmentGateway? remote})
    : super(gateway: remote, verifier: LicenseVerifier({})) {
    loading = false;
    tenantId = 'farm_1';
    business = 'تجارة الفراولة';
    identity = const InstallationIdentity(
      deviceId: 'device_1',
      publicKeySpki: 'test_only',
    );
  }
  final bool managerRole;
  int connections = 0;
  String? connectedCode, connectedUid;
  @override
  bool get manager => managerRole;
  @override
  bool get allowed => managerRole;
  @override
  Future<void> requireAllowed() async {}
  @override
  Future<void> synchronize() async {}
  @override
  Future<void> connectEmployeeInvitation({
    required String invitationToken,
    required String expectedUid,
  }) async {
    connections++;
    connectedCode = invitationToken;
    connectedUid = expectedUid;
  }
}

Widget host(Widget child) => MaterialApp(
  locale: const Locale('ar'),
  supportedLocales: const [Locale('ar')],
  localizationsDelegates: GlobalMaterialLocalizations.delegates,
  home: child,
);
Finder field(String label) => find.ancestor(
  of: find.byWidgetPredicate(
    (widget) => widget is TextField && widget.decoration?.labelText == label,
  ),
  matching: find.byType(TextFormField),
);

Future<void> tapVisible(WidgetTester tester, String label) async {
  final target = find.text(label).last;
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

Future<void> employeeMode(WidgetTester tester, String label) async {
  await tapVisible(tester, 'تسجيل الدخول المعتاد');
  await tapVisible(tester, label);
}

Future<void> fillEmployee(WidgetTester tester, {bool create = true}) async {
  await tester.enterText(field('البريد الإلكتروني'), 'staff@example.test');
  if (create) {
    await tester.enterText(
      field('تأكيد البريد الإلكتروني'),
      'staff@example.test',
    );
  }
  await tester.enterText(field('كلمة المرور'), 'employee-password');
  await tester.enterText(field('كود دعوة المدير'), code);
}

void main() {
  testWidgets('new employee confirms email before any invitation acceptance', (
    tester,
  ) async {
    final auth = OnboardingAuth();
    final app = OnboardingController();
    await tester.pumpWidget(
      host(SetupScreen(app: app, registrationAuth: auth)),
    );
    await employeeMode(tester, 'إنشاء حساب موظف');
    expect(field('معرّف المنشأة'), findsNothing);
    await fillEmployee(tester);
    await tester.enterText(
      field('تأكيد البريد الإلكتروني'),
      'wrong@example.test',
    );
    await tapVisible(tester, 'إنشاء الحساب وإرسال التأكيد');
    expect(auth.creates, 0);
    expect(find.text('اكتب نفس البريد مرة أخرى لتأكيده'), findsOneWidget);
    await tester.enterText(
      field('تأكيد البريد الإلكتروني'),
      'staff@example.test',
    );
    await tapVisible(tester, 'إنشاء الحساب وإرسال التأكيد');
    expect(auth.creates, 1);
    expect(auth.deliveries, 1);
    expect(app.connections, 0);
    expect(find.text('الحساب جاهز: staff@example.test'), findsOneWidget);
    expect(field('كلمة المرور'), findsNothing);
    await tapVisible(tester, 'أكدت بريدي، متابعة');
    expect(app.connections, 0);
    expect(find.textContaining('البريد لم يتأكد بعد'), findsOneWidget);
    await tapVisible(tester, 'إعادة إرسال رسالة التأكيد');
    expect(auth.creates, 1);
    expect(auth.deliveries, 2);
    auth.verified = true;
    await tapVisible(tester, 'أكدت بريدي، متابعة');
    expect(app.connections, 1);
    expect(app.connectedCode, code);
    expect(app.connectedUid, 'staff_1');
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  });

  testWidgets(
    'delivery failure clearly preserves account and resend does not recreate it',
    (tester) async {
      final auth = OnboardingAuth()..failDelivery = true;
      final app = OnboardingController();
      await tester.pumpWidget(
        host(SetupScreen(app: app, registrationAuth: auth)),
      );
      await employeeMode(tester, 'إنشاء حساب موظف');
      await fillEmployee(tester);
      await tapVisible(tester, 'إنشاء الحساب وإرسال التأكيد');
      expect(
        find.textContaining('الحساب موجود ويمكنك الدخول به'),
        findsOneWidget,
      );
      expect(auth.creates, 1);
      expect(app.connections, 0);
      auth.failDelivery = false;
      await tapVisible(tester, 'إعادة إرسال رسالة التأكيد');
      expect(auth.creates, 1);
      expect(auth.deliveries, 2);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    },
  );

  testWidgets(
    'existing verified employee reuses account and invitation after reopening',
    (tester) async {
      final auth = OnboardingAuth()..verified = true;
      final app = OnboardingController();
      await tester.pumpWidget(
        host(SetupScreen(app: app, registrationAuth: auth)),
      );
      await employeeMode(tester, 'لدي حساب ومعي دعوة');
      await fillEmployee(tester, create: false);
      await tapVisible(tester, 'تسجيل الدخول بالدعوة');
      expect(auth.creates, 0);
      expect(auth.signIns, 1);
      expect(auth.deliveries, 0);
      expect(app.connections, 1);
      expect(app.connectedCode, code);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    },
  );

  testWidgets(
    'manager creates code and stops linked employee without entering any UID',
    (tester) async {
      final remote = EnrollmentGateway();
      final app = OnboardingController(managerRole: true, remote: remote);
      await tester.pumpWidget(
        host(
          Scaffold(
            body: EmployeeEnrollmentActions(
              app: app,
              employee: const Employee(
                id: 'employee_1',
                tenantId: 'farm_1',
                name: 'أحمد',
              ),
            ),
          ),
        ),
      );
      await tapVisible(tester, 'إنشاء كود دعوة الموظف');
      expect(field('معرّف حساب الموظف'), findsNothing);
      await tapVisible(tester, 'إنشاء الدعوة');
      expect(remote.invitedEmployee, 'employee_1');
      expect(remote.invitedUid, isNull);
      expect(find.text(code), findsOneWidget);
      await tapVisible(tester, 'تم');
      await tapVisible(tester, 'تفعيل أو إيقاف الحساب');
      expect(field('معرّف حساب الموظف'), findsNothing);
      await tapVisible(tester, 'حفظ القرار');
      expect(remote.changedEmployee, 'employee_1');
      expect(remote.changedUid, isNull);
      expect(remote.changedActive, false);
      await tester.pumpWidget(const SizedBox.shrink());
      app.dispose();
    },
  );
}
