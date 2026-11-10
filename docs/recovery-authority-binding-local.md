# Bind financial images and disabled authority recovery

The [binding coordinator](../backend/src/recovery-authority-binding.mjs) now connects the supported Firestore image verifier to the separately guarded disabled Auth/operator importer. It is an inert local recovery step. Every plan and result retains `activationAllowed: false` and `productionRecoveryAccepted: false`; it neither activates a business nor establishes provider backup consistency.

The binding sequence avoids a circular artifact dependency:

1. Retain the supplied original tenant-scoped Auth JSON and operator-history JSON. Pin their exact raw SHA-256 values and sorted Auth UID inventory in the financial image's dependency evidence.
2. Finish the complete encrypted financial image and obtain its final manifest SHA-256.
3. Seal the Auth/operator package with that final financial-image SHA-256 and its exact project, database, business, read timestamp, image ID and existing key ID.
4. Verify the whole financial image, decrypt that authority package, and compare the original Auth/operator hashes and UID inventories before any target Auth call.

The authority package SHA-256 appears only in the subsequent binding/result receipt. It must not replace the original raw Auth export hash in the financial image's dependency plan.

`prepareImageBoundRecoveryAuthority({image, authorityEnvelope, authorityMasterKey, limits?, monotonicNow?})` verifies the actual full Firestore image, including all decrypted records and re-derived dependency requirements. The `image` argument contains exactly `storage`, `manifestKey`, `manifestSha256`, `masterKey`, and `expected`; the expected context contains exactly `projectId`, `databaseId`, `tenantId`, `readTime`, `imageId`, and `keyId`.

The coordinator then requires both original authority artifact references in the authenticated dependency plan. The authority package's `sourceAuthSha256` and `sourceOperatorSha256` must match those original artifact hashes. The encrypted authority wire package retains the exact original Auth/operator JSON bytes; opening it recomputes their digests and derives the imported rows from those bytes. A separately known authority package key cannot detach replacement rows from a digest authenticated by the financial-image key. The fixed plaintext/envelope caps still apply, so base64 retention overhead reduces the accepted raw source size rather than raising those limits. Its sorted UID list must equal the UID list re-derived from the image and match the authenticated supplied Auth inventory hash. Extra source-project accounts are refused; a broader Auth export must be scoped to the business before producing this supported package. A missing original user, including a retained historical dependency, is a blocker rather than an invented account.

The UID collector now distinguishes three exact server-authored audit profiles from Firebase users: `audit/tenant_created` from trusted enrollment, `audit/transfer_{newDeviceId}` from the guarded demo transfer, and `audit/admin_{UUID}` for the five ordinary owner-admin actions. It matches the actual producer's collection, ID, action, complete field set and typed values. Only that record's `actorUid` is classified as a server principal. The same literal occurring as a real member ID, manager UID, financial `creatorUid`, or an unknown/incomplete audit still remains an Auth dependency. No account named `trusted-operator` or `local-owner-admin` is fabricated to satisfy operator labels.

New images containing those recognized records include `serverAuditPrincipalPolicyVersion: 1` and an exact inventory of their record IDs, principal labels, kinds and source-record SHA-256 values. That inventory is limited to 10,000 records and re-derived by the authenticated image reader. Unknown versions or altered inventories fail closed. The existing overall dependency-byte limit remains unchanged. Images without recognized service records preserve the previous format/hash. A legacy image without a policy field retains its original all-UID interpretation: it can still verify, but an old incomplete authority inventory remains a binding blocker. Recapture through the supported consistent source/policy rather than inventing a service-label account or rewriting the old image.

The returned plan is frozen and privately branded. A JSON copy or cloned plan cannot become an import capability. It contains hashes, counts and false activation gates rather than password bytes or an exposed Auth client. Caller-owned envelope/key/context bytes are copied before the first asynchronous read; shared-memory byte buffers are refused. Dispose an unused prepared plan with `disposeImageBoundRecoveryAuthority(plan)` to clear its private owned copies. A prepared plan is one-shot when used for a restore, including an unsuccessful target attempt.

