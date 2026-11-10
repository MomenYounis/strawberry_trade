# Annual backend continuation: local implementation and exact limits

This document records the renewed local backend work verified on 3 November
2026. It supplements the commercial readiness decision; it does not approve
production deployment, automatic closing, billing, storage provisioning or
destructive cleanup. All test financial records are synthetic. The public
gateway deployment package remains separate from the private Node annual
runtime and the synthetic-only recovery quarantine.

## Completed implementation

The concrete private annual engine now connects bounded Firestore tenant/run/
party inventory, reviewed opening-date evidence, the fenced close state machine,
encrypted resumable source preparation and a streamed export/independent restore.
`createFirestoreAnnualEngine` supplies the actual scoped Firestore adapters.
Construction performs no I/O. All scheduler/export/financial-close/production
acceptance gates remain off by default. No scheduler is registered, and this
engine supplies no prune or delete capability.

The catalog uses stable document-ID pagination, bounded record and byte budgets,
and an exact root recheck after reading opening parties. Disabled or deleting
tenants are skipped. The state store rechecks the active root and lease in every
mutation transaction, including checkpoint, renewal and verification. A tenant
deactivated after selection cannot publish a close or manifest. Reviewed party
hashes and a checkpoint sequence bind the opening-date attestation to the actual
facts. Missing dates and within-year balances are refused; no date is invented.
Verified prior financial years remain valid predecessors while optional cleanup
is pending. Tests preserve cross-year invoice references and prospective salary
terms without moving held historical salary debt into a prior close.

Preparation now reads each accepted source change once in bounded pages at a
fixed closing sequence. It persists authenticated, encrypted, content-addressed
source pages with a fenced O(1) progress pointer, instead of repeatedly querying
the entire Firestore prefix for every archive chunk. A private Node job rebuilds
the SQLite projection from those encrypted pages once per invocation, streams
archive records, persists each chunk and independently restores before marking
verification. A restarted invocation authenticates and replays persisted work;
the first uninterrupted pass is linear in source queries. Deadline, shared quota,
lease, payload, page, record, manifest and export limits remain enforced.

The shared-engine cost model reserves transaction retries and worst-case
immutable collision reads. Mirrored storage reserves both writes and both
readbacks. Unknown/cyclic storage graphs are refused. The separate
[private Node R2 transport](../backend/private-archive-runtime/README.md) closes
the gap between Node execution and the Worker's R2 binding API, using an isolated
pinned official SDK package. Its real HTTP transport tests cover signing,
conditional immutability, byte bounds, timeouts, unknown write outcomes,
persisted restart and mirrored recovery. Every storage adapter continues to
report `productionDurabilityAccepted: false`.

## Reproducible evidence

Commands below run from `backend/`. Their exact command/exit metadata and logs
are under `verification/continuation-2026-11-02/backend-completion/`.
Overlapping unit suites are reported separately and must not be added together
as a unique assertion count.

| Requirement | Result | Evidence / reproduction |
|---|---|---|
| Current backend unit suite (including recovery coordinator) | **PASS 220/220** | [Nov 8 coordinator and backend receipt](../verification/continuation-2026-11-02/final-review/recovery-coordinator-integration-nov8.json); `npm test` |
| Archive, calendar, source preparation, state, scheduler, catalog, recovery coordinator and private scratch unit coverage | **PASS 196/196** | [Nov 8 coordinator and backend receipt](../verification/continuation-2026-11-02/final-review/recovery-coordinator-integration-nov8.json); `npm run test:archive` |
| Real Firestore catalog, actual transactional close/lease, deactivation before export, exact source/control verification | **PASS 3/3** | [guarded combined integration log](../verification/continuation-2026-11-02/backend-completion/annual-catalog-and-quarantine-real-firestore.log); `npm run test:annual-engine` |
| Encrypted tenant-state image and disabled quarantine restore | **PASS 18/18** | [quarantine v2 integration receipt](../verification/continuation-2026-11-02/final-review/recovery-quarantine-integration-final-v2.json); `npm run test:tenant-recovery` |
| Whole-system recovery coordinator and guarded demo activation | **PASS 4 unit + 4 emulator integration suites (76 local recovery tests)** | [Nov 8 coordinator receipt](../verification/continuation-2026-11-02/final-review/recovery-coordinator-integration-nov8.json); `npm run test:recovery-local` and `npm run test:recovery-coordinator` |
| Current financial/permission/invitation integration, including manager salary-reason evidence | **PASS 41/41** | [financial integration log](../verification/continuation-2026-11-02/backend-completion/financial-invitations-current-source.log); `npm run test:invitations` |
| Concrete private Node SDK storage transport plus annual export/restore integration | **PASS 11/11** | [SDK transport log](../verification/continuation-2026-11-02/backend-completion/node-r2-sdk-transport-final.log); `npm run test:node-r2` |
| Isolated SDK package clean exact-lock install | **PASS**, fresh private directory, offline, scripts disabled | [clean install log](../verification/continuation-2026-11-02/backend-completion/node-r2-clean-lock-install.log) |
| Isolated SDK package production-dependency audit | **PASS**, zero reported advisories at this run | [scoped audit JSON output](../verification/continuation-2026-11-02/backend-completion/node-r2-sdk-production-audit.log); this is not an audit verdict for other packages |
| Frozen compatible gateway source and artifact identity | **PASS**, all 20 source files and both tarballs match | [current-source hash check](../verification/continuation-2026-11-02/backend-completion/deployment-artifact-current-source.json); [deployment package/runbook](compatible-backend-deployment.md) |
| Concrete Node storage recognized by downstream cleanup gates without granting acceptance | **PASS**, pruner 15/15, all actual Node adapters remain unaccepted | [targeted cleanup gate log](../verification/continuation-2026-11-02/backend-completion/node-r2-cleanup-gates-final.log); unknown/mirrored kinds and missing acceptance/approval are still refused |
| Normal controller offline license import and role-change quarantine | **PASS**, 3 new cases; combined controller/license suite 54/54 | [before: both defects reproduced](../verification/continuation-2026-11-02/backend-completion/controller-license-import-before.log), [after](../verification/continuation-2026-11-02/backend-completion/controller-license-import-final.log) |
| Real provider storage durability, independent administrative copy and key-custody recovery | **BLOCKED**, no accepted environment/custody evidence | Local HTTP, workerd and synthetic directories do not establish this |
| Production automatic annual close | **BLOCKED / NOT RUN** | All activation/acceptance gates remain disabled |
| Production destructive cleanup | **BLOCKED / NOT RUN** | No cleanup capability is supplied by the engine; existing cleanup gates stay disabled |

