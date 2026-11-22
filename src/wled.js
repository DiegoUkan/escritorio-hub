// Cliente da API JSON do WLED: https://kno.wled.ge/interfaces/json-api/
const TIMEOUT_MS = 2500;

async function request(host, path, body, attempt = 0) {
  const url = `http://${host}${path}`;
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 503 = o WLED está ocupado montando outro JSON; tenta de novo rapidinho
  if (res.status === 503 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    return request(host, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} respondeu ${res.status}`);
  return res.json();
}

export const getJson = (host, path) => request(host, path);
export const getInfoAndState = (host) => request(host, '/json/si');
export const setState = (host, state) => request(host, '/json/state', state);

// Payload do usermod Multi Relay para ligar/desligar um relé
export function relayPayload(relay, on) {
  return { MultiRelay: { relay, on } };
}

export const setRelay = (host, relay, on) => setState(host, relayPayload(relay, on));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SLIDER_MAX = { sx: 255, ix: 255, c1: 255, c2: 255, c3: 31 };

// Converte um comando do hub para o JSON do WLED, aplicando em todos os segmentos.
// cmd: { on, bri, color:[r,g,b], slot (0-2), fx, pal, sx, ix, c1, c2, c3, ps, lor }
export function buildState(cmd, segIds = [0]) {
  const state = {};
  if (typeof cmd.on === 'boolean') state.on = cmd.on;
  if (Number.isFinite(cmd.bri)) state.bri = clamp(Math.round(cmd.bri), 1, 255);
  if (Number.isInteger(cmd.ps)) state.ps = cmd.ps;
  // Ambilight: 0 = mostra as cores que chegam pela rede (HyperHDR), 2 = ignora até o ESP reiniciar
  if ([0, 1, 2].includes(cmd.lor)) state.lor = cmd.lor;

  const seg = {};
  if (Array.isArray(cmd.color) && cmd.color.length === 3) {
    const slot = Number.isInteger(cmd.slot) ? clamp(cmd.slot, 0, 2) : 0;
    const col = [null, null, null];
    col[slot] = cmd.color.map((c) => clamp(Math.round(c), 0, 255));
    seg.col = col.slice(0, slot + 1); // null = não mexe naquela cor
  }
  if (Number.isInteger(cmd.fx)) {
    seg.fx = cmd.fx;
    seg.fxdef = true; // aplica os valores padrão do efeito (velocidade, paleta...), como a interface do WLED
  }
  if (Number.isInteger(cmd.pal)) seg.pal = cmd.pal;
  for (const key of Object.keys(SLIDER_MAX)) {
    if (Number.isFinite(cmd[key])) seg[key] = clamp(Math.round(cmd[key]), 0, SLIDER_MAX[key]);
  }
  if (Object.keys(seg).length) state.seg = segIds.map((id) => ({ id, ...seg }));
  return state;
}

// ---------- Divisão da moldura em segmentos ----------
// "full": um segmento só, com a moldura inteira (o efeito dá a volta na tela toda).
// "sides": um segmento por lado (base, direita, topo, esquerda), e cada lado roda o efeito inteiro.
export const SIDE_NAMES = ['Base', 'Direita', 'Topo', 'Esquerda'];
const FRAME_ORDER = ['bottom', 'right', 'top', 'left'];

// Quantas LEDs a moldura tem (soma dos lados). Depois dela podem vir as LEDs virtuais do gabinete.
export function frameLength(layout) {
  if (layout?.type && layout.type !== 'frame') return 0;
  return FRAME_ORDER.reduce((s, side) => s + Math.max(0, Number(layout?.[side]) || 0), 0);
}

export function frameSides(layout, total) {
  const out = [];
  let start = 0;
  FRAME_ORDER.forEach((side, i) => {
    const n = Math.max(0, Number(layout?.[side]) || 0);
    const stop = Math.min(start + n, total);
    if (stop > start) out.push({ name: SIDE_NAMES[i], start, stop });
    start += n;
  });
  return out;
}

// Segmentos da moldura (os que começam antes do fim dela); o resto é o gabinete
const frameSegs = (segments, len) => (segments ?? []).filter((s) => s.start < len);

// Qual divisão o WLED está usando agora: full, sides ou custom (qualquer outra)
export function frameModeOf(segments, layout, total) {
  const len = Math.min(frameLength(layout) || total, total || Infinity);
  const segs = frameSegs(segments, len);
  if (!segs.length || !len) return 'custom';
  if (segs.length === 1 && segs[0].start === 0 && segs[0].stop === len) return 'full';
  const sides = frameSides(layout, len);
  const same = sides.length === segs.length && sides.every((s, i) => segs[i].start === s.start && segs[i].stop === s.stop);
  return same ? 'sides' : 'custom';
}

// O que passa do segmento principal para os segmentos novos, para todos os lados ficarem iguais
const LOOK_KEYS = ['on', 'bri', 'col', 'fx', 'sx', 'ix', 'pal', 'c1', 'c2', 'c3', 'o1', 'o2', 'o3'];
const lookOf = (seg) => {
  const look = {};
  for (const k of LOOK_KEYS) if (seg?.[k] !== undefined) look[k] = structuredClone(seg[k]);
  return look;
};

// JSON do WLED que redivide a moldura. current = state.seg do WLED agora.
// total = LEDs do WLED; se passar da moldura, o resto vira (ou continua) o segmento Gabinete.
export function frameModeState(mode, layout, total, current = []) {
  const len = Math.min(frameLength(layout) || total, total);
  const wanted = mode === 'full' ? [{ name: 'Moldura', start: 0, stop: len }] : frameSides(layout, len);
  const look = lookOf(current[0]);
  const seg = wanted.map((w, id) => ({ id, start: w.start, stop: w.stop, n: w.name, sel: true, ...(id === 0 ? {} : look) }));
  if (total > len) {
    const cab = (current ?? []).find((s) => s.start >= len);
    seg.push({ id: seg.length, start: len, stop: total, n: CABINET_NAME, sel: true, ...(cab ? lookOf(cab) : look) });
  }
  // segmentos que sobraram são apagados (no WLED, stop 0 remove o segmento)
  const lastId = current.reduce((m, s, i) => Math.max(m, s.id ?? i), -1);
  for (let id = seg.length; id <= lastId; id++) seg.push({ id, stop: 0 });
  return { seg };
}

// ---------- Gabinete: LEDs virtuais depois da moldura ----------
export const CABINET_NAME = 'Gabinete';

// Segmento do gabinete no WLED (o que cobre as LEDs depois da moldura), ou null
export function cabinetSegment(segments, start, total) {
  return (segments ?? []).find((s) => s.start === start && s.stop === total) ?? null;
}

// JSON que cria (ou acerta) o segmento Gabinete, copiando o visual do segmento principal
export function cabinetSegmentState(segments, start, total) {
  const segs = segments ?? [];
  const existing = segs.find((s) => s.start >= start) ?? null;
  const id = existing ? existing.id : segs.reduce((m, s) => Math.max(m, s.id), -1) + 1;
  return { seg: [{ id, start, stop: total, n: CABINET_NAME, sel: true, ...(existing ? {} : lookOf(segs[0])) }] };
}

// Volta o gabinete a seguir a moldura: tira a pintura (frz) e copia o visual do segmento principal
export function cabinetFollowState(segments, cabId) {
  return { seg: [{ id: cabId, frz: false, ...lookOf(segments?.[0]) }] };
}

// Pintura do gabinete: cores LED a LED (na ordem do segmento) no campo "i" do WLED
export function cabinetPaintState(cabId, colors) {
  return { seg: [{ id: cabId, fx: 0, frz: false, i: [0, ...colors] }] };
}

const NET_TYPES = (t) => t >= 80 && t < 96; // saídas de rede do WLED (DDP, E1.31, Art-Net)

// hw.led do /json/cfg com a saída virtual DDP do gabinete: [start, start + len) mandando para ip
export function virtualBusConfig(hwLed, start, len, ip) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) throw new Error(`IP inválido: ${ip}`);
  const ins = (hwLed?.ins ?? []).filter((b) => !(NET_TYPES(b.type) && b.start >= start));
  ins.push({ start, len, pin: octets, order: 0, rev: false, skip: 0, type: 80, ref: false, rgbwm: 0, freq: 0, maxpwr: 0, ledma: 0 });
  const { total, ...rest } = hwLed ?? {};
  return { ...rest, ins };
}

// Saída virtual do gabinete que já existe no WLED, ou null
export function findVirtualBus(hwLed, start) {
  return (hwLed?.ins ?? []).find((b) => NET_TYPES(b.type) && b.start === start) ?? null;
}

export const getConfig = (host) => request(host, '/json/cfg');
export const setConfig = (host, cfg) => request(host, '/json/cfg', cfg);

// Resumo do estado que a página precisa
export function summarize(si) {
  const { info = {}, state = {} } = si ?? {};
  const seg0 = state.seg?.[0] ?? {};
  const colors = [0, 1, 2].map((i) => {
    const c = seg0.col?.[i];
    return Array.isArray(c) ? c.slice(0, 3) : [0, 0, 0];
  });
  return {
    on: !!state.on,
    bri: state.bri ?? 0,
    color: colors[0],
    colors,
    fx: seg0.fx ?? 0,
    pal: seg0.pal ?? 0,
    sx: seg0.sx ?? 128,
    ix: seg0.ix ?? 128,
    c1: seg0.c1 ?? 128,
    c2: seg0.c2 ?? 128,
    c3: seg0.c3 ?? 16,
    ps: state.ps ?? -1,
    segments: (state.seg ?? []).map((s) => ({ id: s.id, name: s.n ?? `Segmento ${s.id}`, start: s.start, stop: s.stop })),
    leds: info.leds?.count ?? 0,
    power: info.leds?.pwr ?? 0,
    maxPower: info.leds?.maxpwr ?? 0,
    version: info.ver ?? '',
    ip: info.ip ?? '',
    deviceName: info.name ?? '',
    live: !!info.live,           // recebendo cores pela rede (ex.: HyperHDR)
    liveMode: info.lm ?? '',
    liveIp: info.lip ?? '',
    lor: state.lor ?? 0,         // 0 = mostra o que chega pela rede, 1/2 = ignora
    signal: info.wifi?.signal ?? null,
    uptime: Number.isFinite(info.uptime) ? info.uptime : null,
  };
}
