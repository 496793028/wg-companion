/* 托盘快捷面板：可滚动小卡片，单击卡片即开关隧道；状态与主界面实时同步。
 * 增量渲染（保留每张卡片与开关元素），避免每次刷新重建 DOM 造成的闪动；
 * 开关的「连接中 / 已开启」过渡动画得以平滑播放。 */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const MODE_LABEL = { allow: '白名单', deny: '黑名单', proxy: '全代理' };
let tunnels = [];
let states = {};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cardStructSig(t) {
  return `${t.name}|${t.mode}|${t.iface.address[0] || ''}|${t.peer.endpoint || ''}`;
}
function cmHTML(t) {
  return `<div class="cm">
    <div class="cn">${esc(t.name)} <span class="mb ${t.mode}">${MODE_LABEL[t.mode] || t.mode}</span></div>
    <div class="ce">${esc(t.iface.address[0] || '')}${t.peer.endpoint ? ' · ' + esc(t.peer.endpoint) : ''}</div>
  </div>`;
}
function renderCard(t, i) {
  return `<div class="card ${states[t.file] === 'up' ? 'up' : ''}" data-file="${esc(t.file)}"
       style="animation-delay:${i * 40}ms" title="单击开关隧道">
    ${cmHTML(t)}
    <div class="tg ${states[t.file] === 'up' ? 'on' : ''} ${states[t.file] === 'connecting' || states[t.file] === 'disconnecting' ? 'connecting' : ''}"></div>
  </div>`;
}
/* 是否有「其他」隧道正在连接/断开（切换中）——并发保护 + 置灰 */
function busyElsewhere(f) {
  return Object.entries(states).some(([k, s]) => k !== f && (s === 'connecting' || s === 'disconnecting'));
}
/* 仅更新开关状态类，保留 .tg 元素（关键：过渡动画靠它），不重建卡片 */
function syncCard(node, t, locked) {
  const st = states[t.file] || 'down';
  const prev = node._st || 'down';
  node.classList.toggle('up', st === 'up');
  const tg = node.querySelector('.tg');
  if (tg) {
    const wasConnecting = prev === 'connecting' || prev === 'disconnecting';
    tg.classList.toggle('on', st === 'up');
    tg.classList.toggle('connecting', st === 'connecting' || st === 'disconnecting');
    tg.classList.toggle('disabled', !!locked);
    tg.classList.remove('busy');
    if (wasConnecting && st === 'up') { tg.classList.add('just-on'); setTimeout(() => tg.classList.remove('just-on'), 440); }
  }
  node._st = st;
}
function renderList() {
  const list = $('#list');
  if (!tunnels.length) {
    if (!list.querySelector('.empty')) list.innerHTML = `<div class="empty">暂无配置<br>请先在主界面导入 .conf</div>`;
    return;
  }
  const empty = list.querySelector('.empty'); if (empty) empty.remove();
  const busyFiles = Object.entries(states)
    .filter(([, s]) => s === 'connecting' || s === 'disconnecting').map(([f]) => f);
  const have = new Map([...list.children].filter(c => c.classList.contains('card')).map(c => [c.dataset.file, c]));
  let prev = null;
  tunnels.forEach((t, i) => {
    let node = have.get(t.file);
    if (!node) {
      const tmp = document.createElement('div'); tmp.innerHTML = renderCard(t, i).trim();
      node = tmp.firstElementChild; list.appendChild(node); node._sig = cardStructSig(t); node._st = states[t.file] || 'down';
    } else {
      const sig = cardStructSig(t);
      if (node._sig !== sig) { node.querySelector('.cm').outerHTML = cmHTML(t); node._sig = sig; }   // 仅内容变化才重建主区
      have.delete(t.file);
    }
    const locked = busyFiles.length > 0 && !busyFiles.includes(t.file);   // 其他隧道切换中 → 置灰
    node.classList.toggle('dim', locked);
    syncCard(node, t, locked);
    const ref = prev ? prev.nextSibling : list.firstChild;
    if (node !== ref) list.insertBefore(node, ref);
    prev = node;
  });
  have.forEach(n => n.remove());
}
function renderHeader() {
  const ups = tunnels.filter(t => states[t.file] === 'up');
  $('#dot').className = 'dot' + (ups.length ? ' up' : '');
  $('#summary').textContent = tunnels.length
    ? (ups.length ? `${ups.length}/${tunnels.length} 条已连接` : '全部未连接')
    : '尚无配置';
}
function renderAll() { renderHeader(); renderList(); }

$('#list').addEventListener('click', async e => {
  const card = e.target.closest('.card'); if (!card) return;
  const f = card.dataset.file;
  const t = tunnels.find(x => x.file === f); if (!t) return;
  const st = states[f] || 'down';
  if (st === 'connecting' || st === 'disconnecting') return;   // 本隧道连接/断开进行中，禁止重复触发
  if (busyElsewhere(f)) return;                                // 其他隧道切换中：禁止并发
  try {
    if (st === 'up') {
      states[f] = 'disconnecting'; renderAll();
      const r = await window.wgc.tunnelDown(f);
      states[f] = r.ok ? 'down' : 'up';
    } else {
      /* 单隧道模式：开新隧道前先断开其他已连隧道（主进程亦会兜底） */
      for (const [k, s] of Object.entries(states)) {
        if (k !== f && s === 'up') { try { await window.wgc.tunnelDown(k); } catch (_) {} states[k] = 'down'; }
      }
      states[f] = 'connecting'; renderAll();
      const r = await window.wgc.tunnelUp(f);   // 主进程成功后会弹系统通知 + 更新托盘
      states[f] = r.ok ? 'up' : 'down';
    }
  } catch { states[f] = 'down'; }
  renderAll();
});

window.wgc.onConfChanged(({ tunnels: ts }) => { tunnels = ts; renderAll(); });
window.wgc.onStatesChanged(({ states: s }) => {
  for (const [f, v] of Object.entries(s)) {
    if (!['connecting', 'disconnecting'].includes(states[f])) states[f] = v;
  }
  renderAll();
});

async function refresh() {
  tunnels = await window.wgc.listTunnels();
  await Promise.all(tunnels.map(async t => {
    const r = await window.wgc.tunnelState(t.file);
    if (!['connecting', 'disconnecting'].includes(states[t.file]))
      states[t.file] = r.state === 'up' ? 'up' : 'down';
  }));
  renderAll();
}
refresh();
setInterval(refresh, 15000);
