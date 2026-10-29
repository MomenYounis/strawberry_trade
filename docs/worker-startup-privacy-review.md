# Worker startup and stream privacy — 23 October 2026

The first publication attempt failed Cloudflare validation with10021: script startup exceeded its CPU limit. A deployment readback confirmed that the previous version remained100% active. The repair defers the Admin runtime import until the Durable Object request, while retaining the protobuf packaging warmup at script startup, where generated code is permitted. The deployment uses `--minify`; the local bundle decreased from about8.6MiB to4.4MiB. Local execution does not measure Cloudflare startup CPU; publication and readback are separate evidence.

A repeated local acceptance run also exposed payload-bearing `STREAM:` debug output. It existed before these changes as well. [workerd's debuglog implementation](https://raw.githubusercontent.com/cloudflare/workerd/main/src/node/internal/debuglog.ts) enables requested debug sections independently of NODE_DEBUG. The readable-stream dependency obtains its logger when SDK modules load.

A preload imported before the SDK packaging shim now disables only the case-insensitive `stream` section of the default Node util.debuglog API. The callback remains deferred until first invocation; `.enabled` is false. Other debug sections and console/error reporting retain their original behavior. No SDK source, authentication, AppCheck, binding validation or financial logic is changed.

The final minified workerd run passed all54 HTTP assertions, including real Firebase-emulator reads/writes, enrollment, revocation, activation and500-record pagination. Its complete local Worker log decreased from about860KB to6146bytes. It contained zero STREAM/readableAddChunk messages and zero tested document, financial, account, device-key, private-key or JWT markers. Counts and exact source digests are saved in `verification/employee-invitations-v9/worker-http-after-privacy-fix.json`; no payload-bearing raw log is delivered.

These are synthetic local tests. No production financial data or real request logs were inspected. Cloudflare startup validation and public post-deployment negative tests are documented in the final deployment receipt, rather than inferred from local success.


Publication subsequently succeeded. Independent readback confirms version `5a519a2a-bcfc-4d6a-b20d-6585e1a37bbc` at100%, created2026-10-23T09:12:51Z. All9 public health/negative checks passed. This proves acceptance by the deployment validator; an exact startup CPU duration was not captured. See the public final readback and command receipts in the verification directory.
