// Monta as listas de efeitos e paletas de um WLED a partir de
// /json/eff (nomes), /json/fxdata (metadados), /json/pal (nomes) e /json/palx (cores das paletas).
// As regras seguem a interface oficial do WLED 0.15 (wled00/data/index.js).

const SLIDER_KEYS = ['sx', 'ix', 'c1', 'c2', 'c3'];
const SLIDER_DEFAULTS = ['Velocidade', 'Intensidade', 'Ajuste 1', 'Ajuste 2', 'Ajuste 3'];
const SLIDER_MAX = { sx: 255, ix: 255, c1: 255, c2: 255, c3: 31 };
const COLOR_DEFAULTS = ['Principal', 'Fundo', 'Extra'];

// Tradução dos rótulos mais comuns que vêm do firmware (em inglês)
const LABELS_PT = {
  speed: 'Velocidade', intensity: 'Intensidade', size: 'Tamanho', width: 'Largura', trail: 'Rastro',
  fade: 'Esmaecer', 'fade speed': 'Velocidade do fade', 'fade rate': 'Taxa do fade', delay: 'Atraso',
  saturation: 'Saturação', hue: 'Matiz', scale: 'Escala', spread: 'Espalhamento', frequency: 'Frequência',
  cooling: 'Resfriamento', 'spark rate': 'Faíscas', density: 'Densidade', zones: 'Zonas', blur: 'Desfoque',
  shift: 'Deslocamento', rotation: 'Rotação', phase: 'Fase', gravity: 'Gravidade', angle: 'Ângulo',
  'wave width': 'Largura da onda', 'twinkle rate': 'Taxa de brilho', 'dot size': 'Tamanho do ponto',
  'time [min]': 'Tempo (min)', smoothness: 'Suavidade', amount: 'Quantidade', overlay: 'Sobrepor',
  'shift speed': 'Velocidade de deslocamento', 'blend speed': 'Velocidade da mistura',
  'repeat speed': 'Velocidade de repetição', 'dissolve speed': 'Velocidade de dissolução',
  'hue speed': 'Velocidade da cor', 'effect speed': 'Velocidade do efeito', boost: 'Reforço',
  fx: 'Efeito', bg: 'Fundo', fg: 'Frente', 'glitter color': 'Cor do brilho', 'fg size': 'Tamanho da frente',
  'bg size': 'Tamanho do fundo', '# of balls': 'Nº de bolas', '# of drips': 'Nº de gotas',
  '# of shadows': 'Nº de sombras', 'wave #': 'Nº de ondas', '1': 'Cor 1', '2': 'Cor 2', '3': 'Cor 3',
  l: 'Esquerda', r: 'Direita',
};

export function translateLabel(label) {
  return LABELS_PT[String(label).trim().toLowerCase()] ?? label;
}

// Interpreta o texto de metadados de um efeito ("@" já removido pelo firmware)
export function parseFxData(fd = '', id = -1) {
  const defined = fd.length > 0;
  const pars = fd === '' ? [] : fd.split(';');
  const sl = !pars[0] ? [] : pars[0].split(',');
  const co = !pars[1] ? [] : pars[1].split(',');
  const pa = !pars[2] ? [] : pars[2].split(',');
  let flags = pars.length < 4 || pars[3] === '' ? '1' : pars[3];

  const sliders = SLIDER_KEYS.map((key, i) => {
    const raw = sl[i];
    const shown = (!defined && i < 2) || (raw !== undefined && raw !== '');
    if (!shown) return null;
    const label = raw && raw !== '!' ? translateLabel(raw.split('=')[0]) : SLIDER_DEFAULTS[i];
    return { key, label, max: SLIDER_MAX[key] };
  }).filter(Boolean);

  const colors = [0, 1, 2].map((i) => {
    const raw = co[i];
    if (raw !== undefined && raw !== '') return { slot: i, label: raw === '!' ? COLOR_DEFAULTS[i] : translateLabel(raw) };
    if (!defined) return { slot: i, label: `Cor ${i + 1}` };
    return null;
  }).filter(Boolean);

  const palette = !defined || (pa.length > 0 && pa[0] !== '' && Number.isNaN(Number(pa[0].split('=')[0])));

  const meta = { sliders, colors, palette, flags };
  if (id === 0) {
    // Solid: só a cor principal, sem ajustes nem paleta
    meta.sliders = [];
    meta.colors = [{ slot: 0, label: COLOR_DEFAULTS[0] }];
    meta.palette = false;
    meta.flags = flags = '';
  }
  meta.is2D = flags.includes('2') && !flags.includes('1');
  meta.audio = flags.includes('v') || flags.includes('f');
  return meta;
}

export function buildEffects(names = [], fxdata = []) {
  const list = [];
  names.forEach((name, id) => {
    if (!name || name.includes('RSVD') || name === '-') return;
    const meta = parseFxData(fxdata[id] ?? '', id);
    if (meta.is2D) return; // as fitas são 1D: efeitos só de matriz 2D ficam de fora
    list.push({ id, name, ...meta });
  });
  return list;
}

// Converte uma paleta do /json/palx em paradas de gradiente
export function paletteStops(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const list = entries.length === 1 ? [entries[0], Array.isArray(entries[0]) ? [255, ...entries[0].slice(1)] : entries[0]] : entries;
  return list.map((e, j) => {
    if (Array.isArray(e)) return { pos: Math.round((e[0] / 255) * 100), rgb: [e[1], e[2], e[3]] };
    return { pos: Math.round((j / list.length) * 100), ref: e }; // "c1", "c2", "c3" ou "r" (aleatória)
  });
}

export function buildPalettes(names = [], palx = {}) {
  const ids = new Set([...names.keys(), ...Object.keys(palx).map(Number)]);
  return [...ids]
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      name: names[id] ?? `Personalizada ${256 - id}`,
      stops: paletteStops(palx[id]),
    }))
    .filter((p) => p.name && p.name !== '-');
}

// Busca tudo do dispositivo (as cores das paletas vêm paginadas, 8 por página no ESP32)
export async function fetchLists(host, getJson) {
  const [effNames, fxdata, palNames] = await Promise.all([
    getJson(host, '/json/eff'),
    getJson(host, '/json/fxdata').catch(() => []),
    getJson(host, '/json/pal'),
  ]);
  const palx = {};
  try {
    const first = await getJson(host, '/json/palx?page=0');
    Object.assign(palx, first.p);
    for (let page = 1; page <= (first.m ?? 0); page++) {
      const res = await getJson(host, `/json/palx?page=${page}`);
      Object.assign(palx, res.p);
    }
  } catch {
    // sem as cores das paletas a lista continua funcionando, só sem a prévia
  }
  return { effects: buildEffects(effNames, fxdata), palettes: buildPalettes(palNames, palx) };
}
