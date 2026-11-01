# Annual archive mission — durable progress and handoff

Campaign began 2026-11-01; final local handoff 2026-11-02 (Africa/Cairo).
Date: 2026-11-01 (Africa/Cairo). Substantial local implementation and verification are committed. **The full mission is NOT complete and production release is NO-GO.** Unfinished engineering is listed as NOT IMPLEMENTED, never passed off as unavailable infrastructure or a successful mocked acceptance.

## Source, preservation and revisions

Original `/home/younis/Downloads/strawberry_trade` resolves to read-only `/mnt/data/LinuxHome/Downloads/strawberry_trade`. Initial `main` commit `e246f436a092616ef2799bb04f969a19fd19ffcc`; index empty; 327 existing mode-only changes, all tracked bytes matched Git. Original branch creation and managed-worktree creation failed because the source filesystem is read-only. A full writable Git clone at `/home/younis/strawberry-trade-annual-review` preserves every original tracked byte/mode. Ignored caches/generated artifacts/private credentials were not silently treated as source or committed. `original-preservation-final.json` rechecks all original hashes, empty original index and 327 unchanged original status entries.

Branch `codex/annual-archive-safety` has code commits:

- `b60ff0c`: gateway authority/session/feed race repairs, closed-period staging/correction, parser lock fix and safe emulator harness.
- `957b1cc`: calendar/fenced state, isolated source controls, bounded encrypted archive/strict restore, budget/storage/view services, fixtures and release/capacity preparation tools.
- `52af431d0d4ff3f125de26b44b2efd187349df04`: schema3 durable correction/provenance, sync guards, manager read-only history UI, money bounds and regression tests.
- `4376643`: fixes the reproduced Arabic PDF direction error for reference identifiers and ISO dates.
- `5ddbe37`: reproduces and repairs native signed-minimum overflow in canonical JSON integer validation.
- **`2a3cd45f82dce989e8db45e1f7a3e113af10f10a`**: adds guarded disposable native storage and signed schema-upgrade fixtures; final source revision used to build the latest signed APK.
- Backend/archive final revision: **`e6e9c4fd6a04846d7a0fb2d3fe0c38790599793a`**. Final review found two confirmed recovery defects (mixed-key export resume and locale-sensitive record identity ordering). Both targeted repairs are implemented; the backend specialist reran `npm --prefix backend run test:archive`: **34/34 PASS, 0 skipped**. Root reviewed the changes and independently reran the archive suite: **34/34 PASS, exit 0, 0 skipped**, recorded in `archive-suite-final.log`. The backend-only repair does not change the APK subsequently rebuilt from `2a3cd45` after the additional canonical JSON repair.

Documentation/evidence commit follows these; use `git log -1` for final handoff revision. Every commit stages exact authored paths/content with original index modes; all owner working-tree mode changes remain. Final source hashes establish no unexplained code drift after APK build. No applicable AGENTS.md was found in repository or original/resolved ancestors.

Actual specialist agents worked on backend, Flutter and archive modules with explicit ownership. Earlier specialist turns stopped on account usage limits; work resumed for final recovery review and handoff updates. Root performed integrated source review, tests, documentation and signed-artifact inspection. A specialist performed a final read-only review of the recovery paths, then implemented the confirmed repairs and passed 34 archive tests. Root reviewed and reran those 34 tests before committing the backend repair; this is not an external whole-repository security certification. No completed independent external security review is claimed.

## Milestones and exact status

| Milestone | Status | Implemented / remaining |
|---|---|---|
| M0 baseline/architecture/map | PASS locally | Shared logical Firestore tenancy confirmed; baseline evidence/tools recorded; no live deployment observation |
| M1 accounting/auth/sync repairs | PASS targeted fixtures | Transaction session recheck, feed role recheck, parser crash fix, integer bounds, durable late staging and linked entry/approval correction |
| M2 calendar/checkpoint/fenced lease | PASS synthetic + real Firestore acceptance paths | Cairo/first-year/backlog/sequence/version/fence; no auto production close |
| M3 encrypted export/strict restore | PASS bounded local fixtures, including 34 archive regressions reviewed/rerun by root | Private Node source/coordinator; R2 adapter API simulated, actual provider/copy/keys BLOCKED; efficient Worker orchestration NOT IMPLEMENTED |
| M4 historical viewing/client protocol | PARTIAL | Manager stable-ID invoice/entry view + Arabic PDF/CSV, safe cursor/floor refusal; full archived party statements and compact snapshot install NOT IMPLEMENTED |
| M5 cleanup/recovery | NO-GO | Disabled switches/grace/dependency gates; actual conditional pruner and complete archive+active recovery NOT IMPLEMENTED |
| M6 release/audit evidence | Local checks PASS; production NO-GO | Signed v10 review APK/continuity/flags verified; representative native storage/migration, signed update and reboot PASS; broader account/business recovery NOT RUN |

