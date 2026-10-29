import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/main.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/services/exports.dart';

/// Run after firebase_gateway_test.dart, with airplane mode enabled, after
/// force-stop/reboot/update. It exercises normal app initialization and storage.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Trusted session and committed pending invoice recover offline', (
    tester,
  ) async {
    expect(Platform.isAndroid, isTrue);
    const security = DeviceSecurity();
    final raw = await security.readSecureValue('integration:offline-ui-proof');
    expect(raw, isNotNull, reason: 'Run the native gateway fixture first');
    final marker = jsonDecode(raw!) as Map<String, dynamic>;
    final app = AppController();
    final watch = Stopwatch()..start();
    await app.initialize();
    expect(app.ready, isTrue, reason: app.error);
    expect(app.allowed, isTrue, reason: app.license?.message);
    expect(app.tenantId, marker['tenantId']);
    expect(app.uid, marker['uid']);
    final committed = app.entries.singleWhere(
      (e) => e.id == marker['operationId'],
    );
    expect(
      (await app.store!.listOutbox()).any((o) => o.id == committed.id),
      isTrue,
    );
    await app.requireAllowed();
    final pdf = await ArabicExports.statement(
      business: app.business,
      title: 'كشف حساب بعد إعادة تشغيل الجهاز دون اتصال',
      entries: app.entries,
    );
    expect(latin1.decode(pdf.sublist(0, 5)), '%PDF-');
    await tester.pumpWidget(
      ProviderScope(
        overrides: [appProvider.overrideWith((ref) => app)],
        child: const StrawberryApp(),
      ),
    );
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('سجلك المحلي جاهز'), findsOneWidget);
    expect(find.text('عملية جديدة'), findsOneWidget);
    expect(find.text('إعداد الحساب والجهاز'), findsNothing);
    // ignore: avoid_print
    print(
      'ANDROID_OFFLINE_RECOVERY_VERIFIED localOpenMs=${watch.elapsedMilliseconds}',
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
