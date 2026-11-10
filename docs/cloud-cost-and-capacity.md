# Cloud cost and capacity — 2026-11-07

Updated 2026-11-07 (Africa/Cairo), v12 continuation. The signed application source is `7058f24b2a85218fb96d88e435e0d3c5fce0e1c8`; backend, budget and deployment receipts identify their exact separate inputs. **No free-hosting guarantee or production cost saving is established.** Live R2 availability, bills, other account usage and production runtime capacity have not been observed. No billing, resource creation, deployment, schedule or deletion occurred.

Five businesses share one configured Firestore project/default database and Worker account. Tenant paths provide logical isolation; they do not multiply free allowances. The gateway's SQLite-class Durable Object hosts the Firestore Admin SDK gateway; it does not replace Firestore ledger storage. [Readiness](commercial-release-readiness.md) records the four separate release decisions.

## Dated primary references

Official documentation was checked **2026-11-05**. These are published limits and prices, not evidence of this account's entitlement or usage.

| Service | Published planning boundary | Primary source |
|---|---|---|
| Firestore Standard free quota | One free database/project; 1 GiB stored, 50,000 reads/day, 20,000 writes/day, 20,000 deletes/day, 10 GiB outbound/month. Daily reset is around Pacific midnight. TTL, PITR, backup, restore and clone usage require billing | [Firestore quotas](https://firebase.google.com/docs/firestore/quotas) |
| Firestore charging | Document and applicable index reads count; queries have a minimum read charge even when empty. Collection-ID listing is also charged per request; stored bytes include document/index metadata | [Firestore pricing](https://firebase.google.com/docs/firestore/pricing) |
| Workers Free | 100,000 requests/day, 10 ms CPU/invocation, 128 MB isolate memory, 50 external subrequests/invocation and five account cron triggers. Successful local requests do not establish production CPU/startup acceptance | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Durable Objects Free | SQLite-backed objects; 100,000 requests/day and 13,000 GB-s/day. Duration includes active or non-hibernating residency; exhaustion fails affected operations. Daily allowances reset at UTC midnight | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| R2 prerequisites | Subscription checkout is required; API-token creation requires an R2 purchase. Object permissions can be bucket-scoped. Existing account availability remains unverified | [R2 setup](https://developers.cloudflare.com/r2/get-started/), [authentication](https://developers.cloudflare.com/r2/api/tokens/) |
| R2 Standard | Monthly allowance 10 GB-month, 1 million Class A and 10 million Class B. Excess: $0.015/GB-month, $4.50/million A, $0.36/million B; direct egress is free. Infrequent Access has no free allowance. Authenticated conditional PUT failures can incur Class A charges | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 retention/identity | Bucket locks can restrict overwrite/deletion but authorized administrators can change rules. S3 compatibility is partial. The implementation uses immutable keys and verified content hashes; it does not promise S3 historical-version recovery | [Bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| Firebase Auth | New-account creation 100/hour/IP; Spark verification email 1,000/day and password reset 150/day. Identity Platform's instrumentless Spark Tier 1 limit is 3,000 daily active users where that configuration applies | [Auth limits](https://firebase.google.com/docs/auth/limits) |

Private annual processing is designed for a separately qualified **Node runtime with a 512 MiB envelope**, not the 128 MB Worker. Its local memory measurements already exceed that Worker limit. Existing approved private hosting, encrypted scratch, operational monitoring and costs need qualification; no new paid service is assumed.

## Reproducible planning model, not a provider bill

`node tools/annual-review/capacity.mjs` reproduces the [saved planning estimate](../verification/annual-2026-11-01/capacity-estimate.json). Its assumptions remain explicitly hypothetical: 365 trading days, one manager/business, 18 reads/four writes per full sync, 20 reads per operation attempt, seven writes per accepted operation, 1.3 changes per operation and an upper feed-fanout assumption. Actual types, reviews, transaction retries, indexes and authentication calls differ. Client sync is event-driven; the rates below model usage/stress, not an installed polling timer.

| Five-business total | Low | Typical | Peak |
|---|---:|---:|---:|
| Employees/business; total devices | 1; 10 | 3; 20 | 8; 45 |
| Operations/business/day | 50 | 200 | 1,000 |
| Syncs/device/day | 12 | 96 | 720 |
| Additional operation attempts | 5% | 10% | 30% |
| Estimated Firestore reads/day | 8,060 | 61,760 | 771,700 |
| Estimated Firestore writes/day | 2,230 | 14,680 | 164,600 |
| Estimated Worker and DO requests/day, each | 623 | 6,860 | 103,700 |
| Logical annual operations | 91,250 | 365,000 | 1,825,000 |
| Full-year archive downloads/month | 2 | 10 | 50 |

Typical assumptions exceed shared free Firestore reads; peak also exceeds writes and Worker/DO requests. Low traffic might fit request allowances, conditional on actual use, unrelated workloads, abuse and retained storage. These are arithmetic implications of the assumptions, not recommendations to activate a plan.

## Storage and retention

At an assumed 6 KiB total/document-and-index footprint per logical operation, yearly online growth is 0.522 / 2.089 / 10.443 GiB. Starting empty reaches 1 GiB after roughly 699 / 175 / 35 days. Existing bytes, indexes and a live-trade reserve shorten those illustrative periods. The 6 KiB value has not been provider-measured.

**The private cleanup primitive removes only duplicate manager `changes` documents.** It retains original financial entries, directories, salary history, submissions/reviews, receipts, counters/locks, audit/late/conflict evidence, authority and the entire employee feed. Production defaults remain off; no measured byte reduction is claimed. Retained active snapshots, preparation data and recovery copies also consume storage. A hypothetical broader 2 KiB retained footprint would still grow by 0.174 / 0.696 / 3.481 GiB/year; no such compact-ledger implementation or saving is claimed.

At an assumed 2 KiB archive payload/operation and two copies, annual archive growth is about 0.374 / 1.495 / 7.475 GB before envelopes/metadata. Mirrored adapters and copy-loss recovery **are implemented and locally tested**; actual administrative independence and provider durability are unaccepted. Two buckets under one administrator do not establish that independence. At 64 KiB chunks, the model estimates 5,714 / 22,824 / 114,074 annual Class A writes across two copies, and 79,996 / 1,415,088 / 34,450,348 annual Class B operations. Snapshot/preparation/catalog, failed conditional writes, repeated verification and reservation overhead add work beyond this old planning model. Monthly peaks and accumulated years matter; annual averages cannot establish a monthly allowance fit.

## Executed scale evidence

| Measured path | Result | Scope and evidence |
|---|---|---|
| Private Node 73,000-entry source/export/restore | **PASS**: 731 source queries; 731 encrypted source pages; 575 annual chunks; 40,910 ms preparation +53,552 ms export/restore; peak RSS 173,692 KiB | [Command](../verification/continuation-2026-11-02/annual/prepared-73k-command.json), [metrics](../verification/continuation-2026-11-02/annual/prepared-73k-final.log); exact controls and identities match |
| Private Node 80,300 entries, 10% growth | **PASS**: 804 source queries; 804 encrypted pages; 632 chunks; 49,777 ms preparation +62,743 ms export/restore; peak RSS 167,304 KiB | [Growth metrics](../verification/continuation-2026-11-02/backend-completion/prepared-archive-growth-80300.log); private Node synthetic data, not Worker/provider acceptance |
| Client SQLite FFI 73,000→80,300 install | **PASS**: 1,218/1,340 pages; complete facts/controls, pending overlay and post-C delta; actual host process-death rollback/resume passes | [Current host measurements](../verification/continuation-2026-11-02/snapshot-annual-scale.json), [kill/resume](../verification/continuation-2026-11-02/recovery/snapshot-sigkill-final-summary.json); native=false |
| Current-source Android SQLCipher staging/install | **PASS** 73,000→80,300 accepted entries plus one retained pending; staging 719,221/791,866 ms, install 459,395/447,914 ms | [Final native receipt](../verification/continuation-2026-11-02/native-durable/annual-nov6batch-final-summary.json); real SIGKILL/fresh rollback/resume, queue/draft/retry retention and reboot verified |
| Complete native controller/domain/RTL home+statement | **PASS** full refresh 12,514 ms, incremental RSS 349,564,928 bytes; full-process peak 765,775,872 bytes (~730 MiB) | Same DEBUG/API35 x86_64 receipt; emulator forced 2,560 MiB despite 1024 MiB request. No release-memory,1 GiB phone,physical ARM or 16 KiB runtime acceptance |
| Local immutable object recovery | **PASS 37 overlapping cases**; 10,240 snapshot records across 256 pages (>12 MB payload), separate 3200-page closure above 1 MiB | [Exact limits/commands](../verification/continuation-2026-11-02/final-review/recovery-objects-local.json); sequential reads peak 1, incremental RSS assertion <96 MiB. Actual local filesystem is synthetic, not cloud capacity/durability |

The 73k backend run recorded conservative reservations of 142,152 Firestore reads/45,060 writes; the 80.3k run recorded 156,303/49,530. These are pre-follow-up synthetic reservation totals, not billed measurements or a single-day authorization. They do not yet include the subsequently repaired Firestore reservation adapter's own admission overhead. Budget windows, required deferral and live-trade reserves must be applied in production.

The engine now prepares the immutable source once in encrypted linked pages and streams its private SQLite projection; it no longer replays the entire Firestore prefix for each small export step. Projection/validation cooperatively checks deadline/lease at bounded intervals. This improves measured scaling but is not preemptive OS enforcement or provider scheduling acceptance.

## Current refusal limits and remaining capacity gates

Incoming active snapshots cap record arrays at 64 KiB/page, individual records at 24,000 bytes, 4,096 pages, 500,000 records and 256 MiB. Indexed SQLite replaced the old 20,000-record/16 MiB whole-graph installer. The combined existing-plus-incoming guard is now 1,000,000 records/512 MiB; Dart merges 16 records at a time. These are refusal ceilings, not certification at the maximum. Facts, cursor and installation proof commit together; interrupted work preserves existing data and queue/drafts.

Staged record-array bytes cap at 256 MiB globally, with four uninstalled transfers and four installed proofs. Only eligible older abandoned staging can be evicted; newer checkpoints/floors and future epochs remain protected. Completed staging pages are reclaimed transactionally. The controller fetches at most 16 missing pages/attempt. SQL staging batches one validated 64 KiB page/native call; independent entries use bounded 16-entry indexed reads/native writes, with unchanged full validation and sequential dependent operations. [Focused 27 cases](../verification/continuation-2026-11-02/final-review/snapshot-bounded-apply.json) pass. Existing report refresh still materializes all scoped models: the actual native full-refresh RSS increase and ~730 MiB full-process peak above are material capacity limits. Passing on the forced 2.5 GiB emulator does not establish acceptable memory or latency on the client's target phones.

The new [object-byte recovery component](recovery-objects-local.md) caps ordinary objects at 1 MiB, metadata at 8 MiB, restored objects at 40,000/512 MiB, counted traffic at 4 GiB, calls at 200,000 and each invocation at 30 minutes. Metadata receives bounded preparse scanning; local reads reject inode growth before exceeding their buffer cap. Source reads, immutable puts, readbacks, prefix checks after restart and final independent verification all add I/O; timeout may leave a safely retryable immutable object. These are local implementation budgets, not provider billing caps or acceptance of the private runtime/storage/key lifecycle.

Archive statement responses cap at 1 MiB/2,048 fragment rows, and assembly caps at20,000 records /16 MiB with a pinned manifest and complete accounting controls. PDF export adds a 500-selected-row/160,000-text-unit/200-page/8 MiB bound; CSV20,000 rows/16 MiB; clipboard20,000 rows/4 MiB. Oversize requests refuse, never silently truncate. Per-year lookup can scan the selected archive; indexed cross-year discovery is not implemented. Bounded requests alone do not make repeated whole-year scans inexpensive.

Each prune step commits at most 20 duplicate manager-feed deletes, but reserves worst-case bounded retries: preflight 15 reads plus step 115 reads/10 writes/100 deletes, and plan read/download work. Its shared Firestore budget adapter now additionally accounts for each reservation transaction's own retry envelope. Those ceilings are not 100 committed deletes/step. Zero delete budget and all production cleanup gates remain disabled.

## Shared budgets, deferral and remaining actions

`backend/src/work-budget.mjs` uses atomic shared project/account reservations, explicit resource windows, bounded retries, default-disabled limits and a required positive headroom monitor. The final self-accounting repair adds five reads/five writes for a Firestore reservation transaction's maximum-five-attempt envelope, including R2-only callers. Impossible requests fail before the monitor/provider transaction; accepted charges are not refunded on uncertainty. [Source freeze and final review](../verification/continuation-2026-11-02/final-review/budget-source-freeze-review.json) records **53 focused /144 backend /120 archive PASS**, with overlapping suites.

A rejected or retry-exhausted reservation can still incur provider reads without committing its counter. Therefore these internal counters are not a hard provider bill cap. The required external observed-usage monitor must include failed admission traffic, retries and unrelated usage; absent/stale observations defer work. R2 daily limits are internal throttles, not a claim that R2's monthly billing resets daily.

The inert review configuration proposes hourly minute 17 checks, 2,500 source reads/day, 500 state writes/day and zero deletes. Under the planning assumptions, source reading alone needs roughly 48 /190 /949 days; state/reservation/mirror/recovery work adds cost. The actual engine/catalog and scheduler selection are implemented and default off, but no production trigger exists. Before enabling, measure ordinary financial writes, duplicates/conflicts/reviews/returns, full/empty pulls, authority sessions, source preparation, every copy/restore and admission failures. Reconcile adapter measurements with provider usage and reserve at least 30% headroom for live trade and unrelated work.

| Remaining gate | Status | Smallest action |
|---|---|---|
| Current-source annual Android capacity/crash/refresh/UI | **PASS measured emulator scenario** | Qualify actual target-phone RAM/performance separately; neither a 1 GiB phone nor physical ARM/16 KiB runtime was tested |
| Final R4 business/offline/replacement and latest signed upgrade | **RUNNING / NOT RUN to completion** | Engineering finishes [R4](../verification/continuation-2026-11-02/native-durable/business-recovery-r4-resumed-progress.json) and latest `9595…` chain locally; older `3350…` signed chain is scoped historical PASS |
| Production usage, remaining shared quotas and cold startup/CPU | **BLOCKED**, existing authentication unavailable | Restore read-only access to the named existing account/runtime; [attempted no-write inventory](../verification/continuation-2026-11-02/final-review/backend-production-readonly-nov6.json) could not authenticate. Then approve a measured budget |
| Durable archive/snapshot storage, independent copies/keys and encrypted private runtime | **BLOCKED** | Identify existing approved resources/custodians and authorize a scoped synthetic provider rehearsal; billing/resource creation is a separate decision |
| Consistent capture/image/dependency planning | **PASS local 19-case suite**; provider/custody **BLOCKED** | Qualify the implemented fixed-readTime source, encrypted image and exact dependency inventories against an approved provider environment |
| Disabled financial/Auth/operator/object component restoration | **PASS separate local scopes** | [18 quarantine](../verification/continuation-2026-11-02/final-review/recovery-quarantine-integration-final-v2.json), [12 Auth/operator](../verification/continuation-2026-11-02/final-review/recovery-authority-integration-v2.json), [37 object/capture](../verification/continuation-2026-11-02/final-review/recovery-objects-local.json) overlap; local bytes/accounts are not provider acceptance |
| Bound whole-system restoration / production activation | **NOT RUN combined integration; activation FAIL/unimplemented** | Finish matched financial-image/authority/object integration locally; provider qualification, approved artifacts/keys and separately reviewed activation remain external gates |
| Production close/schedule/deletion | **NOT RUN / approval required** | Separate named close approval, then a later exact immutable cleanup-plan approval after all recovery/fleet gates |

Archiving and verification initially increase I/O. Manager-feed pruning cannot establish indefinite free storage or lower ordinary sync costs without provider measurements. Annual scope remains intact. Core APK, archive viewing/export, automatic annual closing and destructive cleanup each remain **NO-GO** in [commercial readiness](commercial-release-readiness.md).
