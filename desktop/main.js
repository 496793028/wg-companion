/* wg-companion — Electron 主进程
 * 配套 wg-web（https://github.com/496793028/wg-web）的独立 WireGuard 客户端。
 * 隧道控制走官方客户端的服务化接口：Windows wireguard.exe /installtunnelservice，
 * macOS wg-quick（osascript 提权）——全程无需打开 WireGuard 图形界面。
 *
 * 交互：单实例 · 托盘图标（悬停显示状态 / 点击弹快捷面板）· 关闭时可选最小化或退出
 *      · 隧道卡片双击开关 · 长按拖动排序 · 连接成功系统通知 */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { execFile } = require('child_process');
const core = require('./lib/core.js');

app.setName('wg-companion');

let win = null;        // 主窗口
let quickWin = null;   // 托盘快捷面板
let tray = null;
let quitting = false;  // before-quit 置位：区分「真退出」与「关窗最小化」
const states = {};     // file -> 'up' | 'down'（主进程缓存：托盘/通知/广播共用）

/* ---------------- 配置与排序持久化 ---------------- */
const cfgPath = () => path.join(app.getPath('userData'), 'cfg.json');
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; } };
const saveCfg = c => { try { fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2)); } catch {} };
const orderPath = () => path.join(app.getPath('userData'), 'order.json');
const loadOrder = () => { try { const a = JSON.parse(fs.readFileSync(orderPath(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };

/* ---------------- 账号存储（历史用户名 / 安全保存的密码 / 账号配置归属） ----------------
 * history：按「服务器 + 用户名」记录历史登录；勾选「保存密码」时用系统级加密（Electron
 *          safeStorage：Windows DPAPI / macOS Keychain）加密后落盘，绝不存明文。
 * tunnels：记录哪些隧道配置是登录账号自动拉取的 —— 用于置顶显示与退出时删除。 */
const accountsPath = () => path.join(app.getPath('userData'), 'accounts.json');
const loadAccounts = () => {
  try {
    const o = JSON.parse(fs.readFileSync(accountsPath(), 'utf8'));
    return {
      history: Array.isArray(o.history) ? o.history : [],
      tunnels: (o.tunnels && typeof o.tunnels === 'object') ? o.tunnels : {},
    };
  } catch { return { history: [], tunnels: {} }; }
};
const saveAccounts = a => { try { fs.writeFileSync(accountsPath(), JSON.stringify(a, null, 2)); } catch {} };
const acctKey = (server, username) => String(server || '').replace(/\/+$/, '') + '\u0000' + String(username || '');

function secureAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}
function encPwd(plain) {
  if (!plain) return '';
  try { return safeStorage.encryptString(String(plain)).toString('base64'); } catch { return ''; }
}
function decPwd(b64) {
  if (!b64) return '';
  try { return safeStorage.decryptString(Buffer.from(String(b64), 'base64')); } catch { return ''; }
}
/* 对外一律不暴露密文与明文，只给出「是否已保存密码」 */
const publicAccounts = () => {
  const a = loadAccounts();
  return {
    secure: secureAvailable(),
    history: a.history.map(h => ({
      server: h.server, username: h.username, remember: !!h.remember,
      autoLogin: !!h.autoLogin, hasPwd: !!h.pwdEnc, lastUsed: h.lastUsed || '',
    })).sort((x, y) => String(y.lastUsed).localeCompare(String(x.lastUsed))),
  };
};
/* 记住/忘记某条历史登录 */
function rememberAccount(server, username, remember, autoLogin, password) {
  const a = loadAccounts();
  const key = acctKey(server, username);
  const i = a.history.findIndex(h => acctKey(h.server, h.username) === key);
  const prev = i >= 0 ? a.history[i] : { server, username };
  const entry = {
    ...prev, server: String(server || ''), username: String(username || ''),
    remember: !!remember, autoLogin: !!autoLogin, lastUsed: new Date().toISOString(),
  };
  if (remember) { if (password) entry.pwdEnc = encPwd(password); }
  else { delete entry.pwdEnc; }
  if (i >= 0) a.history[i] = entry; else a.history.push(entry);
  saveAccounts(a);
  return entry;
}
function markAccountTunnel(file, server, username) {
  const a = loadAccounts();
  a.tunnels[file] = { server: String(server || ''), username: String(username || '') };
  saveAccounts(a);
}
function unmarkAccountTunnel(file) {
  const a = loadAccounts();
  if (a.tunnels[file]) { delete a.tunnels[file]; saveAccounts(a); }
}

/* ---------------- 隧道存储与解析 ---------------- */
const tunnelsDir = () => path.join(app.getPath('userData'), 'tunnels');
const ensureDir = () => { try { fs.mkdirSync(tunnelsDir(), { recursive: true }); } catch {} };
const tunnelPath = file => path.join(tunnelsDir(), path.basename(file));

const listTunnels = () => {
  ensureDir();
  const out = [];
  const accts = loadAccounts();
  for (const f of fs.readdirSync(tunnelsDir())) {
    if (!f.toLowerCase().endsWith('.conf')) continue;
    try {
      const text = fs.readFileSync(path.join(tunnelsDir(), f), 'utf8');
      const at = accts.tunnels[f];
      out.push({ file: f, ...core.parseConf(text, f),
        account: !!at, accountUser: at ? at.username : '', accountServer: at ? at.server : '' });
    } catch {}
  }
  const order = loadOrder();
  const idx = f => { const i = order.indexOf(f); return i < 0 ? 9999 : i; };
  /* 登录账号自动拉取的配置恒定置顶；其余按用户拖拽顺序 */
  out.sort((a, b) =>
    (a.account === b.account ? 0 : (a.account ? -1 : 1)) ||
    idx(a.file) - idx(b.file) || a.file.localeCompare(b.file));
  return out;
};

/* ---------------- 进程执行辅助 ---------------- */
const sh = (cmd, args, opt = {}) => new Promise(resolve => {
  execFile(cmd, args, { windowsHide: true, timeout: 30000, ...opt }, (err, stdout, stderr) =>
    resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
/* macOS 用 osascript 弹系统管理员密码框，避免应用自身常驻 root */
const elevateMac = (cmd, args) => new Promise(resolve => {
  const script = `do shell script "${cmd} ${args.map(a => a.replace(/"/g, '\\"')).join(' ')}" with administrator privileges`;
  execFile('osascript', ['-e', script], { timeout: 60000 }, (err, stdout, stderr) =>
    resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});
const runCmd = c => (c.elevate === 'osascript' && process.platform === 'darwin') ? elevateMac(c.cmd, c.args) : sh(c.cmd, c.args);

/* ---------------- 状态广播 / 托盘 / 通知 ---------------- */
const broadcast = (ch, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, payload); };

function setState(file, state) {
  if (states[file] === state) return;
  states[file] = state;
  updateTray();
  broadcast('states-changed', { states: { ...states } });
}

function firstUpTunnel() {
  const ups = Object.entries(states).filter(([, s]) => s === 'up').map(([f]) => f);
  return listTunnels().find(t => ups.includes(t.file)) || null;
}

function updateTray() {
  if (!tray) return;
  const up = firstUpTunnel();
  try {
    tray.setImage(path.join(__dirname, 'assets', up ? 'tray-on.png' : 'tray-off.png'));
    tray.setToolTip(up
      ? `WG Companion · 已连接：${up.name}（${up.iface.address[0] || ''}）· ${core.modeLabel(up.mode)}`
      : 'WG Companion · 未连接');
  } catch {}
}

function notifyUp(t) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: '隧道已连接',
      body: `${t.name} · ${core.modeLabel(t.mode)}${t.iface.address[0] ? ' · ' + t.iface.address[0] : ''}`,
      icon: path.join(__dirname, 'assets', 'tray-on.png'),
      silent: false,
    }).show();
  } catch {}
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 680, minWidth: 860, minHeight: 580,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f16' : '#eef1f6',
    frame: false,                     /* 无系统边框：自绘标题栏，动画统一 */
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });

  /* 关闭 = 询问（最小化到托盘 / 退出），可记住选择；隧道由系统服务承载，最小化不影响连接。
     询问界面由**渲染端自绘**（华丽弹窗 + 按钮动画），主进程只负责发事件、收决定。
     隧道以系统服务方式运行，最小化到托盘后连接不受影响；托盘图标可随时唤回。 */
  win.on('close', e => {
    if (quitting) return;
    const cfg = loadCfg();
    if (cfg.closeAction === 'minimize') { e.preventDefault(); win.hide(); return; }
    if (cfg.closeAction === 'quit') return;            // 不拦截，走正常退出
    e.preventDefault();
    try { win.webContents.send('ask-close'); } catch {}
  });
}

