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

function cardHTML(t, i) {
  return `<div class="tcard ${selected === t.file ? 'sel' : ''} ${states[t.file] === 'up' ? 'up' : ''}"
         data-file="${esc(t.file)}"${t.account ? ' data-account="1"' : ''} style="animation-delay:${i * 60}ms">
      <div class="tc-main">
        <div class="tc-name">${esc(t.name)} ${modeBadge(t.mode)}${t.account ? `<span class="acct-badge" title="由登录账号自动拉取"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>账号配置</span>` : ''}${t.server && t.token ? '<span class="sync-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19h11.5z"/></svg>服务端同步</span>' : ''}</div>
        <div class="tc-nets">${netChips(t.nets)}</div>
        <div class="tc-ep mono">${esc(t.peer.endpoint || '未设置 Endpoint')}${t.iface.address[0] ? ' · ' + esc(t.iface.address[0]) : ''}</div>
      </div>
      <div class="tc-acts">
        <div class="tc-toggle ${states[t.file] === 'up' ? 'on' : ''} ${states[t.file] === 'connecting' || states[t.file] === 'disconnecting' ? 'connecting' : ''}"
             data-toggle="${esc(t.file)}" title="开启/关闭隧道"></div>
        <div class="tc-watch ${watchSet.has(t.file) ? 'on' : ''}" data-watch="${esc(t.file)}">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>
          自动更新</div>
        <button class="tc-del" data-del="${esc(t.file)}">移除</button>
      </div>
    </div>`;
}
/* 内容签名：仅取「名称/模式/账号/同步/网段/端点/地址」等会变化的展示字段，
 * 不含开关状态（up/connecting）与选中态，从而状态刷新不再触发卡片重建（避免闪动）。 */
function contentSig(t) {
  return [t.name, t.mode, t.account || '', (t.server && t.token) ? 1 : 0,
    (t.nets || []).join(','), t.peer.endpoint || '', (t.iface.address[0] || '')].join('|');
}
/* 增量渲染：已有卡片原地更新（仅替换子节点，.tcard 自身不重建），
 * 因此入场动画只在首次创建时播放，配置/状态刷新时卡片不再跳动。
 * 开关状态（up/connecting）只更新 class，保留 .tc-toggle 元素，使过渡动画得以播放。 */
