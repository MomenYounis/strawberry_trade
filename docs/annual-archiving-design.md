# Annual archiving design and implemented boundary

Campaign began 2026-11-01; final local handoff 2026-11-02 (Africa/Cairo).
Date: 2026-11-01. This is an additive local candidate. **Scheduling, automatic financial closing and cleanup remain disabled.** Production storage/keys/recovery have not been accepted. Missing snapshot/pruner functionality below is an implementation gap, not an infrastructure test pass. No tenancy migration or new accounting product was performed.

## Model and effective dates

The APK keeps a scoped SQLCipher local ledger/outbox. Firebase Auth/App Check and device-proof sessions authorize a Worker forwarding to a singleton SQLite-class Durable Object. That object hosts the Firestore Admin SDK gateway; it does not hold a separate ledger database per business. Business isolation uses logical `/tenants/{tenantId}` paths in the existing shared Firestore database/project. Direct Firestore client rules deny all access; the Admin SDK gateway enforces its own authority.

Africa/Cairo civil dates define `[September 1, next September 1)`. The first annual package is 2026-09-01 through 2027-08-31; first eligibility is Cairo 2027-09-01 00:00. `archive-calendar.mjs` uses IANA timezone conversion from trusted server milliseconds. No hardcoded UTC offset or phone-clock authorization. Date-only business fields select a year by their literal validated civil date. Current postings use `date`; corrections also retain `originalBusinessDate`. New authoritative changes record `acceptedAtMs`, tenant `sequence` and closing version. Historic acceptance times/client creation times are not invented where absent.

Default proposed UTC cadence is `17 * * * *`, hourly minute 17, normally 00:17 Cairo September 1 under current September DST. Future offset changes are handled by the Cairo gate rather than annual UTC constants. See operations for missed invocation/backlog handling. No runtime cron is installed. `selectArchiveYears` recovers already started runs, reports unstarted missed years and requires explicit ordered administrator selection; no archives before first year.

## Consistency, closing and fencing

`ArchiveStateStore` with `FirestoreArchiveStateAdapter` reads tenant root and `/archiveRuns/{year}` in a bounded transaction. `checkpoint()` requires explicit trusted close/export authorization, active tenant, eligibility and prior-year verification. It captures root sequence C and closing version V while setting the closed-through boundary on the same root that every financial acceptance transaction reads/updates. Concurrent acceptance serializes with that checkpoint. Subsequent accepted operations receive sequences after C; new-year trade is not locked during export.

`immutableChangesAtCheckpoint` reads bounded ordered pages with `sequence > cursor AND sequence <= C`. Each sequence must be contiguous through C. Accepted financial/directory facts are immutable; submission state changes append full new change payloads. A private SQLite projection replays this frozen feed to reconstruct submissions as they stood at C. Paginating live mutable collections is never used as a snapshot. Root/manual administrative writes outside the gateway are outside this proof; migration/provisioning/audit metadata required for a whole-system backup must be retained separately. The source reader refuses missing history or rewritten immutable IDs.

Each lease has owner, expiry and a monotonically increasing fence. Every authoritative checkpoint/progress/publication/verification transition checks the current persisted fence and expiry. A stale process may finish an immutable object upload, leaving an unreferenced object, but cannot publish the pointer or advance the job. Tests replace an expired runner and deny stale checkpoint, publication and advancement. No unbounded transaction spans export/upload.

Supported durable states are `eligible -> checkpointed -> exporting -> uploaded -> verified -> cleanup_pending`. `pruning`/`complete` are named future lifecycle states; **a conditional deletion runner is not implemented and no completed cleanup is claimed**. `cleanupBlockers` always includes `pruner-not-implemented` in this revision. Retry classifications/time, chunk progress, manifest pointer and verification evidence are stored separately. Close version increments once per tenant/year. Export retry does not create another close.

## Default closed-period policy

Owner review is required before enabling this policy. Historical reopening/restatement is excluded. Late accepted-transport financial submissions become durable `lateOperations` with full original operation/payload/digest/ID, original business date, actor, server receipt time, reason, close version and `needs_review`; no financial entry, approval or sequence is created. Receipts explicitly distinguish transport retention from financial acceptance. Client outbox evidence is retained, blocked from automatic retry, exposed for manager review and excluded from displayed financial effects after the hold is known.

