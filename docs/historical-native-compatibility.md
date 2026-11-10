# Historical client native compatibility fixture

This fixture runs unchanged historical Dart client libraries, Android Keystore and SQLCipher against the owned local demo backend. It is a DEBUG test artifact. It is separate from installation/upgrade of the actual, previously delivered, signed production APKs. Those APKs keep their approved fixed HTTPS destination and issuer; they are never retargeted, patched or re-signed for this test. A successful fixture run is evidence about the recorded historical client source on the current test toolchain, not a network test of the released production binary.

The initial Git revision `e246f436a092616ef2799bb04f969a19fd19ffcc` already has version code 10 and differs from the delivered v9 gateway, ledger and domain code. The v9 fixture therefore comes from the actual delivered source ZIP, SHA-256 `10dc781089cf37a0b9e5ef0279c400a0e3f2cfcbb47dac13a8de52e0860adeee`. The v11 fixture comes from recorded compiled app source `2ad243a44ac7886d2ad49f25b5368811d288d228`.

The preparation script copies only the historical `lib`, Android project, fonts, dependency locks and build metadata. It adds one test entrypoint; historical files remain byte-identical. The v11 Git tree omits three ignored Gradle launchers, so those come from the verified delivered v9 ZIP after checking identical Gradle distribution properties. Every file and origin is recorded in `legacy-source-manifest.json`. The verifier re-derives the source hashes from the original ZIP/commit; changing a library and editing its manifest cannot satisfy verification. It also rejects added library files.

The prepared folders are private and contain no production signing credentials or issuer private key. Fixture jobs contain only disposable demo account credentials and the synthetic issuer's public key, are kept under a private marked host directory, and never enter public logs or source control.

## Prepare and check the exact source

From `/home/younis/strawberry-trade-annual-review`:

```sh
python3 tools/annual-review/prepare-legacy-native.py --client v9
python3 tools/annual-review/prepare-legacy-native.py --client v11
python3 tools/annual-review/prepare-legacy-native.test.py
```

Each preparation prints a newly created `sourceFolder`. Preserve that exact folder for its build and evidence. In each folder resolve only the existing, cached dependency lock:

```sh
/home/younis/flutter/bin/flutter pub get --offline --enforce-lockfile
/home/younis/flutter/bin/cache/dart-sdk/bin/dart analyze integration_test/legacy_client_compatibility_test.dart
```

The already prepared v9 folder is `/home/younis/.local/share/strawberry-trade-test-runtime/legacy-native-v9-qk6wo9uw`; v11 is `/home/younis/.local/share/strawberry-trade-test-runtime/legacy-native-v11-r54j5iyk`. Both dependency setups and fixture analyses passed; their historical content hashes still passed afterward. These are preparation results, not native acceptance results.

## Build and sign, under the root campaign's device/build coordination

Use the selected historical folder as the working directory. Do not change any historical source file or public release configuration. The following build number override is only for retaining one disposable test installation while swapping the historical DEBUG entrypoints. It does not change the recorded historical source version or identify an actual production APK:

```sh
env -u STRAWBERRY_SIGNING_PROPERTIES JAVA_HOME=/usr/lib/jvm/java-17-temurin-jdk \
  /home/younis/flutter/bin/flutter build apk --debug --no-pub \
  --target=integration_test/legacy_client_compatibility_test.dart \
  --build-number=12 --build-name=1.0.0 \
  --dart-define=USE_EMULATORS=true \
  --dart-define=EMULATOR_HOST=10.0.2.2 \
  --dart-define=GATEWAY_BASE_URL=http://10.0.2.2:8788
```

Verify the source again after building, from the review checkout:

```sh
python3 tools/annual-review/prepare-legacy-native.py --verify /absolute/prepared/sourceFolder
```

The root signing coordinator must sign only the generated `build/app/outputs/flutter-apk/app-debug.apk`, verify the kernel contains `legacy_client_compatibility_test.dart`, package `com.strawberrytrade.strawberry_trade`, version code 12, and `application-debuggable`. Use the existing approved signing identity and confirm certificate SHA-256 `bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b`. The signing receipt must record this source folder's manifest SHA-256, historical source origin, input APK hash, output APK hash, synthetic emulator definitions, and test-only overridden version code. Do not use the review checkout's current HEAD as the historical app source revision. Credentials stay in memory under the existing signing procedure. Never distribute these DEBUG APKs.

The extended signer enforces these checks. From the review checkout, after the corresponding build completes:

```sh
python3 tools/annual-review/sign-native-fixture.py legacy-v9 \
  --source-folder /home/younis/.local/share/strawberry-trade-test-runtime/legacy-native-v9-qk6wo9uw \
  --evidence-dir verification/continuation-2026-11-02/compatibility/native-v9
python3 tools/annual-review/sign-native-fixture.py legacy-v11 \
  --source-folder /home/younis/.local/share/strawberry-trade-test-runtime/legacy-native-v11-r54j5iyk \
  --evidence-dir verification/continuation-2026-11-02/compatibility/native-v11
```

