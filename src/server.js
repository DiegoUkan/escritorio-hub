// Escritório Hub: página web + API que controla os WLED, o OpenRGB e a caixa de som.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import * as wled from './wled.js';
import { checkTcp } from './pc.js';
import { SpeakerLogic } from './speaker.js';
import { OpenRGBBridge } from './openrgb.js';
import { fetchLists } from './wled-lists.js';
import { LiveStream } from './live.js';
import { CabinetEngine, DDP_PORT, paintSegmentColors } from './cabinet.js';

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(ROOT, '..', 'node_modules');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'package.json'), 'utf8')).version;
const LISTS_TTL_MS = 60 * 60 * 1000;

const store = new ConfigStore(DATA_DIR);
const speaker = new SpeakerLogic();
const orgb = new OpenRGBBridge();
const cabinet = new CabinetEngine({
  port: Number(process.env.CABINET_DDP_PORT || DDP_PORT),
  output: (id, colors) => orgb.setLeds(id, colors),
});
cabinet.start();
const IMAGE_FILE = path.join(DATA_DIR, 'cabinet-image.bin');
const IMAGE_TYPE = path.join(DATA_DIR, 'cabinet-image.type');

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
        if (findWled(id)) updateCabinetLive(findWled(id));
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

// ---------- Gabinete ----------
// As LEDs do gabinete ficam depois da moldura no WLED escolhido
const cabinetWled = () => {
  const c = store.get().cabinet;
  return c.enabled ? findWled(c.wled) : null;
};
function cabinetInfo(dev = cabinetWled()) {
  const sum = dev ? live.wled[dev.id] : null;
  const start = dev ? wled.frameLength(dev.layout) : 0;
  const total = sum?.leds ?? 0;
  const seg = sum && total > start ? wled.cabinetSegment(sum.segments, start, total) : null;
  return { dev, sum, start, total, seg };
}

// Moldura no Ambilight: o hub assiste a prévia ao vivo para calcular o gabinete
let unwatchMoldura = null;
let watchingId = null;
let wasAmbi = false;
function updateCabinetLive(dev) {
  const c = store.get().cabinet;
  if (!c.enabled || dev.id !== c.wled) return;
  const sum = live.wled[dev.id];
  const ambi = !!(sum?.online && sum.live && !sum.lor);
  cabinet.setMolduraAmbi(ambi);
  cabinet.setWledLevel(!!sum?.on, sum?.bri ?? 0);
  // o HyperHDR parou (ou foi pausado): o WLED tinha apagado a fita, então a pintura volta para o segmento
  if (wasAmbi && !ambi && c.mode === 'paint') pushPaint();
  wasAmbi = ambi;
  const want = ambi && c.ambilight && dev.layout?.type === 'frame';
  if (want && watchingId !== dev.id) {
    unwatchMoldura?.();
    // state.bri continua valendo no Ambilight (o WLED volta a esse brilho quando a tela começa a chegar)
    unwatchMoldura = streamFor(dev.id).watch((bytes) => cabinet.setMoldura(bytes, findWled(dev.id)?.layout, live.wled[dev.id]?.bri ?? 255));
    watchingId = dev.id;
  } else if (!want && unwatchMoldura) {
    unwatchMoldura();
    unwatchMoldura = null;
    watchingId = null;
  }
}
function stopCabinetLive() {
  unwatchMoldura?.();
  unwatchMoldura = null;
  watchingId = null;
  cabinet.setMolduraAmbi(false);
}

// Pintura: manda as cores LED a LED para o segmento Gabinete do WLED (uma requisição por vez)
let paintBusy = false;
let paintAgain = false;
async function pushPaint() {
  if (paintBusy) {
    paintAgain = true;
    return;
  }
  const c = store.get().cabinet;
  const { dev, seg } = cabinetInfo();
  if (!dev || !seg || c.mode !== 'paint' || !cabinet.virt.length) return;
  paintBusy = true;
  try {
    await wled.setState(dev.host, wled.cabinetPaintState(seg.id, paintSegmentColors(c.paint, cabinet.virt)));
  } catch (err) {
    console.warn(`[gabinete] pintura: ${err.message}`);
  } finally {
    paintBusy = false;
    if (paintAgain) {
      paintAgain = false;
      pushPaint();
    }
  }
}