## Requirements/evidence matrix

| Requirement | Implementation/evidence | Result / boundary |
|---|---|---|
| Preserve owner source/index/modes | baseline/final hash and status JSON | PASS; original untouched, clone explicit |
| Actual tenancy/deployment distinction | gateway/runtime/config source + coverage map | Shared project logical tenants; production deployment NOT OBSERVED |
| Cairo year/first allowed/half-open/leap/DST/missed trigger | archive calendar and engine tests | PASS locally; cron remains OFF/unwired |
| Same logical checkpoint and version | root transaction + immutable bounded sequence replay | PASS source/fixtures; no mutable collection snapshot claim |
| Durable leases/stale runner denial | state store and replacement-runner tests | PASS; no stale publication/advancement |
| Pending submissions preserved | source snapshots, gateway approval/rejection tests | PASS; no archive auto-approval/discard |
| Late entry/review recovery and explicit adjustment | server stage/receipt/locks + schema3 queue/provenance/UI | PASS targeted tests; staged salary-term resolution NOT IMPLEMENTED |
| Customer/supplier, advances, returns, payroll, cash continuity | hand-computed Dart + independent SQLite/restore fixtures | PASS at same checkpoint; active compacted baseline not installed |
| Retention/reference dependencies/duplicate protection | design collection matrix; keep all originals/receipts/locks | PASS preservation; zero pruning/storage saving |
| Authenticated bounded archive strict parsing | format/storage + malformed/failure tests | PASS locally; no compressed format, no public bucket |
| Stored bytes re-download + restore financial controls | strict reader/isolated sink/source controls | PASS synthetic/integration filesystem; actual R2 acceptance BLOCKED |
| Independent copy/key recovery/external anchor | operations prerequisites | BLOCKED/NOT CONFIGURED; cannot satisfy cleanup gates |
| Two consecutive annual packages + cross-year original | archive-failure fixture | PASS; linked previous manifest, exact balance/identity controls |
| Upload/replay/transition interruption | resume/failure/fence/timeout tests | PASS supported transitions; prune/install failure tests NOT RUN because absent |
| Active snapshot+deltas/old phones after floor | protocol1 guard; floor remains zero | NOT IMPLEMENTED full snapshot install; pruning compatibility not advertised |
| Read-only historical invoice view/export | bounded service, revocation/UI parser/widget tests, actual Flutter Arabic export and rendered PDF inspection | PASS for the synthetic invoice/export scope; ISO dates/reference IDs repaired in `4376643`; full archived statements/indexed cross-year search incomplete |
| Complete replacement-phone/disaster recovery | retained active data/authority requirements documented | Native storage subset PASS; complete archive+active activation workflow NOT IMPLEMENTED |
| Large annual growth/reduced heap | 73,000 entries/593 chunks/38,612,546 bytes | PASS private Node; 161,512 KiB RSS exceeds Worker 128 MiB; peak envelope not accepted |
| Five-business quotas/capacity | dated official references + reproducible explicit assumptions | Planning estimate; no provider-billed usage measurement/free guarantee |
| Signed release/cert/config/secrets/flags | final APK metadata/inspection | PASS packaging and scoped native storage/update checks; broader business acceptance NOT RUN |
| Entire repository audit coverage | per-file audit-coverage.json with reviewed/unreviewed limits | Targeted review; no exhaustive correctness claim |
| Production actions | no deploy/publish/merge/billing/account/schedule/delete | NOT RUN/NOT AUTHORIZED |

## Traceable feature and data map (source-reviewed paths)

