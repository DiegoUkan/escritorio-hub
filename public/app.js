// Escritório Hub: interface (sem framework)
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const SWATCHES = ['#ffb070', '#ffffff', '#ff2a2a', '#ff8800', '#33ff66', '#00c8ff', '#3355ff', '#b040ff', '#ff3399'];
const lists = {};          // id do WLED -> { effects, palettes }
const touched = new Map(); // elemento -> horário da última interação (não sobrescrever enquanto mexe)

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (data.errors || []).join(', ') || res.statusText);
  return data;
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbToHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

function debounce(fn, ms = 150) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function mark(el) {
  touched.set(el, Date.now());
}
function canSet(el) {
  return document.activeElement !== el && Date.now() - (touched.get(el) || 0) > 3000;
}
function setVal(el, v) {
  if (canSet(el) && el.value !== String(v)) el.value = v;
}

// ---------- Tudo ----------
function initAll() {
  $$('[data-all-on]').forEach((b) =>
    b.addEventListener('click', () => api('POST', '/api/all', { on: b.dataset.allOn === 'true' }).then(refresh).catch(alert)),
  );
  const bri = $('#all-bri');
  bri.addEventListener('input', debounce(() => {
    mark(bri);
    api('POST', '/api/all', { on: true, bri: +bri.value }).catch(console.error);
  }));
  const color = $('#all-color');
  const sendColor = (hex) => api('POST', '/api/all', { on: true, color: hexToRgb(hex), fx: 0 }).then(refresh).catch(console.error);
  color.addEventListener('input', debounce(() => sendColor(color.value), 120));
  const sw = $('#all-swatches');
  SWATCHES.forEach((hex) => {
    const b = document.createElement('button');
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => {
      color.value = hex;
      sendColor(hex);
    });
    sw.append(b);
  });
}

// ---------- WLED ----------
async function loadLists(id) {
  if (lists[id]) return lists[id];
  const data = await api('GET', `/api/wled/${id}/lists`);
  lists[id] = data;
  return data;
}

function fillSelect(sel, names) {
  if (sel.options.length === names.length) return;
  sel.innerHTML = '';
  names.forEach((n, i) => {
    if (n === 'RSVD' || n === '-') return; // slots reservados do WLED
    const o = document.createElement('option');
    o.value = i;
    o.textContent = n.split('@')[0];
    sel.append(o);
  });
}

function wledCard(dev) {
  let card = document.getElementById(`wled-${dev.id}`);
  if (card) return card;
  card = $('#tpl-wled').content.firstElementChild.cloneNode(true);
  card.id = `wled-${dev.id}`;
  const send = (cmd) =>
    api('POST', `/api/wled/${dev.id}`, cmd)
      .then(() => ($('.error', card).textContent = ''))
      .catch((e) => ($('.error', card).textContent = e.message));
  $('.power', card).addEventListener('change', (e) => send({ on: e.target.checked }));
  const bind = (cls, toCmd, ev = 'input') => {
    const el = $(cls, card);
    el.addEventListener(ev, debounce(() => {
      mark(el);
      send(toCmd(el.value));
    }));
  };
  bind('.bri', (v) => ({ on: true, bri: +v }));
  bind('.color', (v) => ({ on: true, color: hexToRgb(v) }));
  bind('.sx', (v) => ({ sx: +v }));
  bind('.fx', (v) => ({ on: true, fx: +v }), 'change');
  bind('.pal', (v) => ({ pal: +v }), 'change');
  $('#wled-list').append(card);
  return card;
}

function renderWled(list) {
  const ids = new Set(list.map((d) => `wled-${d.id}`));
  $$('#wled-list > .card').forEach((c) => !ids.has(c.id) && c.remove());
  for (const dev of list) {
    const card = wledCard(dev);
    card.classList.toggle('offline', !dev.online);
    $('.name', card).textContent = dev.name;
    $('.meta', card).textContent = dev.online
      ? `${dev.host} · ${dev.leds} LEDs · WLED ${dev.version}${dev.live ? ' · recebendo do PC' : ''}`
      : `${dev.host} · offline${dev.error ? ` (${dev.error})` : ''}`;
        $$('input, select', card).forEach((el) => (el.disabled = !dev.online));
    if (!dev.online) continue;
    const power = $('.power', card);
    if (canSet(power)) power.checked = dev.on;
    setVal($('.bri', card), dev.bri);
    setVal($('.color', card), rgbToHex(dev.color));
    setVal($('.sx', card), dev.sx);
    loadLists(dev.id)
      .then(({ effects, palettes }) => {
        fillSelect($('.fx', card), effects);
        fillSelect($('.pal', card), palettes);
        setVal($('.fx', card), dev.fx);
        setVal($('.pal', card), dev.pal);
      })
      .catch(() => {});
  }
}

