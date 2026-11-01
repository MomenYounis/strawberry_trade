# Commercial release readiness — 2026-11-01

Campaign began 2026-11-01; final local handoff 2026-11-02 (Africa/Cairo).
**No production GO is issued.** Targeted local implementation, tests, signed review APK and reviewable commits are available. The complete mission is not claimed finished: active snapshot installation, conditional pruning, full disaster recovery and several archive/history policies remain unfinished. Production deployment, publishing, billing, account creation, schedules and financial cleanup were not performed.

## Four separate verdicts

| Component | Verdict | Why it cannot receive production GO | Owner / required action and evidence |
|---|---|---|---|
| Core commercial APK, archive close/deletion disabled | **NO-GO for commercial distribution** | Host accounting/security, signing continuity and representative native Keystore/SQLCipher migration, queued-data signed update and reboot checks pass. Native two-tenant manager/employee financial sync, normal cached-account/license recovery, replacement-phone flows and compatibility with the unobserved deployed server remain critical unverified paths. | Engineering: extend the isolated API35 campaign to auth/license/invitation, manager/employee/offline financial and recovery flows; record exact versions/hashes and sanitized native evidence. Verify intended compatible backend/config before any separately approved deployment. No owner installation may be cleared. |
| Archive export and read-only viewing | **NO-GO for production** | Bounded encrypted export/strict verification/read-only invoice fixtures pass. Final specialist review found and repaired mixed-key resume and locale-sensitive identity defects; root reviewed and reran the expanded archive suite: 34/34 PASS, exit 0, no skips. No accepted private R2 account/key recovery/copy, no production-private crash-cleaned verifier boundary; archived party statements/indexed search are incomplete. Coordinator is private Node tooling, not accepted Worker orchestration. | Storage/key custodian + engineering: choose approved existing durable storage, prove private permissions/retention/budget, independent recovery copy and keys; staging E2E with actual adapter, invoice/history exports and restore reconciliation. Finish required statement workflow and secure scratch/process-crash recovery. No billing/resource creation without approval. |
| Automatic production financial close | **NO-GO** | Calendar/checkpoint/fencing/late-entry foundations are implemented, but no scheduled handler is enabled or completed. Efficient incremental source/budget orchestration, undated opening policy, held salary-term resolution and full operational acceptance are outstanding. | Engineering + owner: implement/accept remaining policy/workflows and bounded scheduler recovery, verify expected annual load and current Cairo gate, then review a concrete named tenant/year dry run. Separate explicit approval is required for production close/scheduling. First permitted year 2026 is not eligible until 2027-09-01 Cairo. |
| Destructive archival cleanup | **NO-GO** | Conditional pruner and archive-aware active snapshot/client install are **NOT IMPLEMENTED**. Protocol1 advertises no pruning support. Recovery copy/keys, fleet acceptance and post-delete recovery are absent. Cleanup gates always include `pruner-not-implemented`; zero actual saving is claimed. | Engineering + storage/key custodian + owner: implement and fault-test snapshot/outbox-preserving recovery, unchanged-document bounded prune, retained dependencies/receipts, actual copy/key restore and grace-period evidence. Obtain a separate later approval for the exact cleanup plan. Merely changing a boolean cannot make this ready. |

Archive chunks are encrypted, but the HMAC-authenticated manifest is plaintext financial metadata containing account identifiers and controls/balances. It must remain in the same private, restricted storage/access boundary. Concealing those controls from the storage provider would require an additional encrypted manifest envelope; this is not currently implemented.

These are material blockers, not cosmetic conditions. A local staging PASS or signed artifact is not production acceptance.

## Reviewed source and APK identity

