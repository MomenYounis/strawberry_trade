# Annual archive operations and recovery

Campaign began 2026-11-01; final local handoff 2026-11-02 (Africa/Cairo).
Date: 2026-11-01. **Local candidate under review. No production schedule, financial close, archive storage, cleanup or deployment was enabled.** See `implementation-progress.md` and `commercial-release-readiness.md` for precise executed evidence. This runbook is not approval to perform production commands.

## Calendar and initiation

Africa/Cairo civil dates define `[YYYY-09-01, (YYYY+1)-09-01)`. First year is 2026, eligible at Cairo midnight 2027-09-01. Date-only entry fields select the financial year by their civil date. Client creation time, server acceptance time and monotonically increasing tenant sequence are separate evidence. Only trusted server time decides eligibility; never close using a phone clock. Existing records have effective `date`; historic client creation time is not universally captured and cannot be reconstructed honestly.

Proposed UTC cron: `17 * * * *` (hourly, minute 17), gated each time through the runtime IANA Africa/Cairo timezone. Under current rules Cairo is UTC+3 on September 1; first check is normally 21:17 UTC August 31 = 00:17 Cairo September 1. Under a future UTC+2 September the first check becomes 22:17 UTC. The minute17 gate avoids a fixed offset assumption; update/pin runtime tzdata and test actual annual boundary before enablement. Clock skew or missed invocation defers to the next check. Year authorization/state is durable, so recovery is idempotent; expired leases are fenced. An already started run may recover; never silently initiate unstarted missed years. Operator must select a reviewed ordered backlog explicitly. Prior close verification is a dependency of the next close.

`tools/annual-review/config.review.json` is an inert review artifact. Source defaults separately disable scheduling, export, and cleanup; 90-day post-verification grace and zero delete budget are proposed. There is no live scheduler binding or enabled cron in Wrangler configuration. Budget configuration alone does not implement provider-aware quota enforcement.

## Local verification (synthetic only)

From the writable clone `/home/younis/strawberry-trade-annual-review`:

```sh
# No cloud credentials required by these unit suites.
cd backend
npm ci --ignore-scripts --fetch-timeout=20000 --fetch-retries=1
npm test
npm run test:archive
npm run test:integration
# From backend/worker, separate dependency tree:
cd worker
npm ci --ignore-scripts --fetch-timeout=20000 --fetch-retries=1
npm test
npm run dry-run
```

Check actual status logs; the commands are not a claim of success. The integration wrapper must first validate a `demo-*` project, reserved loopback ports, absence of production emulator overrides and endpoint identities. It uses a private disposable copy/config and session-only signing material, not `backend/.secret.local`; it must refuse occupied ports rather than clear an unrelated emulator. Production credentials/ADC must not be used. If emulator binaries/downloads are unavailable, record BLOCKED; never run fixtures against default Firestore.

## Concrete production prerequisites and approval boundaries

1. Engineering completes outstanding automatic source controls, active snapshot installation, compatible outbox upgrade and all financial/dependency checks. Release evidence must identify the actual reviewed commit and no unintended content changes.
2. Owner/storage administrator chooses durable private R2 or another approved storage arrangement. R2 requires a subscription/checkout; do not activate billing or create a bucket under this mission. Supply read-only evidence of the account's existing availability and approved budget. No public bucket/r2.dev route.
3. Security/key custodian provides an existing separately approved archive encryption key lifecycle. Use archive-specific keys, distinct from APK signing/license issuing/device keys. Do not create a production key opportunistically. Key IDs are public metadata; key bytes never enter manifests/APKs/source/logs.
4. Custodian establishes tested recovery escrow outside the phone and outside the storage account's failure domain: two authorized custodians, documented recovery on phone loss/owner credential changes, sealed key recovery, independent storage-provider/account access and restore drill. Exact mechanism, locations and custodians belong in private operational records, not this repository.
5. Engineering stages the real adapter under a synthetic tenant using the same supported infrastructure class. Re-download exact immutable bytes, authenticate/decrypt through the restore reader into private isolated scratch storage, compare identities, controls and source checkpoint. No real account creation/posting/notification during verification. Production scratch requires encrypted storage, minimum permissions and startup crash-cleanup; developer temporary files alone are insufficient.
6. Obtain approval for the exact additive server deployment and compatible signed client rollout. First verify old clients preserve queues and receive actionable upgrade/resync messages. An old APK with a stale cursor is not safely compatible merely because an endpoint still responds.
7. Obtain separate approval for a named tenant/year export-only production dry run and redacted reconciliation report. It must specify whether an effective financial close is included: even without deletion, publishing a closed-period boundary changes acceptance policy and needs owner review.
8. Automatic financial closing requires its own explicit approval after verified recovery, exact accounting controls, pending submission policy and operational budgets. Cleanup requires a later distinct approval naming each collection, retained dependency evidence, byte/document counts, grace expiry, source hashes/revisions and supported client fleet.

The exact existing-gateway deployment command is prepared in `rollout-commands-review.md` for separate approval after account/config/source verification. It has not been executed. No storage/financial-close/cleanup apply command is fabricated before its prerequisites exist. Do not copy placeholder tenants or buckets into live commands.