// Gabinete voltando a seguir a moldura: tira a pintura e copia o efeito do segmento principal
async function followMoldura() {
  const { dev, seg } = cabinetInfo();
  if (!dev || !seg) return;
  const si = await wled.getInfoAndState(dev.host); // o resumo não guarda o visual dos segmentos
  await wled.setState(dev.host, wled.cabinetFollowState(si.state?.seg ?? [], seg.id));
}

// Garante o segmento Gabinete quando o WLED já tem as LEDs virtuais
async function ensureCabinetSegment(dev) {
  const { sum, start, total, seg } = cabinetInfo(dev);
  if (!sum?.online || total <= start || seg) return;
  const si = await wled.getInfoAndState(dev.host);
  await wled.setState(dev.host, wled.cabinetSegmentState(si.state?.seg ?? [], start, total));
  live.wled[dev.id] = { online: true, error: '', ...wled.summarize(await wled.getInfoAndState(dev.host)) };
  console.log(`[gabinete] segmento ${wled.CABINET_NAME} criado (${start}-${total})`);
  if (store.get().cabinet.mode === 'paint') await pushPaint();
}

// IP do hub visto pelo WLED (para a saída DDP). HUB_IP força um valor.
function hubIpFor(host) {
  if (process.env.HUB_IP) return process.env.HUB_IP;
  const h = String(host).split(':')[0];
  if (h.startsWith('127.') || h === 'localhost') return '127.0.0.1';
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  const prefix = /^\d+\.\d+\.\d+\./.exec(h)?.[0];
  return (prefix && addrs.find((a) => a.address.startsWith(prefix))?.address) || addrs[0]?.address || null;
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
      if (await enforceFrameMode(dev, si.state)) {
        console.log(`[moldura] ${dev.id}: divisão "${dev.segmentMode}" reaplicada`);
        if (cabinetWled()?.id === dev.id && store.get().cabinet.mode === 'paint') await pushPaint();
      }
    } catch (err) {
      segWatch.delete(dev.id); // tenta de novo no próximo ciclo
      console.warn(`[moldura] ${dev.id}: ${err.message}`);
    }
  }
  if (cabinetWled()?.id === dev.id) {
    updateCabinetLive(dev);
    try {
      await ensureCabinetSegment(dev);
    } catch (err) {
      console.warn(`[gabinete] ${err.message}`);
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
  syncCabinet();
  live.pc = { online: pcOnline, lastSeen: pcOnline ? new Date().toISOString() : live.pc.lastSeen };
  await applySpeaker(cfg);
  live.updatedAt = new Date().toISOString();
}

// Repassa a configuração e os dispositivos do OpenRGB para o motor do gabinete
let orgbSeq = 0;
function syncCabinet() {
  const c = store.get().cabinet;
  if (orgb.seq !== orgbSeq) {
    orgbSeq = orgb.seq;
    cabinet.invalidate();
  }
  cabinet.configure(c, orgb.connected ? orgb.devices : orgb.known);
  if (!c.enabled) stopCabinetLive();
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
    cabinet: cabinetStatus(),
    favorites: cfg.favorites,
    hub: { version: VERSION },
    updatedAt: live.updatedAt,
  });
});

// Como a página vê o gabinete
function cabinetStatus() {
  const c = store.get().cabinet;
  const info = c.enabled ? cabinetInfo() : { start: 0, total: 0, seg: null };
  const count = cabinet.leds.length;
  let wledState = 'off';
  if (c.enabled) {
    if (!info.dev) wledState = 'no-wled';
    else if (!info.sum?.online) wledState = 'offline';
    else if (info.total <= info.start) wledState = 'missing';
    else if (count && info.total !== info.start + count) wledState = 'mismatch';
    else wledState = 'ok';
  }
  return {
    enabled: c.enabled,
    mode: c.mode,
    ambilight: c.ambilight,
    order: c.order,
    wled: c.wled,
    start: info.start,
    wledLeds: info.total,
    segment: info.seg?.id ?? null,
    wledState,
    devices: orgb.connected ? orgb.devices : orgb.known,
    virt: cabinet.virt,
    ...cabinet.status(),
  };
}

app.get('/api/config', (req, res) => res.json(store.get()));