The real integration harness requires the exact demo project and reserves
Firestore 18180, Auth 19199 and Functions 15101 before starting. It refuses
occupied ports and removes only its own temporary emulator configuration. The
catalog fixture now uses explicit ephemeral synthetic credentials and an
emulator-only owner token; it does not discover ADC or contact metadata services.
The archive unit script explicitly excludes integration fixtures, so it does not
try to run guarded Firestore tests outside their required harness.

The integration review also confirmed and fixed two controller authority defects:
an authentic disabled license imported while offline left exposed financial lists
and cached store handles readable, and an authentic changed role could coexist
with an operational database opened under the previous manager role. Import now
immediately revokes disabled handles and quarantines a changed role before
persisting its disabled-account marker. A failed marker write remains denied.
The same database and queue/draft bytes are retained. Offline older or newer
manager files do not clear the role quarantine, and trusted responses that still
disable the account or mismatch the stored role remain denied. A fresh matching
trusted certificate can clear the authority marker; a new correctly scoped handle
can then read the preserved queue/draft. This unit evidence does not claim a
manager database can be converted to an employee database: the immutable database
scope refuses a changed role/employee ID, and no automatic role migration is
implemented. Actual business API operations only activate/deactivate membership.

## Annual data volume and growth

The 73,000-entry prepared export passes with 731 source queries for 73,001
source changes, 575 archive chunks and 173,692 KiB maximum process RSS. Its
independently expected receivable is 3,660,000 minor units and recorded cash is
3,650,000. [73,000-entry measurements](../verification/continuation-2026-11-02/annual/prepared-73k-final.log).

The renewed growth run passes with **80,300 annual entries**, 804 source queries
for 80,301 source changes, 40,101,896 prepared plaintext bytes, 632 archive chunks
and **167,304 KiB maximum process RSS**. Preparation takes 49.8 seconds and export
plus restore 62.7 seconds; the independently expected receivable is 4,025,000
minor units and recorded cash 4,015,000.
[Growth measurements](../verification/continuation-2026-11-02/backend-completion/prepared-archive-growth-80300.log),
[exact command](../verification/continuation-2026-11-02/backend-completion/prepared-archive-growth-80300-command.json).
Reproduce with `node --max-old-space-size=384 test/archive-prepared-scale.fixture.mjs --records=80300`.

These runs use a private Node runtime with a tested 512 MiB envelope and local
synthetic directory storage. They do **not** qualify a 128 MiB Worker or a real
provider, and are not capacity proof for the 500,000-record format ceiling.
The reported cost reservations are logical conservative reservation requests,
not measured provider bills. The shared budget adapter centrally reserves its
own bounded transaction overhead; the engine does not charge it twice. Failed
admission may still incur reads without a committed reservation, so observed
provider headroom remains necessary. The public Worker import-closure package excludes
this SQLite/source/preparation runtime.

## What the server recovery image actually proves

`tenant-recovery-quarantine.mjs` implements a synthetic-only encrypted tenant
state image, with authenticated context/manifest/pages and a fixed inventory of
the tenant root and all 25 currently supported child collections. This retains
operation receipts, return counters, reversal/review/salary/late-correction locks,
pending submissions, memberships/devices and archive metadata in addition to
financial records. It never recreates an Auth user, license, device key or trial.

