// WLED falso para testes e para ver a interface sem hardware.
// Usa as listas reais do WLED 0.15.5 (test/fixtures) e anima as LEDs com a paleta escolhida.
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/wled-0.15.5.json', import.meta.url), 'utf8'));
const PER_PAGE = 8;

function samplePalette(entries, colors, t) {
  const stops = entries.map((e, j) => {
    if (Array.isArray(e)) return [e[0] / 255, e.slice(1)];
    const c = e === 'r' ? [[255, 0, 80], [0, 200, 255], [255, 180, 0], [120, 0, 255]][j % 4] : colors[Number(e[1]) - 1];
    return [j / entries.length, c];
  });
  if (stops.length === 1) stops.push([1, stops[0][1]]);
  t = ((t % 1) + 1) % 1;
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t >= p0 && t <= p1) {
      const k = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      return c0.map((v, n) => Math.round(v + (c1[n] - v) * k));
    }
  }
  return stops.at(-1)[1];
}

const newSegment = (id, start, stop, n) => ({ id, n, start, stop, col: [[255, 170, 90], [0, 0, 0], [0, 0, 0]], fx: 0, pal: 0, sx: 128, ix: 128, c1: 128, c2: 128, c3: 16 });

// Preset de boot do WLED da mesa: um segmento por lado da moldura
const bootSegments = () => [newSegment(0, 0, 34, 'Base'), newSegment(1, 34, 49, 'Direita'), newSegment(2, 49, 83, 'Topo'), newSegment(3, 83, 98, 'Esquerda')];

export function startFakeWled({ leds = 98, port = 0 } = {}) {
  const state = { on: true, bri: 80, ps: 1, lor: 0, seg: bootSegments() };
  let bootAt = Date.now();
  let uptimeBase = 100;
  let live = null; // stream de cores chegando pela rede (ex.: { lm: 'DDP', lip: '192.168.1.50' })
  const info = () => ({
    ver: FIX.version, name: 'Escritorio Monitor', ip: '127.0.0.1',
    live: !!live, lm: live?.lm ?? '', lip: live?.lip ?? '',
    leds: { count: leds, pwr: 1260, maxpwr: 2000 }, wifi: { signal: 82 },
    uptime: Math.floor((Date.now() - bootAt) / 1000) + uptimeBase,
  });
  const posts = [];
  const relays = { 0: false };

  // Como o WLED: cada segmento roda o efeito do começo ao fim do seu próprio trecho
  const frame = (t) => {
    const buf = Buffer.alloc(2 + leds * 3);
    buf[0] = 0x4c;
    buf[1] = 1;
    // Ambilight: com stream chegando e lor 0, o WLED mostra as cores da tela e ignora os segmentos
    if (live && state.lor === 0) {
      for (let i = 0; i < leds; i++) {
        const c = samplePalette(FIX.palx['11'], [], i / leds / 3 + t * 0.02);
        buf.set(c.map((v) => Math.round(v * 0.7)), 2 + i * 3);
      }
      return buf;
    }
    for (const s of state.seg) {
      const len = s.stop - s.start;
      for (let i = s.start; i < s.stop; i++) {
        let c = [0, 0, 0];
        if (state.on) {
          if (s.fx === 0) c = s.col[0];
          else c = samplePalette(FIX.palx[String(s.pal)] ?? FIX.palx['11'], s.col, (i - s.start) / len + t * (0.05 + s.sx / 1200));
        }
        buf[2 + i * 3] = c[0];
        buf[3 + i * 3] = c[1];
        buf[4 + i * 3] = c[2];
      }
    }
    return buf;
  };

  // Atualiza os segmentos como o WLED 0.15: id novo cria no fim da lista, stop 0 apaga
  const applySegments = (updates) => {
    for (const u of updates) {
      let s = state.seg.find((x) => x.id === u.id);
      if (!s) {
        if (!(u.stop > 0)) continue;
        s = newSegment(state.seg.length, 0, leds);
        state.seg.push(s);
      }
      const { col, fxdef, id, ...rest } = u;
      Object.assign(s, rest);
      (col ?? []).forEach((c, i) => {
        if (Array.isArray(c)) s.col[i] = [...c];
      });
    }
    state.seg = state.seg.filter((s) => s.stop > s.start).map((s, i) => ({ ...s, id: i }));
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (v) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(v));
      };
      switch (url.pathname) {
        case '/json/si':
          return json({ state, info: info() });
        case '/json/eff':
          return json(FIX.eff);
        case '/json/fxdata':
          return json(FIX.fxdata);
        case '/json/pal':
          return json(FIX.pal);
        case '/json/palx': {
          const max = Math.ceil(FIX.pal.length / PER_PAGE) - 1;
          const page = Math.min(Number(url.searchParams.get('page') || 0), max);
          const p = {};
          for (let i = page * PER_PAGE; i < Math.min(FIX.pal.length, (page + 1) * PER_PAGE); i++) p[i] = FIX.palx[String(i)];
          return json({ m: max, p });
        }
        case '/json/state': {
          if (req.method !== 'POST') return json(state);
          const p = JSON.parse(body || '{}');
          posts.push(p);
          if ('on' in p) state.on = p.on;
          if ('bri' in p) state.bri = p.bri;
          if ('lor' in p) state.lor = p.lor;
          if (p.MultiRelay) relays[p.MultiRelay.relay] = p.MultiRelay.on;
          applySegments(p.seg ?? []);
          return json({ success: true });
        }
        default:
          res.statusCode = 404;
          return res.end('{}');
      }
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ state, info: info() }));
    let timer = null;
    const t0 = Date.now();
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if ('lv' in msg) {
        clearInterval(timer);
        timer = msg.lv ? setInterval(() => ws.send(frame((Date.now() - t0) / 1000)), 40) : null;
      }
    });
    ws.on('close', () => clearInterval(timer));
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        state,
        posts,
        relays,
        wss,
        // simula o ESP reiniciando: volta com o preset de boot (4 lados) e o uptime zerado
        // simula o HyperHDR começando (ou parando, com null) a mandar as cores da tela
        setLive: (v) => (live = v),
        reboot: () => {
          state.seg = bootSegments();
          state.lor = 0; // o "ignorar até reiniciar" (lor 2) some quando o ESP reinicia
          bootAt = Date.now();
          uptimeBase = 0;
        },
        close: () => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.close();
        },
      }),
    ),
  );
}

// node test/fake-wled.js 9911 → sobe um WLED falso para testar a interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 9911);
  startFakeWled({ port }).then((w) => {
    if (process.argv.includes('--live')) w.setLive({ lm: 'DDP', lip: '192.168.1.50' });
    console.log(`WLED falso em http://127.0.0.1:${w.port}`);
  });
}
