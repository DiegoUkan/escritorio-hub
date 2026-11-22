// Configuração do hub, salva em DATA_DIR/config.json (volume do Docker).
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  // Dispositivos com WLED (ESP32). "host" pode ser IP ou nome .local
  // layout: como as LEDs estão montadas, para a prévia ao vivo.
  //   frame = moldura de monitor começando no canto inferior esquerdo:
  //           base (esq->dir), lateral direita (sobe), topo (dir->esq), lateral esquerda (desce)
  //   strip = fita reta
  // segmentMode (só moldura, opcional): full = um segmento com a moldura inteira, sides = um por lado.
  //   Escolhido no Controle; o hub reaplica quando o WLED liga ou reinicia.
  wled: [
    { id: 'monitor', name: 'Monitor', host: '192.168.1.251', layout: { type: 'frame', bottom: 34, right: 15, top: 34, left: 15 } },
  ],
  // PC gamer: o hub tenta abrir uma conexão TCP nessa porta para saber se está ligado.
  // 445 (compartilhamento do Windows) costuma estar aberta. Use IP fixo (reserva no roteador).
  pc: { name: 'PC Gamer', host: '', port: 445 },
  // Caixa de som ligada num relé do WLED (usermod Multi Relay)
  speaker: {
    enabled: true,
    mode: 'auto',        // auto | on | off
    wled: 'monitor',     // id do WLED que tem o relé
    relay: 0,            // índice do relé no Multi Relay
    offDelaySec: 60,     // espera o PC ficar offline esse tempo antes de desligar
  },
  // OpenRGB no PC (servidor SDK ligado, porta padrão 6742)
  openrgb: { enabled: false, host: '', port: 6742 },
  // Gabinete: as LEDs do OpenRGB viram LEDs virtuais no fim da fita do WLED (saída DDP para o hub)
  cabinet: {
    enabled: false,
    wled: 'monitor',     // WLED que tem a saída virtual (as LEDs do gabinete vêm depois da moldura)
    mode: 'follow',      // follow = segue o efeito da moldura, paint = pintura LED a LED
    ambilight: true,     // com a moldura no Ambilight, o gabinete copia o lado direito da tela
    order: 'up',         // ordem dos efeitos: up, right, around ou wire (ordem dos cabos)
    maxFps: 30,          // limite de quadros por segundo mandados ao OpenRGB
    aspect: null,        // proporção da imagem de fundo (null = desenho padrão)
    image: false,        // true = usa a foto enviada (DATA_DIR/cabinet-image)
    // zonas do OpenRGB posicionadas no mapa: [{ device, zone, places: [{ from, to, shape, pts, rev }] }]
    zones: [],
    paint: [],           // cor de cada LED física na pintura ('rrggbb' ou '')
  },
  pollSec: 5,
  // Efeitos e paletas favoritos (pelo nome), mostrados no topo das listas
  favorites: {
    effects: ['Solid', 'Breathe', 'Rainbow', 'Colorloop', 'Aurora', 'Pacifica', 'Fire 2012', 'Candle'],
    palettes: ['Default', 'Party', 'Sunset', 'Ocean', 'Aurora', 'Lava'],
  },
};

const FRAME_SIDES = ['bottom', 'right', 'top', 'left'];

// Completa campos que configurações antigas não tinham (ex.: layout das LEDs)
export function normalizeConfig(cfg) {
  const out = structuredClone(cfg);
  out.wled = (out.wled ?? []).map((d) => {
    if (d?.layout?.type) return d;
    // a moldura do monitor do escritório é conhecida; outros dispositivos começam como fita reta
    const layout = d?.id === 'monitor' ? structuredClone(DEFAULT_CONFIG.wled[0].layout) : { type: 'strip' };
    return { ...d, layout };
  });
  out.favorites = {
    effects: Array.isArray(out.favorites?.effects) ? out.favorites.effects : [...DEFAULT_CONFIG.favorites.effects],
    palettes: Array.isArray(out.favorites?.palettes) ? out.favorites.palettes : [...DEFAULT_CONFIG.favorites.palettes],
  };
  return out;
}

