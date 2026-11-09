// Aba Tutorial: carrega public/guide.html e completa com os IPs da configuração do hub.
import { $, $$, api, toast } from './util.js';

const CHECKS_KEY = 'hub.guide.checks';
let loaded = null;

function readChecks() {
  try {
    return JSON.parse(localStorage.getItem(CHECKS_KEY) || '{}');
  } catch {
    return {};
  }
}
function writeChecks(v) {
  try {
    localStorage.setItem(CHECKS_KEY, JSON.stringify(v));
  } catch {}
}

// A página é servida por http na rede de casa, onde navigator.clipboard não existe
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // sem permissão ou sem https: usa o jeito antigo
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('não consegui copiar');
}

function updateCount(view) {
  const boxes = $$('input[data-check]', view);
  const done = boxes.filter((b) => b.checked).length;
  const el = $('#guide-count', view);
  if (el) el.textContent = `${done} de ${boxes.length}`;
}

function setup(view) {
  for (const pre of $$('pre.code', view)) {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copiar';
    btn.addEventListener('click', async () => {
      try {
        await copyText($('code', pre).textContent);
        btn.textContent = 'Copiado!';
        setTimeout(() => (btn.textContent = 'Copiar'), 1600);
      } catch (e) {
        toast(`Selecione e copie à mão: ${e.message}`, true);
      }
    });
    pre.append(btn);
  }

  const checks = readChecks();
  for (const box of $$('input[data-check]', view)) {
    box.checked = !!checks[box.dataset.check];
    box.closest('li').classList.toggle('done', box.checked);
    box.addEventListener('change', () => {
      const now = readChecks();
      now[box.dataset.check] = box.checked;
      writeChecks(now);
      box.closest('li').classList.toggle('done', box.checked);
      updateCount(view);
    });
  }
  updateCount(view);

  // índice: rola até a seção sem mexer no endereço da página
  $('.guide-toc', view).addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    $(a.getAttribute('href'), view)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  view.addEventListener('click', (e) => {
    const a = e.target.closest('.guide-body a[href^="#g-"]');
    if (!a) return;
    e.preventDefault();
    $(a.getAttribute('href'), view)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function fill(view, status) {
  const cfg = await api('GET', '/api/config').catch(() => null);
  const monitor = cfg?.wled.find((d) => d.layout?.type === 'frame') ?? cfg?.wled[0];
  const values = {
    version: status?.hub?.version ?? '—',
    'server-ip': location.hostname,
    'monitor-ip': monitor?.host ?? '192.168.1.251',
    'pc-ip': cfg?.openrgb?.host || cfg?.pc?.host || 'IP do PC',
  };
  for (const el of $$('[data-fill]', view)) {
    const v = values[el.dataset.fill];
    if (v) el.textContent = v;
  }
  for (const a of $$('[data-fill-href="monitor-url"]', view)) a.href = `http://${values['monitor-ip']}`;
}

export async function loadGuide(status) {
  const view = $('#view-guide');
  if (!loaded) {
    loaded = fetch('guide.html')
      .then((r) => {
        if (!r.ok) throw new Error('Não consegui abrir o tutorial');
        return r.text();
      })
      .then((html) => {
        view.innerHTML = html;
        setup(view);
      })
      .catch((e) => {
        loaded = null;
        throw e;
      });
  }
  await loaded;
  await fill(view, status);
}