| Flow | UI / controller -> local transaction | Server acceptance / projections | Reports / recovery |
|---|---|---|---|
| Manager invoice/payment/expense/return/debt/reversal | `lib/presentation/screens.dart`, `shipments.dart` -> `AppController.saveEntry` -> `LedgerStore` entry+stable outbox+audit transaction | `gateway.syncOperation` rechecks tenant/member/device/session/license in transaction; immutable entry + operation digest receipt + tenant sequence/change; original invoice and return/reversal counters validate references | `LedgerRules.partyEffect`, `partyBalance`, `netRecordedCash`; `services/exports.dart`; scoped backup; archive controls compare same captured sequence |
| Party/opening and supplier/customer role | party form -> saveParty -> immutable directory/outbox | party record + manager change; employee projection deliberately excludes `openingMinor` | signed opening is balance baseline, not sale or cash; current model separate IDs/roles; no new multi-role entity product |
| Employee quantity submission | employee form -> saveSubmission -> durable pending queue | submission only; own-UID employee feed, sanitized party directory; no financial entry | provisional pending/rejected states retained; employee receives no manager money payload |
| Manager approval/rejection | review UI -> review outbox; approval stays provisional | reviewLocks ensure one decision; accepted approval atomically creates linked financial entry and changes submission status; rejection creates no financial entry | pending is excluded from accepted accounting; late approval requires explicit current-open-period correction |
| Payroll | employee/salary term forms -> immutable effective-month terms and payroll entry | salaryLocks, employee existence and historical salary-term checks; payment has explicit salaryMonth | entitlement for selected month uses latest applicable term, paid/reversed payments separate; no physical cash custody/accrual product introduced |
| Session/license/device enrollment | enrollment screens, Android Keystore -> trusted bootstrap proof -> scoped store | Auth ownership/revocation, tenant member/device, one-use challenge, signed membership+entitlement, expiring session | offline license and trusted clock retain encrypted ledger; expired auth/license never delete unsent work |
| Outbox and cursor | single `AppController` sync lifecycle -> local ack/conflict, durable retries and cursor | exact operation IDs/digests retained; changing payload under same ID conflicts; manager/employee feeds differ server-side | remote page transaction before cursor update; explicit upgrade/resync refusal preserves queue; full compacted active snapshot remains a separate gate |
| Backup/replace phone | manager export/import -> strict staged validation and atomic scoped merge | backup does not create Auth users, permission, device identity or entitlement; receipts needed for server retry | SQLCipher/Keystore recovery and new enrollment distinct from annual archive; annual package alone is insufficient |
| Annual close/export/view | inert review configuration; gated state adapter captures immutable sequence; viewer uses verified publication | fenced lease, tenant/year state and immutable changes <= checkpoint; late server staging; encrypted content-addressed chunk/manifest adapter | isolated restore verification and bounded manager view; no view/import posting; cleanup remains gated until full recovery/snapshot/retention proof |

## Final executed checks

Authoritative machine-readable [verification summary](../verification/annual-2026-11-01/verification-summary.json), [final review record](../verification/annual-2026-11-01/final-review.json) and [coverage map](../verification/annual-2026-11-01/audit-coverage.json). All paths below are relative to that evidence directory. Commands run from the correct repository/script directories; combined suites overlap and are not summed into invented unique coverage.

