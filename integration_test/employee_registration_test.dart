import 'dart:convert';
import 'dart:io';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:strawberry_trade/application/app_controller.dart';
import 'package:strawberry_trade/security/device_security.dart';
import 'package:strawberry_trade/services/employee_registration.dart';
import 'package:strawberry_trade/services/gateway.dart';
import 'package:strawberry_trade/services/invitation_code.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Native employee signup verifies email and claims manager invitation',
    (tester) async {
      expect(Platform.isAndroid, isTrue);
      expect(FirebaseGateway.emulator, isTrue);
      expect(FirebaseGateway.endpoint.baseUrl, 'http://10.0.2.2:18787');
      final client = HttpClient();
      addTearDown(client.close);
      Future<Map<String, dynamic>> readJson(
        String url, {
        bool post = false,
      }) async {
        final request = post
            ? await client.postUrl(Uri.parse(url))
            : await client.getUrl(Uri.parse(url));
        final response = await request.close();
        expect(response.statusCode, 200);
        return Map<String, dynamic>.from(
          jsonDecode(await utf8.decoder.bind(response).join()) as Map,
        );
      }

      final fixture = await readJson(
        'http://10.0.2.2:18787/employee-fixture',
        post: true,
      );
      expect(fixture['projectId'], 'demo-strawberry-flutter');
      final token = fixture['invitationToken'] as String;
      final parsed = EmployeeInvitationCode.parse(token);
      expect(parsed.tenantId, fixture['tenantId']);
      const security = DeviceSecurity();
      final gateway = FirebaseGateway(security);
      final registration = EmployeeRegistration(gateway);
      await registration.begin(
        email: fixture['email'] as String,
        password: fixture['password'] as String,
        create: true,
      );
      expect(registration.verificationDeliveryError, isNull);
      expect(registration.account!.emailVerified, isFalse);
      final employeeUid = registration.account!.uid;
      expect(await registration.refreshVerified(), isFalse);

      // Auth Emulator captures local synthetic verification messages. No inbox,
      // real email delivery, production user or administrator credential is used.
      final messages = await readJson(
        'http://10.0.2.2:9099/emulator/v1/projects/demo-strawberry-flutter/oobCodes',
      );
      final verification = (messages['oobCodes'] as List)
          .cast<Map>()
          .singleWhere(
            (entry) =>
                entry['email'] == fixture['email'] &&
                entry['requestType'] == 'VERIFY_EMAIL',
          );
      await FirebaseAuth.instance.applyActionCode(
        verification['oobCode'] as String,
      );
      expect(await registration.refreshVerified(), isTrue);
      expect(registration.account!.uid, employeeUid);

      final app = AppController(security: security, gateway: gateway);
      app.identity = await security.installationIdentity();
      app.loading = false;
      addTearDown(app.dispose);
      await app.connectEmployeeInvitation(
        invitationToken: token,
        expectedUid: employeeUid,
      );
      expect(app.ready, isTrue);
      expect(app.allowed, isTrue);
      expect(app.manager, isFalse);
      expect(app.uid, employeeUid);
      expect(app.tenantId, fixture['tenantId']);
      expect(app.employeeId, fixture['employeeId']);
      expect(app.business, fixture['businessName']);
      expect(app.store, isNotNull);
      // A lost first response must allow the same verified installation to retry.
      await gateway.acceptInvitation(parsed.tenantId, token, app.identity!);
      for (var attempt = 0; app.syncing && attempt < 100; attempt++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(app.syncing, isFalse);
      // ignore: avoid_print
      print('NATIVE_EMPLOYEE_SIGNUP_VERIFIED_AND_ENROLLED');
    },
  );
}
