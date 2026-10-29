# Android debug APK manifest inspection

Inspected the final version-code-6 deliverable APK, not just the source manifest. The earlier version-code-4 report is archived as `work/android-debug-manifest-inspection-v4.md`. No source files or device data were changed. This is the debug test build; release packaging has not been inspected by this report.

| Item | Packaged result |
| --- | --- |
| APK | `outputs/strawberry-trade-test.apk` |
| SHA-256 | `78d6b549f2bfa213aa20f512bb382aa1360eb0ded2632084ca14bf128c5bbd92` |
| Package | `com.strawberrytrade.strawberry_trade` |
| Version | `1.0.0` / version code `6` |
| Compile / target / minimum SDK | `36` / `36` / `24` |
| App label | `تجارة الفراولة` |
| Native ABIs | `arm64-v8a`, `armeabi-v7a`, `x86_64` |
| `android:debuggable` | `true` |
| `android:usesCleartextTraffic` | `true`, deliberately enabled for the local Firebase emulator in this debug build |
| `android:allowBackup` | `false` |
| `android:fullBackupContent` | `false` |
| `android:dataExtractionRules` | References compiled `res/xml/data_extraction_rules.xml` |
| Signing | Verification succeeds; APK Signature Scheme v2; one RSA-2048 Android Debug certificate |
| Public signing certificate SHA-256 | `bd7cf78fb174d2e124b6242058998540814a53f0dc246622ea0cc0015e86c69e` |

The inspected debug APK is a test artifact. Its debug flag, cleartext permission and Android Debug signing identity must not be described as production release settings.

## Permissions and package queries

The merged APK requests exactly these six permissions:

- `android.permission.INTERNET`
- `android.permission.ACCESS_NETWORK_STATE`
- `android.permission.WAKE_LOCK`
- `com.google.android.c2dm.permission.RECEIVE`
- `com.google.android.providers.gsf.permission.READ_GSERVICES`
- `com.strawberrytrade.strawberry_trade.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`

The app declares the last permission with protection level `0x2` (signature). No storage, all-files access, contacts, camera, microphone, location, SMS, phone, or notification permission appears in the merged manifest. The GSF/C2DM permissions and extra authentication components are present in the merged dependency manifest even though the application currently uses email/password authentication.

Package queries are limited to intent handlers for `PROCESS_TEXT` with `text/plain` and `GET_CONTENT` with `*/*`. There is no `QUERY_ALL_PACKAGES` request.

## Components

The merged APK contains 16 components: 7 activities, 3 services, 2 receivers and 4 providers. Every component has an explicit `android:exported` value. Exactly five are exported:

| Exported component | Entry point / manifest protection |
| --- | --- |
| `com.strawberrytrade.strawberry_trade.MainActivity` | `MAIN` / `LAUNCHER`; no component permission |
| `com.google.firebase.auth.internal.GenericIdpActivity` | SDK `VIEW` / `DEFAULT` / `BROWSABLE` callback for `genericidp://firebase.auth/`; no component permission |
| `com.google.firebase.auth.internal.RecaptchaActivity` | SDK `VIEW` / `DEFAULT` / `BROWSABLE` callback for `recaptcha://firebase.auth/`; no component permission |
| `com.google.android.gms.auth.api.signin.RevocationBoundService` | Requires `com.google.android.gms.auth.api.signin.permission.REVOCATION_NOTIFICATION` |
| `androidx.profileinstaller.ProfileInstallReceiver` | Requires `android.permission.DUMP`; profile installation/benchmark actions |

The other eleven components are explicitly not exported:

- `androidx.credentials.playservices.HiddenActivity`
- `com.google.android.gms.auth.api.signin.internal.SignInHubActivity`
- `com.google.android.gms.common.api.GoogleApiActivity`
- `com.google.android.play.core.common.PlayCoreDialogWrapperActivity`
- `com.google.firebase.components.ComponentDiscoveryService`
- `androidx.credentials.playservices.CredentialProviderMetadataHolder`
- `dev.fluttercommunity.plus.share.SharePlusPendingIntent`
- The four providers listed below.