- Source baseline: `e246f436a092616ef2799bb04f969a19fd19ffcc`, original `main` with 327 pre-existing mode-only differences and no staged changes.
- Writable full clone: `/home/younis/strawberry-trade-annual-review`, branch `codex/annual-archive-safety`. Original read-only checkout remains untouched. All 327 tracked original bytes/modes were preserved in the clone; commits stage only authored content with original Git modes, not the owner's mode differences.
- Final Flutter source revision: **`2a3cd45f82dce989e8db45e1f7a3e113af10f10a`**, including the rendered-PDF identifier/date direction fix and canonical JSON integer-bound repair. Earlier mission code commits `b60ff0c` (gateway/runner/security fix), `957b1cc` (archive preparation/verification), `52af431` (client/storage/history). Final backend/archive revision: **`e6e9c4fd6a04846d7a0fb2d3fe0c38790599793a`**; mixed-key resume and locale-sensitive identity repairs were reviewed and rerun by root: archive suite 34/34 PASS. This backend-only commit does not require or imply an APK rebuild. Documentation/evidence commit follows; `git log` gives its exact final revision. `final-source-hashes.json` binds the reviewed content. APK build reports `dirtyTree:true` because preserved mode differences and documentation/evidence remained; no unexplained app source drift is implied or hidden.
- APK: `verification/annual-2026-11-01/flutter/strawberry-trade-annual-review-v10-final.apk` (ignored build artifact, delivered separately).
- Version **1.0.0+10**, package **com.strawberrytrade.strawberry_trade**, minSdk 24, target/compileSdk 36. Existing source version was retained; actual installed owner-phone version was not inspected.
- Size **77,512,964 bytes**. SHA-256 **`4c57af562a6f40c295385bb4439bf61105374be45c296b825ce59236a9c07679`**.
- Verified release certificate SHA-256 **`bf1cb6377be0c37cad31811b557ac32b686ffdc75730778edb8488d2bdb3d82b`**; direct read-only signature verification of the original v9 delivery APK matches. APK Signature Scheme v2 verifies, appropriate for minSdk 24. This proves signing identity continuity, **not** an executed upgrade/data-preservation test.
- Merged manifest: debuggable absent/defaultfalse; allowBackup=false, usesCleartextTraffic=false. Permissions: Internet/network state, READ_GSERVICES, WAKE_LOCK, Firebase messaging receive and app-local dynamic receiver permission. No broad storage/install permission was added. Firebase browser auth callback activities remain exported as SDK components; no new exported financial endpoint was introduced. Runtime component abuse/attestation has not been penetration-tested.
- All three ABI `libapp.so` files contain the intended public project/app ID and approved HTTPS gateway. Known signing password/PEM private-key-marker scan found no hits in APK entries; this bounded scan is not proof against every conceivable secret. No signing/issuer/archive private key was created or embedded.

Build used pinned Flutter 3.47.2 / Dart 3.13.2, Android release Gradle configuration and existing signing identity. Existing Secret Service password stayed in memory; Java properties were exposed by anonymous memfd, not source/disk/password arguments. Command: `python3 tools/annual-review/build-release.py`, wrapping `flutter build apk --release --dart-define-from-file=/home/younis/.local/share/strawberry-trade-operator/firebase-production/cloudflare-setup-v8-defines.json`. The definitions filename is historical; byte/config checks verify the intended project, application and gateway, rather than assuming its name proves compatibility. Build exit0. Java 17 is configured for Android compilation; host default Java 25 and exact toolchain evidence are recorded separately. No owner device install/uninstall/data clear was run.

The actual Flutter export was generated from synthetic data and rendered for visual inspection: [archived-invoice-synthetic.pdf](../output/pdf/archived-invoice-synthetic.pdf). That review exposed an RTL layout defect that reversed reference identifiers/ISO-date fragments; commit `4376643` fixes their direction while retaining Arabic layout. Focused export/direction tests pass, final host suite is 146 PASS and analyzer reports zero issues. This checks the rendered sample, not every export layout or native accessibility/share/print path.

Evidence: `release-build-final.json`, `release-build-final.log`, `apk-inspection-final.json`, `release-signature-final.log`, `prior-v9-signature-readonly.log`, `release-manifest-final.xml`, `release-badging-final.log` in `verification/annual-2026-11-01/flutter/`. Earlier unsigned/debug/historical APK evidence is not transferred to this candidate.

## Test decision summary