app.put('/api/config', wrap(async (req, res) => {
  const patch = req.body ?? {};
  // A página de Ajustes não mexe na divisão da moldura (ela é escolhida no Controle): mantém a que já estava
  if (Array.isArray(patch.wled)) {
    const before = new Map(store.get().wled.map((d) => [d.id, d]));
    patch.wled = patch.wled.map((d) => (d && d.segmentMode === undefined && before.get(d.id)?.segmentMode ? { ...d, segmentMode: before.get(d.id).segmentMode } : d));
  }
  const cabBefore = store.get().cabinet;
  const errors = store.update(patch);
  if (errors.length) return res.status(400).json({ errors });
  segWatch.clear(); // o layout pode ter mudado: confere a divisão da moldura no próximo ciclo
  syncCabinet();
  await applyCabinetChange(cabBefore, store.get().cabinet).catch((err) => console.warn(`[gabinete] ${err.message}`));
  clearTimeout(timer);
  loop();
  res.json(store.get());
}));

// Mudou o modo, o mapa ou a ordem: acerta o segmento Gabinete do WLED
async function applyCabinetChange(before, after) {
  if (!after.enabled) return;
  if (after.mode === 'paint') {
    const remap = JSON.stringify([before.zones, before.order]) !== JSON.stringify([after.zones, after.order]);
    if (before.mode !== 'paint' || remap || !before.enabled) await pushPaint();
  } else if (before.mode === 'paint') {
    await followMoldura();
  }
}

// ---------- Gabinete ----------
// Prévia ao vivo do gabinete (cores de cada LED física, na ordem do OpenRGB)
app.get('/api/cabinet/live', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const stop = cabinet.subscribe((hex) => res.write(`data: ${hex}\n\n`));
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    stop();
  });
});

// Acende uma zona (branco) e apaga o resto por alguns segundos, para achar qual fan é qual
app.post('/api/cabinet/identify', (req, res) => {
  const { device, zone } = req.body ?? {};
  if (typeof device !== 'string' || typeof zone !== 'string') return res.status(400).json({ error: 'use { device, zone }' });
  if (!store.get().cabinet.enabled) return res.status(400).json({ error: 'Ative o gabinete em Ajustes primeiro' });
  cabinet.identify(device, zone, 3000);
  res.json({ ok: true });
});

// Pintura: { set: { "<índice da LED>": "rrggbb" } } ou { all: "rrggbb" } ("" apaga)
app.post('/api/cabinet/paint', wrap(async (req, res) => {
  const { set, all } = req.body ?? {};
  const n = cabinet.leds.length;
  if (!n) return res.status(400).json({ error: 'Nenhuma LED do OpenRGB ainda: conecte o OpenRGB' });
  const okHex = (h) => typeof h === 'string' && /^([0-9a-f]{6})?$/i.test(h);
  const paint = Array.from({ length: n }, (_, i) => store.get().cabinet.paint[i] ?? '');
  if (all !== undefined) {
    if (!okHex(all)) return res.status(400).json({ error: 'all deve ser rrggbb' });
    paint.fill(all.toLowerCase());
  }
  for (const [k, h] of Object.entries(set ?? {})) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= n || !okHex(h)) return res.status(400).json({ error: `cor inválida para a LED ${k}` });
    paint[i] = h.toLowerCase();
  }
  const errors = store.update({ cabinet: { paint, mode: 'paint' } });
  if (errors.length) return res.status(400).json({ errors });
  syncCabinet();
  await pushPaint();
  res.json({ ok: true, paint });
}));

