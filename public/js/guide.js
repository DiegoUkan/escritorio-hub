// Aba Tutorial: carrega o guia, guarda os passos marcados e copia os comandos
import { $, $$, toast } from './util.js';

const KEY = 'hub.guide.steps';
let loading;

function readDone() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function writeDone(done) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    // sem armazenamento: o guia funciona, só não lembra os passos
  }
}

// O hub é servido em http, onde navigator.clipboard não existe
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // segue para o método antigo
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function updateProgress(root) {
  const boxes = $$('[data-step]', root);
  const total = boxes.length;
  const done = boxes.filter((b) => b.checked).length;
  $('#guide-count', root).textContent = `${done} de ${total} passos`;
  $('#guide-fill', root).style.width = `${total ? (done / total) * 100 : 0}%`;
}

function setup(root) {
  const done = readDone();
  $$('[data-step]', root).forEach((box) => {
    box.checked = done.has(box.dataset.step);
    box.closest('li').classList.toggle('done', box.checked);
  });
  updateProgress(root);

  root.addEventListener('change', (e) => {
    const box = e.target.closest('[data-step]');
    if (!box) return;
    if (box.checked) done.add(box.dataset.step);
    else done.delete(box.dataset.step);
    writeDone(done);
    box.closest('li').classList.toggle('done', box.checked);
    updateProgress(root);
  });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('.guide-copy');
    if (!btn) return;
    try {
      await copyText($('code', btn.parentElement).textContent);
      toast('Comando copiado');
    } catch {
      toast('Não consegui copiar. Selecione o texto e copie à mão.', true);
    }
  });
}

export function loadGuide() {
  if (!loading) {
    loading = fetch('guide.html')
      .then((res) => {
        if (!res.ok) throw new Error('Não consegui carregar o tutorial');
        return res.text();
      })
      .then((html) => {
        const root = $('#view-guide');
        root.innerHTML = html;
        setup(root);
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}
