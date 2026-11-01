# Financial carry-forward verification

Campaign began 2026-11-01; final local handoff 2026-11-02 (Africa/Cairo).
Date: 2026-11-01. This report covers synthetic fixtures and inspected source. Final Flutter artifact revision is `2a3cd45f82dce989e8db45e1f7a3e113af10f10a`; final backend/archive revision is `e6e9c4fd6a04846d7a0fb2d3fe0c38790599793a`. Both final recovery repairs are implemented; the specialist and root archive runs pass 34/34, exit 0, with no skipped tests. It does not reconcile customer data or establish post-pruning accounting. **No opening checkpoint is posted as a sale, receipt, expense or profit. All original financial records remain online.**

## Authoritative values and invariant

Each accepted immutable entry and tenant sequence is committed together by `backend/src/gateway.mjs`. A close transaction captures `(tenant, year, sequence, closingVersion)` and updates the closed-period boundary. `archive-projection.mjs` replays the complete immutable feed only through that sequence into an isolated SQLite projection. Its BigInt aggregation independently computes opening, in-period effects and closing controls; `archive-accounting.mjs` then calculates controls again from exported records during restore. Hand-calculated fixtures below are the independent expected values; comparing two calls to one function is not the sole check.

For each role/account at checkpoint C:

`closing(C) = original directory baseline + accepted effects before start + accepted effects in [start,end) through C`

The package represents this as `opening(C) + period(C) = closing(C)`. Later-period continuity is `carried closing + later accepted effects`, excluding historical events already represented in that carried value. Current client reports continue reading the complete retained ledger with the original party baseline; archive checkpoints are not imported into that ledger. Therefore the current implementation cannot double-count an archive opening, but it also does **not** implement an active compacted-baseline/snapshot installation. No post-pruning equivalence is claimed.

`merchant` receivables and `supplier` payables are separate signed accounts. The existing model assigns one role per party ID; if one real person has both relationships, distinct role-specific IDs remain necessary. This mission does not silently merge roles or add a new multi-role accounting product.

## Exact representation

Currency uses integer piastres, quantities integer thousandths, price integer minor units. Backend inputs reject unsafe/noninteger JavaScript numbers, and critical products/control sums use BigInt before checked conversion. Dart JSON parsing now rejects values outside ±9,007,199,254,740,991; signed-minimum party balances can no longer bypass bounds through `abs()` overflow. Per-entry money and party baselines retain existing bounded limits. Dart half-up calculation uses quotient/remainder, avoiding an unsafe `product + 500` intermediate. SQLite stores bounded integer facts and JSON; no floating-point financial arithmetic or lossy JSON transport is introduced.

Source/restore controls reject an aggregate outside the safe serialized range and block export/cleanup. This is a refusal contract, not arbitrary-precision customer balances. Whole-program proof of every long-lived report sum is not established; source/control limits and future extreme totals need explicit product capacity handling before expanding the supported envelope.

The manifest financial controls are authenticated plaintext metadata, including private account identifiers and balances. Chunk encryption does not conceal them. They require the same private storage/access boundary as the financial records; an encrypted manifest envelope would be needed for a stronger storage-provider confidentiality requirement.

## Hand-computed examples and evidence

| Scenario | Expected independent result | Evidence |
|---|---|---|
| Customer sale EGP 20,000 unpaid at 2027-08-31 | close 2,000,000 piastres; September receipt 500,000 -> 1,500,000 (EGP 15,000) | `backend/test/archive-engine.test.mjs`, `test/annual_financial_reference_test.dart` |
| Supplier purchase EGP 20,000 unpaid | payable 2,000,000; September supplier payment 500,000 -> 1,500,000 | same independent fixtures, separate supplier account |
| Two consecutive packages | year 2026 closes 2,000,000; year 2027 opens 2,000,000, receipt -500,000 and 25% old-invoice return -500,000 -> 1,000,000 | `backend/test/archive-failure.test.mjs`; second manifest links first manifest hash |
| Prior-year partial returns | cumulative quantities/value cannot exceed immutable invoice; final rounding residual equals original total exactly; reversal releases returned capacity once | gateway real Firestore integration tests plus Dart reference fixtures; online invoice/counter/reversal locks retained |
| Negative opening/advance | signed baseline -100,000 + old unpaid sale 2,000,000, current decrease 10,000 with return and reversal cancelling -> 1,890,000 | source/restore agreement plus explicit expected assertion in archive-engine test |
| Operating expense | 7,000 paid -> current recorded cash -7,000; adjustment has no cash effect | archive fixture, existing domain/report tests |
| Payroll | July entitlement 100,000, paid 25,000 -> remaining 75,000; August unpaid -> remaining 100,000 | independent source and archive reader; effective-month salary terms and paid-by-salary-month accounts preserved |
| Employee pending expense 99,999 | pending count 1, no cash/receivable/payable effect | archive-engine test; snapshot retains pending status |
| Approval after close | normal old-date approval is `needs_review`, leaves submission pending and adds no entry/sequence; manager explicitly posts linked open-period correction once; rejection remains nonfinancial | gateway unit and Firestore integration; client store/controller regression |
| Repeated archived invoice view/restore | same original ID and amount, zero new active entries/outbox/notifications | historical-view tests (3 visits), archive restore tests (3 reconstructions), Flutter read-only parser/export tests |
| New-year write during export | it has a sequence after C and is absent from C's controls; subsequent period replay includes it once | gateway close/concurrent-write emulator case; fixed-sequence source queries |