// Cria a saída virtual (DDP) no WLED com as LEDs do gabinete depois da moldura
app.post('/api/cabinet/setup-wled', wrap(async (req, res) => {
  const c = store.get().cabinet;
  const dev = findWled(c.wled);
  if (!dev) return res.status(400).json({ error: `WLED "${c.wled}" não encontrado` });
  if (dev.layout?.type !== 'frame') return res.status(400).json({ error: 'O WLED do gabinete precisa do layout de moldura (veja em Ajustes)' });
  const count = Number(req.body?.count) || cabinet.leds.length;
  if (!(count > 0 && count <= 1000)) return res.status(400).json({ error: 'Não sei quantas LEDs o PC tem: conecte o OpenRGB primeiro' });
  const ip = hubIpFor(dev.host);
  if (!ip) return res.status(500).json({ error: 'Não descobri o IP do hub na rede (defina HUB_IP)' });
  const start = wled.frameLength(dev.layout);
  const cfg = await wled.getConfig(dev.host);
  const backup = path.join(DATA_DIR, `wled-${dev.id}-cfg-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(cfg, null, 2));
  const existing = wled.findVirtualBus(cfg.hw?.led, start);
  const same = existing && existing.len === count && existing.type === 80 && (existing.pin ?? []).join('.') === ip;
  if (!same) {
    await wled.setConfig(dev.host, { hw: { led: wled.virtualBusConfig(cfg.hw?.led, start, count, ip) } });
    console.log(`[gabinete] saída virtual no WLED ${dev.id}: LEDs ${start}-${start + count - 1} -> ${ip}:${DDP_PORT} (backup ${path.basename(backup)})`);
  }
  // o WLED reinicia as saídas (às vezes reinicia inteiro): espera ele voltar com o total novo
  let total = 0;
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try {
      const si = await wled.getInfoAndState(dev.host);
      live.wled[dev.id] = { online: true, error: '', ...wled.summarize(si) };
      total = si.info?.leds?.count ?? 0;
      if (total === start + count) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 700));
  }
  if (total !== start + count) {
    return res.status(502).json({ error: `O WLED ainda mostra ${total} LEDs (esperava ${start + count}). Confira em LED Preferences.`, backup: path.basename(backup) });
  }
  segWatch.delete(dev.id); // reaplica a divisão da moldura junto com o segmento Gabinete
  await enforceFrameMode(dev, (await wled.getInfoAndState(dev.host)).state).catch(() => {});
  await ensureCabinetSegment(dev);
  res.json({ ok: true, ip, port: DDP_PORT, start, count, changed: !same, backup: path.basename(backup), cabinet: cabinetStatus() });
}));

// Foto do gabinete (fundo do mapa). ?aspect=largura/altura
app.get('/api/cabinet/image', (req, res) => {
  if (!fs.existsSync(IMAGE_FILE)) return res.status(404).json({ error: 'sem foto' });
  res.setHeader('Content-Type', fs.existsSync(IMAGE_TYPE) ? fs.readFileSync(IMAGE_TYPE, 'utf8') : 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(IMAGE_FILE).pipe(res);
});
app.post('/api/cabinet/image', express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
  const type = req.headers['content-type'] ?? '';
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type) || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Envie uma imagem JPG, PNG, WEBP ou GIF de até 8 MB' });
  }
  const aspect = Number(req.query.aspect);
  if (!(aspect >= 0.2 && aspect <= 5)) return res.status(400).json({ error: 'aspect inválido' });
  fs.writeFileSync(IMAGE_FILE, req.body);
  fs.writeFileSync(IMAGE_TYPE, type);
  const errors = store.update({ cabinet: { image: true, aspect: Math.round(aspect * 10000) / 10000 } });
  if (errors.length) return res.status(400).json({ errors });
  syncCabinet();
  res.json(store.get().cabinet);
});
app.delete('/api/cabinet/image', (req, res) => {
  for (const f of [IMAGE_FILE, IMAGE_TYPE]) fs.rmSync(f, { force: true });
  store.update({ cabinet: { image: false, aspect: null } });
  syncCabinet();
  res.json(store.get().cabinet);
});

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
  let segIds = (live.wled[dev.id]?.segments ?? []).map((s) => s.id);
  // na pintura, os controles da moldura não mexem no segmento Gabinete
  const cab = cabinetWled()?.id === dev.id && store.get().cabinet.mode === 'paint' ? cabinetInfo(dev).seg : null;
  if (cab) segIds = segIds.filter((id) => id !== cab.id);
  const state = wled.buildState(cmd, segIds.length ? segIds : [0]);
  await wled.setState(dev.host, state);
  // brilho e liga/desliga valem na hora para a pintura do gabinete (sem esperar o próximo ciclo)
  const sum = live.wled[dev.id];
  if (sum && (state.on !== undefined || state.bri !== undefined)) {
    if (state.on !== undefined) sum.on = state.on;
    if (state.bri !== undefined) sum.bri = state.bri;
    updateCabinetLive(dev);
  }
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
  // com o gabinete ativo, o PC segue o WLED (as LEDs virtuais); sem ele, pinta o OpenRGB direto
  if (store.get().openrgb.enabled && orgb.connected && !store.get().cabinet.enabled) {
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
  console.log(`Escritório Hub ${VERSION} em http://0.0.0.0:${PORT} (dados em ${DATA_DIR}, gabinete por DDP na UDP ${cabinet.port})`);
  loop();
});
