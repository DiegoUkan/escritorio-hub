// Ajustes → Gabinete: liga o gabinete, configura o WLED e desenha o mapa das LEDs do PC.
// Cada zona do OpenRGB vira um ou mais trechos (linha, anel, contorno ou ponto a ponto). Fans no mesmo
// hub/splitter repetem o mesmo sinal: o trecho é colocado de novo com "+ cópia".
import { $, $$, api, escapeHtml, toast } from './util.js';
import { CabinetStage } from './cabinet-view.js';
import { buildLeds, shapePoints } from './cabinet-geom.js';
import { SUGGESTED } from './cabinet-art.js';

const SHAPES = [
  ['line', 'Linha'],
  ['ring', 'Anel'],
  ['rect', 'Contorno'],
  ['points', 'Ponto a ponto'],
];
const HINT = {
  line: 'Arraste na imagem do primeiro ao último LED do trecho.',
  ring: 'Clique no centro do fan e arraste até onde fica o LED 1 (o resto segue no sentido horário).',
  rect: 'Arraste de um canto ao canto oposto. O LED 1 fica logo depois do canto onde você começou.',
  points: 'Clique em cada LED, na ordem.',
};
const zoneKey = (device, zone) => `${device}|${zone}`;
const hueOf = (i) => (i * 67 + 190) % 360;
const hsl = (h, l = 0.6) => {
  const k = (n) => (n + h / 30) % 12;
  const a = 0.85 * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
};

export class CabinetEditor {
  constructor() {
    this.stage = new CabinetStage($('#cab-edit-stage'));
    this.zones = [];
    this.devices = [];
    this.list = [];       // zonas do OpenRGB na ordem: { key, device, zone, leds, hue }
    this.sel = null;      // zona escolhida
    this.active = 0;      // trecho escolhido dentro da zona
    this.drawing = false; // esperando o desenho do trecho ativo
    this.drag = null;
    this.cfg = null;
    this.imageVersion = Date.now();
    this.stage.style = (led) => {
      const z = this.list.find((x) => x.device === led.deviceName && x.zone === led.zone);
      const selected = z?.key === this.sel;
      return { color: hsl(z ? z.hue : 0, selected ? 0.62 : 0.5), alpha: this.sel && !selected ? 0.35 : 1 };
    };
    this.stage.extra = (ctx, toPx) => this.#drawExtra(ctx, toPx);
    this.#bind();
  }