function positionQuick(bounds) {
  if (!quickWin || quickWin.isDestroyed()) return;
  const [w, h] = quickWin.getSize();
  if (bounds && typeof bounds.x === 'number') {
    const x = Math.round(bounds.x + bounds.width / 2 - w / 2);
    const y = Math.round(bounds.y - h - 10);
    quickWin.setPosition(Math.max(0, x), Math.max(0, y), false);
  }
}

function toggleQuick(bounds) {
  if (quickWin && !quickWin.isDestroyed()) {
    if (quickWin.isVisible()) { quickWin.hide(); return; }
    positionQuick(bounds); quickWin.show(); quickWin.focus(); return;
  }
  quickWin = new BrowserWindow({
    width: 380, height: 470, frame: false, resizable: false, movable: false,
    show: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#0b0f16',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  quickWin.loadFile(path.join(__dirname, 'renderer', 'quick.html'));
  quickWin.on('blur', () => { try { quickWin.hide(); } catch {} });
  quickWin.once('ready-to-show', () => { positionQuick(bounds); quickWin.show(); quickWin.focus(); });
}

/* 打开（还原并置前）主窗口 */
function showMainWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createTray() {
  try { tray = new Tray(path.join(__dirname, 'assets', 'tray-off.png')); } catch { return; }
  tray.setToolTip('WG Companion · 未连接');
  /* 单击 = 快捷面板；双击 = 打开主窗口。
   * Windows 上双击会先触发两次 click，用 240ms 去抖：若期间来了 double-click 就取消待执行的单击。 */
  let trayClickTimer = null;
  tray.on('click', (_e, bounds) => {
    if (trayClickTimer) { clearTimeout(trayClickTimer); trayClickTimer = null; }
    trayClickTimer = setTimeout(() => { trayClickTimer = null; toggleQuick(bounds); }, 240);
  });
  tray.on('double-click', () => {
    if (trayClickTimer) { clearTimeout(trayClickTimer); trayClickTimer = null; }
    showMainWindow();
  });
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showMainWindow() },
      { label: '快捷面板', click: () => toggleQuick() },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
  });
  updateTray();
}

