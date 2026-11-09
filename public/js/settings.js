// Página de Ajustes
import { $, $$, api, escapeHtml, toast } from './util.js';

const SIDES = [
  ['bottom', 'Base'],
  ['right', 'Direita'],
  ['top', 'Topo'],
  ['left', 'Esquerda'],
];

function wledRow(d = { id: '', name: '', host: '', layout: { type: 'strip' } }) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  const lay = d.layout ?? { type: 'strip' };
  row.innerHTML = `
    <label>ID <input class="w-id" placeholder="monitor"></label>
    <label>Nome <input class="w-name" placeholder="Monitor"></label>
    <label>Endereço (IP) <input class="w-host" placeholder="192.168.1.251"></label>
    <label>Layout das LEDs
      <select class="w-type">
        <option value="frame">Moldura de monitor</option>
        <option value="strip">Fita reta</option>
      </select>
    </label>
    <button class="btn ghost icon w-del" title="Remover" aria-label="Remover"><svg class="ico"><use href="#i-x"/></svg></button>
    <div class="frame">${SIDES.map(([k, label]) => `<label>${label} <input class="w-${k}" type="number" min="0" max="1000"></label>`).join('')}</div>`;
  $('.w-id', row).value = d.id;
  $('.w-name', row).value = d.name ?? '';
  $('.w-host', row).value = d.host ?? '';
  $('.w-type', row).value = lay.type === 'frame' ? 'frame' : 'strip';
  for (const [k] of SIDES) $(`.w-${k}`, row).value = lay[k] ?? 0;
  const syncFrame = () => ($('.frame', row).hidden = $('.w-type', row).value !== 'frame');
  $('.w-type', row).addEventListener('change', syncFrame);
  syncFrame();
  $('.w-del', row).addEventListener('click', () => row.remove());
  return row;
}

export async function loadSettings() {
  const cfg = await api('GET', '/api/config');
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

async function saveSettings(onSaved) {
  const wled = $$('#cfg-wled .cfg-row').map((r) => {
    const type = $('.w-type', r).value;
    const layout = { type };
    if (type === 'frame') for (const [k] of SIDES) layout[k] = Number($(`.w-${k}`, r).value) || 0;
    return { id: $('.w-id', r).value.trim(), name: $('.w-name', r).value.trim(), host: $('.w-host', r).value.trim(), layout };
  });
  const patch = {
    wled,
    pc: { name: $('#cfg-pc-name').value.trim(), host: $('#cfg-pc-host').value.trim(), port: Number($('#cfg-pc-port').value) },
    speaker: {
      enabled: $('#cfg-sp-enabled').checked,
      wled: $('#cfg-sp-wled').value || wled[0]?.id || '',
      relay: Number($('#cfg-sp-relay').value),
      offDelaySec: Number($('#cfg-sp-delay').value),
    },
    openrgb: { enabled: $('#cfg-orgb-enabled').checked, host: $('#cfg-orgb-host').value.trim(), port: Number($('#cfg-orgb-port').value) },
    pollSec: Number($('#cfg-poll').value),
  };
  try {
    await api('PUT', '/api/config', patch);
    await loadSettings();
    $('#cfg-msg').textContent = 'Salvo.';
    toast('Configurações salvas');
    onSaved?.();
  } catch (e) {
    $('#cfg-msg').textContent = e.message;
    toast(e.message, true);
  }
}

export function initSettings(onSaved) {
  $('#cfg-wled-add').addEventListener('click', () => $('#cfg-wled').append(wledRow()));
  $('#cfg-save').addEventListener('click', () => saveSettings(onSaved));
}