All financial comparisons use the **same source checkpoint**. Comparing a close against a current live report while new operations arrive is invalid. Post-checkpoint activity is a separate delta. Final review found locale-sensitive identity ordering; source projection and restore accounting now use deterministic code-unit ordering. The new English/Turkish subprocess regression requires identical source identities and restored controls for mixed-case `I`, `i`, `J` identifiers and passed in the 34-test archive suite rerun by root; restore compares logical identities and effects, not physical active/archive row counts. Duplicate receipts remain online indefinitely; no unenforced age horizon is invented.

## Reports and provenance

Recorded net cash movement remains inflows minus recorded outflows. Package controls separate period recorded movement from cumulative recorded movement/baseline. Neither is reconciled physical cash on hand. No cashbox opening, inventory, employee cash custody or actual-profit calculation was added. Sales minus purchases retains its limited existing label.

Closed-period held entries and their dependent provisional effects are excluded from displayed accounting after the server returns `needs_review`. Original local evidence and outbox remain visible/actionable; retry of a permanent closed-period refusal is blocked. The schema-3 correction queue preserves the source operation link. Trusted correction provenance is stored in separate local columns, survives server replay and backup, and is displayed/exported as original business date plus current posting date. Those server-only fields are omitted from client financial payload serialization and cannot authorize a new posting.

The actual Flutter `ArabicExports.statement` path generated a synthetic archived correction, which was rendered and visually inspected: [archived-invoice-synthetic.pdf](../output/pdf/archived-invoice-synthetic.pdf). The original business date, current posting date and source operation ID remain distinguishable. Review exposed a reference/ISO-date direction defect in RTL layout; commit `4376643` fixes it, with focused direction/export tests passing. Evidence: `verification/annual-2026-11-01/flutter/pdf-export-probe.log` and `pdf-direction-review.log`. This is a rendered synthetic document check, not a native phone-share/print test or proof of complete archived statements.

## Remaining acceptance limits

- Final recovery review confirmed two defects beyond earlier fixtures and both are repaired: reused chunks now require length/hash, GCM key/context authentication and exact plaintext equality before resume advances, and source/restore identity ordering uses code units. Wrong-key/key-ID tests preserve the original progress and prove original-key retry; English/Turkish subprocess controls agree. Specialist and root archive runs: 34/34 PASS, exit 0, 0 skipped; reviewed/committed in `e6e9c4fd6a04846d7a0fb2d3fe0c38790599793a`. All originals remain retained and all four production verdicts remain NO-GO.

- No active history was deleted. A compacted-baseline client, atomic/resumable active snapshot with preserved outbox, complete archive+active metadata recovery and conditional pruner are not implemented. Cleanup is a NO-GO.
- An annual package is a financial/history package, not Auth/membership/device/license/duplicate-receipt recovery by itself. Pending/late evidence, counters, locks and active metadata remain required online or in a complete private backup.
- Payroll controls preserve the existing selected-month policy: latest documented term at/before that month minus paid/reversed payroll by `salaryMonth`. Missing historical terms are unknown, never fabricated. No new employment termination/accrual policy is introduced.
- Customer production totals, unpaid obligations, actual physical cash and owner business-policy acceptance were not independently checked. No production financial close was performed.
- Native encrypted migration/phone loss, prior signed APK upgrade and multi-device acceptance remain BLOCKED without a disposable Android device/emulator. Host SQLite is not proof of SQLCipher/Keystore behavior.

See `implementation-progress.md` for final command statuses, `annual-archiving-design.md` for retention and bounded limits, and `commercial-release-readiness.md` for separate release decisions.