`restoreImageBoundAuthority({target, image, authorityEnvelope, authorityMasterKey, restoreOptions?})` performs that preparation and then calls the existing disabled demo restore. Alternatively, `restorePreparedImageBoundAuthority({target, plan, restoreOptions?})` consumes a prepared capability. The only forwarded restore options are the existing bounded user/record/runtime budgets and synthetic interruption hooks. The target, package, keys and expected context cannot be overridden through those options. All of the importer's dedicated demo endpoint, reservation, disabled-account, empty-claims, lease, collision and readback checks remain in force.

| Resource | Hard coordinator maximum |
| --- | --- |
| Authority envelope | Existing 11,186,176-byte authority limit |
| One financial-image read | 8 MiB |
| Aggregate financial-image read allowance | 1 GiB |
| Financial-image read calls | 30,000 |
| One awaited image read | 10 seconds |
| Preparation and restore combined | 30 minutes |

Callers can lower these limits. They cannot raise them above the hard maxima. The aggregate limit admits the existing 512 MiB captured document limit plus encrypted page/manifest overhead. Reads remain sequential. The adapter must enforce the supplied `maxBytes` before buffering; the coordinator independently checks and copies each returned buffer within that cap. The authority package remains a bounded in-memory Node artifact, so multiple temporary decoded/encoded copies can coexist. These bounds are not a low-memory Android or Worker-runtime claim.

The combined clock starts before image verification. A prepared plan expires against that same clock, and the importer receives only the remaining execution budget. A timed-out read never proceeds to an Auth call; an adapter may nevertheless finish an already started read later. The separately guarded Auth transport controls its own accepted/uncertain writes and preserves disabled partial work. No claim of an atomic Firestore/Auth transaction is made.

The reproducible pure suite uses an actual branded fixed-timestamp source through a local HTTP fixture, creates the supported encrypted financial image, and seals the supported authority package. It does not mock the image verifier:

```sh
cd /home/younis/strawberry-trade-annual-review
node --test backend/test/recovery-authority-binding.test.mjs backend/test/recovery-server-principals.test.mjs
```

It covers complete valid binding, wrong keys/context/image bytes, missing original artifacts, source artifact hash mismatch, valid authority-key reseals with changed original bytes or asserted digests, omitted or extra required identities, supplied UID digest mismatch, mutation of caller byte buffers/context/storage methods during verification, shared memory refusal, request/byte/deadline bounds, forged/disposed capabilities and option overrides. The focused principal-policy suite calls the actual trusted provisioner, pure production enrollment plan, owner-admin operations and demo-transfer producers through injected local fixtures, then verifies a real captured image and authority binding. It also tests forged lookalikes, real Auth UIDs with the same literal names, legacy image compatibility and policy tampering. Actual disabled Auth/Firestore integration is separately executed by the dedicated authority emulator suite; its receipt must pass before that execution is reported as accepted.

Final local evidence records [72 focused pure cases](../verification/continuation-2026-11-02/final-review/recovery-integration-independent-review-local-pure-nov7.json) and [16 actual disabled Auth/Firestore cases](../verification/continuation-2026-11-02/final-review/recovery-authority-integration-v5.json), with before/after source hashes unchanged in each run. The emulator suite includes all three real service-principal audit shapes, exactly two real Auth UIDs, no fabricated service accounts, independent financial totals, interrupted imports and an actual SIGKILL/resume. The pure suite ran on Node 22.22.2; the isolated emulator harness ran on Node 24.22.1 and Java 25.0.4. These are local acceptance results; actual provider password sign-in and production activation remain unaccepted.

Provider-consistent capture across Firestore/Auth/operator data, accepted original hash parameters, complete historical identity custody, independent durable object/key restore, fresh device/license enrollment and production activation remain separate gates. The coordinator does not fetch missing exports, create replacement production keys, deploy infrastructure, publish a live catalog or enable deletion.
