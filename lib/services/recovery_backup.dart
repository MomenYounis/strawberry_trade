import 'dart:convert';

import 'package:cryptography/cryptography.dart';

import '../domain/ledger.dart';

/// Portable financial backup, not an account, device key or license transfer.
/// Its separate passphrase must survive independently of the lost phone.
/// The bounded envelope is deliberately unsuitable for unbounded annual dumps.
class RecoveryBackup {
  static const maxPlaintextBytes = 16 * 1024 * 1024;
  static const maxEnvelopeBytes = 23 * 1024 * 1024;
  static const _iterations = 210000;
  static final _cipher = AesGcm.with256bits();
  static final _kdf = Pbkdf2(
    macAlgorithm: Hmac.sha256(),
    iterations: _iterations,
    bits: 256,
  );
  static final _aad = utf8.encode('strawberry-recovery-v1');

  static void _password(String value) {
    if (value.length < 12 || utf8.encode(value).length > 1024) {
      invalid(
        'backup_password',
        'استخدم عبارة استعادة مستقلة من 12 حرفاً على الأقل.',
      );
    }
  }

  static Future<Map<String, dynamic>> encrypt(
    Map<String, dynamic> backup,
    String passphrase,
  ) async {
    _password(passphrase);
    final bytes = utf8.encode(jsonEncode(backup));
    if (bytes.length > maxPlaintextBytes) {
      invalid(
        'backup_size',
        'تتجاوز النسخة حد التشفير الآمن؛ لم تُنشأ نسخة ناقصة. احتفظ بالجهاز وراجع المسؤول.',
      );
    }
    final salt = <int>[..._cipher.newNonce(), ..._cipher.newNonce().take(4)];
    final key = await _kdf.deriveKey(
      secretKey: SecretKey(utf8.encode(passphrase)),
      nonce: salt,
    );
    final box = await _cipher.encrypt(bytes, secretKey: key, aad: _aad);
    return {
      'format': 'strawberry-recovery',
      'version': 1,
      'kdf': 'PBKDF2-HMAC-SHA256',
      'iterations': _iterations,
      'salt': base64Encode(salt),
      'nonce': base64Encode(box.nonce),
      'ciphertext': base64Encode(box.cipherText),
      'tag': base64Encode(box.mac.bytes),
    };
  }

  static Future<Map<String, dynamic>> decrypt(
    Map<String, dynamic> envelope,
    String passphrase,
  ) async {
    _password(passphrase);
    const fields = {
      'format',
      'version',
      'kdf',
      'iterations',
      'salt',
      'nonce',
      'ciphertext',
      'tag',
    };
    if (envelope.keys.toSet().difference(fields).isNotEmpty ||
        envelope.length != fields.length ||
        envelope['format'] != 'strawberry-recovery' ||
        envelope['version'] != 1 ||
        envelope['kdf'] != 'PBKDF2-HMAC-SHA256' ||
        envelope['iterations'] != _iterations ||
        [
          'salt',
          'nonce',
          'ciphertext',
          'tag',
        ].any((key) => envelope[key] is! String) ||
        (envelope['ciphertext'] is String &&
            (envelope['ciphertext'] as String).length > maxEnvelopeBytes)) {
      invalid('backup_format', 'تنسيق نسخة الاستعادة أو حجمها غير مدعوم.');
    }
    try {
      List<int> field(String key) => base64Decode(envelope[key] as String);
      if ((envelope['salt'] as String).length != 24 ||
          (envelope['nonce'] as String).length != 16 ||
          (envelope['tag'] as String).length != 24) {
        invalid('backup_format', 'بنية نسخة الاستعادة غير صالحة.');
      }
      final salt = field('salt'),
          nonce = field('nonce'),
          tag = field('tag'),
          bytes = field('ciphertext');
      if (salt.length != 16 ||
          nonce.length != 12 ||
          tag.length != 16 ||
          bytes.length > maxPlaintextBytes) {
        invalid('backup_format', 'بنية نسخة الاستعادة غير صالحة.');
      }
      final key = await _kdf.deriveKey(
        secretKey: SecretKey(utf8.encode(passphrase)),
        nonce: salt,
      );
      final plain = await _cipher.decrypt(
        SecretBox(bytes, nonce: nonce, mac: Mac(tag)),
        secretKey: key,
        aad: _aad,
      );
      final value = jsonDecode(utf8.decode(plain));
      if (value is! Map<String, dynamic>) {
        invalid('backup_format', 'بنية النسخة غير صالحة.');
      }
      return value;
    } on LedgerException {
      rethrow;
    } catch (_) {
      invalid(
        'backup_decrypt',
        'عبارة الاستعادة غير صحيحة أو الملف تالف؛ لم تتغير البيانات.',
      );
    }
  }
}
