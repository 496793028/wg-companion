package io.github.wgweb.companion

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/* =====================================================================
 *  客户端登录（wg-web）—— POST {server}/api/client/login
 *  入参「用户名 + 口令」，返回本账号的 .conf（含 wg-meta：server/token/id，
 *  客户端据此可继续做服务端自动更新）与账号信息。
 *
 *  HTTPS 证书策略：先按系统标准校验连接；仅在握手失败时按「允许自签名证书」
 *  重试一次（内网自签名部署常见，与桌面端 allowInsecure 默认开 的行为对齐）。
 * ===================================================================== */
object LoginApi {

    data class Result(
        val ok: Boolean,
        val error: String = "",
        val name: String = "",
        val vpnIp: String = "",
        val conf: String = "",
        /** 服务端明确表示账号不存在/已停用（HTTP 401/404）—— 调用方应清理本地残留配置。
         *  与网络错误区分：后者不应误删本地配置。 */
        val gone: Boolean = false,
    )

    fun normalizeServer(s: String): String {
        var v = s.trim().trimEnd('/')
        if (v.isNotEmpty() && !v.startsWith("http://") && !v.startsWith("https://")) v = "http://$v"
        return v
    }

    /** 宽松的 TLS 工厂：仅用于自签名/内网证书的兜底重试 */
    private fun lenientFactory(): SSLSocketFactory {
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<TrustManager>(tm), SecureRandom())
        return ctx.socketFactory
    }

    fun login(serverRaw: String, username: String, password: String): Result {
        val server = normalizeServer(serverRaw)
        if (server.isEmpty() || username.isBlank() || password.isEmpty())
            return Result(false, "请填写服务器地址、用户名与密码")
        return try {
            post(server, username, password, lenient = false)
        } catch (e: Exception) {
            try { post(server, username, password, lenient = true) }
            catch (e2: Exception) {
                Result(false, "无法连接服务器：${e2.message ?: e2.javaClass.simpleName}")
            }
        }
    }

    private fun post(server: String, username: String, password: String, lenient: Boolean): Result {
        val urlConn = URL("$server/api/client/login").openConnection()
        val conn = urlConn as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        conn.setRequestProperty("User-Agent", "wg-companion-android")
        if (lenient && urlConn is HttpsURLConnection) {
            urlConn.sslSocketFactory = lenientFactory()
            urlConn.hostnameVerifier = HostnameVerifier { _, _ -> true }
        }

        val payload = JSONObject().put("username", username).put("password", password).toString()
        conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }

        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()

        val json = try { JSONObject(text) } catch (_: Exception) { null }
        if (code in 200..299 && json != null && json.optBoolean("ok")) {
            val conf = json.optString("conf")
            if (conf.isEmpty()) return Result(false, "服务器未返回配置")
            return Result(true, name = json.optString("name"), vpnIp = json.optString("vpn_ip"), conf = conf)
        }
        val msg = json?.optString("error") ?: ""
        /* 401/404 = 账号已被删除 / 停用 / 口令已改：告知调用方清理本地残留配置 */
        val gone = (code == 401 || code == 404)
        return Result(false, msg.ifEmpty { "登录失败（HTTP $code）" }, gone = gone)
    }

    /* 服务端自动更新：凭每账号只读 token 拉取最新 .conf（与桌面端 fetchServerConf 对齐）。
       GET {server}/api/client/conf?token=...；
       返回 ConfResult：ok=拿到配置，gone=账号/令牌已被删除或撤销（此时应清理本地配置），
       两者都为 false 表示网络异常（保留本地，稍后重试）。 */
    data class ConfResult(val ok: Boolean = false, val conf: String = "", val gone: Boolean = false)

    fun confByToken(serverRaw: String, token: String): ConfResult {
        val server = normalizeServer(serverRaw)
        if (server.isEmpty() || token.isEmpty()) return ConfResult()
        return try {
            fetchByToken(server, token, lenient = false)
        } catch (_: Exception) {
            try { fetchByToken(server, token, lenient = true) } catch (_: Exception) { ConfResult() }
        }
    }

    private fun fetchByToken(server: String, token: String, lenient: Boolean): ConfResult {
        val urlConn = URL("$server/api/client/conf?token=${URLEncoder.encode(token, "UTF-8")}").openConnection()
        val conn = urlConn as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 15000
        conn.readTimeout = 15000
        conn.setRequestProperty("User-Agent", "wg-companion-android")
        if (lenient && urlConn is HttpsURLConnection) {
            urlConn.sslSocketFactory = lenientFactory()
            urlConn.hostnameVerifier = HostnameVerifier { _, _ -> true }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        conn.disconnect()
        val json = try { JSONObject(text) } catch (_: Exception) { null }
        if (code in 200..299 && json != null && json.optString("conf").isNotEmpty())
            return ConfResult(ok = true, conf = json.optString("conf"))
        /* 401/404：令牌无效或已被撤销 / 账号不存在 → 需要清理本地配置 */
        return ConfResult(ok = false, gone = (code == 401 || code == 404))
    }
}