| Check | Result | Evidence / limits |
|---|---|---|
| Pinned Flutter dependency resolution | PASS | `pub-get.json`; no pubspec/lock replacement |
| Baseline Flutter host tests | PASS 126 | `baseline-tests.log` |
| Baseline analyzer | FAIL | Two pre-existing style infos; repaired narrowly |
| Final analyzer | PASS, exit0 | `integrated-analyze.log` |
| Final Flutter host suite | PASS 146 | `integrated-tests-final.log`; synthetic SQLite/FFI, widgets and PDFs, not native SQLCipher |
| Exact baseline backend unit suite | PASS 43 | Disposable exact-HEAD source with pinned deps; original checkout dependency/read-only failures separated |
| Final backend unit suite after recovery repairs | PASS 67 | `backend-unit-final.log`, includes parser/authority/late-term/protocol/history/budget regressions |
| Final local Firestore/Auth/Functions integration | PASS 27 | `backend-integration-final.log`; guarded synthetic endpoints, includes close/current-write/correction/late salary term |
| Invitation combined local emulator suite | PASS 39 | Contains overlap with gateway/shipment suite; do not sum as unique coverage |
| Archive/reader/budget suite after recovery repairs | PASS 34, exit 0, 0 skipped; root rerun | `npm --prefix backend run test:archive`; `archive-suite-final.log`. Synthetic stores/local R2 API simulation, not actual R2 acceptance |
| Annual scale,73,000 entries | PASS in private Node | 593 chunks,38,612,546 ciphertext bytes, 96 MiB JS heap,161,512 KiB peak RSS; exceeds Worker 128 MiB |
| Tool suites | PASS | issuer 8, config 14, operator 30, admin 33; mocked/synthetic tools, no production writes |
| Worker config tests / local bundle dry run | PASS 4 / PASS | Dry run packages code; no deployment/production CPU acceptance |
| Known parser security reproduction | FAIL before fix -> PASS 3 after | Retained before/after logs; targeted compatible lock update |
| Final backend production dependency audit | Six moderate; zero high/critical | Audit exit1 for remaining findings; not a clean dependency audit |
| Actual Flutter Arabic archived PDF/export QA | PASS, synthetic fixture | [Rendered export](../output/pdf/archived-invoice-synthetic.pdf); actual `ArabicExports.statement` output, render/visual inspection, LTR reference/ISO date defect repaired in `4376643`; no phone printing/share acceptance inferred |
| Final backend recovery regressions | PASS; root reviewed/reran and committed `e6e9c4f` | Changed key/key-ID cannot advance persisted export; original-key recovery verifies. English/Turkish subprocess fixtures produce identical source identities/restored controls |
| Native Keystore/SQLCipher/storage-full and representative schema migration | PASS on isolated API35 | Actual native APIs; schema1→3; signed v9→v10 sequence retains representative schema2 queue/key/draft, then verifies after reboot; `flutter/native/README.md` |
| Native full account/business/multi-device/replacement-phone acceptance | NOT RUN / incomplete | Storage-only fixtures and offline setup-screen startup do not establish these critical workflows; no owner device was used |
| Actual R2 staging integration/copy/key recovery | BLOCKED | Storage/account/recovery not configured or independently observed |
| Worker annual job runtime/failure budget | NOT RUN / unsupported envelope | Private Node total memory is already above Worker limit; no production handler acceptance |
| Active compact snapshot install, post-prune old APK recovery, delete-batch failure | NOT RUN: NOT IMPLEMENTED | Explicit implementation gaps, never converted to PASS |
| Complete archived statements + whole-system archive/active recovery | NOT RUN: INCOMPLETE | Invoice viewing/isolated financial restore do not establish these workflows |
| Production dry run/close/cleanup/deploy | NOT RUN: NOT AUTHORIZED | All switches remain off |

## Staged rollout and rollback boundaries

1. Finish additive server/protocol/snapshot/recovery code and verify backups before deployment. Review exact diff/config/endpoints, then obtain explicit approval for that concrete server deployment.
2. Roll compatible signed clients to disposable synthetic installations first; prove upgrade/offline queues and old-client upgrade messaging, then separately approve client distribution. Never uninstall the owner's installation to make a test pass.
3. Test synthetic staging end-to-end using actual private storage/copy/key infrastructure and supported request/memory budgets; record source checkpoint/control and byte-identity evidence.
4. Review and obtain approval for a named production export-only dry run. A financial close changes acceptance policy even when deletion is disabled and needs explicit policy review.
5. Review retention/dependencies/keys/recovery, current fleet capability and exact cleanup candidates after grace expiry.
6. Separately approve automatic close/scheduling only after its blockers are resolved; cleanup approval is later and independent.

Disable switches/config review artifact are in `tools/annual-review/config.review.json`; it is inert and not a deployed config. Before a close, disabling job initiation is straightforward. After a close, preserve its immutable boundary and resume export; do not silently reopen or rewrite a published balance. Before deletion, failures retain originals. After deletion begins, stop further batches and use validated forward recovery of already-deleted data; an old APK/backend binary alone is not safe rollback. Current code has no destructive runner to enable.

Smallest next concrete actions: engineering finishes the listed snapshot/pruner/history/policy gaps and extends the completed native storage campaign to account/business/recovery flows; storage/key custodian selects an approved durable arrangement and independent recovery model. Production enablement is not being requested while these blockers remain.

Source-level rollout constraint: the baseline gateway rejects the newly sent `syncProtocolVersion` field. Accept and separately approve the additive server deployment before client distribution; no claim is made about the current unobserved cloud version. Offline work is retained, but pointing the new APK at an incompatible old server is not accepted rollout.
