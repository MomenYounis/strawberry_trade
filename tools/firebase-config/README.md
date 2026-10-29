# Android production public configuration

This local tool converts the owner's downloaded Android `google-services.json` into the external Dart definitions consumed by `FirebaseGateway`. It makes no network calls, creates no credentials, changes no Firebase project, and writes no private key material. It needs Node 22 or later and no additional dependencies.

Run from the Flutter project directory:

```sh
node tools/firebase-config/cli.mjs \
  --google-services /absolute/path/google-services.json \
  --license-public-keys /absolute/path/approved-issuer-public.json \
  --project strawberry-trade-261017-6a49b \
  --out /absolute/path/outside-the-project/production-defines.json
```

The public-key input accepts the existing license-issuer tool's public output (`kid`, raw `publicKey`, optional matching `spkiPem`) or a nonempty rotation map of key IDs to raw 32-byte Ed25519 public keys encoded as unpadded base64url. Supply only public key material. The tool validates the exact Android package `com.strawberrytrade.strawberry_trade`, the project/sender number against the Android app ID, the public API key, and the trusted public-key format. `--project` is an optional additional project identity check. It refuses demo projects, existing outputs, and output paths within the application source, including existing parent-directory symlinks.

The generated file contains `USE_EMULATORS=false` and the `FIREBASE_*` / `LICENSE_PUBLIC_KEYS` values expected by the application. All configuration values are public client data, but keeping them outside the source helps keep reusable source archives separate from an operator's reviewed production configuration.

For a separately reviewed host that implements the same callable protocol, add `--gateway-url https://YOUR-APP.workers.dev` (or another reviewed public HTTPS host). The tool canonicalizes the URL and adds `GATEWAY_BASE_URL`; omitting this option preserves the existing Firebase Functions destination. It refuses IP/local hosts, credentials, queries, fragments, encoded/ambiguous path components and non-HTTPS URLs. It validates URL syntax without making a network request or proving deployment ownership. Choose a new output path when changing a reviewed configuration.

The Flutter client uses the existing Firebase callable SDK's `httpsCallableFromUrl`, retaining its Auth/App Check attachment. A generic host must verify both tokens and implement the callable response/error contract as well as the original tenant/device authority checks. Local configuration tests do not establish native SDK token attachment or successful production transport. An explicit local HTTP override is accepted by the Dart parser only when `USE_EMULATORS=true` and the host is exactly `localhost`, `127.0.0.1`, or Android's `10.0.2.2`; the production generator never emits that override. The actual Android emulator test passed using the explicit external URL while ordinary Functions emulator configuration remained enabled: the external bridge independently verified native Auth tokens and decoded the SDK's Int64-tagged 3,000,000,000 minor-unit value exactly. This was guarded demo mode, which exempts App Check; live App Check attachment/verification remains a physical-phone production acceptance requirement. See `verification/no-card/` and the test report.

After the separately reviewed signing, backend, App Check and onboarding work is ready:

```sh
flutter build apk --release --dart-define-from-file=/absolute/path/outside-the-project/production-defines.json
```

The app initializes with explicit `FirebaseOptions`; this tool does not enable the Google Services Gradle plugin. Enabling that plugin unconditionally against a production JSON file would auto-initialize the production default Firebase app before the current emulator isolation checks run. Do not mix these configurations accidentally.

A generated file and successful build establish local configuration and packaging, not live attestation, callable deployment, tenant authorization or legacy migration. In particular, direct APK distribution needs the App Check Play Integrity settings appropriate to distribution outside Google Play, as described in the production setup guide.

Run the focused local checks:

```sh
node --test tools/firebase-config/config.test.mjs
```
