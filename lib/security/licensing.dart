import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'device_security.dart';
import 'trusted_clock.dart';

const trialDurationMs = 30 * 24 * 60 * 60 * 1000;

class LicenseException implements Exception {
  const LicenseException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

/// Canonical, restricted JSON: sorted object keys, safe integer numbers only.
String canonicalJson(Object? value) {
  if (value == null || value is bool || value is String) {
    return jsonEncode(value);
  }
  if (value is int && value.abs() <= 9007199254740991) return value.toString();
  if (value is List) return '[${value.map(canonicalJson).join(',')}]';
  if (value is Map<String, dynamic>) {
    final keys = value.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${canonicalJson(value[key])}').join(',')}}';
  }
  throw const LicenseException('format', 'تنسيق حزمة التفعيل غير صالح.');
}

class TenantLicense {
  const TenantLicense({
    required this.tenantId,
    required this.licenseId,
    required this.epoch,
    required this.issuedAtMs,
    required this.notBeforeMs,
    required this.expiresAtMs,
    required this.trialStartMs,
    required this.trial,
    required this.maxDevices,
  });
  final String tenantId;
  final String licenseId;
  final int epoch;
  final int issuedAtMs;
  final int notBeforeMs;
  final int? expiresAtMs;
  final int? trialStartMs;
  final bool trial;
  final int maxDevices;
}

class MembershipCertificate {
  const MembershipCertificate({
    required this.tenantId,
    required this.uid,
    required this.deviceId,
    required this.role,
    required this.epoch,
    required this.entitlementEpoch,
    required this.issuedAtMs,
    required this.expiresAtMs,
    required this.enabled,
  });
  final String tenantId;
  final String uid;
  final String deviceId;
  final String role;
  final int epoch;
  final int entitlementEpoch;
  final int issuedAtMs;
  final int? expiresAtMs;
  final bool enabled;
}

class VerifiedLicensePackage {
  const VerifiedLicensePackage({
    required this.license,
    required this.membership,
    required this.serialized,
    required this.entitlementPayload,
    required this.membershipPayload,
  });
  final TenantLicense license;
  final MembershipCertificate membership;
  final String serialized;
  final String entitlementPayload;
  final String membershipPayload;
  int get issuedAtMs => license.issuedAtMs > membership.issuedAtMs
      ? license.issuedAtMs
      : membership.issuedAtMs;
}

class LicenseVerifier {
  LicenseVerifier(Map<String, String> trustedPublicKeys)
    : _trustedKeys = Map.unmodifiable(trustedPublicKeys);
  final Map<String, String> _trustedKeys;

  /// No production key is invented or bundled. Missing configuration fails closed.
  factory LicenseVerifier.configured() {
    const configured = String.fromEnvironment(
      'LICENSE_PUBLIC_KEYS',
      defaultValue: '{}',
    );
    final decoded = jsonDecode(configured) as Map<String, dynamic>;
    return LicenseVerifier(
      decoded.map((key, value) => MapEntry(key, value as String)),
    );
  }

  Future<VerifiedLicensePackage> verifyPackage(
    String input, {
    required String tenantId,
    required String uid,
    required String deviceId,
  }) async {
    try {
      if (utf8.encode(input).length > 65536) _invalid();
      final json = _map(jsonDecode(input));
      _keys(json, {'version', 'entitlement', 'membership'});
      if (json['version'] != 1) _invalid();
      final entitlement = await _verifyEnvelope(json['entitlement']);
      final membership = await _verifyEnvelope(json['membership']);
      final l = _parseLicense(entitlement);
      final m = _parseMembership(membership);
      if (l.tenantId != tenantId ||
          m.tenantId != tenantId ||
          m.uid != uid ||
          m.deviceId != deviceId ||
          m.entitlementEpoch != l.epoch) {
        throw const LicenseException(
          'binding',
          'الحزمة لا تخص هذا النشاط أو الحساب أو الجهاز.',
        );
      }
      return VerifiedLicensePackage(
        license: l,
        membership: m,
        serialized: canonicalJson(json),
        entitlementPayload: canonicalJson(entitlement),
        membershipPayload: canonicalJson(membership),
      );
    } on LicenseException {
      rethrow;
    } catch (_) {
      throw const LicenseException(
        'format',
        'تعذر قراءة حزمة التفعيل. تحقق من الملف أو الرمز.',
      );
    }
  }

