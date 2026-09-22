/* wg-companion 核心逻辑单测：node lib/core.test.js */
'use strict';
const { parseMeta, parseConf, modeLabel, commands, findWireguardExe, sanitizeTunnelName, isTunnelNameValid } = require('./core.js');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } };

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const meta = { v: 1, name: '陈晓明', mode: 'deny', proxy: 1, nets: ['10.100.0.0/24', '0.0.0.0/0'] };
const conf = `# wg-meta v1 ${b64(JSON.stringify(meta))}
[Interface]
PrivateKey = ABCdef123=
Address = 10.100.0.11/24
MTU = 1280
DNS = 10.100.0.1
[Peer]
PublicKey = SRVpub=
Endpoint = 180.152.3.133:51820
AllowedIPs = 10.100.0.0/24, 0.0.0.0/0
PersistentKeepalive = 25
`;

const p1 = parseConf(conf, '陈晓明-wg.conf');
ok(p1.meta && p1.meta.name === '陈晓明', 'wg-meta 解析：中文姓名');
ok(p1.meta.mode === 'deny' && p1.meta.proxy === 1, 'wg-meta 解析：模式与全代理');
ok(p1.name === '陈晓明', '显示名取元数据姓名');
ok(p1.mode === 'proxy', '模式判定：全代理优先');
ok(p1.modeLabel === undefined && modeLabel(p1.mode) === '全代理', '模式徽章：全代理');
ok(p1.nets.length === 1 && p1.nets[0] === '10.100.0.0/24', '网段过滤 0.0.0.0/0');
ok(p1.iface.address[0] === '10.100.0.11/24' && p1.iface.dns[0] === '10.100.0.1', 'Interface 字段');
ok(p1.peer.endpoint === '180.152.3.133:51820' && p1.peer.keepalive === '25', 'Peer 字段');

/* 白名单模式 */
const p2 = parseConf(conf.replace(b64(JSON.stringify(meta)), b64(JSON.stringify({ v: 1, name: '李静', mode: 'allow', proxy: 0, nets: ['10.100.0.0/24', '10.0.10.5/32'] }))), 'lijing.conf');
ok(p2.mode === 'allow' && modeLabel(p2.mode) === '白名单', '模式判定：白名单');
ok(p2.nets.includes('10.0.10.5/32'), '白名单网段展示');

/* 黑名单（proxy=0）：global 徽章 */
const p3 = parseConf(conf.replace(b64(JSON.stringify(meta)), b64(JSON.stringify({ v: 1, name: '王强', mode: 'deny', proxy: 0, nets: ['0.0.0.0/0'] }))), 'wang.conf');
ok(p3.mode === 'deny' && modeLabel(p3.mode) === '黑名单', '模式判定：黑名单');

/* 老版 wg-web conf（无 wg-meta）：peer 注释兜底 */
const legacy = `# 10.100.0.11 (chenxm)
[Interface]
PrivateKey = ABC=
Address = 10.100.0.11/24
[Peer]
PublicKey = S=
Endpoint = 1.2.3.4:51820
AllowedIPs = 10.100.0.0/24, 10.0.10.5/32
`;
const p4 = parseConf(legacy, 'chenxm-wg.conf');
ok(p4.name === 'chenxm', '老版注释兜底姓名');
ok(p4.mode === 'allow' && p4.nets.length === 2, '老版 conf 模式推断=白名单');

/* 完全裸 conf：文件名兜底 */
const p5 = parseConf('[Interface]\nPrivateKey=A=\n[Peer]\nPublicKey=B=\nAllowedIPs = 0.0.0.0/0\n', 'my-tunnel.conf');
ok(p5.name === 'my-tunnel' && p5.mode === 'global', '裸 conf 文件名兜底 + global 推断');

/* 命令构造 */
const w = commands.win32;
ok(JSON.stringify(w.up('C:\\t\\a.conf')) === JSON.stringify({ cmd: 'wireguard.exe', args: ['/installtunnelservice', 'C:\\t\\a.conf'] }), 'Win up 命令');
ok(JSON.stringify(w.down('a')) === JSON.stringify({ cmd: 'wireguard.exe', args: ['/uninstalltunnelservice', 'a'] }), 'Win down 命令');
ok(w.status('a').args[1] === 'WireGuardTunnel$a', 'Win 服务名 WireGuardTunnel$');
ok(w.parseStatus('  STATE   : 4  RUNNING'), 'Win 状态解析 RUNNING');
ok(w.parseStatus('STATE : 1 STOPPED') === false, 'Win 状态解析 STOPPED');
const d = commands.darwin;
ok(d.up('/etc/wireguard/a.conf').cmd === 'wg-quick' && d.up('/etc/wireguard/a.conf').elevate === 'osascript', 'macOS wg-quick + 提权');
ok(d.parseStatus('interface: a\n  public key: x'), 'macOS 状态解析');
ok(findWireguardExe().some(p => p.endsWith('wireguard.exe')), 'Win 客户端路径候选');

/* 隧道名净化（浏览器 " (1)" 括号/空格/中文） */
ok(sanitizeTunnelName('10.100.0.13-wg (1)') === '10.100.0.13-wg_1', '净化：括号+空格');
ok(sanitizeTunnelName('陈晓明-wg.conf') === '-wg', '净化：中文→下划线并去首尾');
ok(sanitizeTunnelName('   ') === 'tunnel', '净化：全非法→tunnel 兜底');
ok(sanitizeTunnelName('a'.repeat(40)).length === 32, '净化：截断 32 字符');
ok(isTunnelNameValid(sanitizeTunnelName('10.100.0.13-wg (1)')), '净化结果合法');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