function renderList() {
  const list = $('#tunnelList');
  $('#emptyTip').style.display = tunnels.length ? 'none' : '';
  if (!tunnels.length) { list.innerHTML = ''; return; }
  /* 单隧道切换中：把「其他」隧道的开关/按钮置灰禁用（避免并发切换多条） */
  const busyFiles = Object.entries(states)
    .filter(([, s]) => s === 'connecting' || s === 'disconnecting').map(([f]) => f);
  const have = new Map([...list.children].filter(c => c.classList.contains('tcard')).map(c => [c.dataset.file, c]));
  let prev = null;
  tunnels.forEach((t, i) => {
    const html = cardHTML(t, i);
    let node = have.get(t.file);
    if (!node) {
      const tmp = document.createElement('div'); tmp.innerHTML = html.trim();
      node = tmp.firstElementChild; list.appendChild(node); node._sig = contentSig(t); node._st = states[t.file] || 'down';
    } else {
      const sig = contentSig(t);
      if (node._sig !== sig) {                            // 仅内容变化才重建主区，保留开关元素
        const tmp = document.createElement('div'); tmp.innerHTML = html.trim();
        const fn = tmp.firstElementChild;
        const main = node.querySelector('.tc-main'); if (main) main.outerHTML = fn.querySelector('.tc-main').outerHTML;
        const w = node.querySelector('.tc-watch'); if (w) w.classList.toggle('on', watchSet.has(t.file));
        node._sig = sig;
      }
      have.delete(t.file);
    }
    /* 原地更新状态类，保留 .tc-toggle 元素（关键：动画靠它） */
    const st = states[t.file] || 'down';
    const prevSt = node._st || 'down';
    const locked = busyFiles.length > 0 && !busyFiles.includes(t.file);   // 其他隧道切换中 → 本卡置灰
    node.classList.toggle('up', st === 'up');
    node.classList.toggle('sel', selected === t.file);
    node.classList.toggle('dim', locked);
    const tg = node.querySelector('.tc-toggle');
    if (tg) {
      const wasConnecting = prevSt === 'connecting' || prevSt === 'disconnecting';
      tg.classList.toggle('on', st === 'up');
      tg.classList.toggle('connecting', st === 'connecting' || st === 'disconnecting');
      tg.classList.toggle('disabled', locked);
      tg.classList.remove('busy');
      if (wasConnecting && st === 'up') {                // 连接成功：开关从左（连接中）拨动到右（已开启）+ 光泽脉冲
        tg.classList.add('just-on');
        setTimeout(() => tg.classList.remove('just-on'), 440);
      }
    }
    node._st = st;
    const ref = prev ? prev.nextSibling : list.firstChild;
    if (node !== ref) list.insertBefore(node, ref);
    prev = node;
  });
  have.forEach(n => n.remove());
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
  const busyLocked = selected ? busyElsewhere(selected) : false;   // 其他隧道切换中 → 主按钮也禁用
  btn.disabled = !t || st === 'connecting' || st === 'disconnecting' || busyLocked;
  btn.classList.toggle('up', st === 'up');
  $('#powerHint').textContent = !t ? '双击卡片或点此处开关隧道'
    : busyLocked ? '已有隧道正在切换，请稍候…'
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
/* 是否有「其他」隧道正在连接/断开（切换中）——用于并发保护 + 把其他开关置灰 */
function busyElsewhere(file) {
  return Object.entries(states).some(([f, s]) => f !== file && (s === 'connecting' || s === 'disconnecting'));
}
async function toggleTunnel(file) {
  const st = states[file] || 'down';
  if (st === 'connecting' || st === 'disconnecting') return;   // 本隧道连接/断开进行中：禁止重复触发
  if (busyElsewhere(file)) { toast('已有隧道正在切换，请稍候', 'err'); return; }
  try {
    if (st === 'up') {
      states[file] = 'disconnecting'; renderAll();
      const r = await window.wgc.tunnelDown(file);
      if (!r.ok) { toast(r.message || '关闭失败', 'err'); }
      states[file] = 'down';
    } else {
      /* 单隧道模式：开新隧道前先断开其他已连隧道（切换）。主进程也会做同样的事，覆盖托盘/外部调用。 */
      for (const [f, s] of Object.entries(states)) {
        if (f !== file && s === 'up') { try { await window.wgc.tunnelDown(f); } catch (_) {} states[f] = 'down'; }
      }
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

/* ---------------- 卡片交互：单击选中 / 双击开关 / 拖动排序 ---------------- */
const listEl = $('#tunnelList');
let drag = null;             // 拖拽状态
let lastDragEnd = 0;        // 拖拽结束时间戳，用于抑制拖拽后的误触 toggle
let lastToggleClick = 0;    // 开关单击去抖（避免双击开关两次触发相互抵消）
let dropPh = null;          // 拖动时的「落点预览」占位槽（虚线 + 「放到这里」提示）

/* 落点预览占位：一个跟随目标槽位滑动的虚线卡片槽，拖动时实时预览松手后的落点 */
function ensureDropPh() {
  if (!dropPh || !dropPh.isConnected) {
    dropPh = document.createElement('div');
    dropPh.className = 'drop-ph';
    dropPh.innerHTML = '<span>放到这里</span>';
    listEl.appendChild(dropPh);
  }
  return dropPh;
}
function positionDropPh(targetIndex) {
  if (!drag || drag.noReorder) return;
  const ph = ensureDropPh();
  /* offsetTop/offsetLeft 基于布局、不受 transform 影响，天然就是列表内容坐标，无需换算滚动 */
  ph.style.left = drag.el.offsetLeft + 'px';
  ph.style.width = drag.el.offsetWidth + 'px';
  ph.style.height = drag.cardH + 'px';
  ph.style.transform = `translateY(${drag.el.offsetTop + (targetIndex - drag.origIndex) * drag.height}px)`;
  ph.classList.add('show');
}
function hideDropPh() {
  if (dropPh) { dropPh.classList.remove('show'); dropPh.remove(); dropPh = null; }
}
/* 仅取列表中的卡片节点（排除落点占位等辅助元素） */
const cardNodes = () => [...listEl.children].filter(c => c.classList.contains('tcard'));

/* 轻量选中：仅切换 .sel 高亮 + 刷新主环，不重建列表 DOM */
function setSelected(file) {
  if (selected === file) return;
  selected = file;
  $$('.tcard', listEl).forEach(c => c.classList.toggle('sel', c.dataset.file === file));
  renderHero();
}

/* 单击 = 切换选中卡片（驱动主环展示）；点击开关 / 双击卡片 = 开关隧道。开关处于连接/断开加载态时由 toggleTunnel 内部拦截，不会重复触发。 */
const listClickHandler = async e => {
  if (Date.now() - lastDragEnd < 250) return;            // 拖拽结束后的余震 click 忽略
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
  const w = e.target.closest('[data-watch]');
  if (w) {
    e.stopPropagation();
    const f = w.dataset.watch;
    if (watchSet.has(f)) { watchSet.delete(f); window.wgc.unwatch(f); toast('已关闭自动更新'); }
    else { watchSet.add(f); window.wgc.watch(f); toast('已开启自动更新：配置文件变更时自动生效'); }
    renderList(); return;
  }
  const card = e.target.closest('.tcard'); if (!card) return;
  /* 点击开关本身即开/关隧道（与双击卡片等价）；加 300ms 去抖，避免双击开关时的两次触发相互抵消 */
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    e.stopPropagation();
    const f = tg.dataset.toggle;
    if (Date.now() - lastToggleClick < 300) return;
    lastToggleClick = Date.now();
    toggleTunnel(f).then(renderAll);
    return;
  }
  setSelected(card.dataset.file);                        // 单击：仅切换选中卡片（无开关动作、无闪动）
};
$('#tunnelList').addEventListener('click', e => listClickHandler(e));
$('#tunnelList').addEventListener('dblclick', e => {
  if (Date.now() - lastDragEnd < 250) return;            // 拖拽后的余震双击忽略
  if (e.target.closest('[data-del],[data-watch],[data-toggle]')) return;
  const card = e.target.closest('.tcard'); if (!card) return;
  setSelected(card.dataset.file);
  toggleTunnel(card.dataset.file).then(renderAll);       // 双击：开关隧道（连接中/断开中由内部拦截）
});

/* 拖动排序：被拖卡片以 translateY 精确跟随光标（悬浮 + 轻微放大 + 投影），
 * 其余卡片按「目标落点」平滑让位（FLIP），松手时被拖卡片吸入落点，全程无跳变、无卡顿。
 * 置顶（账号）卡片不可调整位置：仅轻轻晃动并提示「账号卡片不可调整位置」。 */
function applySiblingShift() {
  if (drag.noReorder) return;
  const all = cardNodes();
  const origIndex = all.indexOf(drag.el);
  const draggedCenter = drag.startTop + drag.height / 2 + drag.dy;
  const sibs = all.filter(c => c !== drag.el);
  let targetIndex = sibs.length;
  for (let i = 0; i < sibs.length; i++) {
    const r = sibs[i].getBoundingClientRect();
    if (draggedCenter < r.top + r.height / 2) { targetIndex = i; break; }
  }
  if (targetIndex < drag.acctCount) targetIndex = drag.acctCount;   // 置顶账号卡片必须保持最前，不可插到其上方
  sibs.forEach((s, i) => {
    const oldFull = i < origIndex ? i : i + 1;
    const newFull = i < targetIndex ? i : i + 1;
    const move = (newFull - oldFull) * drag.height;     // 让出落点所需位移
    s.style.transition = 'transform .2s var(--ease)';
    s.style.transform = move ? `translateY(${move}px)` : '';
  });
  drag.targetIndex = targetIndex;
  positionDropPh(targetIndex);                          // 实时预览落点槽位
}
function beginDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  const card = drag.el;
  card.classList.add('dragging');
  document.body.classList.add('dragging');
  drag.startTop = card.getBoundingClientRect().top;       // 开始拖动前的布局顶（无 transform）
  drag.cardH = card.offsetHeight;                        // 卡片可视高度（落点占位槽用）
  drag.height = card.offsetHeight + 12;                  // 卡片高度 + 列表间距(gap:12px)
  drag.origIndex = cardNodes().indexOf(card);            // 原槽位索引（用于换算落点坐标）
  drag.acctCount = cardNodes().filter(c => c.dataset.account === '1').length;  // 置顶账号卡片数量
  if (drag.isAccount) {                                  // 置顶账号卡片：不可排序，仅摇晃 + 提示
    drag.noReorder = true;
    card.querySelector('.tc-main').classList.add('wobble');
    setTimeout(() => card.querySelector('.tc-main').classList.remove('wobble'), 600);
    if (!drag.wobbled) { drag.wobbled = true; toast('账号卡片不可调整位置', 'err'); }
  } else {
    positionDropPh(drag.origIndex);                      // 立即显示落点预览槽
  }
}
listEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const card = e.target.closest('.tcard'); if (!card) return;
  if (e.target.closest('[data-del],[data-watch],[data-toggle]')) return;
  drag = {
    el: card, file: card.dataset.file, isAccount: card.dataset.account === '1',
    pointerStartY: e.clientY, startX: e.clientX, dy: 0, startTop: 0, height: 0,
    pointerId: e.pointerId, active: false, noReorder: false, wobbled: false, targetIndex: 0
  };
  drag.timer = setTimeout(beginDrag, 450);               // 长按兜底（触屏）
  try { card.setPointerCapture(e.pointerId); } catch (_) {}
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.pointerStartY) > 6) beginDrag();
    else return;
  }
  e.preventDefault();
  drag.dy = e.clientY - drag.pointerStartY;              // 相对按下点的纵向位移 → 卡片精准跟随光标
  drag.el.style.transform = `translateY(${drag.dy}px) scale(1.03)`;
  if (!drag.noReorder) applySiblingShift();
}, { passive: false });
document.addEventListener('pointerup', e => {
  if (!drag) return;
  clearTimeout(drag.timer);
  const d = drag; drag = null;
  try { d.el.releasePointerCapture(d.pointerId); } catch (_) {}
  if (!d.active) return;                                 // 仅点击未拖拽
  const card = d.el;
  card.classList.remove('dragging');
  document.body.classList.remove('dragging');
  hideDropPh();                                          // 收起落点预览槽（账号卡片本就没有）
  lastDragEnd = Date.now();                              // 抑制拖拽结束后的误触 toggle
  /* 兄弟卡片让位位移归零 */
  cardNodes().forEach(s => { if (s !== card) { s.style.transition = ''; s.style.transform = ''; } });
  if (d.noReorder) {                                     // 账号卡片：顺序不变，原地归位
    card.style.transition = 'transform .26s var(--ease)';
    card.style.transform = '';
    card.addEventListener('transitionend', function clr() {
      card.style.transition = ''; card.removeEventListener('transitionend', clr);
    });
    return;
  }
  /* 计算落点并写入 DOM / 数据顺序 */
  const all = cardNodes();
  const sibs = all.filter(c => c !== card);
  const draggedCenter = d.startTop + d.height / 2 + d.dy;
  let targetIndex = sibs.length;
  for (let i = 0; i < sibs.length; i++) {
    const r = sibs[i].getBoundingClientRect();
    if (draggedCenter < r.top + r.height / 2) { targetIndex = i; break; }
  }
  if (targetIndex < d.acctCount) targetIndex = d.acctCount;         // 置顶账号卡片必须保持最前，不可插到其上方
  const refNode = sibs[targetIndex] || null;
  listEl.insertBefore(card, refNode);
  /* FLIP：从悬浮位置平滑吸入落点，杜绝跳变 */
  const fromTop = card.getBoundingClientRect().top;
  card.style.transition = 'none';
  card.style.transform = '';
  const toTop = card.getBoundingClientRect().top;
  const delta = fromTop - toTop;
  if (Math.abs(delta) > 1) {
    card.style.transform = `translateY(${delta}px) scale(1.03)`;
    void card.offsetWidth;                               // 强制回流
    card.style.transition = 'transform .26s var(--ease)';
    card.style.transform = '';
  }
  card.addEventListener('transitionend', function clr() {
    card.style.transition = ''; card.removeEventListener('transitionend', clr);
  });
  const files = cardNodes().map(c => c.dataset.file);
  const byFile = new Map(tunnels.map(t => [t.file, t]));
  tunnels = files.map(f => byFile.get(f)).filter(Boolean);
  window.wgc.saveOrder(files).then(r => { if (r && r.tunnels) tunnels = r.tunnels; }).catch(() => {});
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
let pwdFromSaved = false;   // 密码是否来自「已保存的安全存储」回填（此时禁止显示、输入即清空）
const $lg = id => document.getElementById(id);

async function reloadAccounts() {
  try { acctState = await window.wgc.accountsList(); }
  catch { acctState = { history: [], secure: true }; }
  return acctState;
}
/* 登录按钮状态：已登录 -> 显示账号名并加 .is-in（悬停由 CSS 变红、文案变「退出」）；未登录 -> 「登录」 */
function refreshLoginBtn() {
  const t = $lg('btnLoginTxt'), btn = $lg('btnLogin');
  if (!t || !btn) return;
  const acct = tunnels.find(x => x.account);
  if (acct) {
    t.textContent = acct.accountUser || '账号';
    btn.classList.add('is-in');
    btn.title = `已登录：${acct.accountUser || ''} —— 点击退出登录（会删除该账号自动拉取的配置）`;
  } else {
    t.textContent = '登录';
    btn.classList.remove('is-in');
    btn.title = '登录 wg-web 账号，自动拉取你的配置并置顶显示';
  }
}
/* 退出账号：删除该账号自动拉取的配置（历史条目与已保存的密码保留） */
async function doLogout() {
  const confs = tunnels.filter(x => x.account);
  if (!confs.length) return;
  const r = await window.wgc.logout({ server: confs[0].accountServer, username: confs[0].accountUser });
  await refresh();
  toast(`已退出登录，删除 ${(r && r.removed) || 0} 个配置`);
  await reloadAccounts();
  renderAcctFooter();
  refreshLoginBtn();
}
function setHint(msg, type) {
  const h = $lg('lgHint'); if (!h) return;
  h.textContent = msg || '';
  h.className = 'lg-hint' + (msg ? ' show ' + (type || 'err') : '');
}
/* 显示密码按钮：来自安全存储的回填密码 -> 置灰禁用，且不可切换为明文 */
function setEyeDisabled(on) {
  const eye = $lg('lgEye'), p = $lg('lgPass'); if (!eye) return;
  eye.classList.toggle('disabled', !!on);
  eye.disabled = !!on;
  eye.title = on ? '保存的密码不可显示' : '显示密码';
  if (on) { p.type = 'password'; eye.classList.remove('on'); }
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
    pwdFromSaved = false; setEyeDisabled(false);   // 每次打开面板重置密码来源与显示按钮状态
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
    if (!tunnels.some(x => x.account)) return;
    if (!confirm('退出登录会同时删除该账号自动拉取的配置，确定继续？')) return;
    await doLogout();
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
      if (r && r.password) {
        $lg('lgPass').value = r.password;      /* 曾保存密码 -> 一并填入 */
        pwdFromSaved = true;                   /* 来自安全存储：禁止显示、输入即清空 */
        setEyeDisabled(true);
      } else { pwdFromSaved = false; setEyeDisabled(false); }
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
$lg('btnTheme').addEventListener('click', () => {
  const el = document.documentElement;
  const goLight = !el.dataset.theme || el.dataset.theme !== 'light';
  el.dataset.theme = goLight ? 'light' : 'dark';
  localStorage.setItem('wgc-theme', goLight ? 'light' : 'dark');
  toast(goLight ? '已切换为浅色主题' : '已切换为深色主题');
});
/* 登录按钮是**双态**的：
 *  · 未登录 -> 点击打开登录面板
 *  · 已登录 -> 按钮显示账号名，悬停即整体变红并显示「退出」，点击直接退出账号 */
$lg('btnLogin').addEventListener('click', () => {
  if (tunnels.some(x => x.account)) return doLogout();
  openLogin();
});
$lg('btnLoginClose').addEventListener('click', closeLogin);
$lg('loginMask').addEventListener('click', e => { if (e.target === $lg('loginMask')) closeLogin(); });
$lg('lgSubmit').addEventListener('click', submitLogin);
$lg('lgPass').addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(); });
$lg('lgUser').addEventListener('keydown', e => { if (e.key === 'Enter') $lg('lgPass').focus(); });
$lg('lgEye').addEventListener('click', () => {
  if ($lg('lgEye').classList.contains('disabled')) return;   // 保存的密码禁止显示
  const p = $lg('lgPass'), show = p.type === 'password';
  p.type = show ? 'text' : 'password';
  $lg('lgEye').classList.toggle('on', show);
  $lg('lgEye').title = show ? '隐藏密码' : '显示密码';
});
/* 回填的密码：聚焦时全选，使首次输入即替换掉整段密文；输入时清掉「来自保存密码」标记并恢复显示按钮 */
$lg('lgPass').addEventListener('focus', () => { if (pwdFromSaved) $lg('lgPass').select(); });
$lg('lgPass').addEventListener('input', () => {
  if (pwdFromSaved) { pwdFromSaved = false; setEyeDisabled(false); }
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