An optional `--input-apk` must resolve to that exact verified historical folder's expected output; arbitrary APKs are refused. A separate receipt records the signing coordinator's current revision and the historical app source origin. Existing receipts/artifacts are preserved: retries need a fresh evidence directory. The optional `legacy-v12` phase accepts a verified v12 source folder, or the exact generated v12 fixture copied into the current checkout with the current source files individually hashed and any content changes since HEAD explicitly recorded. Its signing command without `--source-folder` uses only the current checkout's normal DEBUG output. Six input-guard tests cover phase markers, package/version/debug flags, provenance, arbitrary/symlink APK refusal and streaming kernel-marker checks; these tests never retrieve credentials or sign an APK.

## Native sequence and independently checked results

Use only the marked `compatibility` disposable AVD, reserved serial `emulator-5586`; keep the root firewall restricted to loopback and emulator host TCP 8788/9099. Do not use an owner AVD, physical device, production destination, MITM proxy or production issuer private key. Do not clear/uninstall this test application between phases. The app reads `files/commercial-job.json` and writes `files/commercial-result.json`; the root device helper needs to permit these explicit legacy phases. All account values remain in private jobs.

1. Install the signed v9 DEBUG fixture, run with absent job or `phase: identity`, and copy the private result as `identity.json` into a new mode-0700 `/home/younis/.local/share/strawberry-trade-test-runtime/private-legacy-<unique>` directory. This proves the device's actual v9 fixture P-256 identity before provisioning.
2. Run `node backend/scripts/native-legacy-host.mjs init PRIVATE_DIRECTORY PRIVATE_DIRECTORY/identity.json`. This requires the existing marked, live, durable demo runtime and validates all project/endpoints before SDK initialization. It creates one fresh verified synthetic manager and one isolated tenant bound to that actual device. It writes `legacy-seed-v9-job.json` privately.
3. Push that job and run v9 `legacy_seed_v9`. It uses the unchanged old gateway for authenticated bootstrap, license verification, sync and pull. It saves a party and sale, preserves a synthetic retry through SQLCipher close/reopen, sends every accepted operation twice and requires an identical receipt, then retains a second pending sale and draft. Run `oracle-seed PRIVATE_DIRECTORY`: accepted entries 1; receipts 2; customer balance 1,600 minor units; cash 500. The untransmitted pending sale is excluded.
4. Run host `minimum-v2 PRIVATE_DIRECTORY`, then `unsupported-job PRIVATE_DIRECTORY`. Push `unsupported-job.json` and run the same v9 fixture again. Both real old gateway methods must receive `sync-upgrade-required`. The old controller's existing error behavior retains the pending ID, raw payload and cursor, increments retry attempts, and preserves the draft across close/reopen. Its queue state remains `retry`; v9 does not acquire the newer v12 update message or blocked-status behavior. Run `oracle-unsupported PRIVATE_DIRECTORY`: the accepted entry/receipt sets and amounts remain identical to step 3.
5. Keep minimum protocol 2, install the v11 DEBUG fixture with retained data, run host `v11-job PRIVATE_DIRECTORY`, push `v11-job.json`, then run `legacy_resume_v11`. It must open the same database under its actual schema migration, verify the exact v9 queued operation ID/raw payload/retry attempts and draft, negotiate v2 through unchanged v11 gateway code, deliver the old pending item twice for one receipt, post one v11 sale, pull via the actual v11 parser/atomic cursor method, and retain a new retry item. Run `oracle-v11 PRIVATE_DIRECTORY`: entries 3; receipts 4; customer balance 7,100; cash 2,000. A minimum-v2 tenant accepting v11 requests proves the real client sent v2.
6. Optionally prepare a v12 fixture from the final committed app source with `--client v12 --v12-revision FULL_FINAL_APP_COMMIT`. Build/sign under the same rules. Run host `v12-job PRIVATE_DIRECTORY`, then native `legacy_resume_v12` with retained data. Run `oracle-v12 PRIVATE_DIRECTORY`: entries 5; receipts 6; customer balance 15,100; cash 3,500. One v12 pending item and the original draft must remain local. This phase requires the exact final app source, not an earlier intermediate commit.

Each host command has this shape:

```sh
node backend/scripts/native-legacy-host.mjs PHASE PRIVATE_DIRECTORY
```

The host independently reads accepted Firestore entries, the party baseline and operation receipts. It imports no app/backend financial projection code, compares the complete expected ID sets, checks the fixed sale amounts, and computes integer balances/cash directly. Public oracle files contain only counts, financial totals and safety flags. They are created once under `verification/continuation-2026-11-02/compatibility`; private credentials/job files are not exported there.

The default production minimum must remain 1 with floor 0 while v9 is supported. Deliberately changing a synthetic tenant to minimum 2 above is a local unsupported-client test, not permission to raise the production minimum or prune history. HTTP contract coverage of omitted/v1/v2 fields and arbitrary unsupported versions remains separate evidence. Actual previous signed APK upgrade and production deployment also remain separate acceptance decisions.