| Command/check | Result | Fresh evidence |
|---|---|---|
| Flutter pinned version/pub get | PASS | Flutter 3.47.2, Dart 3.13.2; `flutter/toolchain.log`, `pub-get.json` |
| Baseline Flutter tests | PASS 126 | `flutter/baseline-tests.log` |
| Baseline analyze | FAIL 1, pre-existing 2 style infos | `flutter/baseline-analyze.log`; targeted style repair |
| Final analyze --no-pub | PASS, 0 issues | `flutter/integrated-analyze.log` |
| Final flutter test --no-pub | PASS 146 | `flutter/integrated-tests-final.log` |
| Backend original checkout | FAIL environment | Read-only npm ci; missing symlinked dependencies; preserved separately |
| Exact-HEAD backend baseline with installed pinned deps | PASS 43 | `backend-baseline-unit.log` |
| Backend pinned npm ci | PASS | `backend-npm-ci.log`; Node 22 target, transitive dev engine warnings recorded |
| Final npm test after recovery repairs | PASS 67 | `backend-unit-final.log` |
| Final local Auth/Firestore/Functions integration | PASS 27 | `backend-integration-final.log` |
| Final combined invitations integration | PASS 39 | `backend-invitations-final.log`; includes gateway/shipment overlap |
| npm --prefix backend run test:archive after recovery repairs | PASS 34, exit 0, 0 skipped; root rerun | `archive-suite-final.log`; includes changed key/key-ID recovery and English/Turkish subprocess controls |
| 73k annual constrained-heap fixture | PASS | `archive-scale-final-recovery.log`; private Node, not Worker acceptance |
| Worker npm ci/config tests/dry-run | PASS / PASS 4 / PASS | `worker-npm-ci-final.log`, `worker-tests.log`, `worker-dry-run-final.log` |
| Tool npm test suites | PASS 8/14/30/33 | `tool-tests.json`; issuer/config/operator/admin respectively |
| Parser security regression | FAIL before -> PASS 3 after | `backend-parser-before.log`, `backend-parser-after.log`; compatible body-parser-only lock change |
| Backend production audit | FAIL exit 1: six moderate, zero high/critical | `backend-production-audit-final.json`; relevance in security report |
| Worker dependency audit | FAIL: 8 moderate/1 high graph findings | `worker-dependency-audit.json`; high undici is local Wrangler/Miniflare dev graph |
| Actual Flutter Arabic archive PDF generation, render/visual QA | PASS for synthetic fixture | `flutter/pdf-export-probe.log`, `flutter/pdf-direction-review.log`; `output/pdf/archived-invoice-synthetic.pdf`; reference direction fixed in `4376643` |
| Signed release build and certificate/manifest/config inspection | PASS packaging | build and final inspection bind `2a3cd45` and SHA256 `4c57af562a6f40c295385bb4439bf61105374be45c296b825ce59236a9c07679` |
| Final backend recovery review and repairs | Confirmed defects repaired; dedicated regressions PASS in 34-test archive suite | Wrong-key/key-ID resume preserves prior progress/original-key recovery; English/Turkish identity/control fixtures agree; `e6e9c4fd6a04846d7a0fb2d3fe0c38790599793a`; root review/rerun PASS |
| Scoped native storage/update/reboot | PASS | New isolated API35 AVD; actual Keystore/SQLCipher, v1→v3 and signed v9→v10 sequence with representative queued schema2 data; `flutter/native/README.md`; broader account/business/replacement-phone recovery NOT RUN |
| Real R2/copy/key recovery | BLOCKED | No configured/independently observed approved arrangement |
| Snapshot/prune/whole-system recovery/complete archived statements | NOT RUN / NOT IMPLEMENTED | Explicit code gaps in design/readiness report |

Baseline and intermediate failures are retained. The integrated archive suite initially exposed a real resume-progress regression; root fixed prefix replay persistence and retained final passing tests. Early reader/fixture failures (tiny chunk limit, schema3 backup columns and malformed-fixture setup) were repaired without altering expected financial amounts or weakening authorization. Root added archive-cache revocation and descending-list regressions, late-salary-term hold, timeout cancellation and two-consecutive-year tests. No skipped/mocked result is presented as production acceptance.

## Signed artifact and separate verdicts

Final APK from Flutter source `2a3cd45f82dce989e8db45e1f7a3e113af10f10a`: `verification/annual-2026-11-01/flutter/strawberry-trade-annual-review-v10-final.apk`; version 1.0.0+10; 77,512,964 bytes; SHA256 `4c57af562a6f40c295385bb4439bf61105374be45c296b825ce59236a9c07679`. Certificate matches the original signed v9 APK; release flags/public endpoint checked. The exact candidate was installed and opened only on a newly created isolated offline Android AVD; no owner installation was touched. `commercial-release-readiness.md` gives **NO-GO** separately for commercial APK distribution, production export/viewing, automatic financial close and destructive cleanup. Scheduling/export/cleanup defaults remain OFF; no destructive runner exists.

## Review entry points