  Future<Map<String, dynamic>> _verifyEnvelope(Object? value) async {
    final envelope = _map(value);
    _keys(envelope, {'kid', 'payload', 'signature'});
    final kid = _text(envelope, 'kid', 80);
    final key = _trustedKeys[kid];
    if (key == null) {
      throw const LicenseException('issuer', 'جهة توقيع الحزمة غير موثوقة.');
    }
    final bytes = _base64(_text(envelope, 'payload', 50000));
    final signature = _base64(_text(envelope, 'signature', 100));
    final publicKey = _base64(key);
    if (signature.length != 64 || publicKey.length != 32) _invalid();
    final valid = await Ed25519().verify(
      bytes,
      signature: Signature(
        signature,
        publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519),
      ),
    );
    if (!valid) {
      throw const LicenseException('signature', 'توقيع حزمة التفعيل غير صحيح.');
    }
    final decoded = utf8.decode(bytes);
    final map = _map(jsonDecode(decoded));
    if (canonicalJson(map) != decoded) _invalid();
    return map;
  }

  TenantLicense _parseLicense(Map<String, dynamic> m) {
    _keys(m, {
      'type',
      'version',
      'tenantId',
      'licenseId',
      'epoch',
      'issuedAtMs',
      'notBeforeMs',
      'expiresAtMs',
      'trialStartMs',
      'trial',
      'maxDevices',
    });
    if (m['type'] != 'entitlement' ||
        m['version'] != 1 ||
        m['trial'] is! bool) {
      _invalid();
    }
    final start = _nullableTime(m, 'trialStartMs');
    final expiration = _nullableTime(m, 'expiresAtMs');
    final issued = _time(m, 'issuedAtMs');
    final notBefore = _time(m, 'notBeforeMs');
    final trial = m['trial'] as bool;
    if ((expiration != null && expiration <= notBefore) ||
        issued < notBefore ||
        (trial &&
            (start == null ||
                expiration != start + trialDurationMs ||
                notBefore != start)) ||
        (!trial && start != null)) {
      _invalid();
    }
    return TenantLicense(
      tenantId: _text(m, 'tenantId', 128),
      licenseId: _text(m, 'licenseId', 128),
      epoch: _positive(m, 'epoch'),
      issuedAtMs: issued,
      notBeforeMs: notBefore,
      expiresAtMs: expiration,
      trialStartMs: start,
      trial: trial,
      maxDevices: _positive(m, 'maxDevices', max: 1000),
    );
  }

  MembershipCertificate _parseMembership(Map<String, dynamic> m) {
    _keys(m, {
      'type',
      'version',
      'tenantId',
      'uid',
      'deviceId',
      'role',
      'epoch',
      'entitlementEpoch',
      'issuedAtMs',
      'expiresAtMs',
      'enabled',
    });
    if (m['type'] != 'membership' ||
        m['version'] != 1 ||
        m['enabled'] is! bool ||
        !{'manager', 'employee'}.contains(m['role'])) {
      _invalid();
    }
    return MembershipCertificate(
      tenantId: _text(m, 'tenantId', 128),
      uid: _text(m, 'uid', 128),
      deviceId: _text(m, 'deviceId', 128),
      role: m['role'] as String,
      epoch: _positive(m, 'epoch'),
      entitlementEpoch: _positive(m, 'entitlementEpoch'),
      issuedAtMs: _time(m, 'issuedAtMs'),
      expiresAtMs: _nullableTime(m, 'expiresAtMs'),
      enabled: m['enabled'] as bool,
    );
  }
}

class LicenseStatus {
  const LicenseStatus({
    required this.operationalAllowed,
    required this.message,
    this.code = 'setup',
    this.license,
    this.role,
    this.remaining,
    this.wallRollback = false,
  });
  final bool operationalAllowed;
  final String message;
  final String code;
  final TenantLicense? license;
  final String? role;
  final Duration? remaining;
  final bool wallRollback;
}

/// Call check before an operational transaction as well as on foreground/resume.
/// A failed/expired check never deletes the local ledger or outbox.
class LicenseSession {
  LicenseSession({
    required this.security,
    required this.verifier,
    required this.tenantId,
    required this.uid,
    required this.deviceId,
  });
  final DeviceSecurity security;
  final LicenseVerifier verifier;
  final String tenantId;
  final String uid;
  final String deviceId;
  VerifiedLicensePackage? _package;
  TrustedClockCheckpoint? _clock;
  bool _accountDisabled = false;
  String? _pendingTenantActivation;
  String? get pendingTenantActivation => _pendingTenantActivation;
  String get _scope => 'license:${jsonEncode([tenantId, uid, deviceId])}';
  Future<void> _tail = Future<void>.value();

  Future<T> _serialize<T>(Future<T> Function() action) {
    final next = _tail.then((_) => action());
    _tail = next.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return next;
  }

  String? exportPackage() => _package?.serialized;
  VerifiedLicensePackage? get verifiedPackage => _package;

