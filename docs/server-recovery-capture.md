# Fixed-time server capture and disabled recovery staging

Updated 2026-11-05. The local implementation can capture an explicitly scoped
Firestore tenant at one read time, encrypt its bounded image, verify the image,
and restore it to an isolated, disabled **demo-emulator quarantine**. It cannot
activate a recovered production system. No production service or financial data
was changed by these tests.

## Implemented boundaries

[`firestore-recovery-source.mjs`](../backend/src/firestore-recovery-source.mjs)
requires an explicit project, database, tenant, `readTime` and token callback.
It does not discover application-default credentials or implement provider
writes. Root reads, collection inventory and document pages use the same read
time. The normal window is less than one hour; older captures require a matching,
recently verified PITR capability, a whole-minute timestamp, and a window of
less than seven days. Expiry refuses the capture rather than switching to live
reads. These choices follow the official
[document read](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/get),
[document listing](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/listDocuments)
and [collection inventory](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/listCollectionIds)
contracts, checked 2026-11-05. Missing-parent inventory uses `showMissing` and
the documented default name ordering; it does not combine `showMissing` with an
explicit `orderBy`.

The source inventories the tenant root and 25 supported collections. Unknown
collections, nested descendants, missing parents, tenant mismatches, unsafe
integers and unsupported Firestore types stop capture. Provider create/update
times are retained as source metadata. Supported payloads are JSON integer,
string, boolean, null, array and map values; timestamps, floating point values,
references and byte fields are not silently converted.

[`firestore-recovery-image.mjs`](../backend/src/firestore-recovery-image.mjs)
uses a distinct provider-image format. AES-256-GCM pages bind their context and
index; HKDF derives page/manifest keys and HMAC authenticates the manifest.
Immutable page descriptors and the manifest bind plaintext/ciphertext hashes,
record counts, bytes, ordering and the complete source digest. A failed export
does not publish an accepted manifest; any previously written unreferenced
pages remain unaccepted. No automatic deletion is enabled.

[`recovery-dependency-plan.mjs`](../backend/src/recovery-dependency-plan.mjs)
derives required Auth UIDs, object roots and key IDs from the authenticated
record stream. Auth export, operator history, snapshot catalog, transitive
object inventory and key-custody evidence must match the source. The reader
re-derives those requirements from decrypted records. A supplied inventory is
not proof that the referenced artifacts exist, are recoverable, or are held
independently. `activationAllowed` and production acceptance remain false even
when the inventory is complete.

## Bounded, restartable demo restore

[`firestore-recovery-quarantine.mjs`](../backend/src/firestore-recovery-quarantine.mjs)
accepts the authenticated provider image only for project
`demo-strawberry-flutter`, default database, Firestore `127.0.0.1:18180` and Auth
`127.0.0.1:19199`. Both environment endpoints and the SDK's explicit unencrypted
loopback host must match. There is no production override or Auth mutation API.

The destination is
`firestoreRecoveryQuarantine/<imageId>/tenants/<sourceTenantId>`. The journal and
wrapper root always carry `enabled:false` and `activationAllowed:false`; original
root policy is retained under `sourceRoot`, not copied into active authority.
Each document retains its original logical payload, source metadata and source
record hash. The ordinary `tenants/<tenantId>` namespace is not created.

Each transaction creates at most 20 records, with at most 1 MiB of canonical
wrapper payload, and advances the prefix journal atomically. Colliding target
documents are never overwritten. After an interruption, one invocation streams
the image from its beginning, checks every committed target against the exact
authenticated prefix, and then continues create-only progress. Previously
committed records are not rewritten. Concurrent restorers cannot advance from
an obsolete journal. The full image digest and a fresh bounded target inventory
must reconcile before the journal becomes `verified_quarantine`. Extra tenants,
collections, documents, orphan parents, nested children and changed targets are
refused, including when revisiting a previously verified quarantine.