/* ---------------- 单实例锁 ----------------
 * 已有一个实例在运行时，再次启动（双击/开始菜单/开机自启）不再开新窗口，
 * 而是把已开窗口还原并置前。 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId('io.github.wgweb.companion');   // Windows 通知必需
    createWindow();
    createTray();
    startAutoSync();                                      // 启动服务端自动更新轮询
    startAutoLogin();                                     // 启动自动登录（如已勾选并保存密码）
    setTimeout(() => { reconcileLeftovers(); }, 1500);    // 启动自愈：清掉残留隧道（等渲染端就绪）
  });
}
/* 断开所有「实际在线」的隧道，恢复系统路由。
 * 关键：**不依赖内存里的 states**（崩溃 / 被任务管理器强杀 / 开机自启时它是空的或过期的），
 * 而是按 tunnels 目录枚举全部 .conf、逐条查询其真实运行状态，只对确实在线的执行 down。
 * Windows：down = 卸载 WireGuardTunnel$ 服务（服务停止即移除它写入的路由）；
 * macOS：down = wg-quick down。
 * 返回本次实际断开的隧道条数。 */
let _discPromise = null;
function disconnectAllTunnels() {
  if (_discPromise) return _discPromise;                  // 复用进行中的那一次
  _discPromise = (async () => {
    let cleaned = 0;
    try {
      const c = core.commands[process.platform];
      if (!c) return 0;
      let list = [];
      try { list = listTunnels(); } catch (_) {}
      const files = new Set([
        ...list.map(t => t.file),
        ...Object.entries(states).filter(([, s]) => s === 'up').map(([f]) => f),
      ]);
      for (const file of files) {
        const name = file.replace(/\.conf$/i, '');
        let up = states[file] === 'up';
        if (!up) {                                        // 内存不知道就查真实服务状态
          try { const r = await runCmd(c.status(name)); up = c.parseStatus(r.stdout + r.stderr); } catch (_) {}
        }
        if (!up) { delete states[file]; continue; }
        try { await runCmd(process.platform === 'win32' ? c.down(name) : c.down(tunnelPath(file))); } catch (_) {}
        delete states[file]; cleaned++;
      }
      updateTray();
    } finally { _discPromise = null; }
    return cleaned;
  })();
  return _discPromise;
}

