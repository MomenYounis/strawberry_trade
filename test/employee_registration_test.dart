import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/domain/ledger.dart';
import 'package:strawberry_trade/services/employee_registration.dart';
import 'package:strawberry_trade/services/invitation_code.dart';

class RegistrationAuth implements EmployeeRegistrationAuth {
  int creates = 0, signIns = 0, deliveries = 0, reloads = 0;
  bool verified = false;
  Object? createError, deliveryError;
  String accountUid = 'staff_1';
  EmployeeAccount snapshot() => EmployeeAccount(
    uid: accountUid,
    email: 'staff@example.test',
    emailVerified: verified,
  );
  @override
  Future<EmployeeAccount> createAccount(String email, String password) async {
    creates++;
    if (createError != null) throw createError!;
    return snapshot();
  }

  @override
  Future<EmployeeAccount> signIn(String email, String password) async {
    signIns++;
    return snapshot();
  }

  @override
  Future<EmployeeAccount> reloadAccount(String expectedUid) async {
    reloads++;
    return snapshot();
  }

  @override
  Future<void> sendVerification(String expectedUid) async {
    deliveries++;
    if (deliveryError != null) throw deliveryError!;
  }
}

String invitationFor(String tenant) =>
    'v2.${base64UrlEncode(utf8.encode(tenant)).replaceAll('=', '')}.${'A' * 43}';

void main() {
  test('v2 invitation derives only its canonical bounded tenant route', () {
    for (final tenant in ['a', 'farm_1', 'Farm--_9', 'A' * 120]) {
      final parsed = EmployeeInvitationCode.parse(
        '  ${invitationFor(tenant)}\n',
      );
      expect(parsed.token, invitationFor(tenant));
      expect(parsed.tenantId, tenant);
      expect(parsed.legacy, false);
    }
    final encoded = base64UrlEncode(utf8.encode('a')).replaceAll('=', '');
    for (final token in [
      '',
      'A' * 241,
      'v3.$encoded.${'A' * 43}',
      'v2..${'A' * 43}',
      'v2.$encoded=.${'A' * 43}',
      'v2.YR.${'A' * 43}', // Noncanonical unused bits for "a".
      'v2._w.${'A' * 43}', // Invalid UTF-8.
      invitationFor('../farm'),
      invitationFor('a/b'),
      invitationFor('a b'),
      invitationFor('منشأة'),
      invitationFor('A' * 121),
      'v2.$encoded.${'A' * 42}',
      'v2.$encoded.${'A' * 44}',
      '${invitationFor('farm_1')}.extra',
      invitationFor('farm_1').replaceFirst('v2.', 'v2. '),
    ]) {
      expect(
        () => EmployeeInvitationCode.parse(token),
        throwsA(isA<LedgerException>()),
        reason: token,
      );
    }
  });

  test('legacy invitation requires an explicit valid tenant', () {
    final token = 'B' * 43;
    expect(
      () => EmployeeInvitationCode.parse(token),
      throwsA(isA<LedgerException>()),
    );
    final parsed = EmployeeInvitationCode.parse(
      token,
      legacyTenantId: 'farm_1',
    );
    expect(parsed.tenantId, 'farm_1');
    expect(parsed.legacy, true);
    expect(
      () => EmployeeInvitationCode.parse(token, legacyTenantId: '../farm'),
      throwsA(isA<LedgerException>()),
    );
  });

  test('verification delivery failure retains created account and retries only delivery', () async {
    final auth = RegistrationAuth()
      ..deliveryError = StateError('delivery_unavailable');
    final flow = EmployeeRegistration(auth);
    await flow.begin(
      email: 'staff@example.test',
      password: 'a-password',
      create: true,
    );
    expect(flow.account?.uid, 'staff_1');
    expect(flow.verificationDeliveryError, isNotNull);
    expect(auth.creates, 1);
    expect(auth.signIns, 0);
    expect(await flow.refreshVerified(), false);
    expect(auth.reloads, 1);
    auth.deliveryError = null;
    await flow.resend();
    expect(flow.verificationDeliveryError, isNull);
    expect(auth.deliveries, 2);
    expect(auth.creates, 1);
    expect(
      () => flow.begin(
        email: 'staff@example.test',
        password: 'a-password',
        create: true,
      ),
      throwsA(isA<LedgerException>()),
    );
    auth.verified = true;
    expect(await flow.refreshVerified(), true);
  });

  test(
    'existing verified account signs in without a second create or mail',
    () async {
      final auth = RegistrationAuth()..verified = true;
      final flow = EmployeeRegistration(auth);
      await flow.begin(
        email: 'staff@example.test',
        password: 'old-password',
        create: false,
      );
      expect(auth.creates, 0);
      expect(auth.signIns, 1);
      expect(auth.deliveries, 0);
      expect(await flow.refreshVerified(), true);
      auth.accountUid = 'different_staff';
      expect(() => flow.refreshVerified(), throwsA(isA<LedgerException>()));
    },
  );

  test('failed creation never silently falls back to signing in or changes password', () async {
    final auth = RegistrationAuth()
      ..createError = StateError('email_already_exists');
    final flow = EmployeeRegistration(auth);
    await expectLater(
      flow.begin(
        email: 'staff@example.test',
        password: 'new-password',
        create: true,
      ),
      throwsStateError,
    );
    expect(flow.account, isNull);
    expect(auth.creates, 1);
    expect(auth.signIns, 0);
    expect(auth.deliveries, 0);
  });
}
