/* wg-companion 渲染进程：UI 状态机 + 动画 + 与主进程 IPC
 * 卡片交互：单击 = 选中（主环展示）· 双击 = 开关隧道 · 长按 450ms 拖动 = 排序（自动持久化） */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let env = { platform: 'win32', wgExe: '', version: '1.0.0' };
let tunnels = [];          // [{file,name,mode,nets,iface,peer,...}]
let selected = null;       // 当前选中的 file（主环展示）
let states = {};           // file -> 'up' | 'down' | 'connecting' | 'disconnecting'
const watchSet = new Set();
const MODE_LABEL = { allow: '白名单', deny: '黑名单', proxy: '全代理' };
let cfg = {};   // 设置：autoUpdate / autoUpdateInterval / allowInsecure

/* ---------------- 小工具 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toastWrap').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3200);
}
/* 点击涟漪：所有按钮统一 */
document.addEventListener('click', e => {
  const host = e.target.closest('.btn, .tb-btn, .tc-del, .btn-power, .tc-toggle');
  if (!host) return;
  const rc = host.getBoundingClientRect(), d = Math.max(rc.width, rc.height);
  const r = document.createElement('span');
  r.className = 'ripple';
  r.style.width = r.style.height = d + 'px';
  r.style.left = (e.clientX - rc.left - d / 2) + 'px';
  r.style.top = (e.clientY - rc.top - d / 2) + 'px';
  host.appendChild(r); setTimeout(() => r.remove(), 600);
});

