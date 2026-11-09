// Escritório Hub: página web + API que controla os WLED, o OpenRGB e a caixa de som.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import * as wled from './wled.js';
import { checkTcp } from './pc.js';
import { SpeakerLogic } from './speaker.js';
import { OpenRGBBridge } from './openrgb.js';

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const ROOT = path.dirname(fileURLToPath(import.meta.url));

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

async function pollWled(dev) {
  try {
    const si = await wled.getInfoAndState(dev.host);
    live.wled[dev.id] = { online: true, error: '', ...wled.summarize(si) };
  } catch (err) {
    const reason = err.name === 'TimeoutError' || err.message === 'fetch failed' ? 'sem resposta' : err.message;
    live.wled[dev.id] = { ...(live.wled[dev.id] ?? {}), online: false, error: reason };
  }
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

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(502).json({ error: err.message }));

app.get('/api/status', (req, res) => {
  const cfg = store.get();
  res.json({
    wled: cfg.wled.map((d) => ({ online: false, ...live.wled[d.id], id: d.id, name: d.name || d.id, host: d.host })),
    pc: { name: cfg.pc.name, configured: !!cfg.pc.host, ...live.pc },
    speaker: { enabled: cfg.speaker.enabled, mode: cfg.speaker.mode, ...live.speaker },
    openrgb: { enabled: cfg.openrgb.enabled, ...orgb.status() },
    updatedAt: live.updatedAt,
  });
});

app.get('/api/config', (req, res) => res.json(store.get()));

app.put('/api/config', wrap(async (req, res) => {
  const errors = store.update(req.body);
  if (errors.length) return res.status(400).json({ errors });
  clearTimeout(timer);
  loop();
  res.json(store.get());
}));

// Efeitos e paletas de um WLED (para os menus)
app.get('/api/wled/:id/lists', wrap(async (req, res) => {
  const dev = findWled(req.params.id);
  if (!dev) return res.status(404).json({ error: 'WLED não encontrado' });
  const [effects, palettes] = await Promise.all([wled.getEffects(dev.host), wled.getPalettes(dev.host)]);
  res.json({ effects, palettes });
}));

async function sendToWled(dev, cmd) {
  const segIds = (live.wled[dev.id]?.segments ?? []).map((s) => s.id);
  const state = wled.buildState(cmd, segIds.length ? segIds : [0]);
  await wled.setState(dev.host, state);
  await pollWled(dev);
}

// Comando para um WLED: { on, bri, color:[r,g,b], fx, pal, sx, ps }
app.post('/api/wled/:id', wrap(async (req, res) => {
  const dev = findWled(req.params.id);
  if (!dev) return res.status(404).json({ error: 'WLED não encontrado' });
  await sendToWled(dev, req.body ?? {});
  res.json(live.wled[dev.id]);
}));

// Comando para tudo ao mesmo tempo (todos os WLED + cor no OpenRGB)
app.post('/api/all', wrap(async (req, res) => {
  const cmd = req.body ?? {};
  const results = await Promise.allSettled(store.get().wled.map((d) => sendToWled(d, cmd)));
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (store.get().openrgb.enabled && orgb.connected) {
    try {
      if (cmd.on === false) await orgb.setColor([0, 0, 0]);
      else if (Array.isArray(cmd.color)) await orgb.setColor(cmd.color);
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
  console.log(`Escritório Hub em http://0.0.0.0:${PORT} (dados em ${DATA_DIR})`);
  loop();
});