/* 启动自愈：app 启动时本就不该有任何隧道在线（不自动连）。
 * 若发现残留（上次未正常退出 / 被强杀 / 开机自启残留），一律断开并恢复网络。 */
async function reconcileLeftovers() {
  try {
    const n = await disconnectAllTunnels();
    if (n > 0) {
      broadcast('states-changed', { states: { ...states } });
      try {
        if (Notification.isSupported())
          new Notification({ title: '已恢复网络', body: `检测到 ${n} 条残留隧道（上次未正常退出），已全部断开并移除其路由`, silent: true }).show();
      } catch (_) {}
    }
  } catch (_) {}
}

let _shuttingDown = false;
app.on('before-quit', async (e) => {
  if (_shuttingDown) return;            // 已处理过：放行，真正退出
  _shuttingDown = true;
  e.preventDefault();                   // 先等隧道断开再退出
  /* 兜底超时：即使某条命令卡住，也不让 app 退不出去 */
  try { await Promise.race([disconnectAllTunnels(), new Promise(r => setTimeout(r, 8000))]); } catch (_) {}
  quitting = true;
  app.quit();
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());

/* ---------------- IPC ---------------- */
ipcMain.handle('env', () => ({ platform: process.platform, wgExe: core.findWireguardExe()[0] || '', version: app.getVersion() }));

ipcMain.handle('get-cfg', () => loadCfg());
ipcMain.handle('save-cfg', (_e, c) => { saveCfg(c || {}); startAutoSync(); return loadCfg(); });
ipcMain.handle('sync-now', async () => { await autoSyncTick(); return { ok: true }; });
ipcMain.handle('check-update', () => checkGitHubUpdate());

/* ---------------- 关闭确认（渲染端自绘弹窗回执） ---------------- */
ipcMain.handle('close-decision', (_e, act, remember) => {
  const cfg = loadCfg();
  if (remember) { cfg.closeAction = act === 'quit' ? 'quit' : 'minimize'; saveCfg(cfg); }
  if (act === 'quit') { quitting = true; app.quit(); }
  else if (win && !win.isDestroyed()) win.hide();   // 最小化到托盘：保持隧道连接
  return { ok: true };
});

/* ---------------- 账号登录 / 历史用户名 / 安全保存密码 ---------------- */
const normalizeServer = s => {
  let v = String(s || '').trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
};
function postJson(urlStr, payload, allowInsecure) {
  return new Promise(resolve => {
    let u; try { u = new URL(urlStr); } catch { return resolve({ error: '服务器地址无效' }); }
    if (!/^https?:$/.test(u.protocol)) return resolve({ error: '服务器地址需以 http:// 或 https:// 开头' });
    const data = JSON.stringify(payload || {});
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST', timeout: 15000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        'user-agent': 'wg-companion/' + (app.getVersion() || '1.0.0') },
      rejectUnauthorized: !allowInsecure,       // 默认允许自签名证书（内网部署常见）
    }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(body); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && j) resolve(j);
        else resolve({ error: (j && j.error) || ('登录失败（HTTP ' + res.statusCode + '）') });
      });
    });
    req.on('error', e => resolve({ error: '无法连接服务器：' + ((e && e.message) || e) }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ error: '连接服务器超时' }); });
    req.write(data); req.end();
  });
}
/* 登录 wg-web：成功后把下发的配置写入 tunnels 并标记为「账号配置」（置顶显示） */
async function doLogin(p) {
  const server = normalizeServer(p && p.server);
  const username = String((p && p.username) || '').trim();
  const password = String((p && p.password) || '');
  if (!server || !username || !password) return { ok: false, error: '请填写服务器地址、用户名与密码' };
  const cfg = loadCfg();
  const r = await postJson(server + '/api/client/login', { username, password }, cfg.allowInsecure !== false);
  if (r.error || !r.ok || typeof r.conf !== 'string')
    return { ok: false, error: r.error || '登录失败：服务器未返回配置' };
  ensureDir();
  const base = core.sanitizeTunnelName(username) || 'account';
  const map = loadAccounts().tunnels;
  /* 同一账号再次登录覆盖原文件（保持置顶位置不变）；不同账号重名才追加序号 */
  const existing = Object.keys(map).find(f => map[f] && map[f].username === username && map[f].server === server);
  let name = existing ? existing.replace(/\.conf$/i, '') : base, n = 2;
  if (!existing) while (fs.existsSync(tunnelPath(name + '.conf'))) name = `${base.slice(0, 29)}-${n++}`;
  const file = name + '.conf';
  try { fs.writeFileSync(tunnelPath(file), r.conf, 'utf8'); }
  catch (e) { return { ok: false, error: '写入配置失败：' + e.message }; }
  markAccountTunnel(file, server, username);
  if (p.remember !== undefined || p.autoLogin !== undefined)
    rememberAccount(server, username, !!p.remember, !!p.autoLogin, p.remember ? password : '');
  return { ok: true, file, name: r.name || username, vpn_ip: r.vpn_ip || '', server, username };
}
ipcMain.handle('accounts-list', () => publicAccounts());
ipcMain.handle('login', async (_e, p) => {
  const r = await doLogin(p || {});
  if (r.ok) {
    if (win && !win.isDestroyed()) win.show();
    broadcast('account-changed', { action: 'login', username: r.username, file: r.file });
  }
  return r;
});
ipcMain.handle('logout', async (_e, p) => {
  const server = normalizeServer(p && p.server), username = String((p && p.username) || '');
  const a = loadAccounts();
  const files = Object.keys(a.tunnels).filter(f => a.tunnels[f] &&
    a.tunnels[f].username === username && (!server || a.tunnels[f].server === server));
  for (const f of files) {
    const w = watchers.get(f); if (w) { try { w.close(); } catch {} watchers.delete(f); }
    try { fs.unlinkSync(tunnelPath(f)); } catch {}
    delete a.tunnels[f]; delete states[f];
  }
  saveAccounts(a);
  updateTray();
  broadcast('account-changed', { action: 'logout', username, removed: files.length });
  return { ok: true, removed: files.length };
});
ipcMain.handle('accounts-save', (_e, p) => {
  const server = normalizeServer(p && p.server), username = String((p && p.username) || '').trim();
  if (!server || !username) return { ok: false, error: '缺少服务器地址或用户名' };
  rememberAccount(server, username, !!p.remember, !!p.autoLogin, p.password || '');
  return { ok: true, ...publicAccounts() };
});
ipcMain.handle('accounts-forget', (_e, p) => {
  const server = normalizeServer(p && p.server), username = String((p && p.username) || '');
  const key = acctKey(server, username);
  const a = loadAccounts();
  a.history = a.history.filter(h => acctKey(h.server, h.username) !== key);
  saveAccounts(a);
  return { ok: true, ...publicAccounts() };
});
/* 取回某条历史登录已保存的密码（用户在下拉里选择用户名时回填密码框）。
   仅在勾选过「保存密码」时存在；解密失败返回空串。 */
