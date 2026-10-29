# Licensing and installation identity

This implementation uses issuer-signed Ed25519 tenant entitlements and issuer-signed, device-bound membership certificates. The Flutter application contains verification code and explicitly configured public keys only. No issuer private key or shared signing secret is bundled. The APK signing key, issuer key and device key have distinct purposes.

## Trust and package contract

`lib/security/licensing.dart` verifies `version: 1` packages containing two envelopes: `entitlement` and `membership`. Each envelope has exactly `kid`, `payload` and `signature`. `payload` is unpadded base64url of UTF-8 canonical JSON. `signature` is an unpadded base64url 64-byte Ed25519 signature over those exact bytes. Canonical JSON sorts object keys recursively, uses compact JSON strings, and permits safe integer numbers only. Verification rejects unknown fields, noncanonical encodings, malformed data and files larger than 64 KiB.

The entitlement has exactly:

```json
{
  "type": "entitlement", "version": 1,
  "tenantId": "verified-tenant", "licenseId": "operator-chosen-id", "epoch": 1,
  "issuedAtMs": 1700000000000, "notBeforeMs": 1700000000000,
  "expiresAtMs": 1702592000000, "trialStartMs": 1700000000000,
  "trial": true, "maxDevices": 1
}
```

The membership has exactly:

```json
{
  "type": "membership", "version": 1,
  "tenantId": "verified-tenant", "uid": "verified-firebase-uid",
  "deviceId": "base64url-sha256-of-device-spki", "role": "manager",
  "epoch": 1, "entitlementEpoch": 1,
  "issuedAtMs": 1700000000000, "expiresAtMs": null, "enabled": true
}
```

`role` is `manager` or `employee`. Both signatures, tenant, authenticated UID, installation ID and entitlement epoch must match. `membership.epoch` and entitlement `epoch` cannot decrease. Different payloads with the same epoch are rejected. Re-entering an identical package is idempotent and does not restart time. A renewal changes the entitlement epoch, and the membership references that new epoch. A membership disablement uses a higher membership epoch and `enabled: false`; it cannot extend the tenant entitlement. `expiresAtMs: null` permits a paid perpetual entitlement if the operator chooses it. The app invents no price or renewal interval.

`maxDevices` limits active manager/business devices. Employee memberships inherit the same entitlement and do not create separate trials. The backend separately bounds employee devices to reduce abuse. The issuer CLI maintains a manager-device issuance registry. Every server request still verifies authoritative enrollment; an activation request or device identifier alone grants no access.

## Trial and time

Trusted tenant provisioning records the first trial start on the server, once per tenant. Expiration is exactly `trialStartMs + 2,592,000,000` milliseconds, including for an employee enrolled on day 29. Expiration is exclusive: `now >= expiresAtMs` locks operational features. Creating an employee or replacing a device does not reset the tenant record. Reinstallation generates a different Keystore identity and cannot use the previous device's package.

A successful online bootstrap signs a fresh membership timestamp after a nonce-bound P-256 device proof. The client calls `importPackage(..., trustedOnline: true)` only on that authenticated bootstrap response. Manual file/code imports leave this flag false. An unsigned `serverTimeMs` is not used as a licensing authority.

Time checkpoints are AES-GCM authenticated under an Android Keystore key and stored in `noBackupFilesDir`. Within one boot, `elapsedRealtime` advances the accepted time, including deep sleep. Wall-clock rollback does not rewind it. The expected wall baseline is preserved through checks and package reimports. After a normal restart, a nonnegative wall-time delta advances the prior accepted time. A detected rollback or missing boot counter after restart locks operations until a fresh authenticated bootstrap can repair the reference. An offline file, even with a later signed issue timestamp, cannot repair that condition. A fresh offline package uses the later of signed issue time and wall reference, preventing a delayed transfer from simply resetting trial time. A live trusted setup can establish time even if the phone's initial wall clock is incorrect.

This is not a daily lease. A valid device can remain offline throughout its known entitlement. UTC epoch milliseconds are used; changing the timezone does not change expiry. Checkpoints are persisted before returning an authorization result, and checks run before operational saves and on foregrounding.

Offline time cannot be made perfectly trustworthy on a compromised phone. A user who controls the OS, encrypted-state rollback, runtime or APK can defeat client controls. Across reboot, no standard Android API gives an application a tamper-proof elapsed-time total for time while powered off. A rollback that remains above the saved reference can be undetectable. A clock erroneously far forward across reboot can expire a timed entitlement early; fresh authenticated recovery can repair a suspicious boot baseline but never lowers that accepted high-water mark. Timed entitlement recovery must investigate the original clock error rather than silently extend validity. The server remains authoritative for synchronized operations and the original trial record. A new account does not establish a new real-world person.

