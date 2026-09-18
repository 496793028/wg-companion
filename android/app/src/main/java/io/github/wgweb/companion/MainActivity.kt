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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
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

/* 主界面：导入配置 / 账号登录 → 显示 用户名 · 模式徽章（白名单·黑名单·全代理）· 授权网段 → 一键开合隧道。
 * 隧道由 WireGuard GoBackend（系统 VpnService）承载，无需安装任何 WireGuard 应用。
 *
 * 账号登录（与桌面端能力对齐）：
 *   · 「导入配置」右侧「登录」→ 用平台 VPN 账号（用户名 = VPN 配置姓名 + 密码）登录
 *   · 登录后自动拉取该账号的 .conf 并**置顶显示**（卡片带「账号配置」标识），退出登录即删除
 *   · 保存密码（Android Keystore AES-GCM 加密，不落明文）· 自动登录（启动静默登录）
 *   · 历史用户名下拉：输入即筛选、无匹配自动消失、选中回填已保存密码、条目删除连同密码删除 */
class MainActivity : ComponentActivity() {

    private val pickConf =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? -> uri?.let { importConf(it) } }

    private var pendingToggle: Pair<Boolean, File>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent?.data?.let { importConf(it) }
        setContent { WgcScreen() }
    }

    /* ---------- 数据 ---------- */
    private fun tunnelDir(): File = getExternalFilesDir(null) ?: filesDir

    /** 接口名（GoBackend 用隧道名做网卡名）必须合法：仅 [A-Za-z0-9_=+.-]，且不超过 15 字符 */
    private fun sanitizeTunnelName(raw: String): String {
        val s = raw.replace(Regex("[^a-zA-Z0-9_=+.-]+"), "_").trim('_').take(15)
        if (s.isNotEmpty()) return s
        /* 中文姓名等无法转成合法接口名：用稳定短哈希 —— 同一账号重复登录命中同一文件（保持置顶位置） */
        val h = raw.fold(0) { acc, ch -> (acc * 31 + ch.code) and 0x7fffffff }
        return "acct" + h.toString(36).take(9)
    }

    private fun loadTunnels(): List<TunnelItem> =
        (tunnelDir().listFiles { f -> f.name.endsWith(".conf") } ?: emptyArray())
            .map { f ->
                val text = try { f.readText() } catch (_: Exception) { "" }
                val owner = AccountStore.tunnelOwner(this, f.name)
                TunnelItem(f, ConfMeta.parseInfo(text, f.name), owner?.second)
            }
            /* 登录账号自动拉取的配置恒定置顶；其余按文件名 */
            .sortedWith(compareByDescending<TunnelItem> { it.accountUser != null }.thenBy { it.file.name })

    private fun importConf(uri: Uri) {
        try {
            val raw = contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
                ?: return toast("无法读取该文件")
            val name = ConfMeta.parseInfo(raw, uri.lastPathSegment ?: "tunnel").name
            tunnelDir().mkdirs()
            /* 原样保存（含 wg-meta 注释行），GoBackend 解析时会忽略注释 */
            File(tunnelDir(), "${sanitizeTunnelName(name)}.conf").writeText(raw)
            AccountStore.unmarkTunnel(this, "${sanitizeTunnelName(name)}.conf")
            toast("已导入：$name")
        } catch (e: Exception) {
            toast("导入失败：${e.message}")
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    /* ---------- 账号登录 ---------- */

    /** 登录并落盘：成功返回 (true, 显示名)，失败返回 (false, 错误) */
    private suspend fun performLogin(
        serverRaw: String, username: String, password: String, remember: Boolean, autoLogin: Boolean,
    ): Pair<Boolean, String> {
        val r = withContext(Dispatchers.IO) { LoginApi.login(serverRaw, username, password) }
        if (!r.ok) return false to r.error
        val srv = LoginApi.normalizeServer(serverRaw)
        val dir = tunnelDir(); dir.mkdirs()
        /* 同一账号再次登录覆盖原文件（保持置顶位置不变）；不同账号重名才追加序号 */
        val existing = AccountStore.filesOf(this, srv, username).firstOrNull()
        val base = sanitizeTunnelName(existing?.removeSuffix(".conf") ?: username)
        var name = base; var n = 2
        if (existing == null) while (File(dir, "$name.conf").exists()) name = "${base.take(12)}-${n++}"
        withContext(Dispatchers.IO) {
            File(dir, "$name.conf").writeText(r.conf)
            AccountStore.markTunnel(this@MainActivity, "$name.conf", srv, username)
            AccountStore.remember(this@MainActivity, srv, username, remember, autoLogin,
                if (remember) password else null)
            AccountStore.setLastServer(this@MainActivity, srv)   // 登录成功才记住服务器地址
        }
        return true to r.name.ifEmpty { username }
    }

    /** 退出登录：关闭并删除该账号自动拉取的配置（历史条目与保存的密码保留） */
    private fun performLogout(server: String, username: String): Int {
        val files = AccountStore.filesOf(this, server, username)
        files.forEach { f ->
            val file = File(tunnelDir(), f)
            try { WgcApp.backend.setState(SimpleTunnel(file.nameWithoutExtension), Tunnel.State.DOWN, null) } catch (_: Exception) {}
            file.delete()
        }
        AccountStore.clearTunnelMarks(this, files)
        return files.size
    }

    /* ---------- 版本号 + GitHub 更新检查 ---------- */
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
            runCatching { packageManager.getPackageInfo(packageName, 0).versionName ?: "1.2.0" }.getOrElse { "1.2.0" }
        }
        /* 深色 / 浅色双主题（与桌面端同款切换）：启动时从 SharedPreferences 恢复，点击 moonshot 图标切换 */
        val prefs = remember { getSharedPreferences("wgc_theme", MODE_PRIVATE) }
        var isDark by remember { mutableStateOf(prefs.getBoolean("is_dark", true)) }
        val darkBg = Color(0xFF0B0F16);     val darkCard = Color(0xFF121926);      val darkCard2 = Color(0xFF161E2D)
        val darkTxt = Color(0xFFE8EDF5);    val darkDim = Color(0xFF93A0B4);       val darkFaint = Color(0xFF5C6A7F)
        val darkLine = Color(0xFF2A3648);   val darkBtn = Color(0xFF7C5CFF)
        val lightBg = Color(0xFFF0F2F7);    val lightCard = Color(0xFFFFFFFF);     val lightCard2 = Color(0xFFF4F5FA)
        val lightTxt = Color(0xFF162C40);   val lightDim = Color(0xFF5E6A82);      val lightFaint = Color(0xFF8A96B0)
        val lightLine = Color(0xFFC8CEE0);  val lightBtn = Color(0xFF4C6DEF)
        val surface = if (isDark) darkBg else lightBg
        val cardBg  = if (isDark) darkCard else lightCard
        val cardB2  = if (isDark) darkCard2 else lightCard2
        val textClr = if (isDark) darkTxt else lightTxt
        val dimClr  = if (isDark) darkDim else lightDim
        val faintClr= if (isDark) darkFaint else lightFaint
        val lineClr = if (isDark) darkLine else lightLine
        val btnClr  = if (isDark) darkBtn else lightBtn
        var updateInfo by remember { mutableStateOf<UpdateInfo?>(null) }
        LaunchedEffect(Unit) { updateInfo = checkGitHubUpdate(appVersion) }

        var tunnels by remember { mutableStateOf(loadTunnels()) }
        var showLogin by remember { mutableStateOf(false) }
        val scope = rememberCoroutineScope()

        /* 启动自动登录：勾选了「自动登录」且已安全保存密码的账号（只取最近一条），静默登录 */
        LaunchedEffect(Unit) {
            val h = AccountStore.history(this@MainActivity).firstOrNull { it.autoLogin && it.hasPwd } ?: return@LaunchedEffect
            val pwd = withContext(Dispatchers.IO) { AccountStore.password(this@MainActivity, h.server, h.username) }
            if (pwd.isEmpty()) return@LaunchedEffect
            val (ok, msg) = performLogin(h.server, h.username, pwd, true, true)
            if (ok) { tunnels = loadTunnels(); toast("已自动登录 $msg，配置已置顶") }
        }

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

        Surface(color = surface) {
            Column(Modifier.fillMaxSize().padding(20.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("WG Companion", color = textClr, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Text("wg-web 配套客户端 · 淡紫与鎏金", color = faintClr, fontSize = 12.sp)
                    }
                    Text("v$appVersion", color = faintClr, fontSize = 12.sp)
                    IconButton(
                        onClick = {
                            val next = !isDark
                            isDark = next
                            prefs.edit().putBoolean("is_dark", next).apply()
                        }, modifier = Modifier.size(32.dp)
                    ) { Text(if (isDark) "☀️" else "🌙", fontSize = 16.sp) }
                }

                updateInfo?.let { info ->
                    Card(
                        modifier = Modifier.fillMaxWidth().clickable { openUrl(info.url) }.padding(top = 12.dp, bottom = 4.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = CardDefaults.cardColors(containerColor = cardBg)
                    ) {
                        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("发现新版本 ${info.latest}，建议更新", color = textClr, fontSize = 13.sp, modifier = Modifier.weight(1f))
                            Text("前往下载 ›", color = btnClr, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                Spacer(Modifier.height(18.dp))
                /* 导入配置 | 登录（登录按钮紧贴导入按钮右侧） */
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = { pick.launch(arrayOf("text/plain", "application/octet-stream")) },
                        colors = ButtonDefaults.buttonColors(containerColor = btnClr),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.weight(1f).height(46.dp)
                    ) { Text("导入配置（.conf）", fontSize = 14.sp) }
                    OutlinedButton(
                        onClick = { showLogin = true },
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = if (tunnels.any { it.accountUser != null }) Color(0xFF2FD07B) else textClr),
                        modifier = Modifier.height(46.dp)
                    ) {
                        Text(
                            tunnels.firstOrNull { it.accountUser != null }?.accountUser ?: "登录",
                            fontSize = 14.sp, maxLines = 1
                        )
                    }
                }

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

        if (showLogin) {
            LoginDialog(
                onClose = { showLogin = false },
                onChanged = { tunnels = loadTunnels() },
            )
        }
    }

    data class TunnelItem(val file: File, val info: TunnelInfo, val accountUser: String? = null)

    @Composable
    private fun TunnelCard(t: TunnelItem, onToggle: (Boolean) -> Unit) {
        val up = remember(t) { mutableStateOf(false) }
        val scale by animateFloatAsState(if (up.value) 1.012f else 0.995f, tween(280), label = "sc")
        val knobColor by animateColorAsState(if (up.value) Color(0xFF2FD07B) else dimClr, tween(260), label = "knob")
        LaunchedEffect(t.file) {
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
                    else Brush.horizontalGradient(listOf(cardBg, cardBg)),
                    RoundedCornerShape(18.dp)
                )
                .clickable { onToggle(!up.value) }
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.info.name, color = textClr, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.width(8.dp))
                    Text(t.info.modeLabel, color = badgeColor, fontSize = 11.sp,
                        modifier = Modifier.background(badgeColor.copy(alpha = 0.15f), RoundedCornerShape(999.dp))
                            .padding(horizontal = 9.dp, vertical = 3.dp))
                    /* 登录账号自动拉取的配置：绿色「账号配置」标识 */
                    if (t.accountUser != null) {
                        Spacer(Modifier.width(6.dp))
                        Text("账号配置", color = Color(0xFF2FD07B), fontSize = 10.sp,
                            modifier = Modifier.background(Color(0x1F2FD07B), RoundedCornerShape(999.dp))
                                .padding(horizontal = 8.dp, vertical = 3.dp))
                    }
                }
                Spacer(Modifier.height(7.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    (t.info.nets.take(4).ifEmpty { listOf("全部流量") }).forEach {
                        Text(it, color = dimClr, fontSize = 10.5.sp,
                            modifier = Modifier.background(cardB2, RoundedCornerShape(999.dp))
                                .padding(horizontal = 8.dp, vertical = 2.dp))
                    }
                }
                if (t.info.endpoint.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(t.info.endpoint, color = faintClr, fontSize = 11.sp)
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

    /* ---------- 登录面板（Dialog，华丽卡片 + 历史用户名下拉） ---------- */
    @Composable
    private fun LoginDialog(onClose: () -> Unit, onChanged: () -> Unit) {
        val ctx = this@MainActivity
        val scope = rememberCoroutineScope()

        var server by remember { mutableStateOf("") }
        var user by remember { mutableStateOf("") }
        var pwd by remember { mutableStateOf("") }
        var remember by remember { mutableStateOf(false) }
        var autoLogin by remember { mutableStateOf(false) }
        var showPwd by remember { mutableStateOf(false) }
        var showHist by remember { mutableStateOf(true) }
        var busy by remember { mutableStateOf(false) }
        var hint by remember { mutableStateOf("") }
        var hist by remember { mutableStateOf(AccountStore.history(ctx)) }
        val secure = remember { AccountStore.secureAvailable() }

        /* 已有登录账号（取置顶的账号配置） */
        var owner by remember { mutableStateOf(
            (tunnelDir().listFiles { f -> f.name.endsWith(".conf") } ?: emptyArray())
                .mapNotNull { AccountStore.tunnelOwner(ctx, it.name)?.let { o -> it.name to o } }
                .firstOrNull()
        ) }

        LaunchedEffect(Unit) {
            /* 服务器地址回填「上次**成功登录过**的那个地址」（不是从别处猜 —— 避免把
               127.0.0.1 这类只对本机有效的地址当默认值填进去） */
            server = AccountStore.lastServer(ctx)
            val h = hist.firstOrNull()
            if (h != null) { user = h.username; remember = h.remember; autoLogin = h.autoLogin }
            if (!secure) { remember = false; autoLogin = false }
        }

        val filtered = hist.filter { user.isBlank() || it.username.contains(user, ignoreCase = true) }

        Dialog(onDismissRequest = { onClose() }) {
            Surface(
                shape = RoundedCornerShape(20.dp),
                color = Color(0xFF121926),
                border = androidx.compose.foundation.BorderStroke(1.dp, lineClr),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(20.dp).verticalScroll(rememberScrollState())) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("登录 WG Companion", color = textClr, fontSize = 17.sp, fontWeight = FontWeight.Bold)
                            Text("用 wg-web 平台账号登录，自动拉取你的配置", color = faintClr, fontSize = 11.5.sp)
                        }
                        TextButton(onClick = { onClose() }) { Text("✕", color = dimClr) }
                    }

                    Spacer(Modifier.height(14.dp))
                    OutlinedTextField(
                        value = server, onValueChange = { server = it },
                        label = { Text("服务器地址") },
                        placeholder = { Text("http://192.168.1.10:8787") },
                        singleLine = true, modifier = Modifier.fillMaxWidth()
                    )
                    Text(
                        "填写客户端能访问到的 wg-web 平台地址（含端口）——内网形如 http://192.168.1.10:8787；若平台有对外域名或反向代理，则填 https://vpn.example.com。登录成功后会自动记住该地址。",
                        color = faintClr, fontSize = 10.5.sp, lineHeight = 15.sp
                    )

                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = user,
                        onValueChange = { user = it; showHist = true },
                        label = { Text("用户名（= VPN 配置姓名）") },
                        singleLine = true,
                        trailingIcon = {
                            if (hist.isNotEmpty()) TextButton(onClick = { showHist = !showHist }) {
                                Text(if (showHist) "收起" else "历史", fontSize = 11.5.sp, color = dimClr)
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    )
                    /* 历史用户名下拉：输入即筛选，无匹配自动消失 */
                    if (showHist && filtered.isNotEmpty()) {
                        Card(
                            colors = CardDefaults.cardColors(containerColor = cardB2),
                            shape = RoundedCornerShape(12.dp),
                            modifier = Modifier.fillMaxWidth().padding(top = 6.dp)
                        ) {
                            Column {
                                filtered.take(6).forEach { h ->
                                    Row(
                                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        Column(Modifier.weight(1f).clickable {
                                            server = h.server; user = h.username
                                            remember = h.remember; autoLogin = h.autoLogin
                                            if (h.hasPwd) {
                                                val saved = AccountStore.password(ctx, h.server, h.username)
                                                if (saved.isNotEmpty()) pwd = saved   /* 曾保存密码 -> 一并回填 */
                                            }
                                            showHist = false; hint = ""
                                        }) {
                                            Text(h.username, color = textClr, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold)
                                            Text(
                                                h.server.removePrefix("https://").removePrefix("http://") + if (h.hasPwd) " · 已保存密码" else "",
                                                color = faintClr, fontSize = 10.5.sp
                                            )
                                        }
                                        TextButton(onClick = {
                                            AccountStore.forget(ctx, h.server, h.username)   /* 连同保存的密码一起删除 */
                                            hist = AccountStore.history(ctx)
                                            toast("已删除该条目及其保存的密码")
                                        }) { Text("删除", color = Color(0xFFE5484D), fontSize = 11.5.sp) }
                                    }
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = pwd, onValueChange = { pwd = it },
                        label = { Text("密码") },
                        singleLine = true,
                        visualTransformation = if (showPwd) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            TextButton(onClick = { showPwd = !showPwd }) {
                                Text(if (showPwd) "隐藏" else "显示", fontSize = 11.5.sp, color = dimClr)
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    )

                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = remember && secure, enabled = secure,
                            onCheckedChange = { remember = it }, colors = CheckboxDefaults.colors(checkedColor = Color(0xFF4C8DFF)))
                        Text("保存密码", color = dimClr, fontSize = 12.5.sp)
                        Spacer(Modifier.width(12.dp))
                        Checkbox(checked = autoLogin && secure, enabled = secure,
                            onCheckedChange = { autoLogin = it; if (it) remember = true },
                            colors = CheckboxDefaults.colors(checkedColor = Color(0xFF4C8DFF)))
                        Text("自动登录", color = dimClr, fontSize = 12.5.sp)
                    }
                    if (!secure) {
                        Text("当前系统未提供安全存储，无法保存密码（自动登录不可用）。",
                            color = Color(0xFFD4AF37), fontSize = 11.sp)
                    }
                    Text("保存密码后可用「自动登录」在启动时自动登录；密码经系统密钥库加密，不以明文存储。",
                        color = faintClr, fontSize = 10.5.sp)
                    if (hint.isNotEmpty()) {
                        Spacer(Modifier.height(6.dp))
                        Text(hint, color = Color(0xFFE5484D), fontSize = 11.5.sp)
                    }

                    Spacer(Modifier.height(14.dp))
                    Button(
                        onClick = {
                            if (server.isBlank()) { hint = "请填写服务器地址"; return@Button }
                            if (user.isBlank()) { hint = "请填写用户名"; return@Button }
                            if (pwd.isEmpty()) { hint = "请填写密码"; return@Button }
                            showHist = false; hint = ""; busy = true
                            scope.launch {
                                val (ok, msg) = performLogin(server, user, pwd, remember && secure, autoLogin && secure)
                                busy = false
                                if (ok) {
                                    hist = AccountStore.history(ctx)      /* 刷新历史与条目状态 */
                                    owner = (tunnelDir().listFiles { f -> f.name.endsWith(".conf") } ?: emptyArray())
                                        .mapNotNull { AccountStore.tunnelOwner(ctx, it.name)?.let { o -> it.name to o } }
                                        .firstOrNull()
                                    onChanged(); toast("已登录 $msg，配置已置顶")
                                } else hint = msg
                            }
                        },
                        enabled = !busy,
                        colors = ButtonDefaults.buttonColors(containerColor = btnClr),
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth().height(46.dp)
                    ) {
                        if (busy) CircularProgressIndicator(Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
                        else Text("登 录", fontSize = 14.sp)
                    }

                    owner?.let { (file, o) ->
                        val (srv, uname) = o
                        Spacer(Modifier.height(12.dp))
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text("已登录：$uname", color = dimClr, fontSize = 12.sp, modifier = Modifier.weight(1f))
                            TextButton(onClick = {
                                val n = performLogout(srv, uname)
                                owner = null; onChanged(); toast("已退出登录，删除 $n 个配置")
                            }) { Text("退出登录", color = Color(0xFFE5484D), fontSize = 12.sp) }
                        }
                    }
                }
            }
        }
    }
}
