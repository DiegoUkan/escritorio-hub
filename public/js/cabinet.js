// Painel Gabinete (Controle): as LEDs do PC ao vivo sobre o desenho/foto, modos e pincel.
import { $, $$, api, throttle, toast, hexToRgb, setRangeFill } from './util.js';
import { CabinetStage } from './cabinet-view.js';
import { parseHexFrame } from './stage.js';
import { buildLeds } from './cabinet-geom.js';

const SWATCHES = ['#ffffff', '#ff2448', '#ff7a00', '#ffd400', '#2bff88', '#00e5ff', '#3d5afe', '#c04dff', '#000000'];
const SOURCE = {
  wled: 'efeito do WLED',
  ambilight: 'Ambilight',
  paint: 'pintura',
  identify: 'acendendo uma zona',
  none: 'sem sinal',
};

export class CabinetPanel {
  constructor({ onOpenSettings }) {
    this.el = $('#cab-panel');
    this.stage = new CabinetStage($('#cab-stage'));
    this.cfg = null;
    this.st = null;
    this.leds = [];
    this.ledsKey = '';
    this.frame = null;
    this.frameAt = 0;
    this.es = null;
    this.color = '#00e5ff';
    this.overrides = new Map(); // LED -> { rgb, until }: pintura local enquanto o WLED não devolve
    this.imageVersion = Date.now();
    this.onOpenSettings = onOpenSettings;
    this.#bind();
  }