## Issuer tool

`tools/license-issuer/` is a separate Node.js trusted-operator tool with no external packages. Do not package it as an APK asset. Use Node 22 or later. `issuer.mjs` exposes canonical signing/verification for the trusted backend; `cli.mjs` manages encrypted operator keys and an issuance registry.

Keep the private key and registry outside the Flutter project, on an access-controlled encrypted volume. Obtain a strong unique passphrase through your local secret manager or an interactive shell environment; do not place it in shell history, arguments, a committed file or a screenshot. The tool reads `LICENSE_KEY_PASSPHRASE` and requires at least 20 characters.

```bash
node tools/license-issuer/cli.mjs keygen \
  --private /secure/operator/issuer-v1.pem \
  --public /secure/operator/issuer-v1-public.json \
  --kid issuer-v1
```

The private PKCS#8 PEM is encrypted with AES-256-CBC by Node/OpenSSL and created with mode 0600. The public file contains `kid`, raw Ed25519 `publicKey` and `spkiPem`. The tool refuses to write a private key or registry inside the client project, including through an existing parent-directory symlink, and does not overwrite an existing output. Operator filesystem/volume protection and passphrase custody remain necessary.

Configure Flutter builds with a reviewed map of public keys:

```bash
flutter build apk --debug \
  --dart-define='LICENSE_PUBLIC_KEYS={"issuer-v1":"RAW_32_BYTE_PUBLIC_KEY_BASE64URL"}'
```

The default is `{}` and activation fails closed. The public key in `test/fixtures/license_package.json` is explicitly isolated test input; its random private key was discarded. No application code automatically trusts that fixture. Emulator signing keys must stay outside the client project and be discarded after testing.

Before issuance, verify business ownership, tenant entitlement, the authenticated member UID, role and enrolled device against the trusted registry. Never sign an arbitrary request copied from a phone solely because it contains plausible identifiers. Prepare `unsigned-package.json` with `entitlement` and `membership` objects of the exact schemas above. Use the existing server trial dates; do not create a replacement trial.

```bash
node tools/license-issuer/cli.mjs sign \
  --private /secure/operator/issuer-v1.pem \
  --registry /secure/operator/issuance.json \
  --input /secure/operator/unsigned-package.json \
  --output /secure/operator/activation.json \
  --kid issuer-v1
node tools/license-issuer/cli.mjs verify \
  --public /secure/operator/issuer-v1-public.json \
  --input /secure/operator/activation.json
```

The registry prevents lower epochs, inconsistent same-epoch payloads and manager-device over-issuance on that trusted issuing machine. It also rejects moving a tenant trial start/end at a higher epoch and replacing paid authority with a new trial. A lock file serializes issuance; a crash may leave a `.lock` requiring operator investigation before removal. State is reserved before delivery, so retrying an identical package is safe. Keep one authoritative registry or a trusted centralized issuing service; copying independent registries would defeat the device count. Encrypted backup copies must include the registry and key, with the passphrase backed up separately. Test recovery on a separate trusted machine.

For an approved replacement, first disable the old device through trusted backend administration and enroll the new P-256 public key after account ownership verification. Issue a higher membership epoch for the replacement and preserve the same tenant trial/paid policy. `sign --replace-device OLD_DEVICE_ID` updates the local issuance registry atomically with delivery reservation. It does not update Firestore automatically and cannot revoke a disconnected old phone instantly. The old record remains in the registry to reject accidental stale reissue. A higher epoch is required to reactivate a transferred device.

Key rotation uses a new `kid`. Ship the new public key together with still-valid old public keys before issuing under it. Reissue tenant/device packages and then remove a compromised public key through an APK update after an explicit recovery plan. Offline devices cannot learn that an issuer key was revoked until they receive an authenticated update. Never reuse the APK signing key as an issuer key. Production server secrets must be stored using the deployment's secret manager, not a committed environment file.

## Tenant activation redemption

A manual manager paid-package import stores the verified entitlement and a pending tenant-activation package in the same protected state write. Offline local activation is possible immediately when the package permits it. On the next usable connection, the client proves its device, verifies live membership disablement first, submits the saved package to `activateLicense`, obtains a new bootstrap certificate, and clears pending state only after the server confirms that entitlement. A crash/disconnection keeps the original signed package for retry. An acknowledgment identifies the exact pending package, so an older in-flight redemption cannot clear a newer import. The server transaction also advances the membership epoch so a valid transferred package is not stranded behind older server certificates. This explicit redemption makes the business entitlement available to linked employee devices. Employee imports do not gain permission to activate the tenant on the server; they retain their authentic newer offline entitlement while waiting for the manager's redemption, and the server still decides whether queued operations can be accepted.

