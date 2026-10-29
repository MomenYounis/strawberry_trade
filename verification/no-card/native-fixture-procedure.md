# Native external callable transport fixture

This is an isolated, synthetic Android acceptance fixture. It uses project `demo-strawberry-flutter`, real Auth/Firestore emulators and the production HTTP-adapter code in explicit demo mode. It does not exercise production App Check or deploy a Worker.

From the project's `backend` directory:

```sh
node scripts/external-native-demo.mjs
```

The runner refuses occupied fixture ports and an inherited non-demo project. It sets both emulator endpoints to loopback and calls `assertDemoOperatorEnvironment` before initializing Admin. It generates a session-only issuer, creates mode-0600 `backend/.secret.local` exclusively, writes public-only `work/no-card-native/defines.json`, and starts the normal synthetic enrollment helper and Firebase emulators. Its hub/log/websocket ports 4412/4512/9152 avoid a concurrently isolated Worker probe; Auth/Firestore/Functions/seed/external ports remain 9099/8080/5001/8008/18787. All listeners are loopback-only.

With the same wrapper and matching definitions still running, use the existing headless Android AVD and from the Flutter project root:

```sh
flutter test integration_test/external_gateway_test.dart -d emulator-5554 \
  --no-uninstall \
  --dart-define-from-file=/home/younis/Documents/Codex/2026-10-18/files-pasted-by-the-user-build/work/no-card-native/defines.json \
  --reporter expanded
```

Do not uninstall, clear app data or overwrite an existing `.secret.local` to run this test. No production account, key, App Check debug token or financial record belongs in the fixture. Stop the wrapper gracefully after acceptance so it removes its temporary secret. A crashed wrapper's leftover secret must be identified as this fixture's file before cleanup.

The test requires: actual native Auth headers independently verified by the external bridge; enrolled Keystore P-256 proof; Ed25519-signed exact-30-day demo license; real SQLCipher commit/reopen; a `3,000,000,000` minor-unit invoice preserved exactly; duplicate server acceptance with one change-feed effect; and external bridge counters proving that a default Functions emulator response cannot be mistaken for this route. Parsed, bounded JSON instrumentation records whether the actual SDK uses a JSON number, Int64 tag or UInt64 tag; the test does not invent a wire representation. The final native test result, not this procedure, establishes which checks passed.

No PDF/UI acceptance is repeated here. No actual network-off persistence, physical-phone attestation, deployed Worker latency or Workers Free CPU limit is established by this fixture.