Pending employee submissions remain pending. Rejection remains nonfinancial. Old-date approval is held; an explicit manager correction posts matching financial facts in the current Cairo open period with a new immutable entry ID and linked original operation. Original business date and posting date remain separate in source, local columns, reports, CSV and PDF. A transactional correction lock makes this exactly once, including retries and another device attempting a second correction. A repeated historical view has no posting path.

Backdated salary terms also affect obligations, so historical terms are held without creating the salary term or month lock; the client preserves evidence and excludes the held term from active obligation display. **The manager correction UI currently supports entry/approval corrections; resolution of held salary-term evidence is not implemented.** A separately reviewed current-period salary-policy workflow is required before automatic closing can be accepted. Undated original party baselines likewise require owner policy review rather than invented effective dates.

## Collection-by-collection retention matrix

All deletion eligibility below is **NONE in this revision**. “Future candidate” describes dependencies for later reviewed work, not an implemented pruner or permission to delete by age.

| Collection / data | Annual package contents | Online retained / active projection | Future deletion constraints and rationale |
|---|---|---|---|
| tenant root | financial interval, sequence/version and previous-close linkage, not credentials | whole root, entitlement, counters, close policy/history floor | Never age-prune tenant identity/current authority/checkpoint |
| `entries` | accepted in-period financial/shipment records; explicitly typed historical references for returns/reversals | all original entries | Original invoices, unpaid obligations, return limits, reversal/shipment references and old clients require them; no stubs substitution implemented |
| `parties` | frozen party context and role-specific signed opening controls | all parties/current identities | Creation date is not a retention criterion; baseline/permission/reference dependencies |
| `employees` | frozen directory context | all employees, including historical identities | Payroll, submission attribution and authorization references |
| `salaryTerms` | frozen effective-month terms plus known monthly obligation controls | all salary history | Needed for old salaryMonth payments and missing-history validation; no fabricated accruals |
| `submissions` | checkpoint snapshot of status and payload in separate nonfinancial records | all pending/approved/rejected submissions | Pending never approved/discarded by archive; employee recovery/status and review dependency |
| `reviews` | checkpoint review evidence, separate from financial entry | all decisions | Approval attribution, original facts and review status |
| `operations` | not a complete system receipt backup in annual format | all operation digest/results indefinitely | Durable dedup for months-offline devices; no enforced age horizon, so no receipt age pruning |
| `changes` | used as immutable source through C; package stores reconstructed financial/context identity rather than a complete raw feed dump | full manager feed | Future pruning requires verified tenant snapshot, protocol floor, atomic client install, outbox reconciliation and fleet acceptance; absent now |
| `employeeChanges` | no full manager package access for employee | full sanitized per-user/all directory feed | Employee snapshot must be server-projected; never send manager records and rely on UI filtering |
| `returnCounters` | controls/references are not a replacement for authoritative counter backup | all cumulative return quantities/value | Never delete while original invoice could be returned; archive outage cannot bypass validation |
| `reversalLocks` | financial source/reference effects; lock backup separate | all locks | Prevent repeat reversal and invoice-return bypass |
| `shipmentCounters` | shipment records in financial interval | all order counters | Prevent out-of-order/replayed nonfinancial side effects |
| `reviewLocks` | decision context | all locks | Exactly-once approval/rejection protection |
| `salaryLocks` | salary-term context | all locks | Prevent duplicate historical effective-month definitions |
| `lateOperations` | not treated as accepted annual ledger entries | all original late evidence and resolution status | Recoverable needs-review queue; no automatic age discard |
| `lateCorrectionLocks` | correction links appear on accepted entries | all locks | Prevent a second current-period financial posting for one original held operation |
| `conflicts` | not a complete conflict-evidence backup | all original/local/remote conflict evidence | Explicit resolution and audit dependencies |
| `audit` | archive identity/control evidence is additional, not a replacement | all immutable operational/financial audit | Do not lose actor/authorization/correction/duplicate dependencies |
| `members` | excluded from downloadable annual financial package | all current membership/role/epochs | Security authority, never restore from an ordinary archive view |
| `employeeAccounts` | excluded | all account-to-employee bindings | Invitation and revocation dependencies |
| `devices` | excluded | device enrollment/proof state | Current identity/key binding; not removed for old creation date |
| `sessions` | excluded | valid session/revocation state | Separate expiry policy only; no annual date cutoff |
| `challenges` | excluded | proof/audit dependencies | Separate reviewed short-lived policy; annual cleanup does not delete them |
| `invitations` | excluded | pending/used/revoked evidence | Separate enrollment/abuse policy |
| `archiveRuns` | manifested context, controls and verification versions | all authoritative job pointers/progress/evidence | Retain after export/cleanup for browsing/recovery/fencing |
| `operatorArchiveBudgets` | excluded | shared quota reservation counters | Administrative budget state, not tenant-per-free-quota |
| top-level `adminEnrollmentHistory`, `adminTenantHistory`, `adminOperations`, `adminDeletions` | excluded | all operator/trial/deletion/idempotency evidence | Annual archive must not reset trials, enrollment authority or deletion history |
| local ledger/outbox/drafts/conflicts/keys | not automatically compacted | all local pending/required records | Server export never wipes phone data or resets its cursor; local compaction is separate |

