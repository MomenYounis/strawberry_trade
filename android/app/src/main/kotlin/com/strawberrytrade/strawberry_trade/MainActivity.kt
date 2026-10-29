package com.strawberrytrade.strawberry_trade

import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** No private device or wrapping key is exported across the Flutter channel. */
class MainActivity : FlutterActivity() {
    private val signingAlias = "strawberry.installation.sign.v1"
    private val wrappingAlias = "strawberry.installation.wrap.v1"
    private val keyStore: KeyStore by lazy { KeyStore.getInstance("AndroidKeyStore").apply { load(null) } }
    private val secureDirectory: File by lazy { File(noBackupFilesDir, "protected-v1").apply { mkdirs() } }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "strawberry_trade/device_security")
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "identity" -> {
                            ensureIdentity()
                            val publicKey = keyStore.getCertificate(signingAlias).publicKey.encoded
                            result.success(mapOf("deviceId" to encode(MessageDigest.getInstance("SHA-256").digest(publicKey)),
                                "publicKeySpki" to encode(publicKey), "algorithm" to "P256-SHA256"))
                        }
                        "signChallenge" -> {
                            val challenge = call.arguments as? ByteArray ?: error("invalid_challenge")
                            require(challenge.size in 32..4096) { "invalid_challenge" }
                            ensureIdentity()
                            val signer = Signature.getInstance("SHA256withECDSA")
                            signer.initSign(keyStore.getKey(signingAlias, null) as java.security.PrivateKey)
                            signer.update(challenge)
                            result.success(signer.sign())
                        }
                        "databasePassword" -> {
                            val scope = validScope(call.arguments)
                            val name = "database:$scope"
                            val existing = readProtected(name)
                            val password = existing ?: encode(ByteArray(32).also { SecureRandom().nextBytes(it) }).also {
                                writeProtected(name, it)
                            }
                            result.success(password)
                        }
                        "readSecureValue" -> result.success(readProtected("value:${validScope(call.arguments)}"))
                        "writeSecureValue" -> {
                            val args = call.arguments as? Map<*, *> ?: error("invalid_arguments")
                            val scope = validScope(args["scope"])
                            val value = args["value"] as? String ?: error("invalid_value")
                            require(value.toByteArray(Charsets.UTF_8).size <= 200000) { "value_too_large" }
                            writeProtected("value:$scope", value)
                            result.success(null)
                        }
                        "clock" -> result.success(mapOf("wallMs" to System.currentTimeMillis(),
                            "elapsedMs" to SystemClock.elapsedRealtime(),
                            "bootCount" to Settings.Global.getInt(contentResolver, Settings.Global.BOOT_COUNT, -1)))
                        else -> result.notImplemented()
                    }
                } catch (_: Exception) {
                    // Do not leak secret material or financial data into errors/logs.
                    result.error("device_security_unavailable", "تعذر فتح حماية الجهاز. يلزم الاسترداد الآمن إذا فُقد المفتاح.", null)
                }
            }
    }

    private fun validScope(value: Any?): String {
        val scope = value as? String ?: error("invalid_scope")
        require(scope.isNotEmpty() && scope.length <= 512) { "invalid_scope" }
        return scope
    }

    private fun ensureIdentity() {
        if (keyStore.containsAlias(signingAlias)) return
        // A partially restored installation must never silently become a new device.
        check(secureDirectory.listFiles()?.isEmpty() != false) { "re_enrollment_required" }
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(KeyGenParameterSpec.Builder(signingAlias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256).build())
        generator.generateKeyPair()
    }

    private fun wrappingKey(): SecretKey {
        ensureIdentity()
        if (keyStore.containsAlias(wrappingAlias)) return keyStore.getKey(wrappingAlias, null) as SecretKey
        check(secureDirectory.listFiles()?.isEmpty() != false) { "key_loss_requires_recovery" }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(wrappingAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        return generator.generateKey()
    }

    private fun protectedFile(name: String): AtomicFile {
        val hash = MessageDigest.getInstance("SHA-256").digest(name.toByteArray(Charsets.UTF_8))
        return AtomicFile(File(secureDirectory, encode(hash)))
    }

    private fun readProtected(name: String): String? {
        val file = protectedFile(name)
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return null
        val bytes = file.openRead().use { it.readBytes() }
        require(bytes.size in 29..200100 && bytes[0].toInt() == 1) { "invalid_protected_value" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8)
    }

    private fun writeProtected(name: String, value: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        val bytes = byteArrayOf(1) + cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val file = protectedFile(name)
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (failure: Exception) { file.failWrite(stream); throw failure }
    }

    private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
