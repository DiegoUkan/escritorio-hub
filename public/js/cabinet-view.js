// Desenho do gabinete com as LEDs por cima (brilho "vazando" como no palco da moldura).
// Usado no painel Gabinete (prévia ao vivo e pincel) e no editor do mapa (Ajustes).
import { CABINET_ART } from './cabinet-art.js';
import { DEFAULT_ASPECT } from './cabinet-geom.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class CabinetStage {
  constructor(root) {
    this.root = root;
    root.classList.add('cab-stage');
    root.innerHTML = '<div class="cab-bg"></div><canvas class="cab-glow"></canvas><canvas class="cab-dots"></canvas>';
    this.bg = root.querySelector('.cab-bg');
    this.glow = root.querySelector('.cab-glow');
    this.dots = root.querySelector('.cab-dots');
    this.leds = [];
    this.colors = null;     // Uint8Array RGB na ordem das LEDs físicas
    this.style = null;      // (led, i) => { color, alpha, ring } para o editor
    this.extra = null;      // (ctx, toPx) => desenha alças/guias por cima
    this.bgKey = '';
    this.aspect = DEFAULT_ASPECT;
    this.raf = 0;
    new ResizeObserver(() => this.resize()).observe(root);
  }

  // image: true usa a foto enviada; version força recarregar depois de um envio
  setBackground({ image = false, aspect = null, version = 0 } = {}) {
    const key = JSON.stringify([image, aspect, version]);
    if (key === this.bgKey) return;
    this.bgKey = key;
    this.aspect = image && aspect ? aspect : DEFAULT_ASPECT;
    this.root.style.setProperty('--cab-a', String(this.aspect));
    this.bg.innerHTML = image ? `<img src="/api/cabinet/image?v=${version}" alt="Foto do gabinete" draggable="false">` : CABINET_ART;
    this.resize();
  }

  setLeds(leds) {
    this.leds = leds ?? [];
    this.request();
  }

  setColors(frame) {
    this.colors = frame;
    this.request();
  }

  resize() {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.glow, this.dots]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.W = W;
    this.H = H;
    this.request();
  }

  toPx = ([u, v]) => [u * this.W, v * this.H];

  // posição normalizada (u, v) de um evento do mouse/dedo
  toNorm(ev) {
    const r = this.root.getBoundingClientRect();
    return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
  }

  colorAt(i) {
    const f = this.colors;
    return f && i * 3 + 2 < f.length ? [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]] : [0, 0, 0];
  }

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    const { W, H } = this;
    if (!W || !H) return;
    const g = this.glow.getContext('2d');
    const c = this.dots.getContext('2d');
    g.clearRect(0, 0, W, H);
    c.clearRect(0, 0, W, H);
    const R = clamp(W * 0.05, 10, 34);
    const dot = clamp(W * 0.009, 2.2, 4.5);
    g.globalCompositeOperation = 'lighter';
    this.leds.forEach((led, i) => {
      const st = this.style?.(led, i);
      const rgb = st?.color ?? this.colorAt(i);
      const alpha = st?.alpha ?? 1;
      const [r, gg, b] = rgb;
      const lit = Math.max(r, gg, b) > 6;
      for (const p of led.places) {
        const [x, y] = this.toPx(p);
        if (lit) {
          const grad = g.createRadialGradient(x, y, 0, x, y, R);
          grad.addColorStop(0, `rgba(${r},${gg},${b},${0.7 * alpha})`);
          grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
          g.fillStyle = grad;
          g.fillRect(x - R, y - R, R * 2, R * 2);
          c.shadowColor = `rgb(${r},${gg},${b})`;
          c.shadowBlur = 8;
          c.fillStyle = `rgba(${Math.min(255, r + 40)},${Math.min(255, gg + 40)},${Math.min(255, b + 40)},${alpha})`;
        } else {
          c.shadowBlur = 0;
          c.fillStyle = `rgba(255,255,255,${0.14 * alpha})`;
        }
        c.beginPath();
        c.arc(x, y, lit ? dot : dot * 0.8, 0, Math.PI * 2);
        c.fill();
        if (st?.ring) {
          c.shadowBlur = 0;
          c.strokeStyle = st.ring;
          c.lineWidth = 1.5;
          c.beginPath();
          c.arc(x, y, dot + 3.5, 0, Math.PI * 2);
          c.stroke();
        }
      }
    });
    c.shadowBlur = 0;
    this.extra?.(c, this.toPx);
  }
}