  Future<LicenseStatus> initialize() => _serialize(_initialize);

  Future<LicenseStatus> _initialize() async {
    final raw = await security.readSecureValue(_scope);
    if (raw != null) {
      try {
        final stored = _map(jsonDecode(raw));
        _package = await verifier.verifyPackage(
          stored['package'] as String,
          tenantId: tenantId,
          uid: uid,
          deviceId: deviceId,
        );
        _clock = TrustedClockCheckpoint.fromJson(_map(stored['clock']));
        _accountDisabled = stored['accountDisabled'] == true;
        final pending = stored['pendingTenantActivation'];
        if (pending is String) {
          await verifier.verifyPackage(
            pending,
            tenantId: tenantId,
            uid: uid,
            deviceId: deviceId,
          );
          _pendingTenantActivation = pending;
        }
      } catch (_) {
        _package = null;
        _clock = null;
        return const LicenseStatus(
          operationalAllowed: false,
          code: 'recovery',
          message:
              'تعذر التحقق من صلاحية الجهاز. أعد الالتحاق عبر الاتصال الموثوق.',
        );
      }
    }
    return _check();
  }

  Future<LicenseStatus> importPackage(
    String input, {
    bool trustedOnline = false,
  }) => _serialize(() => _importPackage(input, trustedOnline: trustedOnline));

  Future<LicenseStatus> _importPackage(
    String input, {
    required bool trustedOnline,
  }) async {
    final next = await verifier.verifyPackage(
      input,
      tenantId: tenantId,
      uid: uid,
      deviceId: deviceId,
    );
    final old = _package;
    if (trustedOnline &&
        (!next.membership.enabled ||
            next.membership.role != old?.membership.role) &&
        old != null &&
        _clock != null) {
      // A fresh authenticated disable response overrides an unredeemed offline
      // renewal, even when the server still holds the older entitlement epoch.
      await _persist(old, _clock!, accountDisabled: true);
      _accountDisabled = true;
      return _check();
    }
    if (old != null &&
        (next.license.epoch < old.license.epoch ||
            next.membership.epoch < old.membership.epoch ||
            (next.license.epoch == old.license.epoch &&
                next.entitlementPayload != old.entitlementPayload) ||
            (next.membership.epoch == old.membership.epoch &&
                next.membershipPayload != old.membershipPayload))) {
      throw const LicenseException(
        'replay',
        'هذه الحزمة أقدم من الصلاحية المحفوظة أو تتعارض معها.',
      );
    }
    final sample = await security.platformClock();
    final anchored = TrustedClock.anchor(
      next.issuedAtMs,
      sample,
      previous: _clock,
      authenticatedFreshTime: trustedOnline,
    );
    final pending =
        !trustedOnline &&
            next.membership.role == 'manager' &&
            !next.license.trial &&
            next.membership.enabled
        ? next.serialized
        : _pendingTenantActivation;
    // Persist first: storage failures must not claim successful activation.
    await _persist(
      next,
      anchored.checkpoint,
      accountDisabled: trustedOnline ? false : _accountDisabled,
      pendingPackage: pending,
    );
    if (trustedOnline) _accountDisabled = false;
    _pendingTenantActivation = pending;
    _package = next;
    _clock = anchored.checkpoint;
    return _check();
  }

  Future<void> acknowledgeTenantActivation(
    String acknowledgedPackage,
  ) => _serialize(() async {
    // A second import may arrive while an older package is being redeemed.
    // Its durable retry marker belongs to that newer import, not this response.
    if (_pendingTenantActivation != acknowledgedPackage) return;
    final package = _package;
    final clock = _clock;
    if (package == null || clock == null) return;
    await _persist(package, clock, clearPending: true);
    _pendingTenantActivation = null;
  });

  /// A valid newer offline entitlement may precede its online redemption. Keep
  /// it while accepting only the fresh authenticated time from the older server
  /// package. This never grants additional authority or clears a disable lock.
  Future<LicenseStatus> refreshTrustedTime(String input) =>
      _serialize(() async {
        final incoming = await verifier.verifyPackage(
          input,
          tenantId: tenantId,
          uid: uid,
          deviceId: deviceId,
        );
        if (!incoming.membership.enabled) {
          return _importPackage(input, trustedOnline: true);
        }
        if (_package == null || _clock == null) {
          return _importPackage(input, trustedOnline: true);
        }
        final time = TrustedClock.anchor(
          incoming.issuedAtMs,
          await security.platformClock(),
          previous: _clock,
          authenticatedFreshTime: true,
        );
        await _persist(_package!, time.checkpoint);
        _clock = time.checkpoint;
        return _check();
      });