ipcMain.handle('accounts-get-password', (_e, p) => {
  const server = normalizeServer(p && p.server), username = String((p && p.username) || '');
  const key = acctKey(server, username);
  const h = loadAccounts().history.find(x => acctKey(x.server, x.username) === key);
  return { ok: true, password: (h && h.pwdEnc) ? decPwd(h.pwdEnc) : '' };
});

ipcMain.handle('list-tunnels', () => listTunnels());

ipcMain.handle('save-order', (_e, files) => {
  try { fs.writeFileSync(orderPath(), JSON.stringify(Array.isArray(files) ? files : [])); } catch {}
  return { tunnels: listTunnels() };
});

ipcMain.handle('import-conf', async (_e, paths) => {
  let files = paths;
  if (!files) {
    const r = await dialog.showOpenDialog(win, {
      title: '导入 WireGuard 配置', filters: [{ name: 'WireGuard 配置', extensions: ['conf'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return { canceled: true };
    files = r.filePaths;
  }
  if (!files || !files.length) return { canceled: true };
  ensureDir();
  const imported = [];
  for (const src of files) {
    /* 存储文件名必须合法化为隧道名：浏览器会给重复下载加 " (1)" 等括号/空格，
       wireguard.exe 服务化接口会因此报 "Tunnel name is not valid"。
       显示名来自 wg-meta，不受此影响。重名自动追加 -2/-3… */
    const base = path.basename(src).replace(/\.conf$/i, '');
    let name = core.sanitizeTunnelName(base);
    let n = 2;
    while (fs.existsSync(tunnelPath(name + '.conf'))) name = `${core.sanitizeTunnelName(base).slice(0, 29)}-${n++}`;
    const dest = tunnelPath(name + '.conf');
    fs.copyFileSync(src, dest);       // 复制进应用数据目录：之后才能监视自动更新
    imported.push(name + '.conf');
  }
  return { canceled: false, imported, tunnels: listTunnels() };
});

ipcMain.handle('delete-tunnel', (_e, file) => {
  try { fs.unlinkSync(tunnelPath(file)); } catch {}
  unmarkAccountTunnel(file);          // 手动移除账号配置时同步清掉归属标记
  delete states[file];
  updateTray();
  return { tunnels: listTunnels() };
});

ipcMain.handle('tunnel-state', async (_e, file) => {
  const name = file.replace(/\.conf$/i, '');
  const c = core.commands[process.platform];
  if (!c) return { state: 'unsupported' };
  const r = await runCmd(c.status(name));
  const st = c.parseStatus(r.stdout + r.stderr) ? 'up' : 'down';
  setState(file, st);
  return { state: st };
});

ipcMain.handle('tunnel-up', async (_e, file) => {
  const c = core.commands[process.platform];
  if (!c) return { ok: false, message: '暂不支持该平台' };
  if (process.platform === 'win32' && !core.findWireguardExe().length)
    return { ok: false, message: '未找到 WireGuard 客户端，请先安装官方 MSI（含服务化接口）' };
  /* 单隧道模式：开启新隧道前，先断开其他所有已连隧道（切换），避免同时运行多条 */
  for (const [f, st] of Object.entries({ ...states })) {
    if (f !== file && st === 'up') {
      try { await runCmd(process.platform === 'win32' ? c.down(f.replace(/\.conf$/i, '')) : c.down(tunnelPath(f))); } catch (_) {}
      setState(f, 'down');
    }
  }
  const confPath = tunnelPath(file);
  const r = await runCmd(c.up(confPath));
  if (r.err && !c.parseStatus(r.stdout)) {
    const msg = (r.stderr || r.err.message || '').trim();
    const admin = /administrator|requires elevation|拒绝访问|access is denied/i.test(msg);
    return { ok: false, message: admin ? '需要管理员权限：请右键应用「以管理员身份运行」后重试' : (msg || '启动失败') };
  }
  setState(file, 'up');
  const t = listTunnels().find(x => x.file === file);
  if (t) notifyUp(t);
  return { ok: true };
});

ipcMain.handle('tunnel-down', async (_e, file) => {
  const c = core.commands[process.platform];
  if (!c) return { ok: false, message: '暂不支持该平台' };
  const confPath = tunnelPath(file);
  const r = process.platform === 'win32'
    ? await runCmd(c.down(file.replace(/\.conf$/i, '')))
    : await runCmd(c.down(confPath));
  if (r.err) return { ok: false, message: (r.stderr || r.err.message || '关闭失败').trim() };
  setState(file, 'down');
  return { ok: true };
});

/* 自动更新：监视隧道 conf 文件 —— 重新下载的配置一落盘即刷新界面；
   若隧道正开着，自动重下发（down → up），实现「会自动的更新配置」。 */
const watchers = new Map();
ipcMain.handle('watch-tunnel', (_e, file) => {
  if (watchers.has(file)) return;
  try {
    const full = tunnelPath(file);
    const w = fs.watch(full, { persistent: false }, ev => {
      if (ev !== 'change' && ev !== 'rename') return;
      setTimeout(() => {
        broadcast('conf-changed', { file, tunnels: listTunnels() });
      }, 400);   // 防抖：等写入完成
    });
    watchers.set(file, w);
  } catch {}
});
ipcMain.handle('unwatch-tunnel', (_e, file) => {
  const w = watchers.get(file);
  if (w) { try { w.close(); } catch {} watchers.delete(file); }
});

/* 重下发：down → up（供「配置变更且隧道在线」时自动调用，含服务端自动更新） */
async function reapplyTunnel(file) {
  const c = core.commands[process.platform];
  if (!c) return { ok: false };
  await runCmd(process.platform === 'win32' ? c.down(file.replace(/\.conf$/i, '')) : c.down(tunnelPath(file)));
  const r = await runCmd(c.up(tunnelPath(file)));
  if (!r.err) setState(file, 'up');
  return { ok: !r.err };
}
ipcMain.handle('tunnel-reapply', async (_e, file) => reapplyTunnel(file));

/* ---------------- 服务端自动更新（定时轮询）----------------
 * 客户端凭每账号只读令牌，定时从 wg-web 拉取最新 conf；内容变化则覆盖本地文件，
 * 触发 fs.watch → 刷新界面，若隧道在线则自动重下发。全程出站 HTTPS，无需开放入站端口。 */
async function fetchServerConf(server, token, allowInsecure) {
  return new Promise(resolve => {
    let u;
    try { u = new URL((server || '').replace(/\/+$/, '') + '/api/client/conf?token=' + encodeURIComponent(token || '')); }
    catch { return resolve(null); }
    if (!/^https?:$/.test(u.protocol)) return resolve(null);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, {
      timeout: 15000,
      headers: { 'user-agent': 'wg-companion/' + (app.getVersion() || '1.0.0') },
      rejectUnauthorized: !allowInsecure,   // 默认允许自签名证书（内网部署常见）
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j && typeof j.conf === 'string') resolve({ conf: j.conf, hash: j.hash || '', name: j.name || '' });
          else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
  });
}

let syncTimer = null;
let syncing = false;
async function autoSyncTick() {
  if (syncing) return;
  syncing = true;
  try {
    const cfg = loadCfg();
    if (cfg.autoUpdate === false) return;
    const allowInsecure = cfg.allowInsecure !== false;
    for (const t of listTunnels()) {
      if (!t.server || !t.token) continue;        // 仅服务端下发的配置参与自动更新
      let cur;
      try { cur = fs.readFileSync(tunnelPath(t.file), 'utf8'); } catch { continue; }
      const got = await fetchServerConf(t.server, t.token, allowInsecure);
      if (!got) continue;
      const curNorm = cur.replace(/\r\n/g, '\n');
      const gotNorm = got.conf.replace(/\r\n/g, '\n');
      if (curNorm === gotNorm) continue;          // 未变更，跳过
      try {
        fs.writeFileSync(tunnelPath(t.file), got.conf, 'utf8');
        /* 复用本地监视的同一广播：界面刷新 + 在线则自动重下发 */
        broadcast('conf-changed', { file: t.file, tunnels: listTunnels(), server: true });
      } catch {}
    }
  } catch {}
  finally { syncing = false; }
}

function startAutoSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  const cfg = loadCfg();
  if (cfg.autoUpdate === false) return;            // 用户关闭了自动更新
  const sec = Math.max(10, Number(cfg.autoUpdateInterval) || 30);
  syncTimer = setInterval(autoSyncTick, sec * 1000);
  setTimeout(autoSyncTick, 3000);                  // 启动后先错峰跑一次
}

/* 启动自动登录：对勾选「自动登录」且已安全保存密码的账号依次登录，成功后其配置置顶显示。
   出站 HTTPS、失败静默（不打扰），不影响应用正常启动。 */
async function startAutoLogin() {
  let list = [];
  try { list = loadAccounts().history.filter(h => h.autoLogin && h.pwdEnc); } catch { return; }
  for (const h of list) {
    const pwd = decPwd(h.pwdEnc);
    if (!pwd) continue;
    const r = await doLogin({ server: h.server, username: h.username, password: pwd, remember: true, autoLogin: true });
    if (r.ok) {
      broadcast('account-changed', { action: 'autologin', username: h.username, file: r.file });
      try {
        if (Notification.isSupported())
          new Notification({ title: '已自动登录', body: h.username + ' · 配置已自动更新', silent: true }).show();
      } catch {}
    }
  }
}

/* ---------------- GitHub 更新检查 ----------------
 * 启动时查询 GitHub Releases 最新公开版本，若有更高版本则提示用户前往下载。
 * 仅读取公开 releases/latest，无需鉴权；网络/限流失败一律静默（不弹错）。 */
const GITHUB_REPO = '496793028/wg-companion';
function semverCmp(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1; if (x < y) return -1;
  }
  return 0;
}
function checkGitHubUpdate() {
  return new Promise(resolve => {
    const cur = app.getVersion() || '0.0.0';
    const req = https.get(
      'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest',
      { timeout: 12000, headers: { 'user-agent': 'wg-companion/' + cur, 'accept': 'application/vnd.github+json' } },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (!j || !j.tag_name) return resolve({ current: cur, hasUpdate: false, error: 'no_tag' });
            const latest = String(j.tag_name).replace(/^v/i, '');
            resolve({
              current: cur,
              latest: j.tag_name,
              hasUpdate: semverCmp(latest, cur) > 0,
              url: j.html_url || ('https://github.com/' + GITHUB_REPO + '/releases/latest'),
            });
          } catch { resolve({ current: cur, hasUpdate: false, error: 'parse' }); }
        });
      });
    req.on('error', () => resolve({ current: cur, hasUpdate: false, error: 'net' }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ current: cur, hasUpdate: false, error: 'timeout' }); });
  });
}

/* 窗口控制（无框窗口自绘标题栏） */
ipcMain.on('win-min', () => win && win.minimize());
ipcMain.on('win-max', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win-close', () => win && win.close());     // 触发 close 拦截：询问最小化/退出
ipcMain.on('open-external', (_e, url) => /^https:/.test(url) && shell.openExternal(url));