It would be inaccurate to claim that the launcher is the APK's only exported component. Firebase callback and protected dependency components are also included. This manifest inspection does not independently prove the runtime validation of those SDK callbacks.

## Providers and file sharing boundaries

All four providers have `android:exported="false"`:

| Provider | Authority | URI grants / file paths |
| --- | --- | --- |
| `net.nfet.flutter.printing.PrintFileProvider` | `com.strawberrytrade.strawberry_trade.flutter.printing` | `grantUriPermissions=true`; compiled `flutter_printing_file_paths.xml`: `cache-path`, name `share`, path `/share/` |
| `dev.fluttercommunity.plus.share.ShareFileProvider` | `com.strawberrytrade.strawberry_trade.flutter.share_provider` | `grantUriPermissions=true`; compiled `flutter_share_file_paths.xml`: `cache-path`, name `cache`, path `share_plus/` |
| `com.google.firebase.provider.FirebaseInitProvider` | `com.strawberrytrade.strawberry_trade.firebaseinitprovider` | No file paths metadata; `directBootAware=true`, `initOrder=100` |
| `androidx.startup.InitializationProvider` | `com.strawberrytrade.strawberry_trade.androidx-startup` | No file paths metadata |

The two registered file providers reference cache subdirectories; neither referenced path resource declares `root-path`, `external-path`, or a database path. The APK also contains an `image_share_filepaths.xml` resource with `files-path`, name `image_provider_images`, path `image_provider/`; no provider in this merged manifest references it. Resource presence alone does not register a provider.

## Backup and transfer rules

The compiled data extraction XML was inspected from the APK. `cloud-backup` has `disableIfNoEncryptionCapabilities=true`. Both `cloud-backup` and `device-transfer` contain exclusions with `path="."` for each of these six domains: `root`, `file`, `database`, `sharedpref`, `external`, `device_root`.

These results verify packaged flags and XML contents. Actual cloud-backup restoration and manufacturer device-transfer behavior were not exercised by this inspection.

## Reproduction commands and raw evidence

Run from the workspace root:

```sh
/home/younis/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer manifest print outputs/strawberry-trade-test.apk > work/android-debug-final-merged-manifest.xml
/home/younis/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer manifest permissions outputs/strawberry-trade-test.apk
/home/younis/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer manifest debuggable outputs/strawberry-trade-test.apk
/home/younis/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer manifest min-sdk outputs/strawberry-trade-test.apk
/home/younis/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer manifest target-sdk outputs/strawberry-trade-test.apk
/home/younis/Android/Sdk/build-tools/36.0.0/aapt dump badging outputs/strawberry-trade-test.apk > work/android-debug-final-badging.txt
/home/younis/Android/Sdk/build-tools/36.0.0/apksigner verify --verbose --print-certs outputs/strawberry-trade-test.apk > work/android-debug-final-signature.txt
/home/younis/Android/Sdk/cmdline-tools/latest/bin/apkanalyzer files list outputs/strawberry-trade-test.apk > work/android-debug-final-files.txt
/home/younis/Android/Sdk/build-tools/36.0.0/aapt dump xmltree outputs/strawberry-trade-test.apk res/xml/data_extraction_rules.xml
/home/younis/Android/Sdk/build-tools/36.0.0/aapt dump xmltree outputs/strawberry-trade-test.apk res/xml/flutter_printing_file_paths.xml
/home/younis/Android/Sdk/build-tools/36.0.0/aapt dump xmltree outputs/strawberry-trade-test.apk res/xml/flutter_share_file_paths.xml
/home/younis/Android/Sdk/build-tools/36.0.0/aapt dump xmltree outputs/strawberry-trade-test.apk res/xml/image_share_filepaths.xml
sha256sum outputs/strawberry-trade-test.apk
```

The direct manifest checks return `true`, `24` and `36` respectively. `apksigner` reports `Verifies` and `Verified using v2 scheme (APK Signature Scheme v2): true`. The SDK Java tools emitted deprecated/restricted Java API warnings on this host; the listed inspections and signature verification still completed successfully.

No private signing keys, account identifiers, tenant data, device identifiers, passwords or access tokens are included in this report. The signing fingerprint above belongs to the public test certificate.
