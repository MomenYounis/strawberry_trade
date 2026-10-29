/// Validates an operator-selected callable-protocol gateway without networking.
/// An empty URL preserves the ordinary Firebase Functions/emulator destination.
class GatewayEndpoint {
  GatewayEndpoint._(this.baseUrl);

  factory GatewayEndpoint.parse(String input, {bool emulator = false}) {
    if (input.isEmpty) return GatewayEndpoint._(null);
    Never invalid() => throw const FormatException('gateway_base_url_invalid');
    if (input.length > 2048 ||
        input.codeUnits.any((c) => c < 0x21 || c > 0x7e) ||
        input.contains(r'\')) {
      invalid();
    }
    final parts = RegExp(
      r'^(https?)://([^/?#]+)(/[^?#]*)?$',
      caseSensitive: false,
    ).firstMatch(input);
    if (parts == null) invalid();
    final scheme = parts.group(1)!.toLowerCase();
    final authority = RegExp(
      r'^([a-z0-9.-]+)(?::([0-9]{1,5}))?$',
      caseSensitive: false,
    ).firstMatch(parts.group(2)!);
    if (authority == null) invalid();
    final host = authority.group(1)!.toLowerCase();
    final portText = authority.group(2);
    final port = portText == null ? null : int.parse(portText);
    if (port != null && (port < 1 || port > 65535)) invalid();

    final local =
        emulator && const {'localhost', '127.0.0.1', '10.0.2.2'}.contains(host);
    if (!local) {
      if (scheme != 'https') invalid();
      final labels = host.split('.');
      final labelPattern = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
      if (host.length > 253 ||
          labels.length < 2 ||
          labels.any((label) => !labelPattern.hasMatch(label)) ||
          !RegExp(r'[a-z]').hasMatch(labels.last) ||
          const {
            'localhost',
            'local',
            'internal',
            'lan',
            'home',
            'test',
            'invalid',
            'example',
          }.contains(labels.last)) {
        invalid();
      }
    }

    final path = parts.group(3) ?? '';
    final normalizedPath = path.endsWith('/')
        ? path.substring(0, path.length - 1)
        : path;
    // Literal path components keep the appended operation unambiguous. Encoded
    // separators, dot traversal and repeated slashes are configuration errors.
    if (normalizedPath.isNotEmpty &&
        normalizedPath
            .substring(1)
            .split('/')
            .any(
              (segment) =>
                  segment == '.' ||
                  segment == '..' ||
                  !RegExp(r'^[A-Za-z0-9._~-]+$').hasMatch(segment),
            )) {
      invalid();
    }
    final defaultPort = scheme == 'https' ? 443 : 80;
    final portSuffix = port == null || port == defaultPort ? '' : ':$port';
    return GatewayEndpoint._('$scheme://$host$portSuffix$normalizedPath');
  }

  final String? baseUrl;

  static const operations = {
    'bootstrap',
    'syncOperation',
    'pullChanges',
    'activateLicense',
    'setMemberActive',
    'acceptInvitation',
    'createEmployeeInvitation',
  };

  String? urlFor(String operation) {
    if (!operations.contains(operation)) {
      throw const FormatException('gateway_operation_invalid');
    }
    return baseUrl == null ? null : '$baseUrl/$operation';
  }
}
