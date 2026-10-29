# Final optimized release APK inspection

The actual packaged version6 APK was inspected after the successful release build.

| Item | Result |
|---|---|
| Delivered file | `strawberry-trade-release-unsigned.apk` |
| SHA-256 | `ff7bb610454f8ca8fff62a68e54533ab2328ca0f17b71177a4b18779e12643a3` |
| Bytes | 77008300 |
| Package / version | `com.strawberrytrade.strawberry_trade`, `1.0.0` / `6` |
| SDK | minimum24; target/compile36 |
| Native ABIs | arm64-v8a, armeabi-v7a, x86_64 |
| Debuggable | false (manifest default, runtime flags confirmed) |
| Cleartext HTTP | false |
| Backup | allowBackup=false, fullBackupContent=false, explicit extraction exclusions |
| Signature | **Unsigned**; apksigner exit1 is expected; no production key was available |

The six permissions are INTERNET, ACCESS_NETWORK_STATE, READ_GSERVICES, WAKE_LOCK, C2DM RECEIVE and the app's signature-level dynamic-receiver permission. There is no broad storage/location/contacts/camera permission. Five components are exported: the launcher, Firebase GenericIdpActivity/RecaptchaActivity, GMS RevocationBoundService (GMS permission), and ProfileInstallReceiver (android.permission.DUMP). All four providers are private; PDF sharing uses temporary URI grants. The actual XML is `android-release-manifest.xml`.

A separate local copy was signed with the **existing Android Debug test certificate** solely for runtime verification. Certificate SHA-256: `bd7cf78fb174d2e124b6242058998540814a53f0dc246622ea0cc0015e86c69e`. It installed over version6 synthetic data, opened the real encrypted ledger in airplane mode, retained one pending operation and the 71.00-EGP reference balance, and generated/shared an Arabic PDF to the native chooser. No recipient was selected. See optimized install/signature logs and screenshots. The delivered review APK remains unsigned. This proves an optimized runtime path, not production signing, live production integration or App Check attestation.

Commands used: SDK apkanalyzer manifest print/apk summary; SDK apksigner verify --verbose --print-certs; an isolated `apksigner sign --out` test copy with the existing debug key; adb install -r/am start. No production key was created or committed. The release build omitted --no-pub to regenerate release-only native plugin registration; no SDK/generated-source patch was used.