Residual online storage is intentional. This candidate saves **zero** online storage through cleanup. Five businesses still share project/account quotas. See capacity report for growth and safe-retention estimates.

## Accounting controls and immutable package

`archive-projection.mjs` is private Node tooling using isolated SQLite, not imported by the Worker. It reconstructs the source with BigInt accounting. Source controls and strict reader controls separately include sorted role/account openings, period effects, closing balances, signed receivables/payables, payroll paid-by-month/known obligations, period totals, period and cumulative recorded cash movement, pending submission count, snapshot/source counts and identity digest. Ordering uses explicit code-unit comparisons; locale-specific collation must never affect identity or resumability. English/Turkish subprocess regressions cover mixed-case IDs. Hand-calculated fixtures assert the actual values. Carried values are baselines, never financial postings. Active reports still use complete history; no double-baseline install is performed.

Format/schema version 1, archive protocol 2 (distinct from supported sync protocol 1). Context includes tenant/year/run ID, sequence/version, prior manifest hash, key ID and creation time; interval is explicit Cairo civil half-open dates. Canonical manifest body records algorithm/version, ordered chunk descriptors, plaintext/ciphertext SHA-256, byte lengths, counts and controls. HMAC authenticates the manifest; ciphertext chunks use established Node AES-256-GCM with random 96-bit nonces and separate per-run/per-index HKDF-SHA256 keys. Tenant/run/key ID and purpose bind key derivation; context/index bind AAD. Master key bytes are caller-supplied private runtime material and never enter source, ordinary manifests, APKs or logs. No production archive key was created. Rotation uses new key IDs/runs and retained recovery ability for old keys; provider re-encryption alone does not rotate archive encryption.

The manifest is authenticated plaintext metadata: its controls include account IDs and balances. Chunk encryption does not hide those controls. Treat manifests and run evidence as private financial data under the same restricted storage/access boundary; do not publish them as harmless hashes. A requirement to conceal financial controls from the storage provider would need an additionally encrypted manifest envelope and separate authenticated discovery metadata before acceptance.

Resume authenticates every reused ciphertext chunk with the supplied key and full context, then compares the exact decrypted plaintext with the replayed source before appending objects or publishing. Matching ciphertext hashes alone are insufficient. A changed master key or key ID fails while the persisted run remains `exporting` with its original progress; retrying the original key can complete. Rotation during an existing run is unsupported. Two coordinator regressions prove this recovery property.

Limits: default 64 KiB chunks, maximum 128 KiB, record 24,000 bytes, manifest 512 KiB, at most 1,024 chunks/64 MiB ciphertext and 500,000 records. Progress documents cap at 500 KB, below Firestore's 1 MiB document limit. Accounts cap 10,000 and payroll months 20,000; manifest size may impose a smaller practical envelope. All limits fail closed. The constrained-heap fixture exported/restored 73,000 entries (38,612,546 ciphertext bytes; 593 chunks); peak RSS 161,512 KiB exceeded Worker 128 MiB. This is private Node evidence, not Worker runtime acceptance. Peak annual volume/long notes can exceed package limits. Source replay caps 500,000 cumulative changes; future years need an incremental retained checkpoint rather than unbounded full replay.

`runArchiveExportStep` requires a fenced already-authorized checkpoint and a shared budget reservation. It creates at most four new chunks per step by default, persists progress, and resumes by validating/replaying the immutable prefix. This is bounded new upload work but prefix reconstruction/replay CPU and reads grow with history. It is **not an efficient production Worker scheduler**; no such handler is wired. Budget defaults deny; measured live headroom monitoring is absent. Bounds and deferral prevent unsafe deletion, not quota-free completion.

