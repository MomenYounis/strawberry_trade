import 'package:flutter/services.dart';

/// The installation private signing key and AES wrapping key stay in AndroidKeyStore.
/// A database password is necessarily present in process memory while SQLCipher opens.
class DeviceSecurity {
  const DeviceSecurity();
  static const channel = MethodChannel('strawberry_trade/device_security');

  Future<InstallationIdentity> installationIdentity() async {
    final value = await channel.invokeMapMethod<String, dynamic>('identity');
    if (value == null) throw StateError('Missing installation identity');
    return InstallationIdentity(
      deviceId: value['deviceId'] as String,
      publicKeySpki: value['publicKeySpki'] as String,
    );
  }

  Future<Uint8List> signChallenge(Uint8List challenge) async {
    if (challenge.length < 32 || challenge.length > 4096) {
      throw ArgumentError('Challenge must be 32–4096 bytes');
    }
    final result = await channel.invokeMethod<Uint8List>(
      'signChallenge',
      challenge,
    );
    if (result == null) throw StateError('Missing device signature');
    return result;
  }

  Future<String> databasePassword(String scope) async {
    _scope(scope);
    final value = await channel.invokeMethod<String>('databasePassword', scope);
    if (value == null || value.length < 40) {
      throw StateError('Missing database key');
    }
    return value;
  }

  Future<String?> readSecureValue(String scope) async {
    _scope(scope);
    return channel.invokeMethod<String>('readSecureValue', scope);
  }

  Future<void> writeSecureValue(String scope, String value) async {
    _scope(scope);
    if (value.length > 200000) throw ArgumentError('Secure value too large');
    await channel.invokeMethod<void>('writeSecureValue', {
      'scope': scope,
      'value': value,
    });
  }

  Future<ClockSample> platformClock() async {
    final value = await channel.invokeMapMethod<String, dynamic>('clock');
    if (value == null) throw StateError('Missing Android clock');
    return ClockSample(
      wallMs: value['wallMs'] as int,
      elapsedMs: value['elapsedMs'] as int,
      bootCount: value['bootCount'] as int,
    );
  }

  static void _scope(String scope) {
    if (scope.isEmpty || scope.length > 512) {
      throw ArgumentError('Invalid scope');
    }
  }
}

class InstallationIdentity {
  const InstallationIdentity({
    required this.deviceId,
    required this.publicKeySpki,
  });
  final String deviceId;

  /// Base64url encoded DER SubjectPublicKeyInfo (P-256 / SHA256withECDSA).
  final String publicKeySpki;
  String get algorithm => 'P256-SHA256';
}

class ClockSample {
  const ClockSample({
    required this.wallMs,
    required this.elapsedMs,
    required this.bootCount,
  });
  final int wallMs;
  final int elapsedMs;
  final int bootCount;
}
