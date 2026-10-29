import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/services/gateway.dart';

void main() {
  test(
    'employee account errors explain the enrollment state to its manager',
    () {
      String message(String reason) => arabicError(
        FirebaseFunctionsException(
          code: 'failed-precondition',
          message: reason,
          details: {'reason': reason},
        ),
      );
      expect(
        message('employee-account-already-linked'),
        contains('حساب مرتبط بالفعل'),
      );
      expect(
        message('employee-account-already-linked'),
        contains('إيقاف حسابه'),
      );
      expect(
        message('employee-account-not-linked'),
        contains('لم يسجل حسابه بعد'),
      );
      expect(message('employee-account-not-linked'), contains('كود دعوة'));
      expect(message('missing-employee'), contains('لم يصل سجل الموظف'));
      expect(
        message('employee-invitation-unavailable'),
        contains('الموظف غير نشط'),
      );
      expect(
        message('device-session-expired'),
        contains('انتهت جلسة الاتصال المؤقتة'),
      );
      expect(message('unknown-reason'), contains('تعذر قبول العملية'));
    },
  );
  test('Invitation device proof matches canonical server contract and binds every enrollment scope', () {
    String proof({
      String tenant = 'farm_1',
      String uid = 'staff_1',
      String device = 'device_1',
      String token = 'token_1',
    }) => FirebaseGateway.invitationChallenge(
      tenantId: tenant,
      uid: uid,
      deviceId: device,
      invitationToken: token,
    );
    expect(
      proof(),
      '{"deviceId":"device_1","domain":"strawberry-accept-invitation-v1","invitationToken":"token_1","tenantId":"farm_1","uid":"staff_1"}',
    );
    for (final changed in [
      proof(tenant: 'farm_2'),
      proof(uid: 'staff_2'),
      proof(device: 'device_2'),
      proof(token: 'token_2'),
    ]) {
      expect(changed, isNot(proof()));
    }
  });
}
