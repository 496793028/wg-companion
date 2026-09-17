/* wg-companion 核心逻辑：配置解析 / 元数据 / 平台隧道命令
 * 纯函数 + 命令构造，不触碰 DOM / 文件系统，可独立单测。
 * 配套服务端：wg-web（https://github.com/496793028/wg-web）
 */
'use strict';

/* ---- wg-meta 元数据（wg-web 生成的首行注释）----
 * 格式：# wg-meta v1 <base64(utf8 json)>
 * json = { v:1, name:'真实姓名', mode:'allow'|'deny', proxy:0|1, nets:['10.100.0.0/24', ...] } */
function parseMeta(text) {
  const m = /^\s*#\s*wg-meta\s+v1\s+([A-Za-z0-9+/=]+)\s*$/m.exec(text);
  if (!m) return null;
  try {
    const obj = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    if (!obj || obj.v !== 1) return null;
    return {
      name: String(obj.name || ''),
      mode: obj.mode === 'deny' ? 'deny' : 'allow',
      proxy: obj.proxy ? 1 : 0,
      nets: Array.isArray(obj.nets) ? obj.nets.map(String) : [],
    };
  } catch { return null; }
}

/* ---- 解析 .conf（标准 WireGuard 格式）---- */
function parseConf(text, fileName) {
  const meta = parseMeta(text);
  const iface = { address: [], dns: [], mtu: '' };
  const peer = { endpoint: '', allowedIps: [], keepalive: '' };
  let section = '';
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\[interface\]$/i.test(line)) { section = 'iface'; continue; }
    if (/^\[peer\]$/i.test(line)) { section = 'peer'; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (section === 'iface') {
      if (key === 'address') iface.address.push(...val.split(',').map(s => s.trim()).filter(Boolean));
      else if (key === 'dns') iface.dns.push(...val.split(',').map(s => s.trim()).filter(Boolean));
      else if (key === 'mtu') iface.mtu = val;
    } else if (section === 'peer') {
      if (key === 'endpoint') peer.endpoint = val;
      else if (key === 'allowedips') peer.allowedIps.push(...val.split(',').map(s => s.trim()).filter(Boolean));
      else if (key === 'persistentkeepalive') peer.keepalive = val;
    }
  }
  const base = String(fileName || '').replace(/\.conf$/i, '').trim();
  /* 无元数据时的兜底：老版 wg-web 的 peer 注释是 `# <vpn_ip> (asciiName)` */
  const legacy = /^\s*#\s*(10\.\d+\.\d+\.\d+)\s*\(?([A-Za-z0-9_.-]*)\)?\s*$/m.exec(text);
  const displayName = (meta && meta.name) || (legacy && legacy[2]) || base || '未命名隧道';
  /* 模式推断（无元数据时）：含 0.0.0.0/0 视为全局类，否则白名单 */
  const allNets = meta ? meta.nets : peer.allowedIps;
  const heuristic = allNets.includes('0.0.0.0/0') ? 'global' : 'allow';
  const mode = meta ? (meta.proxy ? 'proxy' : (meta.mode === 'deny' ? 'deny' : 'allow')) : heuristic;
  const nets = allNets.filter(n => n !== '0.0.0.0/0');
  return { meta, name: displayName, mode, nets, iface, peer, fileName: fileName || '' };
}

/* ---- 模式徽章文案 ---- */
const MODE_LABEL = { allow: '白名单', deny: '黑名单', proxy: '全代理' };
const modeLabel = m => MODE_LABEL[m] || '白名单';

/* ---- 隧道名合法性（官方客户端限制：^[a-zA-Z0-9_=+.-]{1,32}$）----
 * 浏览器重复下载会给文件名加 " (1)" 这类括号与空格，导致 /installtunnelservice 报
 * "Tunnel name is not valid"。导入时统一净化为合法名（仅影响服务名，不影响显示名）。 */
const TUNNEL_NAME_RE = /^[a-zA-Z0-9_=+.-]{1,32}$/;
function isTunnelNameValid(n) { return TUNNEL_NAME_RE.test(String(n || '')); }
function sanitizeTunnelName(base) {
  let n = String(base || '').replace(/\.conf$/i, '')
    .replace(/[^a-zA-Z0-9_=+.-]+/g, '_')      // 空格/括号/中文等一律替换为 _
    .replace(/^_+|_+$/g, '')                   // 去首尾下划线
    .slice(0, 32);
  return isTunnelNameValid(n) ? n : 'tunnel';
}

/* ---- 平台隧道命令（官方客户端服务化接口，无需打开 WireGuard GUI）----
 * Windows：官方 MSI 安装后自带服务化 CLI（需要管理员权限）
 *   wireguard.exe /installtunnelservice  <conf 绝对路径>
 *   wireguard.exe /uninstalltunnelservice <隧道名(即 conf 文件名去 .conf)>
 *   服务名：WireGuardTunnel$<隧道名>，随系统自启
 * macOS：brew install wireguard-tools 后用 wg-quick（sudo 提权由应用用 osascript 弹窗） */
function findWireguardExe() {
  const candidates = [
    process.env.ProgramFiles ? process.env.ProgramFiles + '\\WireGuard\\wireguard.exe' : '',
    'C:\\Program Files\\WireGuard\\wireguard.exe',
    'C:\\Program Files (x86)\\WireGuard\\wireguard.exe',
  ].filter(Boolean);
  return candidates;
}
function winServiceName(tunnelName) { return 'WireGuardTunnel$' + tunnelName; }

const commands = {
  win32: {
    up: (confPath) => ({ cmd: 'wireguard.exe', args: ['/installtunnelservice', confPath] }),
    down: (tunnelName) => ({ cmd: 'wireguard.exe', args: ['/uninstalltunnelservice', tunnelName] }),
    status: (tunnelName) => ({ cmd: 'sc.exe', args: ['query', winServiceName(tunnelName)] }),
    parseStatus: (stdout) => /RUNNING/i.test(String(stdout || '')),
  },
  darwin: {
    up: (confPath) => ({ cmd: 'wg-quick', args: ['up', confPath], elevate: 'osascript' }),
    down: (confPath) => ({ cmd: 'wg-quick', args: ['down', confPath], elevate: 'osascript' }),
    status: (tunnelName) => ({ cmd: 'wg', args: ['show', tunnelName] }),
    parseStatus: (stdout) => String(stdout || '').includes('interface'),
  },
};

module.exports = { parseMeta, parseConf, modeLabel, MODE_LABEL, commands, findWireguardExe, winServiceName, isTunnelNameValid, sanitizeTunnelName };
