// Sobe o hub contra um WLED falso e confere o fluxo de ponta a ponta.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFakeWled } from './fake-wled.js';

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function waitFor(fn, ms = 6000) {
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

// lê o primeiro quadro de um Server-Sent Events
function firstSseData(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(/^data: ([0-9a-f]+)$/m);
        if (m) {
          req.destroy();
          resolve({ type: res.headers['content-type'], data: m[1] });
        }
      });
    });
    req.on('error', reject);
    setTimeout(() => reject(new Error('sem quadros')), 5000);
  });
}

test('hub controla WLED, caixa de som, listas, favoritos e prévia ao vivo', async (t) => {
  const wled = await startFakeWled();
  const pcSock = net.createServer().listen(0, '127.0.0.1'); // "PC ligado"
  await new Promise((r) => pcSock.once('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    wled: [{ id: 'monitor', name: 'Monitor', host: `127.0.0.1:${wled.port}` }],
    pc: { host: '127.0.0.1', port: pcSock.address().port },
    pollSec: 1,
  }));
  const port = await freePort();
  const hub = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: 'inherit' });
  t.after(() => {
    hub.kill();
    wled.close();
    pcSock.close();
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (u) => fetch(base + u).then((r) => r.json());
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

  const status = await waitFor(async () => {
    const s = await get('/api/status');
    return s.wled[0].online && s.pc.online && s.speaker.on ? s : null;
  });
  assert.equal(status.wled[0].leds, 98);
  assert.deepEqual(status.wled[0].layout, { type: 'frame', bottom: 34, right: 15, top: 34, left: 15 }, 'config antiga ganha o layout da moldura');
  assert.ok(status.favorites.effects.includes('Aurora'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(status.hub.version, pkg.version, 'a página mostra a versão do hub');
  assert.equal(wled.relays[0], true, 'ligou o relé porque o PC está online');

  // cor, brilho e efeito em todos os segmentos
  await post('/api/all', { on: true, color: [10, 20, 30], bri: 120 });
  assert.equal(wled.state.bri, 120);
  assert.deepEqual(wled.state.seg.map((s) => s.col[0]), Array(4).fill([10, 20, 30]));
  await post('/api/wled/monitor', { color: [1, 2, 3], slot: 1 });
  assert.deepEqual(wled.state.seg[0].col.slice(0, 2), [[10, 20, 30], [1, 2, 3]], 'slot 1 muda só a cor de fundo');
  const res = await post('/api/wled/monitor', { fx: 38, ix: 200 });
  assert.equal(res.fx, 38);
  assert.equal(res.ix, 200);
  assert.equal(wled.posts.at(-1).seg[0].fxdef, true);
  const quick = wled.posts.length;
  await post('/api/wled/monitor?quick=1', { bri: 50 });
  assert.equal(wled.state.bri, 50);
  assert.equal(wled.posts.length, quick + 1);

  // caixa de som manual
  const sp = await post('/api/speaker', { mode: 'off' });
  assert.equal(sp.on, false);
  assert.equal(wled.relays[0], false);

  // listas com metadados e cores das paletas
  const lists = await get('/api/wled/monitor/lists');
  assert.ok(lists.effects.length > 100);
  const aurora = lists.effects.find((e) => e.name === 'Aurora');
  assert.equal(aurora.palette, true);
  assert.ok(lists.palettes.find((p) => p.name === 'Sunset').stops.length > 1);

  // favoritos
  let favs = await post('/api/favorites', { kind: 'effects', name: 'Meteor', fav: true });
  assert.equal(favs.effects.at(-1), 'Meteor');
  favs = await post('/api/favorites', { kind: 'effects', name: 'Solid', fav: false });
  assert.ok(!favs.effects.includes('Solid'));
  const bad = await fetch(base + '/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"x"}' });
  assert.equal(bad.status, 400);

  // moldura inteira: um segmento só, com o efeito do segmento principal
  await post('/api/wled/monitor', { fx: 9, pal: 11 });
  let dev = await post('/api/wled/monitor/frame', { mode: 'full' });
  assert.equal(dev.frameMode, 'full');
  assert.deepEqual(wled.state.seg.map((s) => [s.start, s.stop, s.fx]), [[0, 98, 9]]);
  assert.equal((await get('/api/status')).wled[0].frameMode, 'full');
  // ao salvar os Ajustes, a escolha da moldura continua
  const cfgNow = await get('/api/config');
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wled: cfgNow.wled.map(({ segmentMode, ...d }) => d) }) });
  assert.equal((await get('/api/config')).wled[0].segmentMode, 'full');
  // o ESP reinicia com o preset de boot (4 lados): o hub junta de novo sozinho
  wled.reboot();
  await waitFor(() => wled.state.seg.length === 1);
  // 4 lados de novo, cada lado com o mesmo efeito
  await post('/api/wled/monitor', { fx: 9 }); // o preset de boot trouxe outro efeito
  dev = await post('/api/wled/monitor/frame', { mode: 'sides' });
  assert.equal(dev.frameMode, 'sides');
  assert.deepEqual(wled.state.seg.map((s) => [s.n, s.start, s.stop, s.fx]), [['Base', 0, 34, 9], ['Direita', 34, 49, 9], ['Topo', 49, 83, 9], ['Esquerda', 83, 98, 9]]);
  assert.equal((await fetch(base + '/api/wled/monitor/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"x"}' })).status, 400);

  // Ambilight: o HyperHDR manda as cores da tela; o hub mostra e deixa pausar (lor 2) e voltar (lor 0)
  assert.equal((await get('/api/status')).wled[0].live, false);
  wled.setLive({ lm: 'DDP', lip: '192.168.1.50' });
  const amb = await waitFor(async () => {
    const s = (await get('/api/status')).wled[0];
    return s.live ? s : null;
  });
  assert.equal(amb.liveMode, 'DDP');
  assert.equal(amb.liveIp, '192.168.1.50');
  assert.equal(amb.lor, 0);
  dev = await post('/api/wled/monitor', { lor: 2 });
  assert.equal(wled.state.lor, 2, 'o WLED passa a ignorar a tela');
  assert.equal(dev.lor, 2);
  assert.equal(wled.posts.at(-1).seg, undefined, 'pausar não mexe nos segmentos');
  dev = await post('/api/wled/monitor', { lor: 0 });
  assert.equal(wled.state.lor, 0);
  await post('/api/wled/monitor', { lor: 7 });
  assert.equal(wled.state.lor, 0, 'valor inválido é ignorado');
  wled.setLive(null);

  // prévia ao vivo via SSE (98 LEDs x 3 bytes = 588 dígitos hex)
  const sse = await firstSseData(`${base}/api/wled/monitor/live`);
  assert.match(sse.type, /text\/event-stream/);
  assert.equal(sse.data.length, 98 * 6);

  // página e arquivos estáticos
  const html = await fetch(base + '/').then((r) => r.text());
  assert.match(html, /ESCRITÓRIO/);
  for (const asset of ['/js/app.js', '/js/guide.js', '/guide.html', '/vendor/iro.min.js', '/fonts/chakra/chakra-petch-latin-600-normal.woff2', '/fonts/inter/inter-latin-wght-normal.woff2']) {
    assert.equal((await fetch(base + asset)).status, 200, asset);
  }
});