An explicit Firebase Auth `user-disabled` response for the current UID is stored as a local disable lock. Network failure and token expiry are not treated as disablement. A new authenticated trusted bootstrap is required to clear that lock; importing an offline activation file does not clear it.

## Pending operations and loss recovery

License expiration prevents new operational saves. It does not erase the database, drafts, audit or outbox. The server rejects operations received after current entitlement expiry regardless of client timestamps; backdating cannot bypass it. The queue retains stable identifiers and resumes after renewal. Idempotent server receipts prevent duplicated effects after retry. The same rule applies to employee submissions awaiting delivery. Manager approval is a separate server decision.

Keystore private keys do not transfer with a database backup. If an installation key or wrapping key is unavailable, native code fails closed instead of generating a replacement key over existing protected files. Enroll the replacement installation through a trusted operator, obtain a package for its new device ID, and restore only an authorized backup into that account's own scoped database. Preserve original operation IDs. License/membership/clock state is not restored from a ledger export. This flow cannot restart the tenant trial or grant authority that was revoked on the server.

## خطوات المستخدم بالعربية

1. اضبط الحساب والجهاز أول مرة باتصال متاح ومن خلال مسؤول موثوق. يحتفظ التطبيق بمدة تجربة النشاط؛ إضافة موظف لا تبدأ تجربة جديدة.
2. افتح شاشة «الترخيص والتفعيل»، وانسخ معرّف الجهاز أو طلب التفعيل وأرسله بنفسك إلى مُصدر الترخيص. المعرّف وحده ليس كلمة مرور ولا يمنح صلاحية.
3. استلم ملف التفعيل الموثق، ثم استورده من الشاشة أو الصق محتواه كاملاً. يخص الملف حساباً ونشاطاً وجهازاً محدداً. يمكن نقل الملف بوسيلة مشاركة ملفات متاحة دون إنترنت؛ المدير ينقل التوقيع الأصلي ولا يستطيع تمديد الصلاحية بنفسه.
4. يمكن لكل موظف استيراد حزمته المخصصة بعد الالتحاق الموثوق. مدة الصلاحية هي مدة النشاط نفسها، حتى لو التحق الموظف في آخر أيام التجربة.
5. عند انتهاء الصلاحية تبقى العمليات المحفوظة وقائمة الانتظار. فعّل النشاط ثم أعد المزامنة؛ لا تعِد إدخال العمليات نفسها.
6. إذا تغير الهاتف أو حُذف التطبيق أو فُقد مفتاح الجهاز، اطلب إعادة تسجيل الجهاز وإصدار حزمة جديدة. نسخة البيانات لا تنقل مفتاح الهاتف ولا تمنح تجربة جديدة.
7. إذا ظهرت رسالة تغير الوقت بعد إعادة التشغيل، اتصل للتحقق من الوقت. لا تحذف البيانات لمعالجة المشكلة. قد يلزم التحقق الموثوق إذا كان وقت الهاتف غير صحيح.
8. تعطيل موظف أو جهاز من الإدارة يصل إلى الهاتف عند اتصاله واستلام شهادة موثقة، أو عند نقل معلومات موثقة مناسبة إليه. الهاتف المنقطع لا يعرف التغييرات الجديدة فوراً.

## Verification and references

`flutter test test/license_test.dart` covers Node-to-Dart signatures, tampering, bindings, schema, exact day-30 expiry, day-29 employee inheritance, restart persistence, no daily lease, epoch replay/renewal, disabled membership, failed secure writes, concurrent session calls, clock rollback/reboot/timezone and package replay preserving rollback evidence. `node --test tools/license-issuer/issuer.test.mjs` exercises actual Node signatures and the encrypted-key CLI, including device transfer, device caps and prevention of trial resets. Android integration results and exact executed counts belong in the delivery test report; pure Dart tests do not prove Android Keystore or SQLCipher behavior.

Reviewed official references on 2026-10-18: [cryptography Ed25519 API](https://pub.dev/documentation/cryptography/latest/cryptography/Ed25519-class.html), [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [KeyGenParameterSpec](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec), [SystemClock](https://developer.android.com/reference/android/os/SystemClock), [Android backup exclusions](https://developer.android.com/identity/data/autobackup), [Node crypto](https://nodejs.org/api/crypto.html). The pinned Dart package is `cryptography 2.9.0`; its Dart signature verification does not claim to generate a non-exportable device key. Kotlin supplies that separate capability.
