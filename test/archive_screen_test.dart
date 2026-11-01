import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/presentation/archive_screen.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/security/licensing.dart';
import 'package:strawberry_trade/services/archive_reader.dart';
import 'package:strawberry_trade/services/gateway.dart';

class HistoryGateway implements SyncGateway, ArchiveGateway {
  final pending = Completer<Map<String, dynamic>>();
  @override
  Future<Map<String, dynamic>> listArchives(
    String tenantId,
    String deviceId, {
    int? afterYear,
  }) => pending.future;
  @override
  Future<Map<String, dynamic>> readArchiveRecord(
    String tenantId,
    String deviceId, {
    required int year,
    required String recordId,
    int nextChunk = 0,
  }) async => {};
  @override
  Future<Map<String, dynamic>> bootstrap(
    String t,
    InstallationIdentity i,
  ) async => {};
  @override
  Future<void> activateLicense(String t, String d, String p) async {}
  @override
  Future<Map<String, dynamic>> send(
    String t,
    String d,
    Map<String, dynamic> o,
  ) async => {};
  @override
  Future<Map<String, dynamic>> pull(String t, String d, int s) async => {};
}

class HistoryController extends AppController {
  HistoryController(HistoryGateway history)
    : super(gateway: history, verifier: LicenseVerifier({})) {
    tenantId = 'synthetic_tenant';
    uid = 'synthetic_manager';
    identity = const InstallationIdentity(
      deviceId: 'synthetic_device',
      publicKeySpki: 'test',
    );
  }
  bool access = true;
  @override
  bool get manager => access;
  @override
  bool get hasDataAccess => access;
  void revoke() {
    access = false;
    notifyListeners();
  }
}

void main() {
  testWidgets(
    'revocation removes cached archive state and ignores a pending response',
    (tester) async {
      final gateway = HistoryGateway(), app = HistoryController(gateway);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: ArchiveScreen(app: app)),
        ),
      );
      await tester.enterText(find.byType(TextField), 'private_original_id');
      await tester.tap(find.text('تحميل السنوات المؤرشفة'));
      await tester.pump();
      app.revoke();
      await tester.pump();
      expect(find.text('private_original_id'), findsNothing);
      gateway.pending.complete({
        'archives': [
          {'year': 2026},
        ],
        'nextYear': null,
      });
      await tester.pumpAndSettle();
      expect(find.byType(DropdownButtonFormField<int>), findsNothing);
      expect(
        find.text('عرض الأرشيف متاح للمدير المصرح له فقط.'),
        findsOneWidget,
      );
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