Source limits are 500,000 records, 750,000 bytes per source row, 512 MiB of
canonical source data, 1 MiB per HTTP response, 1 GiB of wire data and 1,100,000
requests. Encrypted pages contain at most 20 records/1 MiB; the manifest is at
most 8 MiB. Restore retains one bounded page and transaction batch rather than
the complete tenant. An invocation permits at most 25,001 new batches and has
a cooperative 30-minute budget checked at I/O boundaries; a smaller explicit
budget returns incomplete disabled staging. It is not a hard interruption of
an already running SDK transaction.
Independent limits may be reached before the record ceiling. These are format
and admission limits, not measured provider capacity or a successful
500,000-record recovery claim. Administrative cancellation or budget expiry can
leave a final bounded transaction committed; the durable journal is the resume
authority.

Avoid a loop of one-batch invocations: every explicit resume verifies the
committed prefix again, so repeated tiny budgets increase work. Use a reviewed
finite full-invocation budget. No automatic background resume, active-root
switch, scheduling or deletion is provided by this demo module.

## Reproducible local verification

From the repository's `backend` directory:

```sh
npm run test:recovery-capture
npm run test:tenant-recovery
```

The first command covers the fixed-time REST source, encrypted image and
dependency verifier. The second starts dedicated demo Auth/Firestore/Functions
emulators and runs the original synthetic-image tests plus the separate
provider-image bridge tests. The provider-shaped source in the bridge tests is
a local HTTP fixture; the destination is the real local Firestore emulator.
This does not qualify Google provider PITR behavior.

Frozen outcomes and exact source hashes are in the
[capture receipt](../verification/continuation-2026-11-02/final-review/recovery-capture-final.json)
and the
[bridge integration receipt](../verification/continuation-2026-11-02/final-review/recovery-quarantine-integration-final-v2.json),
with [bridge output](../verification/continuation-2026-11-02/final-review/recovery-quarantine-integration-final-v2.log).
The bridge exercises real child-process SIGKILL after a committed partial
encrypted page, prefix/revision-preserving resume, root-only images, byte-sized
batches, racing restorers, hostile journals, tampered images/targets, unknown
and nested target data, endpoint refusal and unchanged Auth/source inventory.
The original producer-branded synthetic importer remains separate and unchanged.

## Remaining recovery requirements

| Requirement | Local status | Remaining work and smallest required input |
|---|---|---|
| Fixed-time capture and encrypted provider image | PASS in bounded local transport tests | BLOCKED for provider acceptance: identify an approved existing test database and grant the scoped read/capture rehearsal with existing read-only credentials and a verified PITR configuration if needed. |
| Provider image to isolated Firestore quarantine | PASS in dedicated demo emulators | Production destination integration remains disabled. A reviewed existing recovery environment, IAM and immutable artifact/key inputs are prerequisites; no approval can substitute for missing production integration. |
| Auth and operator restoration | FAIL: not implemented by this module | Implement and test an explicit adapter using the selected Auth/operator backup format; provide that format and a synthetic export contract. Real operator history and existing issuer custody must be identified before an actual drill. |
| Archive/snapshot object and key recovery | Local transport and dependency checks implemented; production acceptance BLOCKED | Supply approved existing object copies, transitive manifest/catalog bytes and key-custody recovery sources. Verify actual restored bytes and independent custody in a scoped rehearsal. |
| Safe authority activation | FAIL: no production activation implementation | Define and test an operator-reviewed activation procedure that validates Auth identity, revocation/membership/license state, re-enrolls devices, and preserves stable operation receipts and locks. Approval is a later gate after implementation and acceptance. |
| Whole-system disaster recovery | FAIL / NO-GO | The preceding independent dependencies and activation path must all be implemented and exercised. Disabled financial-row staging is insufficient evidence. |

Server-accepted operations are recoverable only from retained server state or
its accepted complete recovery image. Pending phone operations require an
encrypted backup containing their original IDs and dependencies. Unsynchronized
operations present only on a lost device have no recovery source. A server
capture, annual archive or older phone backup cannot reconstruct that third
category. The application's portable recovery and its limits are recorded in
[commercial readiness](commercial-release-readiness.md).