/* ---------------- 渲染 ---------------- */
function modeBadge(mode) { return `<span class="mode-badge ${mode}">${MODE_LABEL[mode] || mode}</span>`; }
function netChips(nets) {
  const list = nets.length ? nets : ['（全部流量）'];
  return list.slice(0, 8).map((n, i) => `<span class="chip" style="animation-delay:${i * 45}ms">${esc(n)}</span>`).join('');
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderList() {
  const list = $('#tunnelList');
  $('#emptyTip').style.display = tunnels.length ? 'none' : '';
  list.innerHTML = tunnels.map((t, i) => `
    <div class="tcard ${selected === t.file ? 'sel' : ''} ${states[t.file] === 'up' ? 'up' : ''}"
         data-file="${esc(t.file)}" style="animation-delay:${i * 60}ms" title="双击开关隧道 · 长按拖动排序">
      <div class="tc-main">
        <div class="tc-name">${esc(t.name)} ${modeBadge(t.mode)}${t.server && t.token ? '<span class="sync-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19h11.5z"/></svg>服务端同步</span>' : ''}</div>
        <div class="tc-nets">${netChips(t.nets)}</div>
        <div class="tc-ep mono">${esc(t.peer.endpoint || '未设置 Endpoint')}${t.iface.address[0] ? ' · ' + esc(t.iface.address[0]) : ''}</div>
      </div>
      <div class="tc-acts">
        <div class="tc-toggle ${states[t.file] === 'up' ? 'on' : ''} ${states[t.file] === 'connecting' || states[t.file] === 'disconnecting' ? 'busy' : ''}"
             data-toggle="${esc(t.file)}" title="开启/关闭隧道"></div>
        <div class="tc-watch ${watchSet.has(t.file) ? 'on' : ''}" data-watch="${esc(t.file)}">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>
          自动更新</div>
        <button class="tc-del" data-del="${esc(t.file)}">移除</button>
      </div>
    </div>`).join('');
}

function currentTunnel() { return tunnels.find(t => t.file === selected) || null; }

function renderHero() {
  const t = currentTunnel();
  const st = selected ? (states[selected] || 'down') : 'none';
  const fg = $('#ringFg'), wrap = $('.ring-wrap'), dot = $('#stateDot'), btn = $('#btnPower');
  const C = 2 * Math.PI * 86;
  wrap.classList.toggle('up', st === 'up');
  wrap.classList.toggle('connecting', st === 'connecting' || st === 'disconnecting');
  fg.classList.toggle('up', st === 'up');
  fg.style.strokeDashoffset = st === 'up' ? 0 : (st === 'connecting' || st === 'disconnecting' ? C * 0.5 : C);
  dot.className = 'state-dot' + (st === 'up' ? ' up' : (st === 'connecting' || st === 'disconnecting' ? ' connecting' : ''));
  $('#stateText').textContent =
    st === 'up' ? '已连接' : st === 'connecting' ? '连接中…' : st === 'disconnecting' ? '断开中…' : '未连接';
  $('#stateName').textContent = t ? t.name : '导入配置开始使用';
  $('#heroMode').hidden = !t;
  if (t) { $('#heroMode').className = 'mode-badge ' + t.mode; $('#heroMode').textContent = MODE_LABEL[t.mode] || t.mode; }
  $('#heroNets').innerHTML = t ? netChips(t.nets) : '';
  const ep = $('#heroEndpoint');
  ep.hidden = !t; if (t) ep.textContent = t.peer.endpoint || '';
  btn.disabled = !t || st === 'connecting' || st === 'disconnecting';
  btn.classList.toggle('up', st === 'up');
  $('#powerHint').textContent = !t ? '双击卡片或点此处开关隧道'
    : st === 'up' ? '点击断开隧道' : '点击开启隧道';
}

function renderAll() { renderList(); renderHero(); }

/* ---------------- 数据加载 ---------------- */
async function refresh() {
  tunnels = await window.wgc.listTunnels();
  if (selected && !tunnels.find(t => t.file === selected)) selected = null;
  await Promise.all(tunnels.map(async t => {
    const r = await window.wgc.tunnelState(t.file);
    if (!['connecting', 'disconnecting'].includes(states[t.file]))
      states[t.file] = r.state === 'up' ? 'up' : 'down';
  }));
  renderAll();
}

/* ---------------- 隧道开关 ---------------- */
async function toggleTunnel(file) {
  const st = states[file] || 'down';
  try {
    if (st === 'up') {
      states[file] = 'disconnecting'; renderAll();
      const r = await window.wgc.tunnelDown(file);
      if (!r.ok) { toast(r.message || '关闭失败', 'err'); }
      states[file] = 'down';
    } else {
      states[file] = 'connecting'; renderAll();
      const r = await window.wgc.tunnelUp(file);
      if (!r.ok) { toast(r.message || '开启失败', 'err'); states[file] = 'down'; }
      else {
        await sleep(700);                       // 让「连接中」动画完整走一拍
        states[file] = 'up';
        window.wgc.watch(file); watchSet.add(file);   // 开启即默认纳入自动更新
      }
    }
  } catch (err) { states[file] = 'down'; toast(String(err.message || err), 'err'); }
  await refresh();
}

/* ---------------- 卡片交互：单击选中 / 双击开关 / 长按拖动排序 ---------------- */
let suppressClick = false;   // 拖拽结束后吞掉一次 click，避免误选中
let longFired = false;       // 本次按压是否已进入长按拖拽

const listClickHandler = async e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const f = del.dataset.del;
    if (states[f] === 'up') { toast('请先关闭隧道再移除', 'err'); return; }
    window.wgc.unwatch(f); watchSet.delete(f);
    const r = await window.wgc.deleteTunnel(f);
    tunnels = r.tunnels; if (selected === f) selected = null;
    renderAll(); toast('已移除'); return;
  }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    e.stopPropagation();
    const f = tg.dataset.toggle; selected = f;
    toggleTunnel(f).then(renderAll);
    return;
  }
  const w = e.target.closest('[data-watch]');
  if (w) {
    e.stopPropagation();
    const f = w.dataset.watch;
    if (watchSet.has(f)) { watchSet.delete(f); window.wgc.unwatch(f); toast('已关闭自动更新'); }
    else { watchSet.add(f); window.wgc.watch(f); toast('已开启自动更新：配置文件变更时自动生效'); }
    renderList(); return;
  }
  /* 卡片本体：单击 = 选中（开关由 dblclick 处理） */
  if (suppressClick || longFired) { suppressClick = false; longFired = false; return; }
  const card = e.target.closest('.tcard'); if (!card) return;
  selected = card.dataset.file; renderAll();
};
$('#tunnelList').addEventListener('click', e => listClickHandler(e));
$('#tunnelList').addEventListener('dblclick', e => {
  if (e.target.closest('[data-del],[data-watch],[data-toggle]')) return;
  const card = e.target.closest('.tcard'); if (!card) return;
  const f = card.dataset.file; selected = f;
  toggleTunnel(f).then(renderAll);
});

