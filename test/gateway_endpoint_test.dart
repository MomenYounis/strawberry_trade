import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:strawberry_trade/services/gateway_endpoint.dart';

void main() {
  final cases = jsonDecode(
    File('tools/firebase-config/endpoint-cases.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  test(
    'empty configuration retains Firebase destination for all seven calls',
    () {
      final endpoint = GatewayEndpoint.parse('');
      expect(endpoint.baseUrl, isNull);
      expect(GatewayEndpoint.operations, {
        'bootstrap',
        'syncOperation',
        'pullChanges',
        'activateLicense',
        'setMemberActive',
        'acceptInvitation',
        'createEmployeeInvitation',
      });
      for (final operation in GatewayEndpoint.operations) {
        expect(endpoint.urlFor(operation), isNull);
      }
    },
  );

  test(
    'approved public HTTPS bases canonicalize identically to config tool',
    () {
      for (final raw in cases['valid'] as List) {
        final value = Map<String, dynamic>.from(raw as Map);
        final endpoint = GatewayEndpoint.parse(value['input'] as String);
        expect(
          endpoint.baseUrl ?? '',
          value['expected'],
          reason: value['input'],
        );
        if (endpoint.baseUrl != null) {
          for (final operation in GatewayEndpoint.operations) {
            expect(
              endpoint.urlFor(operation),
              '${value['expected']}/$operation',
            );
          }
        }
      }
    },
  );

  test('untrusted or ambiguous destination cannot receive account tokens', () {
    for (final input in (cases['invalid'] as List).cast<String>()) {
      expect(
        () => GatewayEndpoint.parse(input),
        throwsA(isA<FormatException>()),
        reason: input,
      );
    }
    expect(
      () => GatewayEndpoint.parse('https://gateway.example.com/${'a' * 2048}'),
      throwsA(isA<FormatException>()),
    );
  });

  test(
    'local HTTP override requires explicit emulator mode and exact host',
    () {
      for (final host in ['localhost', '127.0.0.1', '10.0.2.2']) {
        final input = 'http://$host:8008/gateway/';
        expect(
          () => GatewayEndpoint.parse(input),
          throwsA(isA<FormatException>()),
        );
        expect(
          GatewayEndpoint.parse(input, emulator: true).urlFor('bootstrap'),
          'http://$host:8008/gateway/bootstrap',
        );
      }
      for (final input in [
        'http://gateway.example.com',
        'http://localhost.example.com',
        'http://192.168.1.10',
        'http://127.0.0.2',
      ]) {
        expect(
          () => GatewayEndpoint.parse(input, emulator: true),
          throwsA(isA<FormatException>()),
        );
      }
      expect(GatewayEndpoint.parse('', emulator: true).baseUrl, isNull);
    },
  );

  test(
    'operation names cannot select another route or escape the base path',
    () {
      for (final endpoint in [
        GatewayEndpoint.parse(''),
        GatewayEndpoint.parse('https://gateway.example.com/api'),
      ]) {
        for (final operation in [
          '',
          'admin',
          '../bootstrap',
          '/bootstrap',
          'bootstrap?x=1',
          'bootstrap/other',
          '%62ootstrap',
          'https://other.example.com',
        ]) {
          expect(
            () => endpoint.urlFor(operation),
            throwsA(isA<FormatException>()),
          );
        }
      }
    },
  );
}
