/* wg-companion — Electron 主进程
 * 配套 wg-web（https://github.com/496793028/wg-web）的独立 WireGuard 客户端。
 * 隧道控制走官方客户端的服务化接口：Windows wireguard.exe /installtunnelservice，
 * macOS wg-quick（osascript 提权）——全程无需打开 WireGuard 图形界面。
 *
 * 交互：单实例 · 托盘图标（悬停显示状态 / 点击弹快捷面板）· 关闭时可选最小化或退出
 *      · 隧道卡片双击开关 · 长按拖动排序 · 连接成功系统通知 */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Tray, Menu, Notification } = require('electron');
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

/* ---------------- 隧道存储与解析 ---------------- */
const tunnelsDir = () => path.join(app.getPath('userData'), 'tunnels');
const ensureDir = () => { try { fs.mkdirSync(tunnelsDir(), { recursive: true }); } catch {} };
const tunnelPath = file => path.join(tunnelsDir(), path.basename(file));

const listTunnels = () => {
  ensureDir();
  const out = [];
  for (const f of fs.readdirSync(tunnelsDir())) {
    if (!f.toLowerCase().endsWith('.conf')) continue;
    try {
      const text = fs.readFileSync(path.join(tunnelsDir(), f), 'utf8');
      out.push({ file: f, ...core.parseConf(text, f) });
    } catch {}
  }
  const order = loadOrder();
  const idx = f => { const i = order.indexOf(f); return i < 0 ? 9999 : i; };
  out.sort((a, b) => idx(a.file) - idx(b.file) || a.file.localeCompare(b.file));
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

  /* 关闭 = 询问（最小化到托盘 / 退出），可记住选择；隧道由系统服务承载，最小化不影响连接 */
  win.on('close', async e => {
    if (quitting) return;
    const cfg = loadCfg();
    if (cfg.closeAction === 'minimize') { e.preventDefault(); win.hide(); return; }
    if (cfg.closeAction === 'quit') return;            // 不拦截，走正常退出
    e.preventDefault();
    const r = await dialog.showMessageBox(win, {
      type: 'question', title: 'WG Companion',
      message: '关闭窗口时希望做什么？',
      detail: '隧道以系统服务方式运行，最小化到托盘后连接不受影响；托盘图标可随时唤回。',
      buttons: ['最小化到托盘', '退出程序'], defaultId: 0, cancelId: 0,
      checkboxLabel: '记住我的选择', checkboxChecked: false,
      noLink: true,
    });
    if (r.checkboxChecked) { cfg.closeAction = r.response === 0 ? 'minimize' : 'quit'; saveCfg(cfg); }
    if (r.response === 0) { win.hide(); } else { quitting = true; app.quit(); }
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

function createTray() {
  try { tray = new Tray(path.join(__dirname, 'assets', 'tray-off.png')); } catch { return; }
  tray.setToolTip('WG Companion · 未连接');
  tray.on('click', (_e, bounds) => toggleQuick(bounds));
  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: '打开主界面', click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } },
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
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('io.github.wgweb.companion');   // Windows 通知必需
    createWindow();
    createTray();
    startAutoSync();                                      // 启动服务端自动更新轮询
  });
}
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());

/* ---------------- IPC ---------------- */
ipcMain.handle('env', () => ({ platform: process.platform, wgExe: core.findWireguardExe()[0] || '', version: app.getVersion() }));

ipcMain.handle('get-cfg', () => loadCfg());
ipcMain.handle('save-cfg', (_e, c) => { saveCfg(c || {}); startAutoSync(); return loadCfg(); });
ipcMain.handle('sync-now', async () => { await autoSyncTick(); return { ok: true }; });

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

/* 窗口控制（无框窗口自绘标题栏） */
ipcMain.on('win-min', () => win && win.minimize());
ipcMain.on('win-max', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win-close', () => win && win.close());     // 触发 close 拦截：询问最小化/退出
ipcMain.on('open-external', (_e, url) => /^https:/.test(url) && shell.openExternal(url));
