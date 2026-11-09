// Palco: desenha o monitor com as LEDs ao redor, em tempo real, com o brilho "vazando" na parede.

export function parseHexFrame(hex) {
  const n = hex.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = hex.charCodeAt(i * 2);
    const b = hex.charCodeAt(i * 2 + 1);
    out[i] = (((a & 0xf) + (a > 57 ? 9 : 0)) << 4) | ((b & 0xf) + (b > 57 ? 9 : 0));
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Stage {
  constructor(root) {
    this.root = root;
    this.glow = root.querySelector('.stage-glow');
    this.dots = root.querySelector('.stage-leds');
    this.monitor = root.querySelector('.monitor');
    this.layout = { type: 'strip' };
    this.layoutKey = '';
    this.count = 0;
    this.frame = null;
    this.fallback = [0, 0, 0];
    this.on = false;
    this.bri = 128;
    this.points = [];
    this.geo = null;
    this.raf = 0;
    new ResizeObserver(() => this.resize()).observe(root);
  }

  setLayout(layout, count) {
    const key = JSON.stringify([layout, count]);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.layout = layout?.type ? layout : { type: 'strip' };
    this.count = count || 0;
    this.root.classList.toggle('strip', this.layout.type !== 'frame');
    this.resize();
  }

  setPower(on, bri) {
    if (on === this.on && bri === this.bri) return;
    this.on = on;
    this.bri = bri;
    this.request();
  }

  // quadro ao vivo (Uint8Array RGB) ou null para usar a cor de reserva
  setFrame(frame) {
    this.frame = frame;
    this.request();
  }

  setFallback(rgb) {
    this.fallback = rgb;
    if (!this.frame) this.request();
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
    this.points = [];
    const L = this.layout;
    if (L.type === 'frame') {
      const b = L.bottom | 0, r = L.right | 0, t = L.top | 0, l = L.left | 0;
      const A = clamp(Math.max(b, t, 1) / Math.max(l, r, 1), 1.2, 4);
      const padX = Math.max(30, W * 0.07);
      const top = 34;
      const bottom = 46; // espaço para o pé do monitor
      const availW = W - padX * 2;
      const availH = H - top - bottom;
      const mw = Math.min(availW, availH * A);
      const mh = mw / A;
      const x0 = (W - mw) / 2;
      const y0 = top + (availH - mh) / 2;
      Object.assign(this.monitor.style, { left: `${x0}px`, top: `${y0}px`, width: `${mw}px`, height: `${mh}px` });
      const d = 11; // distância das LEDs até a borda (ficam atrás do monitor)
      const P = this.points;
      for (let i = 0; i < b; i++) P.push([x0 + ((i + 0.5) / b) * mw, y0 + mh + d]);
      for (let i = 0; i < r; i++) P.push([x0 + mw + d, y0 + mh - ((i + 0.5) / r) * mh]);
      for (let i = 0; i < t; i++) P.push([x0 + mw - ((i + 0.5) / t) * mw, y0 - d]);
      for (let i = 0; i < l; i++) P.push([x0 - d, y0 + ((i + 0.5) / l) * mh]);
      this.geo = { size: mw, kind: 'frame' };
    } else {
      const n = this.count || 60;
      const padX = Math.max(30, W * 0.08);
      const y = H * 0.5;
      for (let i = 0; i < n; i++) this.points.push([padX + ((i + 0.5) / n) * (W - padX * 2), y]);
      this.geo = { size: W - padX * 2, kind: 'strip', y, x0: padX, x1: W - padX };
    }
    this.W = W;
    this.H = H;
    this.request();
  }

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  colorAt(i) {
    const f = this.frame;
    if (f && i * 3 + 2 < f.length) return [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
    if (f) return [0, 0, 0];
    return this.on ? this.fallback : [0, 0, 0];
  }

  draw() {
    if (!this.geo) return;
    const { W, H } = this;
    const g = this.glow.getContext('2d');
    const c = this.dots.getContext('2d');
    g.clearRect(0, 0, W, H);
    c.clearRect(0, 0, W, H);

    const level = this.on ? 0.35 + 0.65 * (this.bri / 255) : 0;
    const R = clamp(this.geo.size * 0.075, 16, 64);
    const dot = clamp(this.geo.size * 0.0065, 2, 4.2);

    if (this.geo.kind === 'strip') {
      c.fillStyle = 'rgba(255,255,255,0.05)';
      c.beginPath();
      c.roundRect(this.geo.x0 - 10, this.geo.y - 9, this.geo.x1 - this.geo.x0 + 20, 18, 9);
      c.fill();
    }

    g.globalCompositeOperation = 'lighter';
    this.points.forEach(([x, y], i) => {
      const [r, gg, b] = this.colorAt(i);
      const lit = level > 0 && Math.max(r, gg, b) > 6;
      if (lit) {
        const grad = g.createRadialGradient(x, y, 0, x, y, R);
        grad.addColorStop(0, `rgba(${r},${gg},${b},${0.75 * level})`);
        grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
        g.fillStyle = grad;
        g.fillRect(x - R, y - R, R * 2, R * 2);
        c.shadowColor = `rgb(${r},${gg},${b})`;
        c.shadowBlur = 10;
        c.fillStyle = `rgb(${Math.min(255, r + 40)},${Math.min(255, gg + 40)},${Math.min(255, b + 40)})`;
        c.beginPath();
        c.arc(x, y, dot, 0, Math.PI * 2);
        c.fill();
      } else {
        c.shadowBlur = 0;
        c.fillStyle = 'rgba(255,255,255,0.09)';
        c.beginPath();
        c.arc(x, y, dot * 0.75, 0, Math.PI * 2);
        c.fill();
      }
    });
    c.shadowBlur = 0;
  }
}
