import 'dart:convert';

import '../domain/ledger.dart';

/// The tenant carried in a v2 code is a routing hint, never an authorization
/// claim. Only the trusted server can accept the hashed, unused invitation.
class EmployeeInvitationCode {
  const EmployeeInvitationCode._(this.token, this.tenantId, this.legacy);
  final String token;
  final String tenantId;
  final bool legacy;

  static EmployeeInvitationCode parse(String input, {String? legacyTenantId}) {
    final token = input.trim();
    if (token.isEmpty || token.length > 240) _invalid();
    if (RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(token)) {
      final tenant = legacyTenantId?.trim() ?? '';
      if (!RegExp(r'^[A-Za-z0-9_-]{1,120}$').hasMatch(tenant)) {
        invalid(
          'invitation_legacy_tenant',
          'هذه دعوة قديمة؛ استخدم تسجيل الدخول المعتاد مع معرّف المنشأة أو اطلب كود دعوة جديداً من المدير',
        );
      }
      return EmployeeInvitationCode._(token, tenant, true);
    }
    final parts = token.split('.');
    if (parts.length != 3 ||
        parts[0] != 'v2' ||
        !RegExp(r'^[A-Za-z0-9_-]{2,160}$').hasMatch(parts[1]) ||
        !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(parts[2])) {
      _invalid();
    }
    String tenant;
    try {
      tenant = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
      final random = base64Url.decode(base64Url.normalize(parts[2]));
      if (random.length != 32 ||
          base64UrlEncode(random).replaceAll('=', '') != parts[2]) {
        _invalid();
      }
    } on FormatException {
      _invalid();
    }
    if (!RegExp(r'^[A-Za-z0-9_-]{1,120}$').hasMatch(tenant) ||
        base64UrlEncode(utf8.encode(tenant)).replaceAll('=', '') != parts[1]) {
      _invalid();
    }
    return EmployeeInvitationCode._(token, tenant, false);
  }

  static Never _invalid() => invalid(
    'invitation_invalid',
    'كود الدعوة غير صالح؛ انسخه كاملاً من المدير',
  );
}
