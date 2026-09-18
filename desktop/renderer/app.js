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
        <div class="tc-name">${esc(t.name)} ${modeBadge(t.mode)}${t.account ? `<span class="acct-badge" title="由登录账号自动拉取"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>账号配置</span>` : ''}${t.server && t.token ? '<span class="sync-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19h11.5z"/></svg>服务端同步</span>' : ''}</div>
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

function renderAll() { renderList(); renderHero(); refreshLoginBtn(); }

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

/* ---------------- GitHub 更新检查（启动 + 每小时复查）---------------- */
function showUpdateBanner(r) {
  const b = $('#updateBanner'); if (!b) return;
  $('#updateText').textContent = `发现新版本 ${r.latest}（当前 v${r.current}），建议更新`;
  b.dataset.url = r.url || '';
  b.hidden = false;
}
async function checkForUpdate() {
  try {
    const r = await window.wgc.checkUpdate();
    if (r && r.hasUpdate) showUpdateBanner(r);
  } catch {}
}
$('#btnUpdateGo') && $('#btnUpdateGo').addEventListener('click', () => {
  const b = $('#updateBanner'); const url = b && b.dataset.url;
  if (url) window.wgc.openExternal(url);
});
$('#btnUpdateClose') && $('#btnUpdateClose').addEventListener('click', () => { const b = $('#updateBanner'); if (b) b.hidden = true; });

/* ================= 账号登录 =================
 * 登录 wg-web 账号 → 自动拉取该账号的配置并**置顶显示**（落盘与置顶排序在主进程）；
 * 退出登录 → 删除这些配置。
 * 历史用户名下拉：点击用户名框展开，输入时按内容筛选，无匹配自动收起；
 * 选中时若该用户名曾保存密码则一并回填；条目右侧删除按钮会连同保存的密码一起删除。
 * 「保存密码」用系统级安全存储（Electron safeStorage）加密，绝不落明文。
 * 关闭确认弹窗也在此：主进程拦截窗口关闭后通过 onAskClose 请求渲染端展示华丽弹窗。 */
let acctState = { history: [], secure: true };
const $lg = id => document.getElementById(id);

