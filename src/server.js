// Escritório Hub: página web + API que controla os WLED, o OpenRGB e a caixa de som.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import * as wled from './wled.js';
import { checkTcp } from './pc.js';
import { SpeakerLogic } from './speaker.js';
import { OpenRGBBridge } from './openrgb.js';
import { fetchLists } from './wled-lists.js';
import { LiveStream } from './live.js';

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(ROOT, '..', 'node_modules');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'package.json'), 'utf8')).version;
const LISTS_TTL_MS = 60 * 60 * 1000;

const store = new ConfigStore(DATA_DIR);
const speaker = new SpeakerLogic();
const orgb = new OpenRGBBridge();

// Estado em memória, atualizado pelo ciclo de polling
const live = {
  wled: {},          // id -> { online, error, ...summary }
  pc: { online: false, lastSeen: null },
  speaker: { on: false, error: '' },
  updatedAt: null,
};

const findWled = (id) => store.get().wled.find((d) => d.id === id);

// Prévia ao vivo: um websocket por WLED, compartilhado por todas as páginas abertas
const streams = new Map(); // id -> LiveStream
function streamFor(id) {
  let s = streams.get(id);
  if (!s) {
    s = new LiveStream(
      () => findWled(id)?.host,
      (si) => {
        live.wled[id] = { online: true, error: '', ...wled.summarize(si) };
      },
    );
    streams.set(id, s);
  }
  return s;
}

// Efeitos e paletas mudam pouco: guarda por dispositivo + versão do firmware
const listsCache = new Map(); // id -> { key, at, data }
async function getLists(dev, refresh = false) {
  const key = `${dev.host}|${live.wled[dev.id]?.version ?? ''}`;
  const hit = listsCache.get(dev.id);
  if (!refresh && hit && hit.key === key && Date.now() - hit.at < LISTS_TTL_MS) return hit.data;
  const data = await fetchLists(dev.host, wled.getJson);
  listsCache.set(dev.id, { key, at: Date.now(), data });
  return data;
}

// Divisão da moldura (inteira ou 4 lados) escolhida no Controle. O WLED liga com a divisão do
// preset de boot, então o hub reaplica a escolha quando ele volta a responder ou reinicia.
const segWatch = new Map(); // id -> { ok, uptime } da última leitura do polling

async function enforceFrameMode(dev, wledState) {
  const sum = live.wled[dev.id];
  if (!dev.segmentMode || dev.layout?.type !== 'frame' || !sum?.leds) return false;
  if (wled.frameModeOf(sum.segments, dev.layout, sum.leds) === dev.segmentMode) return false;
  await wled.setState(dev.host, wled.frameModeState(dev.segmentMode, dev.layout, sum.leds, wledState?.seg ?? []));
  live.wled[dev.id] = { online: true, error: '', ...wled.summarize(await wled.getInfoAndState(dev.host)) };
  return true;
}

async function pollWled(dev) {
  let si;
  try {
    si = await wled.getInfoAndState(dev.host);
  } catch (err) {
    const reason = err.name === 'TimeoutError' || err.message === 'fetch failed' ? 'sem resposta' : err.message;
    live.wled[dev.id] = { ...(live.wled[dev.id] ?? {}), online: false, error: reason };
    segWatch.set(dev.id, { ok: false, uptime: 0 });
    return;
  }
  const sum = wled.summarize(si);
  live.wled[dev.id] = { online: true, error: '', ...sum };
  const prev = segWatch.get(dev.id);
  const rebooted = prev?.ok && sum.uptime != null && sum.uptime < prev.uptime;
  segWatch.set(dev.id, { ok: true, uptime: sum.uptime ?? 0 });
  if (!prev?.ok || rebooted) {
    try {
      if (await enforceFrameMode(dev, si.state)) console.log(`[moldura] ${dev.id}: divisão "${dev.segmentMode}" reaplicada`);
    } catch (err) {
      segWatch.delete(dev.id); // tenta de novo no próximo ciclo
      console.warn(`[moldura] ${dev.id}: ${err.message}`);
    }
  }
}

// Como a página vê cada WLED
function deviceStatus(d) {
  const l = live.wled[d.id] ?? {};
  const frameMode = d.layout?.type === 'frame' && l.online ? wled.frameModeOf(l.segments, d.layout, l.leds) : null;
  return { online: false, ...l, id: d.id, name: d.name || d.id, host: d.host, layout: d.layout, segmentMode: d.segmentMode ?? null, frameMode };
}

