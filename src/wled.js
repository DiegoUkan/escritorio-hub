// Cliente da API JSON do WLED: https://kno.wled.ge/interfaces/json-api/
const TIMEOUT_MS = 2500;

async function request(host, path, body) {
  const url = `http://${host}${path}`;
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} respondeu ${res.status}`);
  return res.json();
}

export const getInfoAndState = (host) => request(host, '/json/si');
export const getEffects = (host) => request(host, '/json/eff');
export const getPalettes = (host) => request(host, '/json/pal');
export const setState = (host, state) => request(host, '/json/state', state);

// Payload do usermod Multi Relay para ligar/desligar um relé
export function relayPayload(relay, on) {
  return { MultiRelay: { relay, on } };
}

export const setRelay = (host, relay, on) => setState(host, relayPayload(relay, on));

// Converte um comando simples do hub (on, bri, color, fx, pal) para o JSON do WLED,
// aplicando cor/efeito/paleta em todos os segmentos existentes.
export function buildState(cmd, segIds = [0]) {
  const state = {};
  if (typeof cmd.on === 'boolean') state.on = cmd.on;
  if (Number.isFinite(cmd.bri)) state.bri = clamp(Math.round(cmd.bri), 1, 255);
  if (Number.isInteger(cmd.ps)) state.ps = cmd.ps;

  const seg = {};
  if (Array.isArray(cmd.color) && cmd.color.length === 3) seg.col = [cmd.color.map((c) => clamp(Math.round(c), 0, 255))];
  if (Number.isInteger(cmd.fx)) seg.fx = cmd.fx;
  if (Number.isInteger(cmd.pal)) seg.pal = cmd.pal;
  if (Number.isFinite(cmd.sx)) seg.sx = clamp(Math.round(cmd.sx), 0, 255);
  if (Object.keys(seg).length) state.seg = segIds.map((id) => ({ id, ...seg }));
  return state;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Resumo do estado que a página precisa
export function summarize(si) {
  const { info = {}, state = {} } = si ?? {};
  const seg0 = state.seg?.[0] ?? {};
  return {
    on: !!state.on,
    bri: state.bri ?? 0,
    color: seg0.col?.[0]?.slice(0, 3) ?? [255, 255, 255],
    fx: seg0.fx ?? 0,
    pal: seg0.pal ?? 0,
    sx: seg0.sx ?? 128,
    segments: (state.seg ?? []).map((s) => ({ id: s.id, name: s.n ?? `Segmento ${s.id}`, start: s.start, stop: s.stop })),
    leds: info.leds?.count ?? 0,
    version: info.ver ?? '',
    ip: info.ip ?? '',
    deviceName: info.name ?? '',
    live: !!info.live,
  };
}
