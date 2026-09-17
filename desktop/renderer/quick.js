/* 托盘快捷面板：可滚动小卡片，单击卡片即开关隧道；状态与主界面实时同步 */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const MODE_LABEL = { allow: '白名单', deny: '黑名单', proxy: '全代理' };
let tunnels = [];
let states = {};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render() {
  const list = $('#list');
  const ups = tunnels.filter(t => states[t.file] === 'up');
  $('#dot').className = 'dot' + (ups.length ? ' up' : '');
  $('#summary').textContent = tunnels.length
    ? (ups.length ? `${ups.length}/${tunnels.length} 条已连接` : '全部未连接')
    : '尚无配置';
  list.innerHTML = tunnels.map((t, i) => `
    <div class="card ${states[t.file] === 'up' ? 'up' : ''}" data-file="${esc(t.file)}"
         style="animation-delay:${i * 40}ms" title="单击开关隧道">
      <div class="cm">
        <div class="cn">${esc(t.name)} <span class="mb ${t.mode}">${MODE_LABEL[t.mode] || t.mode}</span></div>
        <div class="ce">${esc(t.iface.address[0] || '')}${t.peer.endpoint ? ' · ' + esc(t.peer.endpoint) : ''}</div>
      </div>
      <div class="tg ${states[t.file] === 'up' ? 'on' : ''} ${states[t.file] === 'connecting' || states[t.file] === 'disconnecting' ? 'busy' : ''}"></div>
    </div>`).join('') || `<div class="empty">暂无配置<br>请先在主界面导入 .conf</div>`;
}

async function refresh() {
  tunnels = await window.wgc.listTunnels();
  await Promise.all(tunnels.map(async t => {
    const r = await window.wgc.tunnelState(t.file);
    if (!['connecting', 'disconnecting'].includes(states[t.file]))
      states[t.file] = r.state === 'up' ? 'up' : 'down';
  }));
  render();
}

$('#list').addEventListener('click', async e => {
  const card = e.target.closest('.card'); if (!card) return;
  const f = card.dataset.file;
  const t = tunnels.find(x => x.file === f); if (!t) return;
  const st = states[f] || 'down';
  try {
    if (st === 'up') {
      states[f] = 'disconnecting'; render();
      const r = await window.wgc.tunnelDown(f);
      if (!r.ok) states[f] = 'up'; else states[f] = 'down';
    } else {
      states[f] = 'connecting'; render();
      const r = await window.wgc.tunnelUp(f);   // 主进程成功后会弹系统通知 + 更新托盘
      states[f] = r.ok ? 'up' : 'down';
    }
  } catch { states[f] = 'down'; }
  render();
});

window.wgc.onConfChanged(({ tunnels: ts }) => { tunnels = ts; render(); });
window.wgc.onStatesChanged(({ states: s }) => { Object.assign(states, s); render(); });
refresh();
setInterval(refresh, 15000);