async function applySpeaker(cfg) {
  const sp = cfg.speaker;
  if (!sp.enabled) return;
  const desired = speaker.update({ mode: sp.mode, pcOnline: live.pc.online, offDelaySec: sp.offDelaySec });
  const dev = findWled(sp.wled);
  if (!dev) {
    live.speaker = { on: false, error: `WLED "${sp.wled}" não encontrado` };
    return;
  }
  // Reenvia o estado a cada ciclo: se o ESP reiniciar, ele volta ao estado certo.
  try {
    await wled.setRelay(dev.host, sp.relay, desired);
    live.speaker = { on: desired, error: '' };
  } catch (err) {
    live.speaker = { on: live.speaker.on, error: err.message };
  }
}

async function tick() {
  const cfg = store.get();
  // remove dispositivos que saíram da configuração
  for (const id of Object.keys(live.wled)) if (!findWled(id)) delete live.wled[id];
  for (const [id, s] of streams) {
    if (!findWled(id)) {
      s.shutdown();
      streams.delete(id);
    }
  }

  const [, pcOnline] = await Promise.all([
    Promise.all(cfg.wled.map(pollWled)),
    checkTcp(cfg.pc.host, Number(cfg.pc.port)),
    orgb.sync(cfg.openrgb),
  ]);
  live.pc = { online: pcOnline, lastSeen: pcOnline ? new Date().toISOString() : live.pc.lastSeen };
  await applySpeaker(cfg);
  live.updatedAt = new Date().toISOString();
}

