# Review an owner/device onboarding plan

The default `cli.mjs` prepares a review artifact. It has **no apply option**, Admin SDK, dependency, credential discovery, network request or cloud mutation. Generating a plan **does not authorize onboarding**. A separate opt-in application module/CLI is implemented and described below; the combined suite passes **30 tests**. Every actual application requires the owner's specific approval after the exact owner, tenant and phone public key are established. The first such approved enrollment completed on 20 October 2026; see [current project status](../../docs/current-status-ar.md). The existing demo scripts remain demo-only.

Use Node 22 or later. From the Flutter project root:

```sh
node tools/production-operator/cli.mjs \
  --project strawberry-trade-261017-6a49b \
  --database '(default)' \
  --request /absolute/path/owner-request.json
```

The default emits the plan JSON to stdout and writes no file. Add `--out /absolute/path/new-owner-plan.json` only when you want a local review file. Its existing parent directory must contain no symlinks; the tool exclusively creates a new regular file with mode `0600` and refuses existing files or symlinks. Keep the plan private: it contains an account email and device public identity, although it contains no password or private key. Do not put credentials in the request.

The input must have exactly these fields, with no additional keys:

```json
{
  "projectId": "strawberry-trade-261017-6a49b",
  "databaseId": "(default)",
  "ownerUid": "EXACT_EXISTING_UID",
  "expectedEmail": "owner@example.test",
  "tenantId": "REVIEWED_NEW_TENANT_ID",
  "managerName": "اسم المالك",
  "deviceId": "COPY_DEVICE_ID_FROM_THE_INTENDED_PHONE",
  "publicKeySpki": "COPY_PUBLIC_SPKI_FROM_THE_SAME_PHONE",
  "maxDevices": 1
}
```

The displayed key placeholders are intentionally invalid. Copy the real **public** request using the app's “نسخ طلب تسجيل الجهاز” button. That copy also contains `algorithm`; retain only `deviceId` and `publicKeySpki` in the exact input shape above. The tool validates a canonical P-256 DER SPKI and the matching SHA-256/base64url device ID. It cannot prove who supplied a public key. A trusted operator must manually verify the intended owner, exact existing UID/email and the phone from which the key came. Subsequent protected `bootstrap` requires that phone's private-key signature before issuing a session/package. This preparation does not perform that proof.

Both target arguments are mandatory and must match the request. Only the default Firestore database is supported because that is what the reviewed gateway currently uses. Production planning refuses `demo-` projects, emulator environment markers and conflicting cloud-project environment values. It does not read Firebase CLI credentials or infer a target from the current directory. JSON input is limited to 16 KiB, must be UTF-8, and must be a regular file through a path without symlinks.

## Required checks before an approved application

The plan lists unresolved checks, not completed checks:

- Read the **exact existing UID** in the reviewed project; require exact expected email, verified email and an enabled account. Do not create accounts, reset passwords or promote an identity selected only by an email string.
- Verify the intended physical phone and its public request manually. The existing bootstrap challenge subsequently proves possession of the enrolled private key.
- Confirm that the tenant and all four target documents are absent. Check prior trial/enrollment history: recover/transfer an existing business instead of creating another trial, even if a document was deleted or a different ID was suggested.
- Revoke the owner's refresh tokens, then create tenant, manager membership, device and audit documents in one create-only Firestore transaction. Revocation affects that UID across the Firebase project, potentially including the old website. Auth revocation is separate from Firestore: it can succeed even if the transaction fails. The application module records partial effects in its durable receipt; an uncertain Auth outcome requires review instead of automatic re-revocation.
- Capture trusted server time at approved application, then set the one-time trial to exactly `30 × 24` hours. The planner does not start the trial; the separately approved application derives its start from Firestore `readTime`, never the local workstation clock.
- Complete the approved endpoint, real App Check, Firebase IAM/credential, protected tenant rules, old Admin endpoint and physical-phone reviews. Keep existing site rules and data intact.

No deployment, cloud account, permission, credential, token, session, license or production document is created by the planner. The deterministic plan hash identifies the review content; it is **not an approval token**. Application requires review of the separate implementation and the owner's approval of its concrete effects. Do not add a production override to the demo operator.

## Separate opt-in production application (locally implemented and tested)

`apply.mjs` exports an application function with injected Firestore/Auth clients and durable local receipt storage. `apply-cli.mjs` has no default action. All of `--apply`, `--credentials-stdin`, explicit `--project`, `--database '(default)'`, `--plan`, `--plan-hash`, `--approval`, and `--receipt` are mandatory. Plan, approval and receipt paths must be absolute. Credentials enter the CLI as a bounded service-account JSON on stdin only, using the existing backend Admin SDK installation; no new dependencies or credential-discovery fallback were added. Never paste credentials into a terminal command or chat.

The approval JSON must record a **new, actual human authorization after the exact tenant and physical-device request are known**. A preparatory instruction to implement this tool, plan hash, test fixture, existing deployment approval or machine-generated file is not that authorization. No ready-to-use production approval file is supplied. The required shape is `schemaVersion: 1`, `kind: strawberry-owner-enrollment-approval`, exact `projectId`, `databaseId`, `planHashSha256`, complete `target` copied from the reviewed plan, exact `publicKeySha256Hex`, and a `humanApprovalEvidence` string recording the real instruction. These explicit confirmations must each be true only after actually established:

