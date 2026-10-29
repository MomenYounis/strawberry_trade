# Reviewed legacy migration plan and read-only dry run

The earlier source and production data remain untouched. This delivery prepares a **conversion/reconciliation report**, not an executable production migration. There is no automatic import from legacy production paths into a tenant. Legacy website test baseline was run on the isolated copy under `work/legacy-baseline`; the function map records replacements and gaps.

## Executable local dry run

From `backend/`, with a legacy `downloadBackupJSON()` JSON export:

```sh
node scripts/legacy-dry-run.mjs /absolute/path/legacy-backup.json tenant_identifier /absolute/path/new-review-report.json
```

The tool has no Firebase/Admin import, no credentials and no remote writes. It reads at most 25 MiB, validates exact decimal precision, and writes a new mode-0600 report without overwriting an existing path. Protect this report: quarantined originals and provenance contain financial/personal information. Keep the original file unchanged and retain its SHA-256, recorded in the CLI report.

Report contents:

- Preserved directory and transaction IDs, tenant-scoped candidate parties/employees/entries, canonical counterparty names and opening balances.
- Original invoice relationships and cumulative return counters. Invoice records sort before same-day returns, so an alphabetically earlier return ID does not falsely orphan a valid original.
- Integer minor/milli values with **no automatic rounding of unsupported legacy precision**. Inconsistent totals/payments, wrong unit/grade/party, missing employee/shipment references and excess returns are quarantined with the original record.
- Candidate per-party closing balances, totals/counts per kind and net recorded cash movement. Aggregate totals use decimal strings backed by BigInt to avoid unsafe JavaScript sums. Compare these with independently approved source statements; candidate controls alone do not prove a quarantined dataset balances.
- Legacy creator UID/submission/time provenance retained separately. Missing historical salary terms remain `needs-evidence`. Payroll payments are preserved as candidate payments; **no historical salary is invented from the employee's current salary**. `salaryTerms` remains empty until evidence is reviewed.
- Budget metadata and current salary/role evidence retained for review. Neither is converted silently into a historical financial entitlement.

`readyToMigrate` is false for quarantine or missing evidence. Even true means only that this parser found no blocking conversion issue; it is **not approval**, a live schema audit, a completed migration or an app-restorable backup. It does not contain verified new membership, devices, authority, licenses or a ready-made change-feed sequence. Review all unresolved legacy provenance/account links separately.

Unit regressions demonstrate known totals, precision quarantine, same-day invoice/return linkage, grade/unit/party restrictions, missing shipping employees and absent historical salary evidence. Real customer data has not been converted or reconciled in this task.

## Concrete production run to prepare after review

1. Identify the single legacy business and intended tenant ID, owner **verified UID**, authorized employees and device public requests. Review live Firestore paths, Auth identities, deployment endpoints and current rules without modifying them. A new UID/email is not proof of a new real-world trial customer.
2. Freeze legacy writers for a defined maintenance window. Export the app ledger and complete server records, including pending submissions, reviews, account links, membership, directory and audit. Preserve an immutable hashed backup and a separately recoverable export under restricted operator access. Capture code/rules/index versions and all device queues. No backup should become a new source of authority.
3. Run the local dry run. Resolve every quarantine through documented source correction or explicit immutable adjustment. Obtain evidence for historical salary terms. Reconcile every party statement, paid/refunded totals, monthly payroll payments, transaction counts/IDs, return capacity and net recorded cash movement. Never relabel sales minus purchases actual profit or cash movement actual cash on hand.
4. Rehearse a new tenant import in an isolated emulator/staging environment using synthetic or approved sanitized data. Prepare an operator-only importer that verifies the **approved source hash**, empty destination, complete manifest and `readyToMigrate`, preserves stable IDs and original attribution, and logs an import batch ID/hash/audit. This importer is deliberately **not provided as a production-capable switch** until actual source/schema/evidence and run approval are available. It must create authoritative change-feed records, return/shipment counters and reversal/review locks and immutable receipts appropriate to imported history; preserve accepted effects exactly once rather than resending imported entries through a manager endpoint that reattributes them.
5. Independently map legacy submissions/reviews and account links into the tenant. Do not derive membership from backup claims. Provision verified UIDs and installation keys through reviewed trusted tooling; revoke prior unsafe sessions. Original tenant trial start remains fixed if an entitlement already exists. Device replacement never starts another trial.
6. Validate before/after controls by running the Flutter statements/reports and server queries against the rehearsal. Include original invoice IDs, return residuals, effective salary terms, creator attribution, directories, pending employee submissions/reviews and outbox retries. Test a fresh authorized manager and employee download; employee devices must never receive manager financial history. Export and restore a new-format app backup to a newly enrolled device.
7. Present a **reviewable production manifest**: exact project and tenant, input hash, record/path counts, source freeze time, proposed rules/functions versions, cost/billing implications, credentials/IAM role, validation report and rollback trigger. Obtain user approval of this concrete action before deploying, migrating, closing legacy paths, enabling billing or creating real users.
8. Execute the approved idempotent import under the freeze. Verify the same controls again before allowing new writes. Close global legacy client paths and disable old writable APIs in the approved deployment; the new deny-all rules alone are not evidence that old deployed endpoints are closed. Never allow a second independent business on the old shared paths.
9. Archive protected backups, import manifest, validation and audit. Distribute only a properly signed, configured APK after the Android and release acceptance conditions pass.

## Rollback

Before new-tenant business writes: disable the imported tenant/new endpoints, preserve the failed tenant and logs for diagnosis, and restore the approved legacy service/rules version with the verified backup if needed. Do not delete the source snapshot or reuse imported IDs for different records.

After new-tenant writes have occurred: **do not blindly overwrite with the old backup or reopen both writers**. Freeze both, export the new immutable ledger and every pending device outbox, reconcile the post-cutover delta, and prepare an approved compensating/reverse migration preserving IDs and creator/audit history. Restore old access only after reconciliation. License/membership/device authority is reissued through trusted enrollment, never restored from a financial backup. No rollback was executed because no production migration was performed.