let timer;
async function loop() {
  try {
    await tick();
  } catch (err) {
    console.error('[loop]', err);
  }
  timer = setTimeout(loop, store.get().pollSec * 1000);
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(ROOT, '..', 'public')));
app.use('/vendor/iro.min.js', express.static(path.join(MODULES, '@jaames', 'iro', 'dist', 'iro.min.js'), { maxAge: '7d' }));
app.use('/fonts/chakra', express.static(path.join(MODULES, '@fontsource', 'chakra-petch', 'files'), { maxAge: '30d' }));
app.use('/fonts/inter', express.static(path.join(MODULES, '@fontsource-variable', 'inter', 'files'), { maxAge: '30d' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(502).json({ error: err.message }));

app.get('/api/status', (req, res) => {
  const cfg = store.get();
  res.json({
    wled: cfg.wled.map(deviceStatus),
    pc: { name: cfg.pc.name, configured: !!cfg.pc.host, ...live.pc },
    speaker: { enabled: cfg.speaker.enabled, mode: cfg.speaker.mode, ...live.speaker },
    openrgb: { enabled: cfg.openrgb.enabled, ...orgb.status() },
    favorites: cfg.favorites,
    hub: { version: VERSION },
    updatedAt: live.updatedAt,
  });
});

app.get('/api/config', (req, res) => res.json(store.get()));

app.put('/api/config', wrap(async (req, res) => {
  const patch = req.body ?? {};
  // A página de Ajustes não mexe na divisão da moldura (ela é escolhida no Controle): mantém a que já estava
  if (Array.isArray(patch.wled)) {
    const before = new Map(store.get().wled.map((d) => [d.id, d]));
    patch.wled = patch.wled.map((d) => (d && d.segmentMode === undefined && before.get(d.id)?.segmentMode ? { ...d, segmentMode: before.get(d.id).segmentMode } : d));
  }
  const errors = store.update(patch);
  if (errors.length) return res.status(400).json({ errors });
  segWatch.clear(); // o layout pode ter mudado: confere a divisão da moldura no próximo ciclo
  clearTimeout(timer);
  loop();
  res.json(store.get());
}));

// Efeitos (com os ajustes de cada um) e paletas (com as cores) de um WLED
app.get('/api/wled/:id/lists', wrap(async (req, res) => {
  const dev = findWled(req.params.id);
  if (!dev) return res.status(404).json({ error: 'WLED não encontrado' });
  res.json(await getLists(dev, req.query.refresh === '1'));
}));

// Prévia ao vivo das LEDs (Server-Sent Events, um quadro RGB em hex por mensagem)
app.get('/api/wled/:id/live', (req, res) => {
  const dev = findWled(req.params.id);
  if (!dev) return res.status(404).json({ error: 'WLED não encontrado' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const stream = streamFor(dev.id);
  stream.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    stream.remove(res);
  });
});

// Marca/desmarca um efeito ou paleta como favorito: { kind: "effects"|"palettes", name, fav }
app.post('/api/favorites', wrap(async (req, res) => {
  const { kind, name, fav } = req.body ?? {};
  if (!['effects', 'palettes'].includes(kind) || typeof name !== 'string' || !name) {
    return res.status(400).json({ error: 'use { kind: "effects"|"palettes", name, fav }' });
  }
  const current = store.get().favorites[kind].filter((n) => n !== name);
  if (fav) current.push(name);
  const errors = store.update({ favorites: { [kind]: current } });
  if (errors.length) return res.status(400).json({ errors });
  res.json(store.get().favorites);
}));

// quick = comando no meio de um arraste (cor, brilho): não relê o estado, para não sobrecarregar o ESP
async function sendToWled(dev, cmd, quick = false) {
  const segIds = (live.wled[dev.id]?.segments ?? []).map((s) => s.id);
  const state = wled.buildState(cmd, segIds.length ? segIds : [0]);
  await wled.setState(dev.host, state);
  if (!quick) await pollWled(dev);
}

// Comando para um WLED: { on, bri, color:[r,g,b], slot, fx, pal, sx, ix, c1, c2, c3, ps, lor }
app.post('/api/wled/:id', wrap(async (req, res) => {
  const dev = findWled(req.params.id);
  if (!dev) return res.status(404).json({ error: 'WLED não encontrado' });
  await sendToWled(dev, req.body ?? {}, req.query.quick === '1');
  res.json(deviceStatus(dev));
}));

// Junta os 4 lados numa moldura inteira (o efeito dá a volta na tela) ou separa de novo: { mode: "full" | "sides" }
app.post('/api/wled/:id/frame', wrap(async (req, res) => {
  const dev = findWled(req.params.id);
  if (!dev) return res.status(404).json({ error: 'WLED não encontrado' });
  const mode = req.body?.mode;
  if (!['full', 'sides'].includes(mode)) return res.status(400).json({ error: 'mode deve ser full ou sides' });
  if (dev.layout?.type !== 'frame') return res.status(400).json({ error: 'Só funciona em WLED com layout de moldura (veja em Ajustes)' });
  const errors = store.update({ wled: store.get().wled.map((d) => (d.id === dev.id ? { ...d, segmentMode: mode } : d)) });
  if (errors.length) return res.status(400).json({ errors });
  // se o WLED estiver offline, a escolha fica salva e é aplicada quando ele voltar
  const si = await wled.getInfoAndState(dev.host);
  live.wled[dev.id] = { online: true, error: '', ...wled.summarize(si) };
  await enforceFrameMode(findWled(dev.id), si.state);
  res.json(deviceStatus(findWled(dev.id)));
}));

// Comando para tudo ao mesmo tempo (todos os WLED + cor no OpenRGB)
app.post('/api/all', wrap(async (req, res) => {
  const cmd = req.body ?? {};
  const quick = req.query.quick === '1';
  const results = await Promise.allSettled(store.get().wled.map((d) => sendToWled(d, cmd, quick)));
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (store.get().openrgb.enabled && orgb.connected) {
    try {
      if (cmd.on === false) await orgb.setColor([0, 0, 0]);
      else if (Array.isArray(cmd.color) && !cmd.slot) await orgb.setColor(cmd.color);
    } catch (err) {
      failed.push(`OpenRGB: ${err.message}`);
    }
  }
  res.json({ ok: failed.length === 0, failed });
}));

app.post('/api/speaker', wrap(async (req, res) => {
  const mode = req.body?.mode;
  const errors = store.update({ speaker: { mode } });
  if (errors.length) return res.status(400).json({ errors });
  await applySpeaker(store.get());
  res.json({ mode, ...live.speaker });
}));

app.post('/api/openrgb/color', wrap(async (req, res) => {
  const { color, device } = req.body ?? {};
  if (!Array.isArray(color) || color.length !== 3) return res.status(400).json({ error: 'color deve ser [r,g,b]' });
  const n = await orgb.setColor(color, device === undefined ? undefined : Number(device));
  res.json({ ok: true, devices: n });
}));

app.post('/api/openrgb/profile', wrap(async (req, res) => {
  const name = req.body?.name;
  if (typeof name !== 'string' || !name) return res.status(400).json({ error: 'name obrigatório' });
  orgb.loadProfile(name);
  res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Escritório Hub ${VERSION} em http://0.0.0.0:${PORT} (dados em ${DATA_DIR})`);
  loop();
});