async function reloadAccounts() {
  try { acctState = await window.wgc.accountsList(); }
  catch { acctState = { history: [], secure: true }; }
  return acctState;
}
/* 登录按钮文案：已登录则显示账号名并高亮 */
function refreshLoginBtn() {
  const t = $lg('btnLoginTxt'), btn = $lg('btnLogin');
  if (!t || !btn) return;
  const acct = tunnels.find(x => x.account);
  if (acct) { t.textContent = acct.accountUser || '账号'; btn.classList.add('on'); btn.title = `已登录：${acct.accountUser || ''}（点击管理 / 退出）`; }
  else { t.textContent = '登录'; btn.classList.remove('on'); btn.title = '登录 wg-web 账号，自动拉取你的配置并置顶显示'; }
}
function setHint(msg, type) {
  const h = $lg('lgHint'); if (!h) return;
  h.textContent = msg || '';
  h.className = 'lg-hint' + (msg ? ' show ' + (type || 'err') : '');
}
function openLogin() {
  const m = $lg('loginMask'); if (!m) return;
  m.hidden = false;
  document.body.classList.add('login-open');
  reloadAccounts().then(() => {
    const s = $lg('lgServer'), u = $lg('lgUser'), first = acctState.history[0] || {};
    /* 只回填「上次**成功登录过**的服务器地址」（cfg.server 仅在登录成功时写入）。
       不再用已导入配置 wg-meta 里的 server 兜底 —— 那可能带出 127.0.0.1 这类只对
       「下载配置的那台机器」有效的地址，反而误导。 */
    s.value = cfg.server || '';
    if (!u.value) u.value = first.username || '';
    $lg('lgPass').value = '';
    $lg('lgRemember').checked = !!first.remember;
    $lg('lgAuto').checked = !!first.autoLogin;
    const rk = $lg('lgRemember'), ak = $lg('lgAuto');
    rk.disabled = ak.disabled = !acctState.secure;
    if (!acctState.secure) { rk.checked = ak.checked = false; }
    $lg('lgNote').innerHTML = acctState.secure ? ''
      : '<b>注意</b>：当前系统未提供安全存储，无法保存密码（自动登录不可用）。';
    setHint('');
    setTimeout(() => u.focus(), 70);
    renderAcctFooter();
  });
}
function closeLogin() {
  const m = $lg('loginMask'); if (!m || m.hidden) return;
  m.classList.add('closing');
  setTimeout(() => {
    m.hidden = true; m.classList.remove('closing');
    document.body.classList.remove('login-open'); hideHist();
  }, 180);
}
/* 面板底部：已登录时给出「退出登录」（退出会删除该账号拉取的配置） */
function renderAcctFooter() {
  const f = $lg('lgFoot'); if (!f) return;
  const acct = tunnels.find(x => x.account);
  if (!acct) { f.innerHTML = ''; return; }
  f.innerHTML = `<span>当前已登录：<b>${esc(acct.accountUser || '')}</b>
      <i class="mono">${esc(String(acct.accountServer || '').replace(/^https?:\/\//, ''))}</i></span>
    <button class="lg-out" id="lgLogout">退出登录</button>`;
  $lg('lgLogout').onclick = async () => {
    const confs = tunnels.filter(x => x.account);
    if (!confs.length) return;
    if (!confirm('退出登录会同时删除该账号自动拉取的配置，确定继续？')) return;
    const r = await window.wgc.logout({ server: confs[0].accountServer, username: confs[0].accountUser });
    await refresh(); toast(`已退出登录，删除 ${(r && r.removed) || 0} 个配置`);
    await reloadAccounts(); renderAcctFooter(); refreshLoginBtn();
  };
}
/* ---- 历史用户名下拉 ---- */
function hideHist() { const h = $lg('lgHist'); if (h) { h.hidden = true; h.innerHTML = ''; } }
function showHist(filter) {
  const h = $lg('lgHist'); if (!h) return;
  const q = String(filter || '').trim().toLowerCase();
  const list = acctState.history.filter(x => !q || String(x.username).toLowerCase().includes(q));
  if (!list.length) { hideHist(); return; }        /* 无匹配 -> 下拉消失 */
  h.innerHTML = list.map(x => `
    <div class="lg-hist-item" data-user="${esc(x.username)}" data-server="${esc(x.server)}">
      <span class="lh-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg></span>
      <span class="lh-main"><span class="lh-u">${esc(x.username)}</span>
        <span class="lh-s">${esc(String(x.server).replace(/^https?:\/\//, ''))}${x.hasPwd ? ' · 已保存密码' : ''}</span></span>
      <button class="lh-del" data-del="1" title="删除该条目（连同已保存的密码）">✕</button>
    </div>`).join('');
  h.hidden = false;
  $$('.lg-hist-item', h).forEach(it => {
    const user = it.dataset.user, server = it.dataset.server;
    it.addEventListener('mousedown', async e => {
      if (e.target.closest('[data-del]')) return;
      $lg('lgUser').value = user; $lg('lgServer').value = server;
      const r = await window.wgc.accountsGetPassword({ server, username: user });
      if (r && r.password) $lg('lgPass').value = r.password;      /* 曾保存密码 -> 一并填入 */
      const rec = acctState.history.find(x => x.username === user && x.server === server) || {};
      $lg('lgRemember').checked = !!rec.remember;
      $lg('lgAuto').checked = !!rec.autoLogin;
      hideHist(); setHint('');
    });
    const del = it.querySelector('[data-del]');
    if (del) del.addEventListener('mousedown', async e => {
      e.preventDefault(); e.stopPropagation();
      await window.wgc.accountsForget({ server, username: user });
      await reloadAccounts(); renderAcctFooter();
      showHist($lg('lgUser').value);
      toast('已删除该条目及其保存的密码');
    });
  });
}
async function submitLogin() {
  const server = $lg('lgServer').value.trim();
  const username = $lg('lgUser').value.trim();
  const password = $lg('lgPass').value;
  const remember = $lg('lgRemember').checked && !$lg('lgRemember').disabled;
  const autoLogin = $lg('lgAuto').checked && !$lg('lgAuto').disabled;
  if (!server) return setHint('请填写服务器地址');
  if (!username) return setHint('请填写用户名');
  if (!password) return setHint('请填写密码');
  hideHist();
  const btn = $lg('lgSubmit');
  btn.classList.add('busy'); setHint('正在登录…', 'ok');
  try {
    const r = await window.wgc.login({ server, username, password, remember, autoLogin });
    if (!r || !r.ok) { setHint((r && r.error) || '登录失败'); return; }
    cfg.server = server; await window.wgc.saveCfg(cfg);
    await reloadAccounts();
    await refresh();                                  /* 账号配置已在主进程置顶 */
    if (r.file) { window.wgc.watch(r.file); watchSet.add(r.file); }
    toast(`已登录 ${r.name || username}，配置已置顶显示`);
    renderAcctFooter(); refreshLoginBtn();
    closeLogin();
  } finally { btn.classList.remove('busy'); }
}

