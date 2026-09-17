package io.github.wgweb.companion

/* wg-meta 元数据与配置摘要解析 —— 与桌面端 lib/core.js、wg-web 服务端约定一致：
 * 首行注释 `# wg-meta v1 <base64(utf8 json)>`，json = {v,name,mode,proxy,nets} */
import android.util.Base64
import org.json.JSONObject

data class TunnelInfo(
    val name: String,
    val mode: String,          // allow | deny | proxy
    val modeLabel: String,     // 白名单 | 黑名单 | 全代理
    val nets: List<String>,    // 不含 0.0.0.0/0 的展示网段
    val endpoint: String,
    val address: String,
)

object ConfMeta {
    private val LABELS = mapOf("allow" to "白名单", "deny" to "黑名单", "proxy" to "全代理")

    fun parseInfo(text: String, fileName: String): TunnelInfo {
        val meta = text.lineSequence().firstOrNull { it.trim().startsWith("# wg-meta") }?.let { line ->
            try {
                val b64 = line.trim().split(" ")[3]
                JSONObject(String(Base64.decode(b64, Base64.DEFAULT), Charsets.UTF_8))
            } catch (_: Exception) { null }
        }
        val ifaceAddr = valueOf(text, "Address")
        val endpoint = valueOf(text, "Endpoint")
        val allowed = (valueOf(text, "AllowedIPs")).split(',').map { it.trim() }.filter { it.isNotEmpty() }
        val legacy = Regex("^#\\s*(10\\.\\d+\\.\\d+\\.\\d+)\\s*\\(?([A-Za-z0-9_.-]*)\\)?\\s*$", RegexOption.MULTILINE)
            .find(text)?.groupValues?.get(2) ?: ""
        val baseName = fileName.removeSuffix(".conf").substringAfterLast('/')
        val name = meta?.optString("name")?.takeIf { it.isNotEmpty() } ?: legacy.ifEmpty { baseName.ifEmpty { "未命名隧道" } }
        val allNets = meta?.optJSONArray("nets")?.let { arr -> (0 until arr.length()).map { arr.getString(it) } } ?: allowed
        val mode = when {
            meta == null -> if (allowed.contains("0.0.0.0/0")) "global" else "allow"
            meta.optInt("proxy") == 1 -> "proxy"
            meta.optString("mode") == "deny" -> "deny"
            else -> "allow"
        }
        return TunnelInfo(name, mode, LABELS[mode] ?: "白名单",
            allNets.filter { it != "0.0.0.0/0" }, endpoint, ifaceAddr)
    }

    private fun valueOf(text: String, key: String): String =
        text.lineSequence().map { it.trim() }
            .firstOrNull { it.startsWith("$key =", ignoreCase = true) || it.startsWith("$key=", ignoreCase = true) }
            ?.substringAfter('=')?.trim() ?: ""
}
