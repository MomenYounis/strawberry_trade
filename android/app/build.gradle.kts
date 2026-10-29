import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.strawberrytrade.strawberry_trade"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.strawberrytrade.strawberry_trade"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Keep release credentials outside the source tree when configured by the
    // operator. The local key.properties fallback supports existing setups.
    val externalSigningFile = System.getenv("STRAWBERRY_SIGNING_PROPERTIES")
    val releaseKeyFile = externalSigningFile?.let { file(it) }
        ?: rootProject.file("key.properties")
    check(externalSigningFile == null || releaseKeyFile.isFile) {
        "STRAWBERRY_SIGNING_PROPERTIES must point to an existing signing configuration"
    }
    if (releaseKeyFile.exists()) {
        val keys = Properties().apply { releaseKeyFile.inputStream().use { load(it) } }
        signingConfigs.create("production") {
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
            storeFile = file(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
        }
    }
    buildTypes {
        release {
            // Release remains unsigned until an external production key is configured.
            signingConfig = signingConfigs.findByName("production")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
