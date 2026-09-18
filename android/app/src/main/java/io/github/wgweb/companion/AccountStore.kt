package io.github.wgweb.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/* =====================================================================
 *  账号存储（Android）
 *   · history  —— 历史登录条目（服务器 / 用户名 / 保存密码 / 自动登录），供下拉选择与删除
 *   · tunnels  —— 哪些 .conf 是「登录账号自动拉取」的（用于置顶显示 + 退出登录时删除）
 *   · 口令     —— 用 Android Keystore 里的 AES-256-GCM 密钥加密后存入 SharedPreferences，
 *                密钥不出安全硬件/系统密钥库，**绝不落明文**（不引入任何第三方依赖）
 * ===================================================================== */
data class AccountEntry(
    val server: String,
    val username: String,
    val remember: Boolean,
    val autoLogin: Boolean,
    val hasPwd: Boolean,
    val lastUsed: String = "",
)

object AccountStore {
    private const val PREF = "wgc_accounts"
    private const val K_HISTORY = "history"
    private const val K_TUNNELS = "tunnels"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "wgc_pwd_key_v1"

    private fun prefs(c: Context) = c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
    private fun keyOf(server: String, user: String) = server.trim().trimEnd('/') + "\u0000" + user.trim()
    private fun pwdKey(server: String, user: String) = "pwd::" + keyOf(server, user)

    /* ---------------- 口令加解密（Android Keystore，AES-256-GCM） ---------------- */
    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    /** 系统密钥库是否可用（不可用时禁用「保存密码 / 自动登录」） */
    fun secureAvailable(): Boolean = try { secretKey(); true } catch (_: Exception) { false }

    fun encrypt(plain: String): String = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    } catch (_: Exception) { "" }

    fun decrypt(blob: String): String = try {
        val parts = blob.split(":")
        if (parts.size != 2) "" else {
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ct = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        }
    } catch (_: Exception) { "" }

    /* ---------------- 历史条目 ---------------- */
    fun history(c: Context): List<AccountEntry> {
        val raw = prefs(c).getString(K_HISTORY, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                val server = o.optString("server"); val user = o.optString("username")
                AccountEntry(server, user, o.optBoolean("remember"), o.optBoolean("autoLogin"),
                    prefs(c).contains(pwdKey(server, user)), o.optString("lastUsed"))
            }.sortedByDescending { it.lastUsed }
        } catch (_: Exception) { emptyList() }
    }

    /** 记住 / 更新一条历史登录（remember=false 时顺带清掉已保存的口令） */
    fun remember(c: Context, server: String, username: String, remember: Boolean, autoLogin: Boolean, password: String?) {
        val list = history(c).toMutableList()
        val idx = list.indexOfFirst { it.server == server && it.username == username }
        val prev = if (idx >= 0) list[idx] else AccountEntry(server, username, false, false, false)
        val entry = prev.copy(remember = remember, autoLogin = autoLogin,
            lastUsed = System.currentTimeMillis().toString())
        if (idx >= 0) list[idx] = entry else list.add(entry)
        writeHistory(c, list)
        val p = prefs(c).edit()
        if (remember && !password.isNullOrEmpty()) p.putString(pwdKey(server, username), encrypt(password))
        if (!remember) p.remove(pwdKey(server, username))
        p.apply()
    }

    /** 删除一条历史（连同已保存的口令一起删除） */
    fun forget(c: Context, server: String, username: String) {
        val list = history(c).filterNot { it.server == server && it.username == username }
        writeHistory(c, list)
        prefs(c).edit().remove(pwdKey(server, username)).apply()
    }

    /** 取出已保存的明文口令（下拉选择用户名时回填密码框）；无则返回空串 */
    fun password(c: Context, server: String, username: String): String {
        val blob = prefs(c).getString(pwdKey(server, username), null) ?: return ""
        return decrypt(blob)
    }

    private fun writeHistory(c: Context, list: List<AccountEntry>) {
        val arr = JSONArray()
        list.forEach { e ->
            arr.put(JSONObject().apply {
                put("server", e.server); put("username", e.username)
                put("remember", e.remember); put("autoLogin", e.autoLogin)
                put("lastUsed", e.lastUsed)
            })
        }
        prefs(c).edit().putString(K_HISTORY, arr.toString()).apply()
    }

    /* ---------------- 账号配置归属（登录后拉取的 .conf）---------------- */
    private fun tunnels(c: Context): JSONObject = try {
        JSONObject(prefs(c).getString(K_TUNNELS, null) ?: "{}")
    } catch (_: Exception) { JSONObject() }

    fun markTunnel(c: Context, fileName: String, server: String, username: String) {
        val o = tunnels(c).put(fileName, JSONObject().put("server", server).put("username", username))
        prefs(c).edit().putString(K_TUNNELS, o.toString()).apply()
    }

    fun unmarkTunnel(c: Context, fileName: String) {
        val o = tunnels(c); o.remove(fileName)
        prefs(c).edit().putString(K_TUNNELS, o.toString()).apply()
    }

    /** 该配置是否为某账号自动拉取；返回 (server, username) 或 null */
    fun tunnelOwner(c: Context, fileName: String): Pair<String, String>? {
        val o = tunnels(c).optJSONObject(fileName) ?: return null
        return o.optString("server") to o.optString("username")
    }

    /** 某账号名下拉取的全部配置文件名（退出登录时删除） */
    fun filesOf(c: Context, server: String, username: String): List<String> {
        val o = tunnels(c)
        return o.keys().asSequence().filter { k ->
            val e = o.optJSONObject(k) ?: return@filter false
            e.optString("username") == username && (server.isEmpty() || e.optString("server") == server)
        }.toList()
    }

    fun clearTunnelMarks(c: Context, files: List<String>) {
        val o = tunnels(c); files.forEach { o.remove(it) }
        prefs(c).edit().putString(K_TUNNELS, o.toString()).apply()
    }
}
