# Cloud cost and capacity — implementation update 2026-11-02

Campaign began 2026-11-01; implementation milestone updated 2026-11-02 (Africa/Cairo), source `2ad243a`. Pricing/quota references below remain explicitly dated **2026-11-01**; they were not refreshed for this engineering update.
**No free-hosting guarantee. Production R2 availability and billed usage have NOT been observed in this mission.** Five businesses share the configured Firestore project/default database and Worker account. Tenant paths are logical isolation, not five free allowances. The SQLite Durable Object hosts the gateway; it does not replace Firestore ledger storage. Existing unrelated usage is unknown.

Final backend review revision: **7a51c54b23c9f0ed56db79d49db762dd0952fcdf** (consumer guard and retry-budget repairs). Compiled v11 application source remains **2ad243a44ac7886d2ad49f25b5368811d288d228**; application build inputs are unchanged. Documentation/evidence commits follow these source revisions.

## Dated primary references

Official sources checked 2026-11-01. These are provider documentation, not account entitlements:

- [Firestore quotas](https://firebase.google.com/docs/firestore/quotas): one free database/project; 1 GiB, 50,000 document reads/day, 20,000 writes/day and 20,000 deletes/day, 10 GiB monthly outbound transfer. Daily reset is around Pacific midnight. TTL, PITR, backups and restores require billing.
- [Firestore pricing](https://firebase.google.com/docs/firestore/pricing): document/index reads and empty queries can incur reads. Actual bills require usage instrumentation and the configured region; neither has been freshly measured here.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free allows 100,000 requests/day, 10 ms CPU/request, 128 MB isolate memory, 50 subrequests/request and 5 account cron triggers. A server request success does not prove annual processing fits these limits.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): SQLite objects available on Free; 100,000 requests/day and 13,000 GB-s/day. Exhaustion fails operations. Duration includes time active or unable to hibernate. Track separate SQL row/storage use if added; the current gateway source does not persist ledger rows there.
- [R2 setup](https://developers.cloudflare.com/r2/get-started/): an R2 subscription requires checkout. [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/) requires purchase before API token creation; bucket-scoped object read/write and read-only permissions exist. An allowance is not evidence of an activated subscription or no billing prerequisite. No billing was activated.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard monthly allowance 10 GB-month, 1 million Class A and 10 million Class B; excess $0.015/GB-month, $4.50/million A, $0.36/million B. Direct egress is free, other services still charge. Infrequent Access has no free allowance. Conditional write failures may count as Class A.
- [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/): prefix/time/indefinite rules prevent overwrite/deletion, but privileged administrators can remove rules. This is not independent disaster recovery. [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) is partial; no reliance on S3 version-history recovery. [Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) exposes a per-upload version identifier; content-addressed keys and verified byte digests provide this implementation's immutable identity.
- [Auth limits](https://firebase.google.com/docs/auth/limits): account creation 100/hour/IP, Spark verification emails 1,000/day and password resets 150/day. Identity Platform instrumentless Spark has 3,000 Tier 1 daily active users; this applies only when that service/configuration is present. Existing tenant counts do not prove account configuration. API abuse limits and App Check costs/quotas still require monitoring.

## Reproducible planning model (not a profiler or provider bill)

Run `node tools/annual-review/capacity.mjs`; saved output: `verification/annual-2026-11-01/capacity-estimate.json`.

Assumptions: 365 trading days/year (conservative), one manager/business; 18 reads and four writes per full sync, 20 reads per operation attempt, seven writes per accepted operation, 1.3 changes per operation, feed fanout to all devices as an upper planning assumption. These are deliberately explicit estimates from gateway authority/challenge/session/transaction/feed structure; actual operation types, review multiplicity, transactions retried by Firestore and indexes vary. Auth checks add service calls outside Firestore. No billed instrumentation was available. Client source is event-driven (save/resume/connectivity/manual), **not fixed interval polling**; the sync rates below are usage/stress assumptions equivalent to polling at those rates, not a claim about an existing timer.

| Five-business total | Low | Typical | Peak |
|---|---:|---:|---:|
| Employees/business | 1 | 3 | 8 |
| Total devices | 10 | 20 | 45 |
| Operations/business/day | 50 | 200 | 1,000 |
| Syncs/device/day | 12 | 96 (~5 min/8h) | 720 (~1 min/12h) |
| Retry attempts | 5% | 10% | 30% |
| Estimated Firestore reads/day | 8,060 | 61,760 | 771,700 |
| Estimated Firestore writes/day | 2,230 | 14,680 | 164,600 |
| Estimated Worker AND DO requests/day each | 623 | 6,860 | 103,700 |
| Logical annual operations | 91,250 | 365,000 | 1,825,000 |
| Full-year archive downloads/month | 2 | 10 | 50 |

Typical assumptions already exceed shared free Firestore reads; peak also exceeds writes and Worker/DO requests. Five low-activity tenants may fit request allowances but this is conditional on measurement, other usage, abusive traffic and growing storage. No production plan upgrade is recommended or authorized automatically.

## Storage and post-cleanup capacity

Assume 6 KiB total per logical operation including entry, full change copy, receipt, audit, employee projection where applicable, indexes and names; this is NOT a measured document/index size. At 6 KiB, annual online growth is 0.522 / 2.089 / 10.443 GiB for low/typical/peak. Starting empty with no other usage reaches 1 GiB after about 699 / 175 / 35 days. Subtract existing storage and retain at least 30% headroom; these are illustrative upper times, not service-life promises.

**No production cleanup occurred and no measured storage saving is claimed.** The implemented private conditional pruner can remove duplicate manager `/changes` documents only, after verified snapshot/plan/recovery/fleet acceptance; production defaults and storage acceptance remain disabled. Original financial entries, directories, salary history, submissions/reviews, all receipts/counters/locks/audit/late/conflict evidence and the entire employee feed remain online. The retained manager snapshot itself also consumes private storage. Its preparation pages are canonical plaintext through injected private writers, with production encryption/retention still unaccepted. This is not an implemented reduction to a compact financial ledger.

A future broader design at a hypothetical 2 KiB retained per operation would still grow by 0.174 / 0.696 / 3.481 GiB/year, plus active year, parties, obligations and indexes. That value is a counterfactual planning assumption, not a measurement or saving achieved by the manager-feed-only pruner. Minimal online receipts/return limits/locks/obligations can become the dominant storage. Do not advertise deletion of every historical document or indefinite free storage.

At 2 KiB archive bytes/op and two copies, storage growth is roughly 0.374 / 1.495 / 7.475 GB/year (envelope overhead adds more). The second copy is a cost placeholder: it is **not implemented or independent merely by being in another bucket**. Ten GB of shared R2 allowance is reached by cumulative retained years, existing objects and copies; monthly byte averaging matters. 64 KiB chunks imply roughly 5,714 / 22,824 / 114,074 annual Class A uploads across two copies. Verification rereads and modeled downloads add about 79,996 / 1,415,088 / 34,450,348 Class B/year. These estimates do not include all new active-snapshot, prune-plan, per-page manifest or statement scan work. Peak monthly download concentration can breach the monthly allowance even where annual averages appear low. Individual invoices and now-implemented party statements use bounded chunk scans; an index is still needed for efficient discovery and lookup. Bounded requests alone do not make a whole-year scan cheap.

## Snapshot, statement and cleanup capacity at this milestone

Active snapshot wire/preparation bounds are 64 KiB record arrays/page, 24,000 bytes/record, 4,096 pages, 500,000 records and 256 MiB total. The private Node projection uses SQLite and a verified branded full-manager image can seed the next annual source plus contiguous later deltas, avoiding dependence on a deleted prefix. This does not yet provide efficient scheduled execution or Worker CPU/memory acceptance. No production snapshot catalog/storage/encryption, real R2/key recovery or independently controlled copy has been accepted.

The phone's stricter atomic-install guard caps the **combined existing local projection plus incoming image at 20,000 records and 16 MiB serialized data** because validation still loads the combined state. A larger valid image may stage resumably but fails before active installation or cursor advancement. Queue/draft/retry preservation tests do not remove this scale limit. Even the earlier 73,000-entry synthetic archive fixture exceeds the client install record cap; archive export/restore success is not proof of viable phone recovery at that volume. This remains a production/fleet blocker.

Snapshot recovery fetches at most 16 missing pages per attempt; matching scoped pages can be revalidated and reused after a fresh membership epoch. Headers/pages add storage, hashing, network and transaction work before a successful install. Party statements cap one response at 1 MiB/2,048 fragment rows and scan a bounded number of chunks with a pinned manifest identity; completing a large statement may still read the whole selected archive. Indexed cross-year search remains absent.

The private pruner deletes at most 20 manager-feed duplicates per transaction. Each step conservatively reserves 15 preflight reads, then up to 115 reads, 10 writes and 100 deletes for bounded retry attempts, plus plan-page reads/download bytes. These are reservation ceilings, not measured billed counts or 100 committed deletes per step. Plan capture, independent plan verification, snapshot publication/recovery and state writes add further work. A shared zero/default-disabled delete budget means no cleanup capacity is authorized. There is no automatic cleanup handler, broad historical document deletion or demonstrated net production cost reduction.

## Annual work and deferral

Review-only config: `tools/annual-review/config.review.json`; no runtime schedule or billing resource is enabled. Proposed hourly UTC checks at minute 17 = 24/day, about 8,760/year; five tenant job reads/check adds ~120 Firestore reads/day before locks or recovery. A 2,500 source-read/day budget plus 500 state-write/day ceiling leaves room only if live usage does. This budget would require approximately 48 / 190 / 949 days to read 1.3 changes per annual operation; high scenarios cannot finish within a year at that budget. A verified retained snapshot can seed later source reconstruction, but creating/verifying the image and reading later deltas still consumes capacity. Reconciliation reads, retry uploads, verifying copies, metadata, snapshots and cleanup add more work.

Before enabling, instrument representative ordinary writes, duplicate/conflict/review/return writes, empty and full employee/manager pulls, challenge sessions, archive steps and restore scans. Collect redacted counts and latency/CPU/memory at the adapter boundary; reconcile with provider usage, not just emulator logs. Set budgets using minimum remaining Firestore read/write/delete, Worker subrequest/CPU, DO duration and R2 allowance with **30% headroom for live trade and unrelated usage**. Budget reservations must be atomic and conservative on uncertainty; retries count, quota resets differ by provider. Pause jobs and retain progress on exhaustion. `backend/src/work-budget.mjs` implements shared atomic conservative reservations, non-refunded retries, disabled defaults, and refusal without a positive live-headroom monitor. Its synthetic concurrency/window tests pass. A production usage monitor, cost instrumentation and coordinator wiring still need acceptance; config alone is a proposal, not provider-billed usage evidence. Archiving, verification and cleanup temporarily INCREASE read/write usage; lower stored bytes do not automatically reduce ongoing sync reads.

Snapshot checkpoint capture now pre-reserves its maximum15 authority reads for five SDK attempts; retries are explicitly bounded at5. This is a conservative reservation ceiling, not measured billing. The pruner blocks every checkpointed/exporting/uploaded archive consumer regardless of its final checkpoint; a consumer at or above C may still require the prefix. The state-only query no longer needs the proposed compound archiveRuns index, which was removed from the candidate. No index deployment occurred.