/* 长按 450ms 进入拖拽；拖动经过兄弟卡片中线即实时换位；松手持久化顺序 */
const listEl = $('#tunnelList');
let drag = null;             // {el, startY, timer, active}
listEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const card = e.target.closest('.tcard'); if (!card) return;
  if (e.target.closest('[data-del],[data-watch],[data-toggle]')) return;
  longFired = false;
  drag = { el: card, startY: e.clientY, active: false,
    timer: setTimeout(() => { if (!drag) return; drag.active = true; longFired = true; suppressClick = true;
      card.classList.add('dragging'); document.body.classList.add('dragging'); }, 450) };
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.abs(e.clientY - drag.startY) > 8) clearTimeout(drag.timer);   // 位移取消长按
    return;
  }
  e.preventDefault();
  const dy = e.clientY - drag.startY;
  drag.el.style.transform = 'translateY(' + dy + 'px)';
  for (const s of [...listEl.children].filter(c => c !== drag.el)) {
    const r = s.getBoundingClientRect(), mid = r.top + r.height / 2;
    if (dy > 0 && e.clientY > mid && s.nextSibling !== drag.el) {
      listEl.insertBefore(drag.el, s.nextSibling); drag.startY = e.clientY; drag.el.style.transform = 'none'; break;
    }
    if (dy < 0 && e.clientY < mid && s.previousElementSibling !== drag.el) {
      listEl.insertBefore(drag.el, s); drag.startY = e.clientY; drag.el.style.transform = 'none'; break;
    }
  }
}, { passive: false });
document.addEventListener('pointerup', async () => {
  if (!drag) return;
  clearTimeout(drag.timer);
  const wasDrag = drag.active;
  if (wasDrag) {
    drag.el.classList.remove('dragging'); document.body.classList.remove('dragging');
    drag.el.style.transform = '';
    const files = [...listEl.children].map(c => c.dataset.file);
    const r = await window.wgc.saveOrder(files);
    tunnels = r.tunnels; renderAll();
  }
  drag = null;
  if (wasDrag) setTimeout(() => { suppressClick = false; longFired = false; }, 60);
});

/* 主电源按钮 */
$('#btnPower').addEventListener('click', () => { if (selected) toggleTunnel(selected).then(renderAll); });

$('#btnImport').addEventListener('click', async () => {
  const r = await window.wgc.importConf();
  if (!r.canceled) {
    r.imported.forEach(f => { window.wgc.watch(f); watchSet.add(f); });
    tunnels = r.tunnels;
    if (!selected && tunnels.length) selected = tunnels[0].file;
    await refresh();
    toast(`已导入 ${r.imported.length} 个配置`);
  }
});

/* 拖放导入 */
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropMask').classList.add('show'); });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#dropMask').classList.remove('show'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#dropMask').classList.remove('show');
  const files = [...(e.dataTransfer.files || [])].filter(f => /\.conf$/i.test(f.name)).map(f => f.path);
  if (!files.length) { toast('请拖入 .conf 配置文件', 'err'); return; }
  importPaths(files);
});
async function importPaths(paths) {
  const r = await window.wgc.importConf(paths);
  if (!r.canceled) {
    r.imported.forEach(f => { window.wgc.watch(f); watchSet.add(f); });
    tunnels = r.tunnels;
    if (!selected && tunnels.length) selected = tunnels[0].file;
    await refresh();
    toast(`已导入 ${r.imported.length} 个配置`);
  }
}

