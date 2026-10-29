# Worker/Durable Object local evidence

Verified 2026-10-20. No cloud deployment, real service-account credential, billing change, production tenant or real Auth user was used.

- `worker-config-tests.log`: **4/4 security configuration tests passed**, covering missing/oversized secrets, project/key/app mismatches and strict demo-only emulator boundaries. Keys were generated synthetic fixtures in memory.
- `worker-http-acceptance.json`: **29 assertions passed** through actual local workerd → one SQLite `TradingGateway` Durable Object → the shared HTTP transport → real Auth/Firestore emulators. All seven endpoints were exercised. Evidence includes ID-token refusal/verification, P-256 setup, Ed25519 packages, exactly-once financial receipt/effect, creator/counterparty attribution, forged tenant refusal, employee enrollment and redacted feed, activation, disable, signed revocation and an actual 500-record cursor page plus remainder.
- `worker-sdk-probe.json`: isolated lower-level workerd proof of integer/double/bool/null/list/map/Timestamp/bytes/GeoPoint round-trip, create/update/merge, document and query transaction reads, transaction create/merge/update, duplicate-create error mapping, rollback, 600 unique ordered records as 500+100, device/issuer crypto and retained financial receipt. `wallMs` is local elapsed time, **not** measured cloud CPU.
- `worker-dry-run.log`: pinned Wrangler **4.151.2** built the final production-target bundle without publishing: **8,574.23 KiB uncompressed / 1,188.57 KiB gzip**. Only the `TradingGateway` Durable Object binding is in that unconfigured review target. No cloud account ID, route or secret was supplied.

Resolved compatibility failures were real runtime failures, not only static guesses:

1. Initial workerd startup failed with `ReferenceError: __dirname is not defined` in an eagerly loaded gax gRPC module, despite REST mode. A scoped bundle define fixes that unused directory reference; the local environment needs its own define because Wrangler does not inherit that field.
2. First Firestore operations failed with `EvalError: Code generation from strings disallowed for this context`. Bundled schema setup moved to the allowed startup phase.
3. A duplicate `.create` exposed another request-time protobuf allocation in gax error decoding; it was misclassified/retried for over 60 seconds. An exact-object cache for the two bundled status schemas fixes that path. The test confirms arbitrary request-time `Function()` is still rejected.
4. The first Durable Object configuration failed because JSON.stringify quoting was used as dotenv quoting for the service-account-shaped fixture. The fixture writer now uses single dotenv quotes for JSON, and actual workerd acceptance verifies the result. Neither a production credential nor a weaker validation bypass was used to resolve it.

SDK files remain unedited; `backend/worker/compatibility.mjs` is an explicit pinned in-memory compatibility shim using private schema paths. Upgrades require rerunning both successful and error paths. Financial truth and replay protection remain in Firestore; the Durable Object does not persist the ledger to Cloudflare storage.

Not established by these results: cloud deployment/IAM, real Google App Check token issuance/provider acceptance, actual cloud startup/CPU/memory/subrequest/free-quota metering, host account eligibility, or phone-to-cloud connectivity. Production still enforces App Check for the configured Android app and the existing account/tenant/member/device/session checks. Source readiness is separate from an approved live service.
