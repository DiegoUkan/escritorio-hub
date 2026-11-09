// Sobe o hub contra um WLED falso e confere o fluxo de ponta a ponta.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function fakeWled() {
  const state = { on: false, bri: 50, seg: [{ id: 0, n: 'Base', start: 0, stop: 34, col: [[0, 0, 0]], fx: 0, pal: 0, sx: 128 }, { id: 1, n: 'Topo', start: 34, stop: 98, col: [[0, 0, 0]], fx: 0, pal: 0, sx: 128 }] };
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/json/si') return res.end(JSON.stringify({ info: { ver: '0.15.5', leds: { count: 98 } }, state }));
      if (req.url === '/json/eff') return res.end(JSON.stringify(['Solid', 'Blink']));
      if (req.url === '/json/pal') return res.end(JSON.stringify(['Default']));
      if (req.url === '/json/state' && req.method === 'POST') {
        const p = JSON.parse(body);
        posts.push(p);
        if ('on' in p) state.on = p.on;
        if ('bri' in p) state.bri = p.bri;
        for (const s of p.seg ?? []) Object.assign(state.seg.find((x) => x.id === s.id), s);
        return res.end(JSON.stringify({ success: true }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, posts, state })));
}

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function waitFor(fn, ms = 5000) {
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

test('hub controla WLED e caixa de som', async (t) => {
  const wled = await fakeWled();
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
    wled.server.close();
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
  assert.ok(wled.posts.some((p) => p.MultiRelay?.on === true), 'ligou o relé porque o PC está online');

  await post('/api/all', { on: true, color: [10, 20, 30], bri: 120 });
  assert.equal(wled.state.on, true);
  assert.equal(wled.state.bri, 120);
  assert.deepEqual(wled.state.seg.map((s) => s.col[0]), [[10, 20, 30], [10, 20, 30]]);

  const sp = await post('/api/speaker', { mode: 'off' });
  assert.equal(sp.on, false);
  assert.deepEqual(wled.posts.at(-1), { MultiRelay: { relay: 0, on: false } });

  const lists = await get('/api/wled/monitor/lists');
  assert.deepEqual(lists.effects, ['Solid', 'Blink']);

  const html = await fetch(base + '/').then((r) => r.text());
  assert.match(html, /Escritório/);
});