/* 标题栏 */
$$('.tb-btn').forEach(b => b.addEventListener('click', () => {
  const a = b.dataset.act;
  if (a === 'min') window.wgc.winMin();
  else if (a === 'max') window.wgc.winMax();
  else if (a === 'close') window.wgc.winClose();
  else if (a === 'ext') window.wgc.openExternal(b.dataset.url);
}));

/* 主进程状态广播（托盘/快捷面板改动后主界面同步） */
window.wgc.onStatesChanged(({ states: s }) => {
  for (const [f, v] of Object.entries(s)) {
    if (!['connecting', 'disconnecting'].includes(states[f])) states[f] = v;
  }
  renderAll();
});

/* 配置自动更新：主进程监视到文件变化 → 刷新列表；隧道在线则自动重下发。
 * server=true 表示本次变更来自「服务端自动更新」轮询（区分本地手动覆盖）。 */
window.wgc.onConfChanged(async ({ file, tunnels: ts, server }) => {
  tunnels = ts;
  const nm = (tunnels.find(t => t.file === file) || {}).name || file;
  toast(`「${nm}」配置已更新${server ? '（服务端）' : ''}`);
  if (states[file] === 'up') {
    toast('隧道在线：正在自动重新下发新配置…');
    const r = await window.wgc.reapply(file);
    toast(r.ok ? '新配置已生效' : '重新下发失败，请手动重开隧道', r.ok ? 'ok' : 'err');
  }
  renderAll();
});

/* ---------------- 设置：服务端自动更新 ---------------- */
function openSettings() {
  $('#cfgAutoUpdate').checked = cfg.autoUpdate !== false;
  $('#cfgInterval').value = Math.max(10, Number(cfg.autoUpdateInterval) || 30);
  $('#cfgInsecure').checked = cfg.allowInsecure !== false;
  $('#settingsModal').hidden = false;
}
function closeSettings() { $('#settingsModal').hidden = true; }
$('#btnSettings').addEventListener('click', openSettings);
$('#btnSettingsClose').addEventListener('click', closeSettings);
$('#settingsModal').addEventListener('click', e => { if (e.target === $('#settingsModal')) closeSettings(); });
$('#btnSettingsSave').addEventListener('click', async () => {
  cfg.autoUpdate = $('#cfgAutoUpdate').checked;
  cfg.autoUpdateInterval = Math.max(10, Number($('#cfgInterval').value) || 30);
  cfg.allowInsecure = $('#cfgInsecure').checked;
  await window.wgc.saveCfg(cfg);
  closeSettings();
  toast('设置已保存');
});
$('#btnSyncNow').addEventListener('click', async () => {
  toast('正在检查服务端更新…');
  await window.wgc.syncNow();
  toast('已检查（如有更新已自动生效）');
});

/* ---------------- 启动 ---------------- */
(async () => {
  env = await window.wgc.env();
  cfg = await window.wgc.getCfg();
  $('#platTip').innerHTML = env.platform === 'win32'
    ? `Windows：需安装官方 WireGuard MSI（服务化接口），本应用以 <b>WireGuardTunnel$</b> 系统服务方式开合隧道，随系统自启。安装包要求以管理员身份运行。`
    : env.platform === 'darwin'
      ? `macOS：需 <b>brew install wireguard-tools</b>；开启/关闭时系统会弹出管理员密码确认（wg-quick）。`
      : '';
  await refresh();
  /* 入场后再做一次状态轮询（覆盖应用外开/关隧道的情形） */
  setInterval(refresh, 15000);
})();
