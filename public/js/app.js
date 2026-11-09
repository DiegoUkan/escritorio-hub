// Escritório Hub: interface principal
import { $, $$, api, throttle, toast, vivid, dominant, rgbToHex, hexToRgb, setRangeFill, escapeHtml } from './util.js';
import { Stage, parseHexFrame } from './stage.js';
import { Library } from './library.js';
import { initSettings, loadSettings } from './settings.js';
import { loadGuide } from './guide.js';

const ALL = '__all__';
const DEFAULT_ACCENT = [168, 85, 247];
const SWATCHES = ['#ffb46b', '#ffffff', '#ff2448', '#ff7a00', '#ffd400', '#2bff88', '#00e5ff', '#3d5afe', '#c04dff'];
const ICON = (id) => `<svg><use href="#i-${id}"/></svg>`;

const S = {
  status: null,
  selected: readPref('hub.device'),
  lists: {},            // id -> { effects, palettes } | 'loading' | 'error'
  slot: 0,
  liveAt: 0,
  frame: null,
};
const touched = new Map();
const mark = (el) => touched.set(el, Date.now());
const fresh = (el) => Date.now() - (touched.get(el) || 0) < 2500;

function readPref(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writePref(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

// ---------- dispositivo atual ----------
const devices = () => S.status?.wled ?? [];
function current() {
  const list = devices();
  if (S.selected === ALL) return list.find((d) => d.online) ?? list[0];
  return list.find((d) => d.id === S.selected) ?? list[0];
}
const listsOf = (dev) => (dev && typeof S.lists[dev.id] === 'object' ? S.lists[dev.id] : null);
const effectMeta = (dev) => listsOf(dev)?.effects.find((e) => e.id === dev.fx);
const paletteOf = (dev) => listsOf(dev)?.palettes.find((p) => p.id === dev.pal);

// ---------- cor de destaque (a interface acompanha as LEDs) ----------
let accentKey = '';
function setAccent(rgb) {
  const v = vivid(rgb);
  const key = v.join(' ');
  if (key === accentKey) return;
  accentKey = key;
  document.documentElement.style.setProperty('--led', key);
}
function accentFromState() {
  const dev = current();
  if (!dev?.online || !dev.on) return setAccent(DEFAULT_ACCENT);
  if (Date.now() - S.liveAt < 2500 && S.frame) {
    const d = dominant(S.frame);
    if (d) return setAccent(d);
  }
  setAccent(dev.colors?.[0] ?? DEFAULT_ACCENT);
}

// ---------- comandos ----------
function applyLocal(cmd) {
  const targets = S.selected === ALL ? devices() : [current()].filter(Boolean);
  for (const d of targets) {
    if (typeof cmd.on === 'boolean') d.on = cmd.on;
    if (Number.isFinite(cmd.bri)) d.bri = cmd.bri;
    if (Number.isInteger(cmd.fx)) d.fx = cmd.fx;
    if (Number.isInteger(cmd.pal)) d.pal = cmd.pal;
    for (const k of ['sx', 'ix', 'c1', 'c2', 'c3']) if (Number.isFinite(cmd[k])) d[k] = cmd[k];
    if (Array.isArray(cmd.color)) {
      d.colors = d.colors ? [...d.colors] : [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      d.colors[cmd.slot ?? 0] = cmd.color;
      if (!cmd.slot) d.color = cmd.color;
    }
  }
}

async function send(cmd, { quick = false } = {}) {
  const dev = current();
  if (!dev) return;
  applyLocal(cmd);
  render();
  const url = S.selected === ALL ? '/api/all' : `/api/wled/${dev.id}`;
  try {
    const res = await api('POST', quick ? `${url}?quick=1` : url, cmd);
    if (S.selected !== ALL && res && res.online !== undefined && !quick) {
      Object.assign(dev, res);
      render();
    }
    if (res?.failed?.length) toast(res.failed.join(' · '), true);
  } catch (e) {
    toast(e.message, true);
  }
}
const sendQuick = throttle((cmd) => send(cmd, { quick: true }), 120);

// ---------- palco ----------
const stage = new Stage($('#stage'));
let es = null;
let esId = null;
function connectLive() {
  const dev = current();
  const id = dev?.online && !document.hidden ? dev.id : null;
  if (id === esId) return;
  es?.close();
  es = null;
  esId = id;
  S.liveAt = 0;
  S.frame = null;
  stage.setFrame(null);
  if (!id) return;
  es = new EventSource(`/api/wled/${encodeURIComponent(id)}/live`);
  es.onmessage = (e) => {
    S.frame = parseHexFrame(e.data);
    S.liveAt = Date.now();
    stage.setFrame(S.frame);
  };
}
document.addEventListener('visibilitychange', connectLive);
setInterval(() => {
  const live = Date.now() - S.liveAt < 2500;
  $('#live-badge').classList.toggle('on', live);
  $('#live-badge span').textContent = live ? 'AO VIVO' : 'PRÉVIA';
  if (!live && S.frame) {
    S.frame = null;
    stage.setFrame(null);
  }
  accentFromState();
}, 500);

// ---------- cor ----------
const wheelEl = $('#wheel');
const picker = new window.iro.ColorPicker(wheelEl, {
  width: 240,
  color: '#ffb46b',
  borderWidth: 2,
  borderColor: 'rgba(255,255,255,0.14)',
  handleRadius: 9,
  margin: 16,
  layout: [{ component: window.iro.ui.Wheel }, { component: window.iro.ui.Slider, options: { sliderType: 'value' } }],
});
const sendColor = (rgb) => sendQuick({ on: true, color: rgb, slot: S.slot });
picker.on('input:change', (c) => {
  mark(wheelEl);
  $('#hex').value = c.hexString.toUpperCase();
  sendColor([c.rgb.r, c.rgb.g, c.rgb.b]);
});
picker.on('input:end', (c) => {
  mark(wheelEl);
  send({ on: true, color: [c.rgb.r, c.rgb.g, c.rgb.b], slot: S.slot });
});
new ResizeObserver(() => {
  const max = window.innerWidth < 760 ? 220 : 260;
  const w = Math.max(180, Math.min(max, $('#color-panel').clientWidth - 60));
  if (Math.abs(w - picker.state.width) > 4) picker.resize(w);
}).observe($('#color-panel'));

$('#hex').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!/^#?[0-9a-f]{6}$/i.test(v)) return toast('Use o formato #RRGGBB', true);
  const rgb = hexToRgb(v);
  picker.color.rgb = { r: rgb[0], g: rgb[1], b: rgb[2] };
  mark(wheelEl);
  send({ on: true, color: rgb, slot: S.slot });
});
$('#swatches').innerHTML = SWATCHES.map((c) => `<button style="background:${c};--c:${c}" data-c="${c}" aria-label="Cor ${c}"></button>`).join('');
$('#swatches').addEventListener('click', (e) => {
  const c = e.target.closest('button')?.dataset.c;
  if (!c) return;
  picker.color.hexString = c;
  mark(wheelEl);
  send({ on: true, color: hexToRgb(c), slot: S.slot });
});
$('#slots').addEventListener('click', (e) => {
  const b = e.target.closest('.slot');
  if (!b) return;
  S.slot = Number(b.dataset.slot);
  touched.delete(wheelEl);
  render();
});

// ---------- brilho e energia ----------
const briEl = $('#bri');
briEl.addEventListener('input', () => {
  mark(briEl);
  setRangeFill(briEl);
  $('#bri-val').textContent = `${Math.round((briEl.value / 255) * 100)}%`;
  sendQuick({ on: true, bri: Number(briEl.value) });
});
briEl.addEventListener('change', () => send({ on: true, bri: Number(briEl.value) }));
$('#power').addEventListener('click', () => {
  const on = S.selected === ALL ? !devices().some((d) => d.on) : !current()?.on;
  send({ on });
});

// ---------- ajustes do efeito ----------
let slidersKey = '';
function renderSliders(dev, meta) {
  const box = $('#fx-sliders');
  const sliders = meta?.sliders ?? [];
  const key = JSON.stringify([dev?.id, dev?.fx, sliders]);
  if (key !== slidersKey) {
    slidersKey = key;
    box.innerHTML = sliders.length
      ? sliders
          .map(
            (s) => `<div class="slider-row"><label for="sl-${s.key}">${escapeHtml(s.label)} <output id="out-${s.key}"></output></label>
            <input type="range" class="range" id="sl-${s.key}" data-key="${s.key}" min="0" max="${s.max}"></div>`,
          )
          .join('')
      : `<p class="muted">${meta ? 'Este efeito não tem ajustes.' : 'Escolha um efeito para ver os ajustes.'}</p>`;
    $$('input', box).forEach((inp) => {
      inp.addEventListener('input', () => {
        mark(inp);
        setRangeFill(inp);
        $(`#out-${inp.dataset.key}`).textContent = inp.value;
        sendQuick({ [inp.dataset.key]: Number(inp.value) });
      });
      inp.addEventListener('change', () => send({ [inp.dataset.key]: Number(inp.value) }));
    });
  }
  $$('input', box).forEach((inp) => {
    if (!fresh(inp)) inp.value = dev?.[inp.dataset.key] ?? 128;
    setRangeFill(inp);
    $(`#out-${inp.dataset.key}`).textContent = inp.value;
  });
}

// ---------- biblioteca ----------
const library = new Library({
  onPick: (kind, id) => send(kind === 'effects' ? { on: true, fx: id } : { pal: id }),
  onFav: async (kind, name, fav) => {
    try {
      const favs = await api('POST', '/api/favorites', { kind, name, fav });
      if (S.status) S.status.favorites = favs;
      library.setFavorites(favs);
      toast(fav ? `${name} fixado nos favoritos` : `${name} removido dos favoritos`);
    } catch (e) {
      toast(e.message, true);
    }
  },
});

async function ensureLists(dev) {
  if (!dev?.online || S.lists[dev.id]) return;
  S.lists[dev.id] = 'loading';
  try {
    S.lists[dev.id] = await api('GET', `/api/wled/${encodeURIComponent(dev.id)}/lists`);
  } catch {
    delete S.lists[dev.id]; // tenta de novo no próximo ciclo
    return;
  }
  render();
}

// ---------- renderização ----------
function renderChips(st) {
  const chips = [];
  const on = devices().filter((d) => d.online).length;
  chips.push(`<span class="chip"><i class="dot ${on ? 'ok' : 'bad'}"></i>${ICON('monitor')} WLED ${on}/${devices().length}</span>`);
  if (st.pc.configured) chips.push(`<span class="chip"><i class="dot ${st.pc.online ? 'ok' : ''}"></i>${ICON('cpu')} PC ${st.pc.online ? 'ligado' : 'desligado'}</span>`);
  if (st.speaker.enabled) chips.push(`<span class="chip"><i class="dot ${st.speaker.on ? 'ok' : ''}"></i>${ICON('speaker')} Caixa ${st.speaker.on ? 'ligada' : 'desligada'}</span>`);
  if (st.openrgb.enabled) chips.push(`<span class="chip"><i class="dot ${st.openrgb.connected ? 'ok' : 'warn'}"></i>${ICON('zap')} OpenRGB</span>`);
  $('#chips').innerHTML = chips.join('');
}

function renderDeviceTabs() {
  const list = devices();
  const tabs = [];
  if (list.length > 1) tabs.push({ id: ALL, name: 'Todos', online: list.some((d) => d.online), color: null });
  for (const d of list) tabs.push({ id: d.id, name: d.name, online: d.online, color: d.online && d.on ? vivid(d.colors?.[0] ?? [255, 255, 255]) : null });
  const sel = S.selected === ALL && list.length > 1 ? ALL : current()?.id;
  $('#device-tabs').innerHTML = tabs
    .map(
      (t) => `<button class="dev-tab${t.id === sel ? ' active' : ''}${t.online ? '' : ' offline'}" data-id="${escapeHtml(t.id)}" role="tab" aria-selected="${t.id === sel}">
      ${t.id === ALL ? ICON('layers') : `<i class="swatch" style="background:${t.color ? rgbToHex(t.color) : '#3a3d48'};color:${t.color ? rgbToHex(t.color) : 'transparent'}"></i>`}
      ${escapeHtml(t.name)}</button>`,
    )
    .join('');
}

function renderStage(dev, meta) {
  if (!dev) {
    $('#screen-device').textContent = 'Nenhum dispositivo';
    $('#screen-fx').textContent = '—';
    return;
  }
  stage.setLayout(dev.layout, dev.leds);
  stage.setPower(!!(dev.online && dev.on), dev.bri ?? 0);
  stage.setFallback(dev.colors?.[0] ?? [255, 255, 255]);
  const pal = paletteOf(dev);
  $('#screen-device').textContent = S.selected === ALL ? 'Todos os dispositivos' : dev.name;
  $('#screen-leds').textContent = dev.online ? `${dev.leds} LEDs · ${dev.ip || dev.host}` : 'offline';
  $('#screen-fx').textContent = !dev.online ? 'Offline' : meta ? meta.name : dev.fx === 0 ? 'Solid' : `Efeito ${dev.fx}`;
  $('#screen-pal').textContent = dev.online && meta?.palette && pal ? `Paleta ${pal.name}` : '';
  $('#screen-power').innerHTML = dev.online ? `<i class="pdot${dev.on ? ' on' : ''}"></i>${dev.on ? 'Ligado' : 'Desligado'}` : '';
  $('#screen-bri').textContent = dev.online ? `Brilho ${Math.round((dev.bri / 255) * 100)}%` : '';
}

function renderControls(dev, meta) {
  const anyOn = S.selected === ALL ? devices().some((d) => d.on) : !!dev?.on;
  const power = $('#power');
  power.classList.toggle('on', anyOn && !!dev?.online);
  power.setAttribute('aria-pressed', String(anyOn));
  power.disabled = !dev?.online;
  if (!fresh(briEl) && dev) {
    briEl.value = dev.bri ?? 128;
    $('#bri-val').textContent = dev.online ? `${Math.round(((dev.bri ?? 0) / 255) * 100)}%` : '—';
  }
  briEl.disabled = !dev?.online;
  setRangeFill(briEl);

  // cores que o efeito usa (Principal, Fundo, Extra...)
  const slots = meta?.colors?.length ? meta.colors : [{ slot: 0, label: 'Principal' }];
  if (!slots.some((s) => s.slot === S.slot)) S.slot = slots[0].slot;
  $('#slots').innerHTML = slots
    .map((s) => {
      const c = dev?.colors?.[s.slot] ?? [0, 0, 0];
      return `<button class="slot${s.slot === S.slot ? ' active' : ''}" data-slot="${s.slot}" role="tab" aria-selected="${s.slot === S.slot}"><i style="background:${rgbToHex(c)}"></i>${escapeHtml(s.label)}</button>`;
    })
    .join('');
  if (dev && !fresh(wheelEl)) {
    const c = dev.colors?.[S.slot] ?? [255, 255, 255];
    const hex = rgbToHex(c);
    if (picker.color.hexString.toLowerCase() !== hex) picker.color.hexString = hex;
    $('#hex').value = hex.toUpperCase();
  }
  renderSliders(dev, meta);
}

function renderSystem(st) {
  // PC
  const pcEl = $('#pc-status');
  if (!st.pc.configured) {
    pcEl.textContent = 'Não configurado';
    pcEl.className = 'sys-big off';
    $('#pc-pill').textContent = '—';
    $('#pc-pill').className = 'pill';
    $('#pc-detail').textContent = 'Informe o IP do PC em Ajustes.';
  } else {
    pcEl.textContent = st.pc.online ? 'Ligado' : 'Desligado';
    pcEl.className = `sys-big ${st.pc.online ? 'ok' : 'off'}`;
    $('#pc-pill').innerHTML = `<i class="dot ${st.pc.online ? 'ok' : ''}"></i>${st.pc.online ? 'online' : 'offline'}`;
    $('#pc-pill').className = `pill ${st.pc.online ? 'ok' : ''}`;
    $('#pc-detail').textContent = st.pc.lastSeen ? `Visto por último ${new Date(st.pc.lastSeen).toLocaleString('pt-BR')}` : 'Ainda não foi visto ligado.';
  }
  // Caixa de som
  const sp = st.speaker;
  $('#speaker-pill').innerHTML = sp.enabled ? `<i class="dot ${sp.on ? 'ok' : ''}"></i>${sp.on ? 'ligada' : 'desligada'}` : 'desativada';
  $('#speaker-pill').className = `pill ${sp.enabled && sp.on ? 'ok' : ''}`;
  $$('#speaker-mode button').forEach((b) => {
    const active = b.dataset.mode === sp.mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  });
  $('#speaker-detail').textContent = sp.error ? `Erro: ${sp.error}` : sp.mode === 'auto' ? 'Liga sozinha junto com o PC.' : 'Modo manual.';
  // OpenRGB
  renderOpenRGB(st.openrgb);
}

let orgbKey = '';
function renderOpenRGB(o) {
  const pill = $('#openrgb-pill');
  const body = $('#openrgb-body');
  pill.innerHTML = !o.enabled ? 'desativado' : `<i class="dot ${o.connected ? 'ok' : 'warn'}"></i>${o.connected ? 'conectado' : 'desconectado'}`;
  pill.className = `pill ${o.enabled ? (o.connected ? 'ok' : 'warn') : ''}`;
  const key = JSON.stringify([o.enabled, o.connected, o.error, o.devices, o.profiles]);
  if (key === orgbKey) return;
  orgbKey = key;
  if (!o.enabled) {
    body.innerHTML = '<p class="muted">Ative em Ajustes quando o OpenRGB estiver rodando no PC com o servidor SDK ligado.</p>';
    return;
  }
  if (!o.connected) {
    body.innerHTML = `<p class="muted">Não consegui conectar${o.error ? ` (${escapeHtml(o.error)})` : ''}. O PC está ligado e o servidor SDK do OpenRGB aceita conexões da rede?</p>`;
    return;
  }
  const rows = o.devices.length
    ? o.devices.map((d) => `<div class="orgb-row" data-id="${d.id}"><span>${escapeHtml(d.name)} <small>· ${d.leds} LEDs</small></span><input type="color" value="#ffb46b" aria-label="Cor de ${escapeHtml(d.name)}"></div>`).join('')
    : '<p class="muted">Nenhum dispositivo encontrado no OpenRGB.</p>';
  const profiles = o.profiles.length
    ? `<label class="field">Perfil<select id="orgb-profile"><option value="">Escolha um perfil…</option>${o.profiles.map((p) => `<option>${escapeHtml(p)}</option>`).join('')}</select></label>`
    : '';
  body.innerHTML = `<div class="orgb-list">${rows}</div>${profiles}`;
  $$('.orgb-row input', body).forEach((inp) =>
    inp.addEventListener(
      'input',
      throttle(() => api('POST', '/api/openrgb/color', { color: hexToRgb(inp.value), device: Number(inp.closest('.orgb-row').dataset.id) }).catch((e) => toast(e.message, true)), 150),
    ),
  );
  $('#orgb-profile')?.addEventListener('change', (e) => e.target.value && api('POST', '/api/openrgb/profile', { name: e.target.value }).catch((err) => toast(err.message, true)));
}

function render() {
  const st = S.status;
  if (!st) return;
  const dev = current();
  const meta = dev ? effectMeta(dev) : null;
  renderChips(st);
  renderDeviceTabs();
  renderStage(dev, meta);
  renderControls(dev, meta);
  renderSystem(st);
  library.setOffline(!dev?.online);
  library.setLists(listsOf(dev));
  library.setFavorites(st.favorites);
  library.setActive(dev?.fx ?? -1, dev?.pal ?? -1);
  library.setColors(dev?.colors ?? []);
  library.setPaletteUsed(meta ? meta.palette : true);
  ensureLists(dev);
  connectLive();
  accentFromState();
}

async function refresh() {
  try {
    S.status = await api('GET', '/api/status');
    render();
  } catch {
    $('#chips').innerHTML = '<span class="chip"><i class="dot bad"></i>Sem conexão com o hub</span>';
  }
}

// ---------- navegação ----------
$('#device-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.dev-tab');
  if (!b) return;
  S.selected = b.dataset.id;
  writePref('hub.device', S.selected);
  touched.clear();
  render();
});
$('#speaker-mode').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    await api('POST', '/api/speaker', { mode: b.dataset.mode });
    refresh();
  } catch (err) {
    toast(err.message, true);
  }
});
function showView(view) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-control').hidden = view !== 'control';
  $('#view-settings').hidden = view !== 'settings';
  $('#view-guide').hidden = view !== 'guide';
  if (view === 'settings') loadSettings().catch((e) => toast(e.message, true));
  if (view === 'guide') loadGuide().catch((e) => toast(e.message, true));
  window.scrollTo({ top: 0 });
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('.brand').addEventListener('click', (e) => {
  e.preventDefault();
  showView('control');
});
initSettings(() => {
  S.lists = {};
  refresh();
});

refresh();
setInterval(refresh, 2500);