The source is explicitly a quiescent synthetic repeated scan. Nested, unknown,
orphan-parent and unsupported-type data are refused rather than silently omitted.
The actual emulator may ignore a projection; inventory therefore loads at most
one document and caps the HTTP response at 1 MiB before JSON decoding and before
the SDK payload read. The image has separate record, page, total-byte and
manifest limits. Staging commits one authenticated page and its progress journal
atomically. A crash after any page, including the final page before verification,
resumes without duplicate creates. Existing target data is never overwritten.

Restoration writes only under the separate
`tenantRecoveryQuarantine/<imageId>/tenants/<tenantId>` prefix, with both
`enabled:false` and `activationAllowed:false`. Every supported source document is
reconciled against its logical payload hash and total inventory. Tests exercise
wrong key/context, changed/missing pages, altered manifest/journal/target,
concurrent restorers, source drift, oversize data and production/remote boundary
refusal. The original tenant remains unchanged and Auth users are unchanged.

The preceding synthetic importer remains separate and unchanged. The new
[`firestore-recovery-source.mjs`](../backend/src/firestore-recovery-source.mjs)
adapter reads an explicitly scoped provider REST source at one fixed `readTime`,
including root, document pages and missing-parent/collection inventory. It
preserves provider create/update times and refuses an expired window rather
than falling back to live reads. Its distinct encrypted image and reader bind
source metadata, full-stream hashes, bounded pages and a re-derived UID/object/
key dependency plan. The [19-test receipt](../verification/continuation-2026-11-02/final-review/recovery-capture-final.json)
records local source/image/plan verification; production source-consistency
acceptance remains false.

The separate provider-image bridge now restores into
`firestoreRecoveryQuarantine/<imageId>/tenants/<tenantId>` only on the guarded
dedicated demo emulators. It retains disabled wrapper authority, uses bounded
create-only transactions and an exact-prefix journal, checks committed records
before continuing, and re-inventories the complete target before verification.
Tests include actual child-process SIGKILL/resume and ensure committed revisions
are not rewritten, byte-sized batches, root-only images, racing restorers,
hostile journals and extra/orphan/nested target refusal. See the
[bridge receipt](../verification/continuation-2026-11-02/final-review/recovery-quarantine-integration-final-v2.json),
[full output](../verification/continuation-2026-11-02/final-review/recovery-quarantine-integration-final-v2.log)
and [capture/restore contract](server-recovery-capture.md).

This is **not whole-system production disaster recovery**, though the bound local coordinator and guarded demo activation in [`recovery-coordinator.mjs`](../backend/src/recovery-coordinator.mjs) now pass (**4 unit + 4 emulator integration suites**, [receipt](../verification/continuation-2026-11-02/final-review/recovery-coordinator-integration-nov8.json)) across object-byte copy, financial quarantine, disabled Auth/operator recovery, and transition from verified quarantine to an operational recovered tenant in the isolated demo environment. Actual provider consistency, accepted independent storage, live SCRYPT sign-in verification, and key custody have not been exercised against an approved isolated cloud target (`productionRecoveryAccepted: false`).

| Remaining blocker | Completed locally | Why the environment cannot complete it | Smallest next action |
|---|---|---|---|
| Production-consistent source acceptance | Explicit fixed-readTime REST adapter, provider metadata, encrypted image, strict dependency plan and disabled image-to-quarantine bridge | Local provider-shaped fixtures and emulators do not qualify actual provider consistency/PITR, credentials or durability | Identify an approved existing test database and scoped read-only credentials; authorize its capture/recovery rehearsal and verify PITR capability when required |
| Auth, operator authority and production activation qualification | [`recovery-coordinator.mjs`](../backend/src/recovery-coordinator.mjs) binds object, financial, and Auth/operator layers and executes guarded demo activation to an operational tenant (`test:recovery-coordinator` **PASS 4/4**) | Production activation remains gated off (`productionRecoveryAccepted: false`); live Firebase Auth SCRYPT password sign-in verification and hardware/issuer key custody require an approved isolated target | Authorize an isolated staging/DR Firebase project and issuer/key custodians for a controlled drill verifying live SCRYPT sign-in and license re-issuance |
| Archive/snapshot object and key recovery | Immutable conditional storage transport, both-copy readback, local loss/corruption/restart tests and coordinator object phase | No accepted real bucket/copy/retention or key-escrow drill exists here | Provide approved existing storage/copy resources and key custody; authorize only the scoped test drill after reviewing its plan |
| Dated opening balances | Exact party hash/checkpoint binding and explicit refusal for missing/within-period dates | The software cannot invent the business's historical effective dates | Review the dated-opening plan for each nonzero opening balance; within-period amounts require a separately reviewed dated-posting migration |
| Private production annual runtime | Bounded concrete engine, SDK transport and 73,000/80,300-entry local measurements | No accepted private Node deployment, encrypted scratch volume or production credentials/configuration are available | Approve a specific existing private runtime and its encrypted scratch/custody configuration before a separately approved rehearsal |
| Production scheduling/close/cleanup | Default-off gates, active-root/lease fences, finite recovery/export jobs and independent financial verification | Activation changes financial policy and cleanup can destroy data | After the preceding acceptance evidence is reviewed, approve the exact production action separately; no blanket activation is implied |
