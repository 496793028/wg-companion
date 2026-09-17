/* wg-companion — Electron 主进程
 * 配套 wg-web（https://github.com/496793028/wg-web）的独立 WireGuard 客户端。
 * 隧道控制走官方客户端的服务化接口：Windows wireguard.exe /installtunnelservice，
 * macOS wg-quick（osascript 提权）——全程无需打开 WireGuard 图形界面。 */
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const core = require('./lib/core.js');

app.setName('wg-companion');

let win = null;
const tunnelsDir = () => path.join(app.getPath('userData'), 'tunnels');
const ensureDir = () => { try { fs.mkdirSync(tunnelsDir(), { recursive: true }); } catch {} };

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 680, minWidth: 860, minHeight: 580,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0f16' : '#eef1f6',
    frame: false,                     /* 无系统边框：自绘标题栏，动画统一 */
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());

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

async function runCmd(c) {
  if (c.elevate === 'osascript' && process.platform === 'darwin')
    return elevateMac(c.cmd, c.args);
  return sh(c.cmd, c.args);
}

/* ---------------- 隧道存储与解析 ---------------- */
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
  return out;
};
const tunnelPath = file => path.join(tunnelsDir(), path.basename(file));

/* ---------------- IPC ---------------- */
ipcMain.handle('env', () => ({ platform: process.platform, wgExe: core.findWireguardExe()[0] || '', version: app.getVersion() }));

ipcMain.handle('list-tunnels', () => listTunnels());

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
  return { tunnels: listTunnels() };
});

ipcMain.handle('tunnel-state', async (_e, file) => {
  const name = file.replace(/\.conf$/i, '');
  const c = core.commands[process.platform];
  if (!c) return { state: 'unsupported' };
  const r = await runCmd(c.status(name));
  return { state: c.parseStatus(r.stdout + r.stderr) ? 'up' : 'down' };
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
        win && win.webContents.send('conf-changed', { file, tunnels: listTunnels() });
      }, 400);   // 防抖：等写入完成
    });
    watchers.set(file, w);
  } catch {}
});
ipcMain.handle('unwatch-tunnel', (_e, file) => {
  const w = watchers.get(file);
  if (w) { try { w.close(); } catch {} watchers.delete(file); }
});

/* 重下发：down → up（供「配置变更且隧道在线」时自动调用） */
ipcMain.handle('tunnel-reapply', async (_e, file) => {
  const c = core.commands[process.platform];
  if (!c) return { ok: false };
  await runCmd(process.platform === 'win32' ? c.down(file.replace(/\.conf$/i, '')) : c.down(tunnelPath(file)));
  const r = await runCmd(c.up(tunnelPath(file)));
  return { ok: !r.err };
});

/* 窗口控制（无框窗口自绘标题栏） */
ipcMain.on('win-min', () => win && win.minimize());
ipcMain.on('win-max', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win-close', () => win && win.close());
ipcMain.on('open-external', (_e, url) => /^https:/.test(url) && shell.openExternal(url));