The seven reports are this progress ledger, [design and retention matrix](annual-archiving-design.md), [operations and recovery](annual-archiving-operations.md), [financial controls](financial-carry-forward-verification.md), [security findings](security-audit-report.md), [cost/capacity assumptions](cloud-cost-and-capacity.md), and [four readiness decisions](commercial-release-readiness.md). The [rollout commands](rollout-commands-review.md) remain review-only.

Core paths: [trusted gateway](../backend/src/gateway.mjs), [fenced archive state](../backend/src/archive-state.mjs), [source projection](../backend/src/archive-projection.mjs), [independent reader controls](../backend/src/archive-accounting.mjs), [encrypted format](../backend/src/archive-format.mjs), [coordinator](../backend/src/archive-coordinator.mjs), [manager history service](../backend/src/historical-view.mjs), [durable local schema](../lib/data/ledger_store.dart), [sync controller](../lib/application/app_controller.dart), [protocol guard](../lib/services/sync_protocol.dart), [history UI](../lib/presentation/archive_screen.dart) and [Arabic exports](../lib/services/exports.dart). Financial and recovery examples are executable in [archive engine tests](../backend/test/archive-engine.test.mjs), [failure tests](../backend/test/archive-failure.test.mjs), [locale regression](../backend/test/archive-locale.test.mjs) and [Dart reference fixtures](../test/annual_financial_reference_test.dart).

## Resuming without repeating or inventing work

1. Work in the writable clone, not read-only original. Check `git status`/index and preserve the 327 mode-only differences. Review exact authored commits; no reset/clean/stash or blanket staging.
2. Read the seven mission reports and `verification-summary.json`. Backend recovery repairs are committed at `e6e9c4fd6a04846d7a0fb2d3fe0c38790599793a` with root archive rerun 34/34 PASS; the signed APK is bound to Flutter source `2a3cd45` and its recorded SHA256. Keep source/test/artifact revisions distinct. Re-run checks only for subsequent source changes or unresolved failures, not to manufacture more PASS counts.
3. Engineering implements active role-projected snapshot+atomic/resumable outbox-preserving client installation, conditional pruner with failure recovery, efficient bounded/incremental orchestration, complete archived statements and staged whole-system recovery. These are NOT completed primitives hidden behind switches.
4. Resolve held salary-term workflow and dated-opening/policy questions without historical restatement by default. Owner reviews the default current-period adjustment policy before enablement.
5. Extend the executed disposable API35 storage/update/reboot campaign to native two-tenant manager/employee, auth/license/invitation, ordinary cached-account and multi-device financial flows. The storage subset already passed; do not repeat the obsolete no-target blocker. Physical handset/older-Android coverage remains untested. Never use uninstall/clear-data on the owner's real installation.
6. Storage/key custodian chooses approved durable private storage and independent recovery/key arrangement, with explicit budget/actual adapter staging evidence. No billing or resources are created without separate approval.
7. Baseline server source rejects the new request field `syncProtocolVersion`; additive compatible server support must be accepted and separately deployed **before** distributing this APK. Current live deployment was not observed. Old clients remain protocol1/full-history only; do not advance historyFloor or prune.
8. Follow phased approvals in operations. No production enablement is requested while these blockers remain. After a close, preserve its boundary; after any future deletion use forward recovery, not an old binary or historical reimport.

Final native campaign: root found an installed emulator image/KVM despite the initial no-target preflight, created a separate private API35 AVD, and passed actual Keystore/SQLCipher/migration/storage-full tests plus representative queued schema2 data across signed v9/v10 replacements, v3 migration and offline reboot. See [exact native scope and failures](../verification/annual-2026-11-01/flutter/native/README.md). The owner installation/existing AVD was untouched. A default debug test app was removed only before the signed persistent seed; no uninstall/data-clear occurred after seeding. The disposable emulator and its private scratch directory were removed after successful verification. Broader native account/business/replacement-phone recovery remains NOT RUN; full archive recovery remains NOT IMPLEMENTED.

Final preservation check caught an existing host export test rewriting the tracked historical `verification/arabic-statement-sample.pdf`. Root restored only that test side effect from the untouched read-only original after verifying its recorded baseline hash and unchanged HEAD artifact. The separately generated new synthetic PDF remains in `output/pdf/`. No application source or test expectation changed; see `post-test-preservation-check.json`.
