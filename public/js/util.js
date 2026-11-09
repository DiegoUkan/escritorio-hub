// Utilidades da interface
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (data.errors || []).join(', ') || res.statusText);
  return data;
}

export function debounce(fn, ms = 120) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Limita a frequência mas sempre envia o último valor
export function throttle(fn, ms = 90) {
  let last = 0;
  let t;
  let pending;
  return (...a) => {
    pending = a;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn(...pending);
    } else {
      clearTimeout(t);
      t = setTimeout(() => {
        last = Date.now();
        fn(...pending);
      }, wait);
    }
  };
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
export const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

// Versão "neon" de uma cor para usar na interface (legível sobre fundo escuro)
export function vivid(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  if (s < 0.12) return hslToRgb([h, 0.08, 0.86]); // branco/cinza: mantém neutro e claro
  return hslToRgb([h, Math.max(s, 0.7), Math.min(Math.max(l, 0.56), 0.68)]);
}

// Cor de destaque a partir de um quadro de LEDs: matiz médio ponderado por saturação e brilho
export function dominant(frame) {
  let x = 0;
  let y = 0;
  let w = 0;
  let sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i + 2 < frame.length; i += 3) {
    const rgb = [frame[i], frame[i + 1], frame[i + 2]];
    const max = Math.max(...rgb);
    if (max < 24) continue;
    const [h, s] = rgbToHsl(rgb);
    const weight = s * (max / 255);
    x += Math.cos((h * Math.PI) / 180) * weight;
    y += Math.sin((h * Math.PI) / 180) * weight;
    w += weight;
    sum = sum.map((v, k) => v + rgb[k]);
    n++;
  }
  if (!n) return null;
  if (w / n < 0.15) return sum.map((v) => v / n); // LEDs quase brancas
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return hslToRgb([hue, 0.85, 0.6]);
}

let toastTimer;
export function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Remove acentos para a busca
export const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const p = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

// Gradiente CSS de uma paleta do WLED; refs c1/c2/c3 usam as cores atuais, "r" vira cores aleatórias fixas
export function paletteCss(stops, colors, seed = 0) {
  if (!stops?.length) return 'linear-gradient(90deg, #222, #333)';
  const rand = (i) => {
    const h = (Math.sin((seed + 1) * 9301 + i * 49297) * 233280) % 360;
    return hslToRgb([Math.abs(h), 0.85, 0.55]);
  };
  const parts = stops.map((s, i) => {
    let rgb = s.rgb;
    if (!rgb) rgb = s.ref === 'r' ? rand(i) : colors?.[Number(s.ref?.[1]) - 1] ?? [80, 80, 80];
    return `rgb(${rgb.join(',')}) ${s.pos}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}