  /// Use only for Firebase's authoritative user-disabled response for this
  /// session UID. Network loss or access-token expiry must never call this.
  Future<LicenseStatus> recordAccountDisabled() => _serialize(() async {
    final package = _package;
    final clock = _clock;
    if (package != null && clock != null) {
      await _persist(package, clock, accountDisabled: true);
      _accountDisabled = true;
    }
    return _check();
  });

  Future<LicenseStatus> check() => _serialize(_check);

  Future<LicenseStatus> _check() async {
    final package = _package;
    final clock = _clock;
    if (package == null || clock == null) {
      return const LicenseStatus(
        operationalAllowed: false,
        message: 'يلزم إعداد الحساب والجهاز أول مرة عبر اتصال موثوق أو استيراد حزمة موثقة.',
      );
    }
    if (_accountDisabled) {
      return LicenseStatus(
        operationalAllowed: false,
        code: 'account_disabled',
        message:
            'تم إيقاف هذا الحساب. يلزم تفعيله وإعادة التحقق عبر اتصال موثوق.',
        license: package.license,
        role: package.membership.role,
      );
    }
    final time = TrustedClock.advance(clock, await security.platformClock());
    if (time.requiresTrustedTime) {
      return LicenseStatus(
        operationalAllowed: false,
        code: 'clock',
        license: package.license,
        role: package.membership.role,
        message:
            'تغير وقت الجهاز بعد إعادة التشغيل. اتصل للتحقق من الوقت ثم تابع.',
      );
    }
    await _persist(package, time.checkpoint);
    _clock = time.checkpoint;
    final l = package.license;
    final m = package.membership;
    final expiry = [l.expiresAtMs, m.expiresAtMs].whereType<int>().fold<int?>(
      null,
      (current, value) => current == null || value < current ? value : current,
    );
    final remaining = expiry == null
        ? null
        : Duration(milliseconds: expiry - time.nowMs);
    String code = 'active';
    String message = l.trial ? 'الفترة التجريبية سارية.' : 'التفعيل ساري.';
    if (!m.enabled) {
      code = 'disabled';
      message = 'تم تعطيل عضوية هذا الحساب.';
    } else if (time.nowMs < l.notBeforeMs || time.nowMs < m.issuedAtMs) {
      code = 'not_started';
      message = 'لم يبدأ سريان هذه الصلاحية بعد.';
    } else if (expiry != null && time.nowMs >= expiry) {
      code = 'expired';
      message = 'انتهت صلاحية النشاط. فعّل النشاط لاستئناف العمليات المحفوظة.';
    }
    return LicenseStatus(
      operationalAllowed: code == 'active',
      message: message,
      code: code,
      license: l,
      role: m.role,
      remaining: remaining,
      wallRollback: time.wallRollback,
    );
  }

  Future<void> _persist(
    VerifiedLicensePackage package,
    TrustedClockCheckpoint clock, {
    bool? accountDisabled,
    String? pendingPackage,
    bool clearPending = false,
  }) => security.writeSecureValue(
    _scope,
    jsonEncode({
      'package': package.serialized,
      'clock': clock.toJson(),
      'accountDisabled': accountDisabled ?? _accountDisabled,
      'pendingTenantActivation': clearPending
          ? null
          : pendingPackage ?? _pendingTenantActivation,
    }),
  );
}

Map<String, dynamic> _map(Object? value) {
  if (value is! Map<String, dynamic>) _invalid();
  return value;
}

void _keys(Map<String, dynamic> map, Set<String> expected) {
  if (map.length != expected.length || !map.keys.every(expected.contains)) {
    _invalid();
  }
}

String _text(Map<String, dynamic> map, String key, int max) {
  final value = map[key];
  if (value is! String ||
      value.isEmpty ||
      value.length > max ||
      value.contains(RegExp(r'[\x00-\x1f]'))) {
    _invalid();
  }
  return value;
}

int _positive(
  Map<String, dynamic> map,
  String key, {
  int max = 9007199254740991,
}) {
  final value = map[key];
  if (value is! int || value < 1 || value > max) _invalid();
  return value;
}

int _time(Map<String, dynamic> map, String key) {
  final value = map[key];
  if (value is! int || value < 0 || value > 253402300799999) _invalid();
  return value;
}

int? _nullableTime(Map<String, dynamic> map, String key) =>
    map[key] == null ? null : _time(map, key);
Uint8List _base64(String value) {
  if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value)) _invalid();
  final bytes = base64Url.decode(base64Url.normalize(value));
  if (base64Url.encode(bytes).replaceAll('=', '') != value) _invalid();
  return bytes;
}

Never _invalid() => throw const LicenseException(
  'format',
  'تنسيق حزمة التفعيل أو حقولها غير صالح.',
);
