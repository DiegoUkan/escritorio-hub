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
// cmd: { on, bri, color:[r,g,b], slot (0-2), fx, pal, sx, ix, c1, c2, c3, ps }
export function buildState(cmd, segIds = [0]) {
  const state = {};
  if (typeof cmd.on === 'boolean') state.on = cmd.on;
  if (Number.isFinite(cmd.bri)) state.bri = clamp(Math.round(cmd.bri), 1, 255);
  if (Number.isInteger(cmd.ps)) state.ps = cmd.ps;

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
    live: !!info.live,
    signal: info.wifi?.signal ?? null,
  };
}