export function mergeConfig(base, patch) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.wled)) errors.push('wled deve ser uma lista');
  else {
    const ids = new Set();
    cfg.wled.forEach((d, i) => {
      if (!d || typeof d.id !== 'string' || !/^[a-z0-9_-]+$/i.test(d.id)) errors.push(`wled[${i}].id inválido (use letras, números, - ou _)`);
      else if (ids.has(d.id)) errors.push(`wled[${i}].id repetido: ${d.id}`);
      else ids.add(d.id);
      if (!d || typeof d.host !== 'string' || !d.host.trim()) errors.push(`wled[${i}].host vazio`);
      const lay = d?.layout;
      if (lay && !['frame', 'strip'].includes(lay.type)) errors.push(`wled[${i}].layout.type deve ser frame ou strip`);
      if (lay?.type === 'frame') {
        for (const side of FRAME_SIDES) {
          const n = Number(lay[side]);
          if (!Number.isInteger(n) || n < 0 || n > 1000) errors.push(`wled[${i}].layout.${side} inválido`);
        }
      }
      // divisão da moldura escolhida no Controle: full (moldura inteira) ou sides (4 lados)
      if (d?.segmentMode != null && !['full', 'sides'].includes(d.segmentMode)) errors.push(`wled[${i}].segmentMode deve ser full ou sides`);
    });
  }
  if (!['auto', 'on', 'off'].includes(cfg.speaker?.mode)) errors.push('speaker.mode deve ser auto, on ou off');
  const port = Number(cfg.pc?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('pc.port inválida');
  for (const kind of ['effects', 'palettes']) {
    const list = cfg.favorites?.[kind];
    if (list !== undefined && (!Array.isArray(list) || list.some((n) => typeof n !== 'string'))) errors.push(`favorites.${kind} deve ser uma lista de nomes`);
  }
  const poll = Number(cfg.pollSec);
  if (!(poll >= 1 && poll <= 300)) errors.push('pollSec deve estar entre 1 e 300');
  errors.push(...validateCabinet(cfg.cabinet));
  return errors;
}

const SHAPES = ['line', 'ring', 'rect', 'points'];
const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && n >= -0.5 && n <= 1.5);

function validateCabinet(c) {
  if (c === undefined) return [];
  const errors = [];
  if (typeof c !== 'object' || !c) return ['cabinet inválido'];
  if (typeof c.enabled !== 'boolean') errors.push('cabinet.enabled deve ser true ou false');
  if (typeof c.wled !== 'string') errors.push('cabinet.wled deve ser o id de um WLED');
  if (!['follow', 'paint'].includes(c.mode)) errors.push('cabinet.mode deve ser follow ou paint');
  if (typeof c.ambilight !== 'boolean') errors.push('cabinet.ambilight deve ser true ou false');
  if (!['up', 'right', 'around', 'wire'].includes(c.order)) errors.push('cabinet.order deve ser up, right, around ou wire');
  const fps = Number(c.maxFps);
  if (!(fps >= 5 && fps <= 60)) errors.push('cabinet.maxFps deve estar entre 5 e 60');
  if (c.aspect !== null && !(Number(c.aspect) >= 0.2 && Number(c.aspect) <= 5)) errors.push('cabinet.aspect inválido');
  if (!Array.isArray(c.zones)) errors.push('cabinet.zones deve ser uma lista');
  else {
    c.zones.forEach((z, i) => {
      if (typeof z?.device !== 'string' || typeof z?.zone !== 'string') errors.push(`cabinet.zones[${i}] precisa de device e zone`);
      if (!Array.isArray(z?.places)) return errors.push(`cabinet.zones[${i}].places deve ser uma lista`);
      if (z.places.length > 64) errors.push(`cabinet.zones[${i}]: trechos demais`);
      z.places.forEach((p, k) => {
        const at = `cabinet.zones[${i}].places[${k}]`;
        if (!SHAPES.includes(p?.shape)) errors.push(`${at}.shape deve ser ${SHAPES.join(', ')}`);
        if (!Number.isInteger(p?.from) || !Number.isInteger(p?.to) || p.from < 0 || p.to <= p.from || p.to > 2000) errors.push(`${at}: from/to inválidos`);
        if (!Array.isArray(p?.pts) || p.pts.length > 2000 || !p.pts.every(isPt)) errors.push(`${at}.pts inválido`);
      });
    });
  }
  if (!Array.isArray(c.paint) || c.paint.length > 4000 || c.paint.some((h) => typeof h !== 'string' || !/^([0-9a-f]{6})?$/i.test(h))) {
    errors.push("cabinet.paint deve ser uma lista de cores 'rrggbb'");
  }
  return errors;
}

export class ConfigStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.config = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return normalizeConfig(mergeConfig(DEFAULT_CONFIG, raw));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[config] arquivo inválido, usando padrão:', err.message);
      const cfg = structuredClone(DEFAULT_CONFIG);
      this.#write(cfg);
      return cfg;
    }
  }

  #write(cfg) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get() {
    return this.config;
  }

  // Aplica um patch parcial; retorna lista de erros (vazia se salvou)
  update(patch) {
    const next = normalizeConfig(mergeConfig(this.config, patch));
    const errors = validateConfig(next);
    if (errors.length) return errors;
    this.#write(next);
    this.config = next;
    return [];
  }
}
