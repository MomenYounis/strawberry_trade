# Bounded archive and snapshot object recovery

This component restores actual immutable object bytes into a separate local destination. It does not activate recovered businesses, publish a live snapshot catalog, import Auth credentials, grant device authority, post opening balances, or authorize deletion. Every plan, journal result and verification receipt retains `activationAllowed: false` and `productionRecoveryAccepted: false`.

The implementation is in [recovery-object-copy.mjs](../backend/src/recovery-object-copy.mjs), with a durable [SQLite journal](../backend/src/recovery-object-journal.mjs) and a [local filesystem adapter](../backend/src/recovery-object-local-storage.mjs). The filesystem adapter is explicitly synthetic integration storage. Its successful use is not evidence of independent provider storage, accepted retention, encryption of its containing volume, production key custody or disaster recovery acceptance.

## What is authenticated and copied

`prepareRecoveryObjectCopy` first calls the complete supported Firestore recovery image verifier. A plain dependency-plan object or a cloned prepared plan cannot substitute for that verification. The image MAC binds its source project, database, business, fixed read timestamp, document-stream hash, required object roots, original key IDs and the SHA-256 of the separately supplied catalog and closure artifacts.

`encodeRecoveryObjectArtifacts` produces canonical version-1 metadata. It does not establish source completeness or provider acceptance. The producer must supply the exact captured source binding, snapshot root references, and an inventory derived from the real retained manifests and pages. Each inventory object contains its exact key, SHA-256, byte count, ordered child references and sorted original key IDs. The existing dependency-plan inventory hash covers the reference/child/key inventory; the artifact SHA additionally authenticates the exact byte counts. Both are rechecked by the consumer.

The consumer rejects missing references, conflicting hashes, duplicate objects or children, cycles and objects outside the reachable root closure. It accepts only content-addressed keys in these namespaces for the same captured business:

| Bytes | Namespace |
| --- | --- |
| Existing encrypted archive manifests and chunks | `archives/v1/{tenant}/{year}/{run}/{manifests\|chunks}/{SHA256}` |
| Supported snapshot publications and their pages | `snapshots/v1/{tenant}/{snapshot}/{manifests\|pages}/{SHA256}` |
| Exact catalog and closure artifacts | `recovery-objects/v1/{tenant}/{catalogs\|closures}/{SHA256}` |

An object key never becomes a network URL or filesystem path. Legacy keys lacking a byte-level content address fail closed. A snapshot descriptor's `sha256` identifies its record list; this is distinct from the raw page object's content address. The consumer checks both values rather than treating those two digests as interchangeable.

For each archive manifest, the existing archive verifier authenticates its MAC using the caller-supplied original archive key and exact business/year/run/key-ID context. The actual authenticated chunk keys, ciphertext hashes, sizes and key IDs must exactly match the closure. No replacement production key is created. Missing or incorrect original keys stop preparation. Snapshot publication headers, descriptor counts/content digests, page bytes and individual supported page schemas are checked against the actual stored publication. Leaves without a supported authenticated parent manifest are rejected.

The exact catalog and closure bytes are copied too. Keeping only their inventory digests would not restore the catalog or its evidence. The provider recovery image, Auth/operator packages and original key-custody packages remain separately retained inputs; this component does not copy or activate those packages.

## Bounds and interruption behavior

| Bound | Maximum per invocation/prepared copy |
| --- | --- |
| Objects, including catalog and closure | 40,000 |
| Ordinary archive/snapshot object | 1 MiB |
| Each catalog, closure or input image manifest | 8 MiB |
| Restored object bytes, including metadata | 512 MiB |
| Counted read/write traffic | 4 GiB |
| Counted storage/journal/key-resolution calls | 200,000 |
| Total invocation duration | 30 minutes |
| Individual awaited operation | 30 seconds |

Callers can lower these limits. They cannot raise them above the implementation maxima. Source and destination adapters must enforce every supplied `maxBytes` before buffering their response. The local reader allocates at most the advertised file size plus one sentinel byte and reads in chunks of at most 64 KiB; a file growing after `stat()` cannot cause an unbounded `readFile()` allocation. UTF-8 metadata receives a nonallocating lexical depth/token scan before `JSON.parse`, followed by canonical/schema validation. Ordinary objects are processed sequentially; the complete annual payload is never accumulated. The bounded metadata inventories remain in memory. A separate test covers metadata larger than 1 MiB under its 8 MiB cap while leaving the ordinary-object cap unchanged. RSS observations are local test results, not a universal device-memory or provider-runtime guarantee.

The private journal uses SQLite transactions with `synchronous=FULL`. Its compare-and-swap progress is bound to the exact authenticated image/context, root and closure inventory through `copyPlanSha256`. Each object advances the journal only after immutable conditional publication and exact destination hash/size readback. A fresh invocation reauthenticates the image and metadata and checks every previously journaled destination object before continuing. The final state requires another independent full destination reread; `verifyRecoveryObjectDestination` can repeat that read-only verification separately.

The local object adapter writes a private temporary file, syncs it, atomically hard-links it to the immutable final name, syncs the directory, and removes the temporary name. An interrupted temporary write cannot become a partial final object. Existing final objects are never overwritten. Process termination can leave private unpublished temporary files; they are not evidence of a completed copy and must be accounted for during local scratch maintenance. This adapter is not a production storage quota or retention service.

A timed-out provider write can still complete its immutable publication later. The journal cannot advance after the deadline. Its private write buffer remains stable until the underlying write settles, and the same prepared plan rejects another copy while a write remains in flight. Once the transfer settles, retry uses the same immutable identity and performs full readback. An adapter which cannot bound/cancel its own I/O remains unsuitable for unattended production recovery.

The `verified_quarantine` state means exact expected object bytes were read back. It is not a financial ledger installation or authorization decision. Snapshot validation here does not replace the installation transaction's global ID/sequence uniqueness, dependency, financial-rule, permission or pending-queue checks. Archive restore financial controls, fresh Auth/device/license enrollment, independent provider recovery tests and explicit production activation approval remain separate requirements.

## Reproduce the local evidence

From `backend`:

```sh
node --test test/recovery-object-copy.test.mjs test/firestore-recovery-source.test.mjs
```

The tests use real private filesystem objects, original synthetic archive/image keys, actual supported archive/snapshot encodings, a local HTTP fixed-timestamp source fixture, durable SQLite progress and an actual child-process `SIGKILL`. They cover immutable collisions, interrupted and late puts, source/destination corruption or loss, resume after process death, wrong keys, missing child references, cycles, namespace and budget rejection, a 10,240-record snapshot across 256 bounded pages, and metadata larger than 1 MiB. Fixtures and keys are synthetic and removed from private temporary directories after each test.

The sanitized command log and source-hash receipt are recorded in [recovery-objects-local.log](../verification/continuation-2026-11-02/final-review/recovery-objects-local.log) and [recovery-objects-local.json](../verification/continuation-2026-11-02/final-review/recovery-objects-local.json). Those receipts report their actual status; this document is not a substitute for a passing receipt.

## Production boundary

Local byte recovery is implemented. Production acceptance remains blocked on real durable source/destination storage, accepted captured catalog/closure completeness, existing original keys and independently tested custody, provider-consistent Firestore/Auth/operator backups, approved destination infrastructure and a separately reviewed activation procedure. Existing archive-only R2 adapters do not automatically support the additional snapshot/metadata namespaces. No cloud resources, credentials, deployment, scheduling, live catalog publication or production deletion are created or enabled by this work.
