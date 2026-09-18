package io.github.wgweb.companion

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.max

/* 主界面：导入配置 → 显示 用户名 / 模式徽章（白名单·黑名单·全代理）/ 授权网段 → 一键开合隧道。
 * 隧道由 WireGuard GoBackend（系统 VpnService）承载，无需安装任何 WireGuard 应用。 */
class MainActivity : ComponentActivity() {

    private val pickConf =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? -> uri?.let { importConf(it) } }

    private val vpnPermission =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val t = pendingToggle
            pendingToggle = null
            if (result.resultCode == RESULT_OK && t != null) toggle(t.first, t.second)
            else if (t != null && t.first) toast("未授予 VPN 权限，无法开启隧道")
        }

    private var pendingToggle: Pair<Boolean, File>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        /* 从文件管理器「用其他应用打开」.conf 直接进入导入 */
        intent?.data?.let { importConf(it) }
        setContent { WgcScreen() }
    }

    /* ---------- 数据 ---------- */
    private fun tunnelDir(): File = getExternalFilesDir(null) ?: filesDir

    private fun loadTunnels(): List<TunnelItem> =
        (tunnelDir().listFiles { f -> f.name.endsWith(".conf") } ?: emptyArray())
            .sortedBy { it.name }
            .map { f ->
                val text = try { f.readText() } catch (_: Exception) { "" }
                TunnelItem(f, ConfMeta.parseInfo(text, f.name))
            }

    private fun importConf(uri: Uri) {
        try {
            val raw = contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                ?: return toast("无法读取该文件")
            val name = ConfMeta.parseInfo(raw, uri.lastPathSegment ?: "tunnel").name
            tunnelDir().mkdirs()
            /* 原样保存（含 wg-meta 注释行），GoBackend 解析时会忽略注释 */
            File(tunnelDir(), "$name.conf").writeText(raw)
            toast("已导入：$name")
        } catch (e: Exception) {
            toast("导入失败：${e.message}")
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    /* 版本号 + GitHub 更新检查（与桌面端 1.1.0 行为一致） */
    private data class UpdateInfo(val latest: String, val url: String)

    private fun openUrl(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
    }

    private fun semverGt(a: String, b: String): Boolean {
        val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
        val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until max(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }; val y = pb.getOrElse(i) { 0 }
            if (x > y) return true
            if (x < y) return false
        }
        return false
    }

    private suspend fun checkGitHubUpdate(current: String): UpdateInfo? = withContext(Dispatchers.IO) {
        try {
            val u = URL("https://api.github.com/repos/496793028/wg-companion/releases/latest")
            val conn = (u.openConnection() as HttpURLConnection).apply {
                connectTimeout = 12000; readTimeout = 12000
                requestMethod = "GET"
                setRequestProperty("User-Agent", "wg-companion-android/$current")
                setRequestProperty("Accept", "application/vnd.github+json")
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val tag = Regex("\"tag_name\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
            val html = Regex("\"html_url\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
            if (tag != null && semverGt(tag.removePrefix("v"), current))
                UpdateInfo(tag, html ?: "https://github.com/496793028/wg-companion/releases/latest")
            else null
        } catch (_: Exception) { null }
    }

    /* ---------- 隧道控制 ---------- */
    private fun toggle(wantUp: Boolean, confFile: File) {
        lifecycleScope.launch {
            try {
                val name = confFile.nameWithoutExtension
                val tunnel = SimpleTunnel(name)
                val state = if (wantUp) Tunnel.State.UP else Tunnel.State.DOWN
                val config = if (wantUp)
                    withContext(Dispatchers.IO) { Config.parse(BufferedReader(confFile.reader())) } else null
                WgcApp.backend.setState(tunnel, state, config)
            } catch (e: Exception) {
                toast("操作失败：${e.message}")
            }
        }
    }

    /* Tunnel 接口的最小实现：后端内部保存状态 */
    private class SimpleTunnel(private val n: String) : Tunnel {
        override fun getName(): String = n
        override fun onStateChange(newState: Tunnel.State) {}
    }

    /* ---------- UI ---------- */
    @Composable
    private fun WgcScreen() {
        val appVersion = remember {
            runCatching { packageManager.getPackageInfo(packageName, 0).versionName ?: "1.1.0" }.getOrElse { "1.1.0" }
        }
        var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
        LaunchedEffect(Unit) { updateInfo = checkGitHubUpdate(appVersion) }

        var tunnels by remember { mutableStateOf(loadTunnels()) }
        val scope = rememberCoroutineScope()
        val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            uri?.let { importConf(it); tunnels = loadTunnels() }
        }
        val vpnPermissionLauncher =
            rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
                val t = pendingToggle
                pendingToggle = null
                if (r.resultCode == RESULT_OK && t != null) {
                    scope.launch { toggle(t.first, t.second) }
                    tunnels = loadTunnels()
                } else if (t != null && t.first) toast("未授予 VPN 权限，无法开启隧道")
            }

        Surface(color = Color(0xFF0B0F16)) {
            Column(Modifier.fillMaxSize().padding(20.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("WG Companion", color = Color(0xFFE8EDF5), fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Text("wg-web 配套客户端 · 淡紫与鎏金", color = Color(0xFF5C6A7F), fontSize = 12.sp)
                    }
                    Text("v$appVersion", color = Color(0xFF5C6A7F), fontSize = 12.sp)
                }

                updateInfo?.let { info ->
                    Card(
                        modifier = Modifier.fillMaxWidth().clickable { openUrl(info.url) }.padding(top = 12.dp, bottom = 4.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = Color(0xFF1B2540))
                    ) {
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("发现新版本 ${info.latest}，建议更新", color = Color(0xFFE8EDF5), fontSize = 13.sp, modifier = Modifier.weight(1f))
                            Text("前往下载 ›", color = Color(0xFF7C5CFF), fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                Spacer(Modifier.height(18.dp))
                Button(
                    onClick = { pick.launch(arrayOf("text/plain", "application/octet-stream")) },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7C5CFF)),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.height(46.dp).fillMaxWidth()
                ) { Text("导入配置（.conf）", fontSize = 14.sp) }

                Spacer(Modifier.height(18.dp))
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(tunnels, key = { it.file.absolutePath }) { item ->
                        TunnelCard(item,
                            onToggle = { wantUp ->
                                val intent = WgcApp.vpnPermissionIntent(this@MainActivity)
                                if (wantUp && intent != null) { pendingToggle = wantUp to item.file; vpnPermissionLauncher.launch(intent) }
                                else { toggle(wantUp, item.file); scope.launch { kotlinx.coroutines.delay(600); tunnels = loadTunnels() } }
                            })
                    }
                }
            }
        }
    }

    data class TunnelItem(val file: File, val info: TunnelInfo)

    @Composable
    private fun TunnelCard(t: TunnelItem, onToggle: (Boolean) -> Unit) {
        val up = remember(t) { mutableStateOf(false) }
        val scale by animateFloatAsState(if (up.value) 1.012f else 0.995f, tween(280), label = "sc")
        val knobColor by animateColorAsState(if (up.value) Color(0xFF2FD07B) else Color(0xFF8FA0B8), tween(260), label = "knob")
        LaunchedEffect(t.file) {
            /* 每次重组读一次后端状态（简单可靠） */
            up.value = try {
                WgcApp.backend.getState(SimpleTunnel(t.info.name)) == Tunnel.State.UP
            } catch (_: Exception) { false }
        }
        val badgeColor = when (t.info.mode) {
            "deny" -> Color(0xFFD4AF37)
            "proxy" -> Color(0xFFB69BFF)
            else -> Color(0xFF4C8DFF)
        }
        Row(
            Modifier.fillMaxWidth().scale(scale)
                .background(
                    if (up.value) Brush.horizontalGradient(listOf(Color(0xFF12301F), Color(0xFF0F1A26)))
                    else Brush.horizontalGradient(listOf(Color(0xFF121926), Color(0xFF121926))),
                    RoundedCornerShape(18.dp)
                )
                .clickable { onToggle(!up.value) }
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.info.name, color = Color(0xFFE8EDF5), fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(8.dp))
                    Text(t.info.modeLabel, color = badgeColor, fontSize = 11.sp,
                        modifier = Modifier.background(badgeColor.copy(alpha = 0.15f), RoundedCornerShape(999.dp))
                            .padding(horizontal = 9.dp, vertical = 3.dp))
                }
                Spacer(Modifier.height(7.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    (t.info.nets.take(4).ifEmpty { listOf("全部流量") }).forEach {
                        Text(it, color = Color(0xFF93A0B4), fontSize = 10.5.sp,
                            modifier = Modifier.background(Color(0xFF161E2D), RoundedCornerShape(999.dp))
                                .padding(horizontal = 8.dp, vertical = 2.dp))
                    }
                }
                if (t.info.endpoint.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(t.info.endpoint, color = Color(0xFF5C6A7F), fontSize = 11.sp)
                }
            }
            Box(
                Modifier.size(width = 52.dp, height = 28.dp)
                    .background(if (up.value) Color(0x332FD07B) else Color(0xFF202A3A), CircleShape)
                    .clickable { onToggle(!up.value) },
                contentAlignment = Alignment.CenterStart
            ) {
                Box(Modifier.padding(start = if (up.value) 26.dp else 3.dp).size(22.dp).background(knobColor, CircleShape))
            }
        }
    }
}