  #bind() {
    $('#cab-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.#save({ mode: b.dataset.mode }, b.dataset.mode === 'paint' ? 'Pintura: pinte o gabinete com o pincel' : 'O gabinete segue o efeito da moldura');
    });
    $('#cab-ambi').addEventListener('change', (e) => this.#save({ ambilight: e.target.checked }, e.target.checked ? 'No Ambilight, o gabinete copia o lado direito da tela' : 'Ambilight só na moldura'));
    $('#cab-cta').addEventListener('click', () => this.onOpenSettings?.());
    $('#cab-swatches').innerHTML = SWATCHES.map((c) => `<button style="background:${c};--c:${c}" data-c="${c}" aria-label="Cor ${c}"></button>`).join('');
    $('#cab-swatches').addEventListener('click', (e) => {
      const c = e.target.closest('button')?.dataset.c;
      if (c) this.#setColor(c);
    });
    $('#cab-color').addEventListener('input', (e) => this.#setColor(e.target.value));
    const brush = $('#cab-brush');
    brush.addEventListener('input', () => setRangeFill(brush));
    setRangeFill(brush);
    $('#cab-fill').addEventListener('click', () => this.#paintAll(this.color.slice(1)));
    $('#cab-clear').addEventListener('click', () => this.#paintAll(''));
    this.#setColor(this.color);

    // pincel: arrasta sobre o gabinete; LEDs com cópias pintam todas as posições
    const root = $('#cab-stage');
    let down = false;
    const sendPaint = throttle((set) => {
      api('POST', '/api/cabinet/paint', { set })
        .then(() => {
          if (this.st) this.st.mode = 'paint'; // pintar liga a Pintura no hub
          this.#render();
        })
        .catch((err) => toast(err.message, true));
      this.pending = {};
    }, 140);
    this.pending = {};
    const brushAt = (ev) => {
      const [u, v] = this.stage.toNorm(ev);
      const r = Number(brush.value) / 100; // raio em fração da largura
      const A = this.stage.aspect;
      const hex = this.color.slice(1);
      const rgb = hexToRgb(hex);
      let hit = false;
      this.leds.forEach((led, i) => {
        if (led.places.some(([pu, pv]) => Math.hypot(pu - u, (pv - v) / A) <= r)) {
          this.pending[i] = hex;
          this.overrides.set(i, { rgb, until: Date.now() + 1200 });
          hit = true;
        }
      });
      this.cursor = { u, v, r };
      if (hit) {
        sendPaint({ ...this.pending });
        this.#redraw();
      } else this.stage.request();
    };
    root.addEventListener('pointerdown', (ev) => {
      if (!this.st?.enabled || !this.leds.length) return;
      down = true;
      root.setPointerCapture(ev.pointerId);
      brushAt(ev);
    });
    root.addEventListener('pointermove', (ev) => {
      if (down) brushAt(ev);
      else if (this.st?.enabled) {
        const [u, v] = this.stage.toNorm(ev);
        this.cursor = { u, v, r: Number(brush.value) / 100 };
        this.stage.request();
      }
    });
    const up = () => (down = false);
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.stage.request();
    });
    this.stage.extra = (ctx, toPx) => {
      if (!this.cursor) return;
      const [x, y] = toPx([this.cursor.u, this.cursor.v]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, this.cursor.r * this.stage.W, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    document.addEventListener('visibilitychange', () => this.#connect());
  }

  #setColor(c) {
    this.color = c.toLowerCase();
    $('#cab-color').value = this.color;
    $$('#cab-swatches button').forEach((b) => b.classList.toggle('active', b.dataset.c === this.color));
  }

  async #save(cabinet, msg) {
    try {
      this.cfg = await api('PUT', '/api/config', { cabinet });
      if (this.st) Object.assign(this.st, cabinet);
      if (msg) toast(msg);
      this.#render();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async #paintAll(hex) {
    try {
      await api('POST', '/api/cabinet/paint', { all: hex });
      const rgb = hex ? hexToRgb(hex) : [0, 0, 0];
      this.leds.forEach((_, i) => this.overrides.set(i, { rgb, until: Date.now() + 1200 }));
      this.#redraw();
      toast(hex ? 'Gabinete pintado' : 'Gabinete apagado');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // a configuração (mapa, foto) muda pelos Ajustes
  async loadConfig() {
    try {
      this.cfg = await api('GET', '/api/config');
      this.imageVersion = Date.now();
      this.ledsKey = '';
      this.#render();
    } catch {}
  }

  update(status) {
    this.st = status.cabinet;
    this.orgb = status.openrgb;
    this.#render();
  }

  #render() {
    const st = this.st;
    if (!st || !this.cfg) return;
    const cab = this.cfg.cabinet;
    const show = st.enabled || this.orgb?.enabled;
    this.el.hidden = !show;
    if (!show) return this.#connect();
    this.el.classList.toggle('off', !st.enabled);
    $('#cab-cta-box').hidden = st.enabled;
    $('#cab-controls').hidden = !st.enabled;

    this.stage.setBackground({ image: cab.image, aspect: cab.aspect, version: this.imageVersion });
    const key = JSON.stringify([st.devices, cab.zones, cab.aspect, cab.image]);
    if (key !== this.ledsKey) {
      this.ledsKey = key;
      this.leds = buildLeds(st.devices, cab.zones, this.stage.aspect);
      this.stage.setLeds(this.leds);
    }

    // modo e Ambilight vêm do status (atualizado a cada ciclo); a config só traz o mapa e a foto
    $$('#cab-mode button').forEach((b) => {
      const on = b.dataset.mode === st.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    $('#cab-ambi').checked = st.ambilight;
    $('#cab-ambi-sub').textContent = st.ambilightActive ? 'agora: copiando o lado direito da tela' : 'lado direito da tela, quando a moldura estiver no Ambilight';

    const pill = $('#cab-pill');
    const live = Date.now() - this.frameAt < 2500;
    const source = st.source === 'wled' && st.mode === 'paint' ? 'paint' : st.source;
    pill.innerHTML = st.enabled ? `<i class="dot ${live && st.source !== 'none' ? 'ok' : 'warn'}"></i>${SOURCE[source] ?? source}` : 'desativado';
    pill.className = `pill ${st.enabled ? (live && st.source !== 'none' ? 'ok' : 'warn') : ''}`;
    $('#cab-note').textContent = this.#note(st);
    this.#connect();
  }

  #note(st) {
    if (!st.count) return 'O OpenRGB ainda não respondeu: as LEDs do PC aparecem quando ele conectar.';
    if (!st.mapped) return 'Nenhuma LED posicionada ainda: desenhe as zonas em Ajustes → Gabinete.';
    const map = st.mapped < st.count ? ` ${st.count - st.mapped} de ${st.count} LEDs ainda sem posição no mapa.` : '';
    switch (st.wledState) {
      case 'missing': return `Falta a saída virtual no WLED: Ajustes → Gabinete → Configurar no WLED.${map}`;
      case 'mismatch': return `O WLED tem ${st.wledLeds - st.start} LEDs virtuais e o PC tem ${st.count}: rode "Configurar no WLED" de novo.${map}`;
      case 'offline': return 'O WLED do gabinete está offline.';
      case 'no-wled': return `WLED "${st.wled}" não existe mais: escolha outro em Ajustes → Gabinete.`;
      default: break;
    }
    const painting = st.mode === 'paint' && (st.source === 'wled' || st.source === 'paint');
    const fps = st.source === 'wled' && !painting && st.ddpFps ? ` (${st.ddpFps} quadros/s do WLED)` : '';
    const how = st.source === 'ambilight' ? 'o lado direito da tela' : painting ? 'a pintura' : st.source === 'wled' ? 'o efeito da moldura' : 'nada ainda';
    return `Mostrando ${how}${fps}. Arraste sobre o gabinete para pintar.${map}`;
  }

  #connect() {
    const want = !!(this.st?.enabled && !this.el.hidden && !document.hidden);
    if (want === !!this.es) return;
    this.es?.close();
    this.es = null;
    if (!want) return;
    this.es = new EventSource('/api/cabinet/live');
    this.es.onmessage = (e) => {
      this.frame = parseHexFrame(e.data);
      this.frameAt = Date.now();
      this.#redraw();
    };
  }

  #redraw() {
    const now = Date.now();
    const n = this.leds.length;
    const out = new Uint8Array(n * 3);
    if (this.frame) out.set(this.frame.subarray(0, n * 3));
    for (const [i, o] of this.overrides) {
      if (o.until < now) this.overrides.delete(i);
      else if (i < n) out.set(o.rgb, i * 3);
    }
    this.stage.setColors(out);
  }
}