## Storage, restore verification and access

R2 was evaluated first using dated official sources in the capacity report. `R2ArchiveStorage` uses a private binding, conditional `If-None-Match:*` content-addressed objects, bounded body reads and timeouts. It makes no ETag-as-verification assumption or historical-version-retrieval promise. On timeout it cancels active bodies and cancels a late returned body. A timed-out put may complete as an unreferenced immutable object, which is safe to retry but still consumes budget. R2 production durability acceptance is deliberately false pending real storage/recovery acceptance. Source Worker config contains no R2 binding and no live availability was observed. Subscription/billing activation remains unauthorized.

Synthetic in-memory and private synthetic-directory adapters support local tests. Neither can satisfy durable production archive or independent-backup gates. Private temporary plaintext SQLite/restore files are development-only and securely scoped/cleaned on ordinary completion/failure. Process-kill cleanup, encrypted private production scratch storage and a startup sweeper require implementation/acceptance before real financial verification.

Independent verification re-downloads immutable bytes through `readArchiveManifest`/`readArchiveRecords`, checks canonical UTF-8/schema/limits/tenant/year/order/path/hash/HMAC/GCM, reconstructs into an isolated temporary sink, and compares trusted checkpoint controls/identities. Evidence binds verifier version, exact manifest hash, tenant/year/run/checkpoint/key and verification time. Upload response alone never advances to verified. Tests reject mixed financial years/tenants, invalid UTF-8, traversal, missing/reordered chunks, truncation, wrong key/tag and mismatched controls. No compression is accepted, removing decompression-bomb ambiguity. Verification creates no real users, financial postings or notifications.

Manager `listArchives`/`readArchiveRecord` authorize before and after the bounded read. Catalog pointers must be verified/published and match tenant/year/checkpoint. Four chunks/request by default; explicit continuation is required. Employee calls are denied server-side. No public bucket or signed URL is used. Flutter offers stable-ID read-only invoice/entry viewing and Arabic PDF/CSV; cached UI clears on authority/scope changes. **Complete archived party statements and indexed cross-year search are not implemented.** Ordinary viewing never calls active ledger import.

## Tamper evidence and disaster recovery

Hashes plus manifest MAC detect byte modifications under uncompromised key custody. An administrator able to replace metadata, objects and key authority can rewrite this evidence; a chain in the same mutable database cannot prevent it. An external signed evidence anchor and an independently controlled recovery copy/key escrow are prerequisites for the declared disaster-recovery model. Another mutable object under identical credentials is insufficient. Those arrangements are unavailable/unverified here; cleanup stays disabled.

An annual package lacks the complete Auth/member/device/license state, receipts, current data/deltas, late/conflict queues, counters/locks and key custody needed for whole-system recovery. Replacement-phone enrollment, current snapshot+deltas and archives+active metadata recovery are separate staged workflows. No historical archive import into active accounting or automatic reopening is implemented. Existing scoped manager JSON backup is a different workflow and contains private plaintext finance; it is not a substitute for a verified current-system backup.

## Explicit unfinished production gates

1. Efficient bounded scheduled orchestration, provider-aware measured headroom, larger segmented package/progress design and private production scratch recovery.
2. Supported archive-aware sync protocol with role-projected active snapshot, atomic/resumable client installation preserving unsent/provisional work and reconciliation by operation ID. Current protocol 1 deliberately advertises no pruning support; server historyFloor remains zero.
3. Conditional unchanged-record bounded pruner with persisted delete progress, lease/floor/dependency/backup/grace rechecks and mid-delete failure recovery. No delete code is hidden behind an easily flipped flag.
4. Complete archive+active-data disaster recovery and replacement-phone/old-APK upgrade evidence. Representative native storage migration, signed update and reboot are now verified on an isolated API35 AVD; normal account/business and replacement-phone recovery remain untested.
5. Real private storage/key-recovery/independent-copy/external-anchor acceptance, owner policy review (including undated openings and held salary terms), production dry run and separate enablement approvals.

These are release blockers. Production rollout/cleanup is a NO-GO even when local archive fixtures pass. See operations and commercial-readiness reports.
