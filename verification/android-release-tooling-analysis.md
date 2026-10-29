# Release plugin registrant mismatch

## Observed failure

`work/android-release-final-build.log` records `:app:compileReleaseJavaWithJavac` failing because `GeneratedPluginRegistrant.java` references `dev.flutter.plugins.integration_test.IntegrationTestPlugin`, whose development-only Android dependency is absent from the release compile classpath. The preceding invocation used `flutter build apk --release --no-pub` after native integration testing.

## Root cause verified in the installed Flutter 3.47.2 source

- `packages/flutter_tools/lib/src/runner/flutter_command.dart`, `regeneratePlatformSpecificToolingIfApplicable` (around lines 2054–2060), immediately returns when `shouldRunPub` is false. Thus `--no-pub` skips native plugin registrant regeneration as well as dependency preparation.
- `packages/flutter_tools/lib/src/flutter_plugins.dart`, `injectPlugins` (around lines 1407–1423), removes plugins with `isDevDependency` only when `releaseMode` is true, then writes the Android registrant from the filtered list.
- `packages/flutter_tools/lib/src/commands/packages.dart` (around lines 392–410) explicitly documents this mode problem: standalone dependency preparation is neither a debug nor release build and generates tooling with `releaseMode=false`; the comment warns about a later `flutter build --no-pub`.
- `packages/flutter_tools/gradle/src/main/kotlin/plugins/PluginHandler.kt` (around lines 111–118) correctly adds development plugin dependencies only for non-release build types. This explains why an old debug registrant cannot compile as release.

These are the installed primary tool sources. No SDK files, generated source, app dependencies, or Android build configuration were modified to work around the failure.

## Reproducible correction

Run the build with its normal tooling preparation, after other Flutter build/test/dependency commands on this checkout finish:

```sh
/home/younis/flutter/bin/flutter build apk --release --dart-define-from-file=integration-test-defines.json
```

The definitions file above is the local emulator fixture for this test workspace, not production configuration. Use the approved public definitions file for a real release. Do not add `--no-pub` to this mode-switch build. Do not replace this with a standalone `flutter pub get` followed by `--no-pub`; standalone dependency preparation creates a development registrant again.

Keep `integration_test` in `dev_dependencies`, allow the normal release build to regenerate the registrant without development plugins, and preserve the existing unsigned-unless-external-key release signing configuration. Do not edit `GeneratedPluginRegistrant.java`, patch the SDK, or add the integration test plugin to release dependencies. Use normal tooling regeneration when switching back to native integration testing, too.

The developer guide now documents these instructions. The corrected release command has **not** been launched by this investigation; the root agent will run it after outstanding source work finishes. Success still requires confirming the new build log, artifact, merged release manifest and absence of the integration plugin from the packaged release.
