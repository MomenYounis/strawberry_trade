# Private Node archive storage runtime

This package supplies the concrete S3 transport that a private Node annual job
can use. The Worker's R2 binding object is not available inside Node. It is kept
separate from the public gateway package and is not imported by the Worker.

Install the exact lock with `npm ci --ignore-scripts` in this directory. From
`backend/`, `npm run test:node-r2` runs actual SDK-signed requests against a
guarded loopback server. It never contacts R2. Both direct dependencies are pinned:
`@aws-sdk/client-s3` 3.1161.0 and `@smithy/node-http-handler` 4.14.1.

`createNodeR2ArchiveStorage({accountId,bucket,credentials,timeoutMs})` is inert on
construction. The account ID fixes the HTTPS endpoint to
`https://<accountId>.r2.cloudflarestorage.com`, with region `auto` and path-style
bucket access. Credentials must be supplied explicitly in memory; there is no
default credential discovery, file reader, environment lookup, logging, public
download URL, bucket creation, object listing or deletion method. This initial
adapter supports the standard R2 endpoint; jurisdiction-specific endpoints need
a separate reviewed configuration change.

The only remote operations are content-addressed conditional PUT and bounded
GET. PUT signs `If-None-Match: *`, supplies the exact body length and Content-MD5,
and copies caller-owned input before sending. On 412 it reads back the same
content address and compares the bytes. A timeout or unknown result is not proof
of failure: a later retry remains conditional. Automatic SDK retries and region
redirects are disabled. GET verifies the final SHA-256 content address as well
as declared length and the streaming limit. One operation is allowed at a time;
the default full-operation deadline is 15 seconds, configurable from 100 ms to
30 seconds. Bodies are capped by the archive format's 524,288-byte maximum, and
provider error bodies are stopped at 16 KiB before SDK XML decoding. Errors
returned to callers contain fixed local codes, not provider response text.

Use `close()` to release the transport and abort outstanding work. The adapter
does not provide secure erasure of JavaScript process memory. Accepted private
runtime isolation, encrypted scratch storage and key custody remain operational
requirements. Passing two independently configured adapters to
`MirroredArchiveStorage` performs bounded readback from both copies; it does not
prove provider independence or administrative retention.

`productionDurabilityAccepted` is always false, including after successful
local tests. No production scheduler can be enabled with this adapter's current
acceptance value. No acceptance override, production cron, R2 binding, resource
creation or cleanup activation is added here. Real storage/copy/key recovery
must be separately accepted before any production close or cleanup decision.

The HTTP test exception requires the existing demo-project/two-loopback-service
guard, a numeric `127.0.0.1` endpoint without path, credentials or query, and
explicit credentials beginning with `synthetic-`. It cannot be used to select a
remote HTTP endpoint or send production credentials to the fixture.

Cloudflare documents the [R2 endpoint and SDK configuration](https://developers.cloudflare.com/r2/get-started/s3/)
and [atomic conditional PUT semantics](https://developers.cloudflare.com/r2/api/s3/extensions/).
The adapter uses the official AWS SDK rather than implementing its own signing.
AWS documents [request-handler bounds](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html)
and [retry/redirect behavior](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-client-constructors.html).