  // ---------- dados ----------
  async load(cfg) {
    this.cfg = cfg;
    const c = cfg.cabinet;
    $('#cab-enabled').checked = c.enabled;
    $('#cab-wled').innerHTML = cfg.wled.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name || d.id)}</option>`).join('');
    $('#cab-wled').value = c.wled;
    $('#cab-order').value = c.order;
    $('#cab-fps').value = c.maxFps;
    $('#cab-ambilight').checked = c.ambilight;
    this.zones = structuredClone(c.zones ?? []);
    try {
      this.status = (await api('GET', '/api/status')).cabinet;
    } catch {
      this.status = null;
    }
    this.devices = this.status?.devices ?? [];
    this.list = this.devices.flatMap((d) => d.zones.map((z) => ({ key: zoneKey(d.name, z.name), device: d.name, zone: z.name, leds: z.leds })));
    this.list.forEach((z, i) => (z.hue = hueOf(i)));
    if (!this.list.some((z) => z.key === this.sel)) this.sel = null;
    this.stage.setBackground({ image: c.image, aspect: c.aspect, version: this.imageVersion });
    this.#renderWled();
    this.#refresh();
  }

  value() {
    return {
      enabled: $('#cab-enabled').checked,
      wled: $('#cab-wled').value,
      order: $('#cab-order').value,
      maxFps: Number($('#cab-fps').value) || 30,
      ambilight: $('#cab-ambilight').checked,
      zones: this.zones
        .map((z) => ({ ...z, places: z.places.filter((p) => p.pts?.length) }))
        .filter((z) => z.places.length),
    };
  }

  #entry(key, create = false) {
    const z = this.list.find((x) => x.key === key);
    if (!z) return null;
    let e = this.zones.find((x) => x.device === z.device && x.zone === z.zone);
    if (!e && create) {
      e = { device: z.device, zone: z.zone, places: [] };
      this.zones.push(e);
    }
    return e;
  }

  #place() {
    return this.#entry(this.sel)?.places[this.active] ?? null;
  }

  // ---------- desenho ----------
  #refresh() {
    this.leds = buildLeds(this.devices, this.zones, this.stage.aspect);
    this.stage.setLeds(this.leds);
    this.#renderZones();
    this.#hint();
  }

  #handles(place) {
    if (!place?.pts?.length) return [];
    return place.pts.map((p, i) => ({ i, p }));
  }

  #drawExtra(ctx, toPx) {
    const z = this.list.find((x) => x.key === this.sel);
    const entry = this.#entry(this.sel);
    if (!z || !entry) return;
    const [r, g, b] = hsl(z.hue, 0.62);
    entry.places.forEach((place, k) => {
      const n = Math.max(0, Math.min(z.leds, place.to) - place.from);
      const pts = shapePoints(place, n, this.stage.aspect);
      const first = pts.find(Boolean);
      // número do primeiro LED do trecho, para conferir o sentido
      if (first) {
        const [x, y] = toPx(first);
        ctx.font = '600 11px Inter Variable, system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 3;
        const label = String(place.from + 1);
        ctx.strokeText(label, x + 7, y - 6);
        ctx.fillText(label, x + 7, y - 6);
      }
      if (k !== this.active) return;
      // guia da forma e alças do trecho ativo
      ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.3;
      const P = (place.pts ?? []).map(toPx);
      if (place.shape === 'line' && P.length === 2) {
        ctx.beginPath();
        ctx.moveTo(...P[0]);
        ctx.lineTo(...P[1]);
        ctx.stroke();
      } else if (place.shape === 'ring' && P.length === 2) {
        ctx.beginPath();
        ctx.arc(P[0][0], P[0][1], Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), 0, Math.PI * 2);
        ctx.stroke();
      } else if (place.shape === 'rect' && P.length === 2) {
        ctx.strokeRect(Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]), Math.abs(P[1][0] - P[0][0]), Math.abs(P[1][1] - P[0][1]));
      }
      ctx.setLineDash([]);
      for (const [x, y] of P) {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    });
  }

  #hint() {
    const place = this.#place();
    const z = this.list.find((x) => x.key === this.sel);
    let text;
    if (!this.list.length) text = 'O OpenRGB ainda não respondeu. Ative e conecte o OpenRGB (acima) para ver as zonas do PC.';
    else if (!z) text = 'Escolha uma zona na lista. "Acender" faz ela piscar no PC de verdade, para você saber qual fan ou fita é.';
    else if (this.drawing && place) {
      const n = place.to - place.from;
      text = HINT[place.shape] + (place.shape === 'points' ? ` Faltam ${n - (place.pts?.length ?? 0)}.` : '');
    } else if (place) text = 'Arraste as alças brancas para ajustar, ou "Desenhar" para refazer. O número mostra onde fica o LED 1 do trecho.';
    else text = `${z.zone} ainda não tem posição: use "+ trecho".`;
    $('#cab-edit-hint').textContent = text;
    this.stage.root.classList.toggle('drawing', !!this.drawing);
  }

  // ---------- lista de zonas ----------
  #renderZones() {
    const box = $('#cab-zones');
    if (!this.list.length) {
      box.innerHTML = '<p class="muted">Sem zonas do OpenRGB ainda.</p>';
      return;
    }
    box.innerHTML = this.list
      .map((z) => {
        const e = this.#entry(z.key);
        const places = e?.places ?? [];
        const sel = z.key === this.sel;
        const copies = new Set(places.map((p) => `${p.from}-${p.to}`)).size < places.length;
        const [r, g, b] = hsl(z.hue, 0.62);
        const rows = places
          .map((p, k) => `
          <div class="cab-place${sel && k === this.active ? ' active' : ''}" data-k="${k}">
            <span class="cab-range">LED <input type="number" class="p-from" min="1" max="${z.leds}" value="${p.from + 1}" aria-label="Do LED"> a <input type="number" class="p-to" min="1" max="${z.leds}" value="${p.to}" aria-label="Até o LED"></span>
            <select class="p-shape" aria-label="Forma">${SHAPES.map(([v, l]) => `<option value="${v}"${v === p.shape ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <button class="btn ghost sm p-draw" title="Desenhar este trecho na imagem">Desenhar</button>
            <button class="btn ghost sm p-rev${p.rev ? ' on' : ''}" title="Inverter o sentido" aria-pressed="${!!p.rev}">⇄</button>
            <button class="btn ghost sm p-copy" title="Mais um fan com o mesmo sinal (hub ou splitter)">+ cópia</button>
            <button class="btn ghost sm icon p-del" title="Remover trecho" aria-label="Remover trecho"><svg class="ico"><use href="#i-x"/></svg></button>
          </div>`)
          .join('');
        return `<div class="cab-zone${sel ? ' sel' : ''}" data-key="${escapeHtml(z.key)}">
          <div class="cab-zone-head">
            <i class="cab-swatch" style="background:rgb(${r},${g},${b});color:rgb(${r},${g},${b})"></i>
            <button class="cab-zone-name">${escapeHtml(z.zone)} <small>${z.leds} LEDs · ${escapeHtml(z.device)}${copies ? ' · com cópias' : ''}</small></button>
            <button class="btn ghost sm z-ident" title="Pisca esta zona no PC por 3 segundos">Acender</button>
          </div>
          ${sel ? `<div class="cab-places">${rows || '<p class="muted">Sem posição ainda.</p>'}<button class="btn ghost sm z-add">+ trecho</button></div>` : ''}
        </div>`;
      })
      .join('');
  }

  #select(key, active = 0) {
    this.sel = key;
    this.active = active;
    this.drawing = false;
    this.#refresh();
  }

  #bind() {
    const box = $('#cab-zones');
    box.addEventListener('click', async (e) => {
      const zEl = e.target.closest('.cab-zone');
      if (!zEl) return;
      const key = zEl.dataset.key;
      const z = this.list.find((x) => x.key === key);
      if (e.target.closest('.z-ident')) return this.#identify(z);
      if (e.target.closest('.cab-zone-name')) return this.#select(key === this.sel ? null : key);
      if (e.target.closest('.z-add')) {
        const entry = this.#entry(key, true);
        const last = entry.places.at(-1);
        const from = last && last.to < z.leds ? last.to : 0;
        entry.places.push({ from, to: z.leds, shape: 'line', pts: [] });
        this.active = entry.places.length - 1;
        this.drawing = true;
        return this.#refresh();
      }
      const pEl = e.target.closest('.cab-place');
      if (!pEl) return;
      const k = Number(pEl.dataset.k);
      const entry = this.#entry(key);
      const place = entry.places[k];
      if (e.target.closest('.p-draw')) {
        this.active = k;
        this.drawing = true;
        place.pts = [];
      } else if (e.target.closest('.p-rev')) place.rev = !place.rev;
      else if (e.target.closest('.p-copy')) {
        // mesma faixa de LEDs, um pouco abaixo: arraste ou redesenhe sobre o outro fan
        const copy = structuredClone(place);
        copy.pts = (copy.pts ?? []).map(([u, v]) => [u, Math.min(1, v + 0.08)]);
        entry.places.splice(k + 1, 0, copy);
        this.active = k + 1;
        toast('Cópia criada: arraste as alças até o outro fan (ou clique em Desenhar)');
      } else if (e.target.closest('.p-del')) {
        entry.places.splice(k, 1);
        this.active = Math.max(0, Math.min(this.active, entry.places.length - 1));
      } else if (e.target.closest('input, select')) {
        this.active = k;
        return;
      } else this.active = k;
      this.#refresh();
    });
    box.addEventListener('change', (e) => {
      const pEl = e.target.closest('.cab-place');
      if (!pEl) return;
      const z = this.list.find((x) => x.key === e.target.closest('.cab-zone').dataset.key);
      const place = this.#entry(z.key).places[Number(pEl.dataset.k)];
      if (e.target.classList.contains('p-shape')) {
        const shape = e.target.value;
        // para "ponto a ponto", parte das posições atuais (dá para ajustar LED por LED)
        if (shape === 'points') place.pts = shapePoints(place, place.to - place.from, this.stage.aspect).filter(Boolean);
        else if (place.shape === 'points') place.pts = place.pts.length > 1 ? [place.pts[0], place.pts.at(-1)] : [];
        place.shape = shape;
        if (!place.pts.length) this.drawing = true;
      } else {
        const from = Math.max(1, Math.min(z.leds, Number(pEl.querySelector('.p-from').value) || 1)) - 1;
        const to = Math.max(from + 1, Math.min(z.leds, Number(pEl.querySelector('.p-to').value) || z.leds));
        place.from = from;
        place.to = to;
        if (place.shape === 'points') place.pts = place.pts.slice(0, to - from);
      }
      this.#refresh();
    });

    // desenhar e arrastar na imagem
    const root = this.stage.root;
    const near = (a, b, px = 12) => Math.hypot((a[0] - b[0]) * this.stage.W, (a[1] - b[1]) * this.stage.H) <= px;
    root.addEventListener('pointerdown', (ev) => {
      const p = this.stage.toNorm(ev);
      const place = this.#place();
      if (this.drawing && place) {
        if (place.shape === 'points') {
          place.pts = [...(place.pts ?? []), p];
          if (place.pts.length >= place.to - place.from) this.drawing = false;
          return this.#refresh();
        }
        place.pts = [p, p];
        this.drag = { kind: 'new' };
      } else {
        const h = this.#handles(place).find(({ p: q }) => near(p, q));
        if (h) this.drag = { kind: 'handle', i: h.i };
        else {
          // clicou num LED: escolhe a zona (e o trecho) dele
          const hit = this.leds.findIndex((l) => l.places.some((q) => near(p, q, 9)));
          if (hit < 0) return;
          const led = this.leds[hit];
          const key = zoneKey(led.deviceName, led.zone);
          const entry = this.#entry(key);
          const k = entry?.places.findIndex((pl) => led.zi >= pl.from && led.zi < pl.to) ?? 0;
          return this.#select(key, Math.max(0, k));
        }
      }
      root.setPointerCapture(ev.pointerId);
    });
    root.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      const place = this.#place();
      if (!place) return;
      const p = this.stage.toNorm(ev);
      if (this.drag.kind === 'new') place.pts[1] = p;
      else place.pts[this.drag.i] = p;
      this.leds = buildLeds(this.devices, this.zones, this.stage.aspect);
      this.stage.setLeds(this.leds);
    });
    const up = () => {
      if (!this.drag) return;
      if (this.drag.kind === 'new') this.drawing = false;
      this.drag = null;
      this.#refresh();
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);

    $('#cab-photo').addEventListener('change', (e) => this.#upload(e.target.files?.[0]));
    $('#cab-photo-reset').addEventListener('click', () => this.#resetPhoto());
    $('#cab-suggest').addEventListener('click', () => this.#suggest());
    $('#cab-setup').addEventListener('click', () => this.#setupWled());
  }

  // ---------- ações ----------
  async #saveCabinet() {
    this.cfg = await api('PUT', '/api/config', { cabinet: this.value() });
  }

  async #identify(z) {
    try {
      if (!$('#cab-enabled').checked) $('#cab-enabled').checked = true;
      await this.#saveCabinet();
      await api('POST', '/api/cabinet/identify', { device: z.device, zone: z.zone });
      toast(`${z.zone} piscando no PC (o mapa foi salvo)`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async #upload(file) {
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      const aspect = img.naturalWidth / img.naturalHeight;
      URL.revokeObjectURL(url);
      const res = await fetch(`/api/cabinet/image?aspect=${aspect.toFixed(4)}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      this.imageVersion = Date.now();
      this.cfg.cabinet = { ...this.cfg.cabinet, image: true, aspect: data.aspect };
      this.stage.setBackground({ image: true, aspect: data.aspect, version: this.imageVersion });
      this.#refresh();
      toast('Foto enviada. Agora posicione as zonas em cima dela.');
    } catch (err) {
      toast(`Não consegui usar a foto: ${err.message}`, true);
    } finally {
      $('#cab-photo').value = '';
    }
  }

  async #resetPhoto() {
    try {
      const c = await api('DELETE', '/api/cabinet/image');
      this.cfg.cabinet = c;
      this.stage.setBackground({ image: false, aspect: null, version: Date.now() });
      this.#refresh();
      toast('Voltou para o desenho do gabinete');
    } catch (err) {
      toast(err.message, true);
    }
  }

  #suggest() {
    if (this.zones.length && !window.confirm('Trocar o mapa atual pelo sugerido para o desenho padrão?')) return;
    this.zones = this.list
      .filter((z) => SUGGESTED[z.zone])
      .map((z) => ({ device: z.device, zone: z.zone, places: SUGGESTED[z.zone].map((p) => ({ from: 0, to: z.leds, ...structuredClone(p) })) }));
    this.sel = null;
    this.#refresh();
    toast(this.zones.length ? 'Mapa sugerido aplicado: confira cada zona com "Acender" e salve' : 'Nenhuma zona com nome conhecido (DRAM, JAF, JARGB 1-3)', !this.zones.length);
  }

  #renderWled() {
    const st = this.status;
    const el = $('#cab-wled-state');
    if (!st || !st.enabled) {
      el.textContent = 'Ative o gabinete, salve e depois configure a saída virtual no WLED.';
      return;
    }
    const msgs = {
      ok: `Pronto: o WLED tem as LEDs ${st.start} a ${st.wledLeds - 1} (gabinete) e manda para o hub por DDP.`,
      missing: `O WLED ainda não tem a saída virtual. Ela vai ocupar as LEDs ${st.start} a ${st.start + st.count - 1}.`,
      mismatch: `O WLED tem ${st.wledLeds - st.start} LEDs virtuais, mas o PC tem ${st.count}. Configure de novo.`,
      offline: 'O WLED está offline.',
      'no-wled': 'Escolha um WLED que exista.',
    };
    el.textContent = msgs[st.wledState] ?? '';
  }

  async #setupWled() {
    const n = this.status?.count;
    if (!n) return toast('Conecte o OpenRGB primeiro: é ele que diz quantas LEDs o PC tem', true);
    const ok = window.confirm(`Adicionar no WLED uma saída virtual (DDP) com ${n} LEDs depois da moldura, mandando para o hub?\n\nO hub guarda um backup da configuração do WLED antes. As LEDs do monitor podem apagar por alguns segundos.`);
    if (!ok) return;
    const btn = $('#cab-setup');
    btn.disabled = true;
    btn.textContent = 'Configurando…';
    try {
      if (!$('#cab-enabled').checked) $('#cab-enabled').checked = true;
      await this.#saveCabinet();
      const res = await api('POST', '/api/cabinet/setup-wled', {});
      this.status = res.cabinet;
      this.#renderWled();
      toast(res.changed ? `WLED configurado: LEDs ${res.start}-${res.start + res.count - 1} → ${res.ip}` : 'O WLED já estava configurado');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Configurar no WLED';
    }
  }
}