/* ---- 关闭确认弹窗（两个按钮均带动画） ---- */
function showExitDialog() {
  const m = $lg('exitMask'); if (!m) return;
  m.hidden = false;
  $lg('exRemember').checked = false;
  setTimeout(() => $lg('exMin').focus(), 80);
}
function exitDecision(act) {
  const m = $lg('exitMask'); if (!m) return;
  const remember = $lg('exRemember').checked;
  m.classList.add('closing');
  setTimeout(() => { m.hidden = true; m.classList.remove('closing'); }, 170);
  window.wgc.closeDecision(act, remember);
}

/* ---- 账号区事件绑定 ---- */
$lg('btnLogin').addEventListener('click', openLogin);
$lg('btnLoginClose').addEventListener('click', closeLogin);
$lg('loginMask').addEventListener('click', e => { if (e.target === $lg('loginMask')) closeLogin(); });
$lg('lgSubmit').addEventListener('click', submitLogin);
$lg('lgPass').addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
$lg('lgUser').addEventListener('keydown', e => { if (e.key === 'Enter') $lg('lgPass').focus(); });
$lg('lgEye').addEventListener('click', () => {
  const p = $lg('lgPass'), show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $lg('lgEye').classList.toggle('on', show);
  $lg('lgEye').title = show ? '隐藏密码' : '显示密码';
});
$lg('lgUser').addEventListener('focus', () => showHist($lg('lgUser').value));
$lg('lgUser').addEventListener('input', () => showHist($lg('lgUser').value));
$lg('lgUser').addEventListener('blur', () => setTimeout(hideHist, 170));
/* 勾选「自动登录」时自动勾上「保存密码」（自动登录必须依赖已保存的密码） */
$lg('lgAuto').addEventListener('change', () => {
  if ($lg('lgAuto').checked && !$lg('lgRemember').disabled) $lg('lgRemember').checked = true;
});
$lg('exMin').addEventListener('click', () => exitDecision('minimize'));
$lg('exQuit').addEventListener('click', () => exitDecision('quit'));
$lg('exitMask').addEventListener('click', e => { if (e.target === $lg('exitMask')) $lg('exitMask').hidden = true; });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  hideHist();
  if (!$lg('loginMask').hidden) closeLogin();
  else if (!$lg('exitMask').hidden) $lg('exitMask').hidden = true;
});
window.wgc.onAskClose(() => showExitDialog());
window.wgc.onAccountChanged(async d => {
  await refresh();
  refreshLoginBtn(); renderAcctFooter();
  if (d && d.action === 'autologin') toast(`已自动登录 ${d.username}`);
  else if (d && d.action === 'logout') toast(`已退出登录 ${d.username}`);
});

/* ================= 启动 ================= */
(async () => {
  env = await window.wgc.env();
  cfg = await window.wgc.getCfg();
  $('#versionTag').textContent = 'v' + env.version;
  $('#platTip').innerHTML = env.platform === 'win32'
    ? `Windows：需安装官方 WireGuard MSI（服务化接口），本应用以 <b>WireGuardTunnel$</b> 系统服务方式开合隧道，随系统自启。安装包要求以管理员身份运行。`
    : env.platform === 'darwin'
      ? `macOS：需 <b>brew install wireguard-tools</b>；开启/关闭时系统会弹出管理员密码确认（wg-quick）。`
      : '';
  await refresh();
  /* 入场后再做一次状态轮询（覆盖应用外开/关隧道的情形） */
  setInterval(refresh, 15000);
  /* 检查 GitHub 是否有新版本（每整小时复查一次） */
  checkForUpdate();
  setInterval(checkForUpdate, 60 * 60 * 1000);
})();
