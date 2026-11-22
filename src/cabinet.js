// Gabinete: as LEDs do PC (OpenRGB) aparecem como LEDs "virtuais" no fim da fita do WLED.
// O WLED manda essas LEDs por DDP para o hub, que converte pela posição no mapa e pinta no OpenRGB.
// Com a moldura no Ambilight, o hub calcula as cores do gabinete pelo lado direito da tela.
import dgram from 'node:dgram';
import { buildLeds, virtualOrder, DEFAULT_ASPECT } from '../public/js/cabinet-geom.js';

export const DDP_PORT = 4048;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Pacote DDP (http://www.3waylabs.com/ddp/): cabeçalho de 10 bytes (14 com timecode), depois RGB.
export function parseDdp(buf) {
  if (!buf || buf.length < 10) return null;
  const flags = buf[0];
  if ((flags & 0xc0) !== 0x40) return null; // só a versão 1
  const header = flags & 0x10 ? 14 : 10;
  const offset = buf.readUInt32BE(4);
  const len = Math.min(buf.readUInt16BE(8), Math.max(0, buf.length - header));
  return { push: !!(flags & 0x01), offset, data: buf.subarray(header, header + len) };
}

// Monta um pacote DDP (usado pelo WLED falso dos testes)
export function buildDdp(data, offset = 0, push = true) {
  const head = Buffer.alloc(10);
  head[0] = 0x40 | (push ? 0x01 : 0);
  head[2] = 0x0b; // RGB, 8 bits
  head[3] = 1;
  head.writeUInt32BE(offset, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([head, Buffer.from(data)]);
}

// Cor do lado direito da moldura na altura v (0 = topo, 1 = base), interpolando as LEDs vizinhas.
// frame: RGB da moldura (prévia ao vivo, começa no canto inferior esquerdo e a lateral direita sobe)
export function sampleRight(frame, layout, v) {
  const b = Math.max(0, layout?.bottom | 0);
  const r = Math.max(0, layout?.right | 0);
  if (!r || !frame) return [0, 0, 0];
  const pos = clamp((1 - clamp(v, 0, 1)) * r - 0.5, 0, r - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(r - 1, i0 + 1);
  const f = pos - i0;
  const at = (k) => {
    const o = (b + k) * 3;
    return o + 2 < frame.length ? [frame[o], frame[o + 1], frame[o + 2]] : [0, 0, 0];
  };
  const c0 = at(i0);
  const c1 = at(i1);
  return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
}

// Cor de cada LED física no Ambilight: média das cópias, cada uma na sua altura
export function ambilightColors(leds, frame, layout) {
  return leds.map((l) => {
    if (!l.places.length) return [0, 0, 0];
    const acc = [0, 0, 0];
    for (const [, v] of l.places) sampleRight(frame, layout, v).forEach((c, k) => (acc[k] += c));
    return acc.map((c) => Math.round(c / l.places.length));
  });
}

const hexOf = (rgb) => rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
const rgbOf = (hex) => (/^[0-9a-f]{6}$/i.test(hex ?? '') ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : [0, 0, 0]);

// Cores da pintura na ordem virtual (segmento Gabinete do WLED), no formato do campo "i" da API
export function paintSegmentColors(paint, virt) {
  return virt.map((p) => (/^[0-9a-f]{6}$/i.test(paint?.[p] ?? '') ? paint[p].toLowerCase() : '000000'));
}

export class CabinetEngine {
  // output(deviceId, [[r,g,b], ...]) pinta um dispositivo do OpenRGB
  constructor({ port = DDP_PORT, output = () => {}, log = console } = {}) {
    this.port = port;
    this.output = output;
    this.log = log;
    this.cfg = null;
    this.leds = [];
    this.virt = [];
    this.key = '';
    this.ddp = null;          // último quadro DDP completo (ordem virtual)
    this.ddpBuf = null;       // quadro sendo montado (pacotes com offset)
    this.ddpAt = 0;
    this.ddpCount = 0;
    this.ddpFps = 0;
    this.mold = null;         // { frame, layout, at } prévia ao vivo da moldura
    this.moldAmbi = false;    // moldura mostrando a tela (HyperHDR chegando e lor 0)
    this.ident = null;        // { device, zone, until }
    this.current = null;      // quadro atual (ordem física, RGB)
    this.sent = new Map();    // deviceId -> string das cores enviadas
    this.source = 'none';
    this.listeners = new Set();
    this.timer = null;
    this.sock = null;
    this.lastBroadcast = 0;
  }

  start() {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg) => this.ingest(msg));
    sock.on('error', (err) => this.log.warn?.(`[gabinete] UDP ${this.port}: ${err.message}`));
    sock.bind(this.port);
    this.sock = sock;
    setInterval(() => {
      this.ddpFps = this.ddpCount;
      this.ddpCount = 0;
    }, 1000).unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try {
      this.sock?.close();
    } catch {}
    this.sock = null;
  }

  // devices: dispositivos do OpenRGB com as zonas; cfg: bloco cabinet da configuração
  configure(cfg, devices) {
    this.cfg = cfg;
    const key = JSON.stringify([devices?.map((d) => [d.id, d.name, d.zones]), cfg?.zones, cfg?.order, cfg?.aspect]);
    if (key !== this.key) {
      this.key = key;
      this.leds = buildLeds(devices ?? [], cfg?.zones ?? [], cfg?.aspect ?? DEFAULT_ASPECT);
      this.virt = virtualOrder(this.leds, cfg?.order ?? 'up', cfg?.aspect ?? DEFAULT_ASPECT);
      this.current = null;
      this.sent.clear();
    }
    const fps = clamp(Number(cfg?.maxFps) || 30, 5, 60);
    if (!cfg?.enabled) {
      clearInterval(this.timer);
      this.timer = null;
      this.timerFps = 0;
      return;
    }
    if (this.timerFps !== fps) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), Math.round(1000 / fps));
      this.timer.unref?.();
      this.timerFps = fps;
    }
  }

  // O OpenRGB reconectou: reenvia tudo no próximo quadro
  invalidate() {
    this.sent.clear();
  }

  setMoldura(frame, layout) {
    this.mold = { frame, layout, at: Date.now() };
  }

  setMolduraAmbi(on) {
    this.moldAmbi = !!on;
  }

  identify(device, zone, ms = 3000) {
    this.ident = { device, zone, until: Date.now() + ms };
  }

  // Um pacote DDP chegando do WLED (público para os testes)
  ingest(msg) {
    const p = parseDdp(msg);
    if (!p) return;
    const need = this.leds.length * 3;
    if (!this.ddpBuf || this.ddpBuf.length !== need) this.ddpBuf = new Uint8Array(need);
    if (p.offset < need) this.ddpBuf.set(p.data.subarray(0, need - p.offset), p.offset);
    if (p.push) {
      this.ddp = Uint8Array.from(this.ddpBuf);
      this.ddpAt = Date.now();
      this.ddpCount++;
    }
  }

  get ambilightActive() {
    return !!(this.cfg?.ambilight && this.moldAmbi && this.mold && Date.now() - this.mold.at < 3000);
  }

  // Calcula o quadro do gabinete (ordem física) e de onde ele veio
  compute() {
    const n = this.leds.length;
    const out = new Array(n);
    const now = Date.now();
    if (this.ident && now < this.ident.until) {
      this.leds.forEach((l, i) => (out[i] = l.deviceName === this.ident.device && l.zone === this.ident.zone ? [255, 255, 255] : [0, 0, 0]));
      return { frame: out, source: 'identify' };
    }
    this.ident = null;
    if (this.ambilightActive) {
      const target = ambilightColors(this.leds, this.mold.frame, this.mold.layout);
      // a prévia do WLED chega a ~12 quadros/s: suaviza para não piscar
      const prev = this.current && this.source === 'ambilight' ? this.current : target;
      target.forEach((c, i) => (out[i] = c.map((v, k) => Math.round(prev[i][k] + (v - prev[i][k]) * 0.35))));
      return { frame: out, source: 'ambilight' };
    }
    const paintNow = this.cfg?.mode === 'paint' && (this.moldAmbi || !this.ddp);
    if (!paintNow && this.ddp && this.ddp.length >= n * 3) {
      for (let k = 0; k < n; k++) out[this.virt[k]] = [this.ddp[k * 3], this.ddp[k * 3 + 1], this.ddp[k * 3 + 2]];
      return { frame: out, source: 'wled' };
    }
    if (this.cfg?.mode === 'paint') {
      this.leds.forEach((_, i) => (out[i] = rgbOf(this.cfg.paint?.[i])));
      return { frame: out, source: 'paint' };
    }
    return { frame: null, source: 'none' };
  }

  tick() {
    if (!this.cfg?.enabled || !this.leds.length) return;
    const { frame, source } = this.compute();
    this.source = source;
    if (!frame) return;
    this.current = frame;
    // envia só os dispositivos que mudaram
    const byDevice = new Map();
    this.leds.forEach((l, i) => {
      if (!byDevice.has(l.device)) byDevice.set(l.device, []);
      byDevice.get(l.device)[l.index] = frame[i];
    });
    for (const [id, colors] of byDevice) {
      const filled = Array.from(colors, (c) => c ?? [0, 0, 0]);
      const key = filled.join(';');
      if (this.sent.get(id) === key) continue;
      try {
        this.output(id, filled);
        this.sent.set(id, key);
      } catch {
        // OpenRGB fora do ar: tenta de novo no próximo quadro
      }
    }
    this.#broadcast(frame);
  }

  // Prévia ao vivo para as páginas (no máximo ~15 quadros/s)
  #broadcast(frame) {
    if (!this.listeners.size) return;
    const now = Date.now();
    if (now - this.lastBroadcast < 66) return;
    this.lastBroadcast = now;
    const hex = frame.map(hexOf).join('');
    for (const fn of this.listeners) fn(hex);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    if (this.current) fn(this.current.map(hexOf).join(''));
    return () => this.listeners.delete(fn);
  }

  status() {
    return {
      count: this.leds.length,
      mapped: this.leds.filter((l) => l.mapped).length,
      source: this.source,
      ddpFps: this.ddpFps,
      ddpSeen: this.ddpAt ? new Date(this.ddpAt).toISOString() : null,
      ambilightActive: this.ambilightActive,
    };
  }
}
