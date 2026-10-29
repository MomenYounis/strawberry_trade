# App Check without a Play developer account — reviewed 2026-10-19

## Recommendation

Keep the existing built-in Firebase Play Integrity provider and test the Cloud-only setup first. A paid Google Play developer account is not an established prerequisite for this path. Do not build a custom hardware-attestation service merely because the app is distributed as a direct APK.

The current Android setup documentation, updated **2026-10-16**, permits enabling Play Integrity API in Google Cloud Console and then integrating it. Linking Play Console is recommended for additional configuration, testing/reporting and quota increases; unlinked Cloud projects can use the base API. The default project quota is 10,000 daily token requests and 10,000 token decryptions. A sideload-only app cannot rely on the documented Play-distribution quota-increase path. [Official Android setup](https://developer.android.com/google/play/integrity/setup).

The Firebase how-to still describes linking through Play Console. The newer general setup, Firebase's off-Play policy controls and provider implementation together support the Cloud-only built-in route. **That interoperability is an inference from supported mechanisms, not an observed successful token on this user's phone.** A physical-device token exchange remains the acceptance criterion.

## Provider policy for direct APK distribution

Firebase's documented `PlayIntegrityConfig` has controls specifically for off-Play apps. `allowUnrecognizedVersion=true` is the off-Play setting; `requireLicensed=false` avoids requiring a Play-acquired entitlement. Set `MEETS_DEVICE_INTEGRITY` explicitly: omitting the level defaults to `NO_INTEGRITY`, and allowing unrecognized versions also permits an unevaluated app-recognition verdict. Device integrity is available without optional Play Console opt-ins; Basic and Strong are optional verdicts. Firebase uses the Android app's registered SHA-256 fingerprints in token validation. [Official REST resource](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.playIntegrityConfig).

Reviewable desired configuration, not executed by this research:

```json
{
  "name": "projects/713439663809/apps/1:713439663809:android:c0565e7ada543b0e2b6640/playIntegrityConfig",
  "tokenTtl": "3600s",
  "appIntegrity": {"allowUnrecognizedVersion": true},
  "deviceIntegrity": {"minDeviceRecognitionLevel": "MEETS_DEVICE_INTEGRITY"},
  "accountDetails": {"requireLicensed": false}
}
```

The provider-specific GET endpoint is `https://firebaseappcheck.googleapis.com/v1/projects/713439663809/apps/1:713439663809:android:c0565e7ada543b0e2b6640/playIntegrityConfig`. A later reviewed PATCH can use `updateMask=tokenTtl,appIntegrity,deviceIntegrity,accountDetails`; it does not require changing global service enforcement. Preserve and compare the old config before writing. [GET API](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.playIntegrityConfig/get), [PATCH API](https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.playIntegrityConfig/patch).

## Why the installed client can use this

The official Android Firebase provider obtains the Cloud project number from `FirebaseApp`'s GCM sender ID, gets a nonce from Firebase, calls Play Integrity with that number and nonce, and exchanges the result with Firebase App Check. It does not request Play Console credentials or a Play-published application identifier. [Official provider source](https://github.com/firebase/firebase-android-sdk/blob/main/appcheck/firebase-appcheck-playintegrity/src/main/java/com/google/firebase/appcheck/playintegrity/internal/PlayIntegrityAppCheckProvider.java).

Local inspection found Firebase BoM 35.0.0, `firebase-appcheck-playintegrity` 20.0.0 and Play Integrity 1.4.0 already in Gradle's dependency cache; Flutter's `firebase_app_check` 0.5.0 supplies its provider dependency. No extra native implementation is justified before testing the configured built-in provider. Current merchant device coverage still depends on genuine certified devices with working Google Play services and acceptable device integrity; minSdk 24 alone is not an integrity guarantee.

A focused validation sequence is: read provider/API state; prepare Cloud API/provider settings for this Android app; install the correctly signed APK on a physical certified phone; explicitly request an App Check token without printing it; then, after separately approved backend deployment/onboarding, obtain a signed protected bootstrap for the owner/device. Keep existing server App Check enforcement, P-256 enrollment proofs and tenant checks. Failure must retain offline records and identify the specific provider error, rather than trigger installation deletion or a debug-provider workaround.

## Hardware-attestation fallback, only if needed

Firebase officially supports custom providers: a trusted backend validates authenticity evidence and mints App Check tokens using the Admin SDK, while a native Android `AppCheckProvider` obtains fresh tokens. This would add a separately secured token endpoint, verifier service, replay/rate controls, IAM token-signing permission, SDK integration and production operation. It is not a configuration-only substitution. [Firebase custom-provider server](https://firebase.google.com/docs/app-check/custom-provider), [Android custom provider](https://firebase.google.com/docs/app-check/android/custom-provider).

Android hardware-key attestation needs server-side chain/root/revocation validation and Trusted Environment or StrongBox security. Attestation was not mandatory until devices launched with API 26, despite the API existing at 24. Current validation must handle the 2026 additional trust root and different factory/RKP certificate-expiration policies. Android now recommends its maintained Kotlin verifier instead of bespoke parsers. This implies a JVM verifier component rather than casually adding ASN.1 parsing to the Node Functions backend. [Android verification guide](https://developer.android.com/privacy-and-security/security-key-attestation), [official verifier](https://github.com/android/keyattestation).

The policy would need to check the server nonce, public key, exact package and release-certificate SHA-256, locked/verified boot, and chosen patch-age rules. These attestation fields have defined platform semantics; some old attestations lack application-ID information. Strict rejection can exclude older merchant phones, and softening it must be an explicit policy choice. [AOSP attestation format](https://source.android.com/docs/security/features/keystore/attestation).

The current installation P-256 key was generated without an attestation challenge. Preserve its identity, encrypted database and licensing binding. If a fallback were later justified, add a **separate** fresh attestation key whose challenge includes the existing public identity and server nonce; verify possession of both keys in one enrollment transaction. Refreshing boot evidence requires new challenged attestation, not replaying a years-old certificate. The existing key cannot retroactively acquire a key-generation challenge. [Android key-generation API](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setAttestationChallenge(byte[])). This is a proposed design, not implemented evidence.

No remote API was enabled, policy changed, token obtained, paid account created or fallback implemented during this review.