## Close/export/verify lifecycle

The implemented persisted run progresses `eligible -> checkpointed -> exporting -> uploaded -> verified -> cleanup_pending`. Future `pruning -> complete` transitions require an unimplemented conditional deletion runner and snapshot protocol; they remain blocked. A transaction captures root sequence and closing version while updating the acceptance boundary. New-year writes continue normally and receive later sequences. Read immutable change records through that fixed sequence, not mutable party/submission pages. A bounded export step records its immutable chunk descriptors and cursor under a current lease. Retry reuses matching source identity only after authenticating and decrypting stored chunks with the original key/context. A changed key or key ID fails before further uploads/publication and preserves original-key recovery; never rotate keys within an in-progress run. Changed source or mismatched controls also blocks publication. Source/control ordering is deterministic across host locales.

Each lease has owner, expiry and increasing fencing token. Reacquisition after a crash changes the token. All authoritative progress, manifest publication and cleanup checks must compare the stored token and expiry. Stale uploads may leave unreferenced encrypted objects; they cannot become an authoritative publication. Delete orphan temporary objects only by a separately reviewed prefix/run inventory after proving no active/verified manifest references them and the retention period expired. No automatic broad bucket deletion.

Verification must read the stored content-addressed manifest/chunks again, validate tenant/year/schema/order/limits, verify HMAC and GCM tags, restore through the same strict reader into an isolated store, and reconcile with independently trusted checkpoint controls. Upload acknowledgments/ETags never satisfy verification. Keep verifier version, manifest hash, checkpoint/version and test result. Anchor a signed/exported evidence digest in a separate administrative trust domain when feasible; a database-internal hash chain cannot resist an administrator rewriting all its members.

Manifests contain authenticated but unencrypted account controls. Restrict their storage and download permissions as private financial data. Never attach real manifests or financial reconciliation output to a public issue or ordinary diagnostic log.

## Late work and corrections

Default policy for owner review before enablement: historical reopening/restatement is excluded. Server retains closed-period financial operations with original operation ID, payload/digest, actor, business date, receipt time, close version and `needs_review`. The transport result is not financial acceptance. Client preserves the operation and exposes actionable blocked status; accepted totals must exclude the held provisional effect. A manager may explicitly post one linked adjustment in the current open period, keeping the original business date in provenance and the current posting date in accounting. Exactly-once server locks prevent a second financial adjustment from another device/retry. Employee pending submissions remain pending; rejection is nonfinancial, approval after close must explicitly select an open-period correction. Do not auto-approve, rewrite the source payload or keep retrying an immutable closed-period refusal.

Old invoices/return counters/reversal locks/party identities and receipts remain online in this candidate. Cross-year returns therefore still validate against authoritative facts during archive outages. An unavailable archive never authorizes bypassing limits or discarding an outbox operation.

## Historical view and complete-system recovery

Normal manager browsing uses `listArchives` and `readArchiveRecord` with verified published pointers, bounded chunks and manager/session authorization before and after the read. Employee access is denied on the server. Archived data is read-only; repeated viewing/export does not call active ledger import. Lookup continues with an explicit bounded cursor, never an implicit whole-year download. Unconfigured storage is an explicit unavailable status.

Replacement phone recovery needs the **active data, pending operation evidence, trusted tenant identity, duplicate receipts and checkpoint metadata**, plus Auth/membership/device enrollment and available key custody. An annual financial package alone is not a full-system backup. Existing manager JSON backup is private financial plaintext and scoped to its tenant/UID; it does not contain Auth authority or device keys. It is not an archive import protocol. Never activate restored data until schema, tenant, immutable-ID collisions, sequence floor, manifest, keys and receipts have been checked in staging. Preserve provisional work and unsent stable IDs.

Complete archive+active-data disaster recovery and atomic active-snapshot client installation require fresh end-to-end evidence before cleanup. Tests of decoding archive records alone do not establish either workflow.

## Failure, disable and rollback boundaries

- Before any close checkpoint: disable scheduler/export, retain data and pending work; review eligibility/backlog. No published close exists.
- After checkpoint but before verified archive: stop job on failure, retain originals, closing metadata, queued late evidence and chunk progress. Resume with a new lease; do not silently reopen the boundary. Existing new-year writes remain valid.
- After verification before pruning: disable cleanup, retain all originals and immutable objects/keys. Fix verification/control discrepancies; do not mark mismatch as a warning.
- After pruning has started: stop further batches; preserve exact archive bytes, evidence, remaining documents and delete cursor. Already deleted documents require validated restoration or forward recovery. Do not claim originals are untouched.
- After cleanup: reverting an old APK/backend is unsafe unless tested with the history floor, snapshots, retained receipts and new metadata. Never reimport a historical year's entries into active balances or roll back a close by duplicating financial events. Retain the compatible protocol and restore required records under an explicit recovery workflow.

This candidate's production cleanup gate remains closed. Source defaults cannot stand in for production acceptance, storage availability, independent recovery or client-upgrade proof.
