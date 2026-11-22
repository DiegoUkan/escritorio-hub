// Gabinete de ponta a ponta: WLED falso (com saída virtual DDP) -> hub -> OpenRGB falso.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFakeWled } from './fake-wled.js';
import { startFakeOpenRGB } from './fake-openrgb.js';

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const freeUdp = () => new Promise((r) => { const s = dgram.createSocket('udp4'); s.bind(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function firstSseData(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(/^data: ([0-9a-f]+)$/m);
        if (m) {
          req.destroy();
          resolve(m[1]);
        }
      });
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('sem quadros')), 5000);
  });
}

const DEVICES = [
  { name: 'ENE DRAM', zones: [{ name: 'DRAM', leds: 2 }] },
  { name: 'MSI MYSTIC LIGHT', zones: [{ name: 'JAF', leds: 2 }, { name: 'JARGB 1', leds: 2 }] },
];

test('gabinete: saída virtual no WLED, efeito no PC, pintura, Acender, moldura e Ambilight', async (t) => {
  const ddpPort = await freeUdp();
  const wled = await startFakeWled({ ddpPort });
  const orgb = await startFakeOpenRGB(DEVICES);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cab-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    wled: [{ id: 'monitor', name: 'Monitor', host: `127.0.0.1:${wled.port}` }],
    openrgb: { enabled: true, host: '127.0.0.1', port: orgb.port },
    cabinet: {
      enabled: true,
      zones: [
        { device: 'MSI MYSTIC LIGHT', zone: 'JAF', places: [{ from: 0, to: 2, shape: 'line', pts: [[0.2, 0.8], [0.2, 0.2]] }] },
        // JARGB 1 com dois fans no mesmo splitter: duas cópias
        { device: 'MSI MYSTIC LIGHT', zone: 'JARGB 1', places: [
          { from: 0, to: 2, shape: 'ring', pts: [[0.8, 0.3], [0.8, 0.2]] },
          { from: 0, to: 2, shape: 'ring', pts: [[0.8, 0.7], [0.8, 0.6]] },
        ] },
      ],
    },
    pollSec: 1,
  }));
  const port = await freePort();
  const hub = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, CABINET_DDP_PORT: String(ddpPort) }, stdio: 'inherit' });
  t.after(() => {
    hub.kill();
    wled.close();
    orgb.close();
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (u) => fetch(base + u).then((r) => r.json());
  const send = (method, u, b) => fetch(base + u, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const post = (u, b) => send('POST', u, b);
  const cab = async () => (await get('/api/status')).cabinet;

  // OpenRGB conectado (com as flags novas nas zonas), WLED ainda sem as LEDs virtuais
  let st = await waitFor(async () => {
    const c = await cab();
    return c.count === 6 && c.wledState === 'missing' ? c : null;
  });
  assert.equal(st.start, 98);
  assert.equal(st.mapped, 4, 'JAF (2) + JARGB 1 (2, com cópias)');
  assert.deepEqual(st.devices.map((d) => d.zones.map((z) => z.name)), [['DRAM'], ['JAF', 'JARGB 1']]);

  // Configurar no WLED: saída DDP 98-103 para o hub e segmento Gabinete
  const setup = await post('/api/cabinet/setup-wled', {});
  assert.equal(setup.status, 200, JSON.stringify(setup));
  assert.equal(setup.start, 98);
  assert.equal(setup.count, 6);
  assert.equal(setup.ip, '127.0.0.1');
  assert.ok(fs.existsSync(path.join(dataDir, setup.backup)), 'backup do cfg do WLED');
  assert.deepEqual(wled.hwLed.ins.map((b) => [b.start, b.len, b.type]), [[0, 98, 22], [98, 6, 80]]);
  assert.deepEqual(wled.hwLed.ins[1].pin, [127, 0, 0, 1]);
  assert.deepEqual(wled.state.seg.at(-1).n, 'Gabinete');
  assert.deepEqual([wled.state.seg.at(-1).start, wled.state.seg.at(-1).stop], [98, 104]);
  st = await waitFor(async () => {
    const c = await cab();
    return c.wledState === 'ok' && c.segment != null ? c : null;
  });
  // rodar de novo não duplica a saída
  assert.equal((await post('/api/cabinet/setup-wled', {})).changed, false);
  assert.equal(wled.hwLed.ins.length, 2);

  // Efeito da moldura chega no PC: cor sólida em todos os segmentos -> DDP -> OpenRGB
  await post('/api/wled/monitor', { on: true, bri: 255, fx: 0, color: [200, 100, 50] });
  await waitFor(() => JSON.stringify(orgb.updates[1]) === JSON.stringify(Array(4).fill([200, 100, 50])));
  await waitFor(() => JSON.stringify(orgb.updates[0]) === JSON.stringify(Array(2).fill([200, 100, 50])));
  assert.ok(orgb.modes.includes(1), 'pôs a MSI no modo Direct');
  st = await cab();
  assert.equal(st.source, 'wled');
  assert.ok(st.ddpSeen, 'já recebeu DDP do WLED');
  // brilho do WLED vale para o gabinete
  await post('/api/wled/monitor', { bri: 128 });
  await waitFor(() => orgb.updates[1]?.[0]?.[0] === 100);

  // prévia ao vivo do gabinete: 6 LEDs x 3 bytes
  assert.equal((await firstSseData(`${base}/api/cabinet/live`)).length, 6 * 6);

  // o comando "tudo" não pinta o OpenRGB direto (o PC segue o WLED)
  const before = orgb.counts[1];
  await post('/api/all', { color: [10, 20, 30] });
  await waitFor(() => orgb.updates[1]?.[0]?.join() === [5, 10, 15].join()); // 10,20,30 com brilho 128
  assert.ok(orgb.counts[1] > before);

  // Pintura: LED 2 (JAF 0) verde; os controles da moldura param de mexer no gabinete
  await post('/api/wled/monitor', { bri: 255 });
  const paint = await post('/api/cabinet/paint', { set: { 2: '00ff00', 4: 'ff0000' } });
  assert.equal(paint.status, 200);
  assert.equal((await get('/api/config')).cabinet.mode, 'paint');
  const cabSeg = () => wled.state.seg.find((s) => s.start === 98);
  assert.equal(cabSeg().frz, true);
  await waitFor(() => orgb.updates[1]?.[0]?.join() === '0,255,0' && orgb.updates[1]?.[2]?.join() === '255,0,0');
  await post('/api/wled/monitor', { color: [1, 2, 3] });
  assert.notDeepEqual(cabSeg().col[0], [1, 2, 3], 'na pintura, o gabinete não segue a cor da moldura');
  assert.deepEqual(wled.state.seg[0].col[0], [1, 2, 3]);
  const badPaint = await post('/api/cabinet/paint', { set: { 99: 'ff0000' } });
  assert.equal(badPaint.status, 400);

  // Voltar a seguir a moldura
  await send('PUT', '/api/config', { cabinet: { mode: 'follow' } });
  assert.equal(cabSeg().frz, false);
  assert.deepEqual(cabSeg().col[0], [1, 2, 3], 'copiou o visual da moldura');

  // Acender: JAF branco, o resto apagado
  await post('/api/cabinet/identify', { device: 'MSI MYSTIC LIGHT', zone: 'JAF' });
  await waitFor(() => JSON.stringify(orgb.updates[1]) === JSON.stringify([[255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0]]));
  assert.equal((await cab()).source, 'identify');

  // Moldura em 4 lados e inteira de novo: o segmento Gabinete continua no fim
  let dev = await post('/api/wled/monitor/frame', { mode: 'sides' });
  assert.equal(dev.frameMode, 'sides');
  assert.deepEqual(wled.state.seg.map((s) => [s.start, s.stop]), [[0, 34], [34, 49], [49, 83], [83, 98], [98, 104]]);
  dev = await post('/api/wled/monitor/frame', { mode: 'full' });
  assert.equal(dev.frameMode, 'full');
  assert.deepEqual(wled.state.seg.map((s) => [s.start, s.stop]), [[0, 98], [98, 104]]);
  // o ESP reinicia sem o segmento Gabinete: o hub cria de novo
  wled.reboot();
  await waitFor(() => wled.state.seg.some((s) => s.start === 98 && s.stop === 104) && wled.state.seg.length === 2);

  // Ambilight: HyperHDR chegando e lor 0 -> o gabinete copia o lado direito da prévia
  wled.setLive({ lm: 'UDP', lip: '192.168.1.166' });
  st = await waitFor(async () => {
    const c = await cab();
    return c.source === 'ambilight' ? c : null;
  });
  assert.equal(st.ambilightActive, true);
  // desligando o Ambilight do gabinete, ele volta para o WLED
  await send('PUT', '/api/config', { cabinet: { ambilight: false } });
  await waitFor(async () => (await cab()).source !== 'ambilight');
  wled.setLive(null);

  // Foto do gabinete
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const up = await fetch(`${base}/api/cabinet/image?aspect=0.75`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png }).then((r) => r.json());
  assert.equal(up.image, true);
  assert.equal(up.aspect, 0.75);
  const img = await fetch(`${base}/api/cabinet/image`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/cabinet/image?aspect=1`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 400);
  await fetch(`${base}/api/cabinet/image`, { method: 'DELETE' });
  assert.equal((await fetch(`${base}/api/cabinet/image`)).status, 404);
  assert.equal((await get('/api/config')).cabinet.aspect, null);
});