- `manualOwnerAndPhysicalPhoneKeyHandoffConfirmed`
- `priorBusinessEnrollmentAndTrialHistoryChecked`
- `noPriorBusinessEnrollmentFound`
- `liveGatewayAppCheckRulesAndIndexReviewCompleted`
- `projectWideOwnerSessionRevocationAcknowledged`
- `createOnlyEnrollmentAndThirtyDayTrialApproved`

The library rebuilds the source plan and verifies its complete canonical content/hash before any client operation. It checks the exact existing enabled, verified UID/email initially, again immediately before project-wide Auth revocation, and inside every final transaction attempt. An account changed during preflight or revocation is refused; Auth and Firestore remain separate services, so these reads cannot create an atomic cross-service guarantee. Both the preliminary read-only transaction and final create transaction read all four document paths and query `tenants.ownerUid`; another tenant for that UID refuses enrollment. These checks cannot discover deliberately deleted history or recognize a business under an unrelated identity: the separate operator history confirmation is essential and must not be inferred from an empty query.

Before revocation, the tool durably writes its local receipt. Auth revocation is non-atomic with Firestore and affects the UID across this project. A lost Auth response stops processing and refuses automatic repeat revocation; review the receipt and the live account before any separately approved recovery. The final transaction rechecks owner history and all create-only preconditions, derives the initial trial time from its Firestore snapshots' `readTime` (never the workstation clock or preliminary transaction), and creates exactly four planned documents. Trial length is exactly 2,592,000,000 milliseconds. A transaction retry keeps the originally recorded server time.

Firestore [BatchGet read metadata can vary across responses](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/batchGet); timestamp equality is not a transaction-isolation test. [Firestore provides serializable transaction isolation](https://firebase.google.com/docs/firestore/transaction-data-contention) independently of those metadata values. The operator selects the latest valid server `readTime` from the four document snapshots and owner-query snapshot in the final create transaction, flooring it to milliseconds before first persistence. Missing, nonnumeric, nonfinite, nonpositive or unsafe timestamps still refuse application. Once saved, that original trial time is retained even if later attempts observe newer timestamps. A receipt with confirmed successful revocation and no trial time can resume from fresh final-transaction reads without revoking again.

Retry success requires the original local receipt, successful revocation evidence, and exact matches for **all four** original documents and trial times. It never resets a trial, repairs changed/partial records or revokes again when the exact original enrollment is already committed. Missing documents after a completed receipt are refused. Keep the receipt private and backed up; losing it requires operator investigation, not a fresh trial.

The CLI exclusively creates a local `.lock` beside the receipt, atomically replaces/fsyncs receipt updates with mode `0600`, and releases the lock on ordinary completion. A process crash may leave a lock: investigate the receipt/cloud state before manually removing it. Implementation and synthetic tests do not themselves enroll real users. A separate owner-approved run subsequently created the four intended enrollment documents and completed with the original receipt, preserving successful Auth revocation and the exact trial. Its phone bootstrap has matching server challenge/session evidence and an owner home-open report; the owner also reported offline reopening without login. Every other target still requires its own identity/history/phone checks and specific approval. See [the test report](../../docs/test-results.md) for the remaining business-operation checks.

## Required employee-feed composite index

`backend/src/gateway.mjs` uses an `employeeChanges` query combining equality on `uid` and a range/order on `sequence`. Its required definition is already in `backend/firestore.indexes.json`:

```json
{
  "collectionGroup": "employeeChanges",
  "queryScope": "COLLECTION",
  "fields": [
    {"fieldPath": "uid", "order": "ASCENDING"},
    {"fieldPath": "sequence", "order": "ASCENDING"}
  ]
}
```

Worker publication does not publish this Firestore index. Local emulator success does not prove a matching production index exists. Before approved employee onboarding, inspect the explicit project's current indexes and require this definition to be **READY**. If absent, prepare a separate additive index-only change for review. Preserve other indexes and the old website's rules; do not publish this backend's deny-all rules as part of index setup. No live index inventory or index change was performed by this tool.

## Verify locally

```sh
cd tools/production-operator
npm test
```

Tests use generated public keys, synthetic local requests and injected in-memory clients. They cover malformed/mismatched devices, explicit target and emulator refusal, unknown fields, create-only/deferred trial/revocation boundaries, bounded input, private exclusive output and symlink refusal, final-transaction prior-owner checks, exact idempotency, lost commit responses, uncertain Auth revocation, changing live owner state and local receipt-persistence failures. Clock regressions cover unequal document/query metadata, final-transaction-only time, invalid timestamps, successful-revocation/null-trial recovery and preserving the first saved trial across newer retry reads. A fully specified application CLI with missing consent is tested to refuse before parsing credential stdin or creating a lock/receipt. The default planner CLI is also run with Node filesystem-write permissions withheld and network/process calls trapped. No real account, private credential, network call or cloud write is used; these tests do not prove production IAM or server transaction behavior.
