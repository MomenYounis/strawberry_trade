# Fresh legacy rules baseline evidence

- Executed afresh on 2026-10-19T12:36:41.301533+03:00.
- Result: 42 tests, 42 passed, zero failures; emulator command exit code 0.
- Rules and tests ran from the isolated `work/legacy-baseline/backend` copy and remain byte-for-byte identical to original source. The original source was not modified.
- Existing cached Firebase CLI 15.34.0; emulator project `demo-strawberry-trade`; Firestore `127.0.0.1:8181`, hub `127.0.0.1:4411`, logging `127.0.0.1:4511`, websocket `9151`, UI disabled. Before spawning the unchanged test file, a wrapper asserted the exact Firestore host, hub and project environment.
- The separate current Android acceptance project `demo-strawberry-flutter` and its ports 8080/5001/9099/4400 were not used or stopped.
- JVM constrained locally by `JAVA_TOOL_OPTIONS=-Xms64m -Xmx512m`.
- New stdout: `work/legacy-rules-final.log`; SHA-256 `6a1b18b7b27a9d7c88bf16b6e03c5bc5063db821eb9bce47a0ea2e91f0753cb7`.
- Prior original execution stdout retained separately as `work/legacy-rules-prior.log`.

Source SHA-256:

- `firestore.rules`: `96fb39261cecf72d08fb6c14249a1d79e800cc32ec1141b8ade5cb37b152cba5`
- `test/firestore.rules.test.mjs`: `05a3f8b13860fc40a28ca7d6fe298a044d462f170d92a63df95abe8334292028`

Reproduction from `work/legacy-baseline/backend`:

```sh
JAVA_TOOL_OPTIONS='-Xms64m -Xmx512m' GCLOUD_PROJECT=demo-strawberry-trade FIRESTORE_EMULATOR_HOST=127.0.0.1:8181 FIREBASE_EMULATOR_HUB=127.0.0.1:4411 ./node_modules/.bin/firebase emulators:exec --config firebase.isolated-legacy-baseline.json --project demo-strawberry-trade --only firestore 'node scripts/run-isolated-rules.mjs'
```