// ---------- PC / caixa ----------
function renderPc(pc) {
  const el = $('#pc-status');
  if (!pc.configured) {
    el.textContent = 'Não configurado';
    el.className = 'big off';
    $('#pc-detail').textContent = 'Informe o IP do PC em Configurações.';
    return;
  }
  el.textContent = pc.online ? 'Ligado' : 'Desligado';
  el.className = `big ${pc.online ? 'on' : 'off'}`;
  $('#pc-detail').textContent = pc.lastSeen ? `Visto por último: ${new Date(pc.lastSeen).toLocaleString('pt-BR')}` : '';
}

function initSpeaker() {
  $$('#speaker-mode button').forEach((b) =>
    b.addEventListener('click', () => api('POST', '/api/speaker', { mode: b.dataset.mode }).then(refresh).catch(alert)),
  );
}

function renderSpeaker(sp) {
  const el = $('#speaker-status');
  if (!sp.enabled) {
    el.textContent = 'Desativada';
    el.className = 'big off';
  } else {
    el.textContent = sp.on ? 'Ligada' : 'Desligada';
    el.className = `big ${sp.on ? 'on' : 'off'}`;
  }
  $$('#speaker-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === sp.mode));
  $('#speaker-detail').textContent = sp.error
    ? `Erro: ${sp.error}`
    : sp.mode === 'auto'
      ? 'Automático: liga junto com o PC.'
      : 'Modo manual.';
}

// ---------- OpenRGB ----------
function renderOpenRGB(o) {
  const pill = $('#openrgb-pill');
  const body = $('#openrgb-body');
  if (!o.enabled) {
    pill.textContent = 'desativado';
    pill.className = 'pill';
    body.innerHTML = '<p class="muted">Ative em Configurações quando o OpenRGB estiver rodando no PC com o SDK Server ligado.</p>';
    return;
  }
  pill.textContent = o.connected ? 'conectado' : 'desconectado';
  pill.className = `pill ${o.connected ? 'on' : ''}`;
  if (!o.connected) {
    body.innerHTML = `<p class="muted">Não consegui conectar${o.error ? `: ${escapeHtml(o.error)}` : ''}. O PC está ligado e o SDK Server do OpenRGB iniciado?</p>`;
    return;
  }
  const key = JSON.stringify([o.devices, o.profiles]);
  if (body.dataset.key === key) return;
  body.dataset.key = key;
  body.innerHTML = '';
  const listEl = document.createElement('div');
  listEl.className = 'device-list';
  for (const d of o.devices) {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.innerHTML = `<span>${escapeHtml(d.name)} <span class="muted">· ${d.leds} LEDs</span></span><input type="color" value="#ffb070">`;
    const input = $('input', row);
    input.addEventListener('input', debounce(() => api('POST', '/api/openrgb/color', { color: hexToRgb(input.value), device: d.id }).catch(console.error)));
    listEl.append(row);
  }
  if (!o.devices.length) listEl.innerHTML = '<p class="muted">Nenhum dispositivo encontrado no OpenRGB.</p>';
  body.append(listEl);
  if (o.profiles.length) {
    const label = document.createElement('label');
    label.textContent = 'Perfil do OpenRGB';
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">Escolha um perfil…</option>' + o.profiles.map((p) => `<option>${escapeHtml(p)}</option>`).join('');
    sel.addEventListener('change', () => sel.value && api('POST', '/api/openrgb/profile', { name: sel.value }).catch(alert));
    label.append(sel);
    body.append(label);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Ciclo ----------
async function refresh() {
  try {
    const s = await api('GET', '/api/status');
    renderWled(s.wled);
    renderPc(s.pc);
    renderSpeaker(s.speaker);
    renderOpenRGB(s.openrgb);
    const online = s.wled.filter((d) => d.online);
    if (online.length) {
      setVal($('#all-bri'), online[0].bri);
    }
    $('#updated').textContent = s.updatedAt ? `atualizado ${new Date(s.updatedAt).toLocaleTimeString('pt-BR')}` : '';
  } catch (e) {
    $('#updated').textContent = 'sem conexão com o hub';
  }
}

// ---------- Configurações ----------
let cfg;

function wledRow(d = { id: '', name: '', host: '' }) {
  const row = document.createElement('div');
  row.className = 'cfg-wled-row';
  row.innerHTML = `
    <label>ID <input class="w-id" placeholder="monitor"></label>
    <label>Nome <input class="w-name" placeholder="Monitor"></label>
    <label>Endereço (IP ou .local) <input class="w-host" placeholder="escritorio.local"></label>
    <button class="ghost w-del" title="Remover">✕</button>`;
  $('.w-id', row).value = d.id;
  $('.w-name', row).value = d.name;
  $('.w-host', row).value = d.host;
  $('.w-del', row).addEventListener('click', () => row.remove());
  return row;
}

async function loadSettings() {
  cfg = await api('GET', '/api/config');
  const wrap = $('#cfg-wled');
  wrap.innerHTML = '';
  cfg.wled.forEach((d) => wrap.append(wledRow(d)));
  $('#cfg-pc-name').value = cfg.pc.name;
  $('#cfg-pc-host').value = cfg.pc.host;
  $('#cfg-pc-port').value = cfg.pc.port;
  $('#cfg-sp-enabled').checked = cfg.speaker.enabled;
  $('#cfg-sp-wled').innerHTML = cfg.wled.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name || d.id)}</option>`).join('');
  $('#cfg-sp-wled').value = cfg.speaker.wled;
  $('#cfg-sp-relay').value = cfg.speaker.relay;
  $('#cfg-sp-delay').value = cfg.speaker.offDelaySec;
  $('#cfg-orgb-enabled').checked = cfg.openrgb.enabled;
  $('#cfg-orgb-host').value = cfg.openrgb.host;
  $('#cfg-orgb-port').value = cfg.openrgb.port;
  $('#cfg-poll').value = cfg.pollSec;
  $('#cfg-msg').textContent = '';
}

async function saveSettings() {
  const wled = $$('#cfg-wled .cfg-wled-row').map((r) => ({
    id: $('.w-id', r).value.trim(),
    name: $('.w-name', r).value.trim(),
    host: $('.w-host', r).value.trim(),
  }));
  const patch = {
    wled,
    pc: { name: $('#cfg-pc-name').value.trim(), host: $('#cfg-pc-host').value.trim(), port: +$('#cfg-pc-port').value },
    speaker: {
      enabled: $('#cfg-sp-enabled').checked,
      wled: $('#cfg-sp-wled').value || wled[0]?.id || '',
      relay: +$('#cfg-sp-relay').value,
      offDelaySec: +$('#cfg-sp-delay').value,
    },
    openrgb: { enabled: $('#cfg-orgb-enabled').checked, host: $('#cfg-orgb-host').value.trim(), port: +$('#cfg-orgb-port').value },
    pollSec: +$('#cfg-poll').value,
  };
  try {
    await api('PUT', '/api/config', patch);
    Object.keys(lists).forEach((k) => delete lists[k]);
    $('#cfg-msg').textContent = 'Salvo.';
    await loadSettings();
    $('#cfg-msg').textContent = 'Salvo.';
  } catch (e) {
    $('#cfg-msg').textContent = e.message;
  }
}

function initTabs() {
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $('#view-control').hidden = t.dataset.view !== 'control';
      $('#view-settings').hidden = t.dataset.view !== 'settings';
      if (t.dataset.view === 'settings') loadSettings().catch((e) => ($('#cfg-msg').textContent = e.message));
    }),
  );
  $('#cfg-wled-add').addEventListener('click', () => $('#cfg-wled').append(wledRow()));
  $('#cfg-save').addEventListener('click', saveSettings);
}

initAll();
initSpeaker();
initTabs();
refresh();
setInterval(refresh, 3000);
