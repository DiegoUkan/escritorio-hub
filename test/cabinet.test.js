// Gabinete: geometria do mapa, cópias, ordem dos efeitos, DDP, Ambilight e o segmento no WLED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapePoints, buildLeds, virtualOrder } from '../public/js/cabinet-geom.js';
import { parseDdp, buildDdp, sampleRight, ambilightColors, paintSegmentColors, CabinetEngine } from '../src/cabinet.js';
import { frameLength, frameModeOf, frameModeState, cabinetSegment, cabinetSegmentState, cabinetPaintState, cabinetFollowState, virtualBusConfig, findVirtualBus } from '../src/wled.js';
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../src/config.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const nearPt = (p, q) => {
  near(p[0], q[0]);
  near(p[1], q[1]);
};

test('linha distribui as LEDs do início ao fim (e inverte com rev)', () => {
  const pts = shapePoints({ shape: 'line', pts: [[0, 0], [0, 1]] }, 4, 1);
  assert.deepEqual(pts.map((p) => p[1]), [0.125, 0.375, 0.625, 0.875]);
  const rev = shapePoints({ shape: 'line', pts: [[0, 0], [0, 1]], rev: true }, 4, 1);
  assert.deepEqual(rev.map((p) => p[1]), [0.875, 0.625, 0.375, 0.125]);
});

test('anel começa no ponto da borda, gira no sentido horário e respeita a proporção da foto', () => {
  const ring = shapePoints({ shape: 'ring', pts: [[0.5, 0.5], [0.5, 0.3]] }, 4, 1);
  nearPt(ring[0], [0.5, 0.3]); // começa em cima
  nearPt(ring[1], [0.7, 0.5]); // depois direita
  nearPt(ring[2], [0.5, 0.7]);
  nearPt(ring[3], [0.3, 0.5]);
  const ccw = shapePoints({ shape: 'ring', pts: [[0.5, 0.5], [0.5, 0.3]], rev: true }, 4, 1);
  nearPt(ccw[1], [0.3, 0.5]);
  // foto 2:1: o raio de 0.2 na vertical vira 0.1 na horizontal (continua um círculo na tela)
  const wide = shapePoints({ shape: 'ring', pts: [[0.5, 0.5], [0.5, 0.3]] }, 4, 2);
  nearPt(wide[1], [0.6, 0.5]);
});

test('contorno percorre o retângulo a partir do canto inicial', () => {
  const r = shapePoints({ shape: 'rect', pts: [[0, 0], [1, 1]] }, 8, 1);
  assert.equal(r.length, 8);
  nearPt(r[0], [0.25, 0]); // topo, indo para a direita
  nearPt(r[2], [1, 0.25]); // lateral direita, descendo
  nearPt(r[4], [0.75, 1]); // base, voltando
  nearPt(r[6], [0, 0.75]); // lateral esquerda, subindo
});

test('ponto a ponto usa um ponto por LED e deixa as que faltam sem posição', () => {
  const p = shapePoints({ shape: 'points', pts: [[0.1, 0.2], [0.3, 0.4]] }, 3, 1);
  assert.deepEqual(p, [[0.1, 0.2], [0.3, 0.4], null]);
});

const DEVICES = [
  { id: 0, name: 'ENE DRAM', zones: [{ name: 'DRAM', leds: 2 }] },
  { id: 1, name: 'MSI MYSTIC LIGHT', zones: [{ name: 'JAF', leds: 2 }, { name: 'JARGB 1', leds: 2 }] },
];

test('buildLeds segue a ordem do OpenRGB e junta as cópias de um fan espelhado', () => {
  const zones = [
    { device: 'ENE DRAM', zone: 'DRAM', places: [{ from: 0, to: 2, shape: 'line', pts: [[0.5, 0.1], [0.5, 0.3]] }] },
    // JARGB 1 vai para dois fans (splitter): duas cópias das mesmas 2 LEDs
    { device: 'MSI MYSTIC LIGHT', zone: 'JARGB 1', places: [
      { from: 0, to: 2, shape: 'line', pts: [[0.8, 0.2], [0.8, 0.4]] },
      { from: 0, to: 2, shape: 'line', pts: [[0.8, 0.6], [0.8, 0.8]] },
    ] },
  ];
  const leds = buildLeds(DEVICES, zones, 1);
  assert.equal(leds.length, 6);
  assert.deepEqual(leds.map((l) => [l.device, l.zone, l.index]), [[0, 'DRAM', 0], [0, 'DRAM', 1], [1, 'JAF', 0], [1, 'JAF', 1], [1, 'JARGB 1', 2], [1, 'JARGB 1', 3]]);
  assert.equal(leds[2].mapped, false, 'JAF sem posição');
  assert.equal(leds[4].places.length, 2, 'uma LED, duas posições');
  near(leds[4].v, (0.25 + 0.65) / 2); // posição média das cópias
});

test('buildLeds aceita um trecho só de parte da zona (fans em série)', () => {
  const zones = [{ device: 'MSI MYSTIC LIGHT', zone: 'JAF', places: [{ from: 1, to: 2, shape: 'points', pts: [[0.2, 0.9]] }] }];
  const leds = buildLeds(DEVICES, zones, 1);
  assert.equal(leds[2].mapped, false);
  assert.deepEqual(leds[3].places, [[0.2, 0.9]]);
});

test('virtualOrder ordena de baixo para cima, da esquerda para a direita, em volta ou pelos cabos', () => {
  const leds = [
    { mapped: true, u: 0.5, v: 0.1 }, // topo
    { mapped: true, u: 0.9, v: 0.5 }, // direita
    { mapped: false },
    { mapped: true, u: 0.5, v: 0.9 }, // base
    { mapped: true, u: 0.1, v: 0.5 }, // esquerda
  ];
  assert.deepEqual(virtualOrder(leds, 'up', 1), [3, 4, 1, 0, 2], 'base, meio (da esquerda), topo, sem posição no fim');
  assert.deepEqual(virtualOrder(leds, 'right', 1), [4, 3, 0, 1, 2]);
  assert.deepEqual(virtualOrder(leds, 'around', 1), [3, 4, 0, 1, 2], 'base, esquerda, topo, direita');
  assert.deepEqual(virtualOrder(leds, 'wire', 1), [0, 1, 2, 3, 4]);
});

test('DDP: monta e lê o pacote (com e sem timecode)', () => {
  const p = parseDdp(buildDdp([1, 2, 3, 4, 5, 6], 3, true));
  assert.equal(p.push, true);
  assert.equal(p.offset, 3);
  assert.deepEqual([...p.data], [1, 2, 3, 4, 5, 6]);
  const tc = Buffer.concat([Buffer.from([0x41 | 0x10, 0, 0x0b, 1, 0, 0, 0, 0, 0, 3, 9, 9, 9, 9]), Buffer.from([7, 8, 9])]);
  assert.deepEqual([...parseDdp(tc).data], [7, 8, 9]);
  assert.equal(parseDdp(Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'versão errada');
  assert.equal(parseDdp(Buffer.from([0x41])), null);
});

test('Ambilight: lado direito da moldura na mesma altura, com média das cópias', () => {
  const layout = { bottom: 2, right: 4, top: 2, left: 4 };
  // lateral direita sobe: LEDs 2 (embaixo) a 5 (em cima)
  const frame = new Uint8Array(12 * 3);
  [[2, 0], [3, 80], [4, 160], [5, 240]].forEach(([i, r]) => (frame[i * 3] = r));
  assert.deepEqual(sampleRight(frame, layout, 0), [240, 0, 0], 'topo');
  assert.deepEqual(sampleRight(frame, layout, 1), [0, 0, 0], 'base');
  assert.deepEqual(sampleRight(frame, layout, 0.5), [120, 0, 0], 'meio interpolado');
  const leds = [{ places: [[0.9, 0], [0.9, 1]] }, { places: [] }];
  assert.deepEqual(ambilightColors(leds, frame, layout), [[120, 0, 0], [0, 0, 0]]);
});

test('pintura vai para o WLED na ordem virtual', () => {
  assert.deepEqual(paintSegmentColors(['ff0000', '', '00FF00'], [2, 0, 1]), ['00ff00', 'ff0000', '000000']);
  assert.deepEqual(cabinetPaintState(4, ['ff0000']), { seg: [{ id: 4, fx: 0, frz: false, i: [0, 'ff0000'] }] });
});

const LAYOUT = { type: 'frame', bottom: 34, right: 15, top: 34, left: 15 };

test('moldura ignora e preserva o segmento Gabinete', () => {
  assert.equal(frameLength(LAYOUT), 98);
  assert.equal(frameLength({ type: 'strip' }), 0);
  const withCab = [{ id: 0, start: 0, stop: 98 }, { id: 1, start: 98, stop: 154, n: 'Gabinete' }];
  assert.equal(frameModeOf(withCab, LAYOUT, 154), 'full', 'o gabinete não conta na divisão da moldura');
  // de inteira para 4 lados: o gabinete vira o segmento 4 e fica com o visual que tinha
  const st = frameModeState('sides', LAYOUT, 154, [{ id: 0, start: 0, stop: 98, fx: 9 }, { id: 1, start: 98, stop: 154, fx: 38, pal: 5 }]);
  assert.deepEqual(st.seg.map((s) => [s.id, s.start, s.stop]), [[0, 0, 34], [1, 34, 49], [2, 49, 83], [3, 83, 98], [4, 98, 154]]);
  assert.equal(st.seg[4].n, 'Gabinete');
  assert.equal(st.seg[4].fx, 38);
  assert.equal(st.seg[1].fx, 9);
  // de 4 lados para inteira: o gabinete vira o segmento 1 e os que sobram são apagados
  const sides = [0, 1, 2, 3].map((id) => ({ id, start: [0, 34, 49, 83][id], stop: [34, 49, 83, 98][id] }));
  const full = frameModeState('full', LAYOUT, 154, [...sides, { id: 4, start: 98, stop: 154, fx: 2 }]);
  assert.deepEqual(full.seg.map((s) => [s.id, s.start ?? null, s.stop]), [[0, 0, 98], [1, 98, 154], [2, null, 0], [3, null, 0], [4, null, 0]]);
  assert.equal(full.seg[1].fx, 2);
});

test('segmento Gabinete: acha, cria com o visual da moldura e volta a seguir', () => {
  const segs = [{ id: 0, start: 0, stop: 98, fx: 9, pal: 3 }];
  assert.equal(cabinetSegment(segs, 98, 154), null);
  assert.deepEqual(cabinetSegmentState(segs, 98, 154), { seg: [{ id: 1, start: 98, stop: 154, n: 'Gabinete', sel: true, fx: 9, pal: 3 }] });
  assert.equal(cabinetSegment([...segs, { id: 1, start: 98, stop: 154 }], 98, 154).id, 1);
  assert.deepEqual(cabinetFollowState(segs, 1), { seg: [{ id: 1, frz: false, fx: 9, pal: 3 }] });
});

test('saída virtual DDP no /json/cfg do WLED', () => {
  const hw = { total: 98, maxpwr: 1500, ins: [{ start: 0, len: 98, pin: [13], type: 22 }] };
  const out = virtualBusConfig(hw, 98, 56, '192.168.1.170');
  assert.equal(out.total, undefined, 'o WLED recalcula o total');
  assert.equal(out.maxpwr, 1500);
  assert.deepEqual(out.ins[1], { start: 98, len: 56, pin: [192, 168, 1, 170], order: 0, rev: false, skip: 0, type: 80, ref: false, rgbwm: 0, freq: 0, maxpwr: 0, ledma: 0 });
  // trocar de novo substitui a saída virtual em vez de duplicar
  const again = virtualBusConfig({ ins: out.ins }, 98, 60, '192.168.1.171');
  assert.equal(again.ins.length, 2);
  assert.equal(findVirtualBus({ ins: again.ins }, 98).len, 60);
  assert.throws(() => virtualBusConfig(hw, 98, 56, 'casa'), /IP inválido/);
});

test('validateConfig confere o bloco do gabinete', () => {
  const ok = mergeConfig(DEFAULT_CONFIG, { cabinet: { enabled: true, zones: [{ device: 'X', zone: 'Y', places: [{ from: 0, to: 12, shape: 'ring', pts: [[0.5, 0.5], [0.5, 0.4]] }] }], paint: ['ff0000', ''] } });
  assert.deepEqual(validateConfig(ok), []);
  const bad = mergeConfig(DEFAULT_CONFIG, { cabinet: { mode: 'x', order: 'y', maxFps: 500, zones: [{ device: 'X', zone: 'Y', places: [{ from: 3, to: 1, shape: 'blob', pts: [[9, 9]] }] }], paint: ['red'] } });
  const errs = validateConfig(bad).join(' | ');
  for (const part of ['cabinet.mode', 'cabinet.order', 'cabinet.maxFps', 'shape', 'from/to', 'pts', 'cabinet.paint']) assert.match(errs, new RegExp(part.replace('.', '\\.')));
});

test('CabinetEngine: o Ambilight do gabinete usa o brilho do WLED (a prévia ao vivo vem sem ele)', () => {
  const sent = [];
  const engine = new CabinetEngine({ output: (id, colors) => sent.push([id, colors]) });
  const cfg = mergeConfig(DEFAULT_CONFIG.cabinet, {
    enabled: true,
    aspect: 1,
    zones: [{ device: 'ENE DRAM', zone: 'DRAM', places: [{ from: 0, to: 2, shape: 'line', pts: [[0.5, 0.5], [0.5, 0.5]] }] }],
  });
  engine.configure(cfg, DEVICES);
  clearInterval(engine.timer);
  const layout = { bottom: 1, right: 2, top: 1, left: 2 };
  const frame = new Uint8Array(6 * 3).fill(200);
  engine.setMolduraAmbi(true);
  engine.setMoldura(frame, layout, 51); // brilho 20%
  engine.tick();
  assert.deepEqual(sent.find(([id]) => id === 0)[1], [[40, 40, 40], [40, 40, 40]]);
});

test('CabinetEngine: DDP vira cor por LED física, só manda o que mudou e cede ao Ambilight e ao Acender', () => {
  const sent = [];
  const engine = new CabinetEngine({ output: (id, colors) => sent.push([id, colors]) });
  const cfg = mergeConfig(DEFAULT_CONFIG.cabinet, {
    enabled: true,
    order: 'up',
    aspect: 1,
    zones: [{ device: 'MSI MYSTIC LIGHT', zone: 'JAF', places: [{ from: 0, to: 2, shape: 'line', pts: [[0.5, 0.9], [0.5, 0.1]] }] }],
  });
  engine.configure(cfg, DEVICES);
  clearInterval(engine.timer); // o teste chama tick() na mão
  assert.equal(engine.leds.length, 6);
  // JAF 0 está embaixo (v 0.7), JAF 1 em cima (v 0.3): na ordem "up" elas são os pixels virtuais 0 e 1
  assert.deepEqual(engine.virt.slice(0, 2), [2, 3]);
  const data = new Array(18).fill(0);
  data.splice(0, 6, 10, 20, 30, 40, 50, 60);
  engine.ingest(buildDdp(data));
  engine.tick();
  assert.equal(engine.source, 'wled');
  const msi = sent.find(([id]) => id === 1)[1];
  assert.deepEqual(msi.slice(0, 2), [[10, 20, 30], [40, 50, 60]]);
  const before = sent.length;
  engine.tick();
  assert.equal(sent.length, before, 'nada mudou, nada enviado');

  engine.identify('MSI MYSTIC LIGHT', 'JAF');
  engine.tick();
  assert.equal(engine.source, 'identify');
  assert.deepEqual(sent.at(-1)[1], [[255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0]]);
  engine.ident.until = 0;

  // moldura no Ambilight: o gabinete copia o lado direito (com suavização a partir do primeiro quadro)
  const layout = { bottom: 2, right: 2, top: 2, left: 2 };
  const frame = new Uint8Array(8 * 3);
  frame[2 * 3] = 100; // lateral direita, embaixo
  frame[3 * 3 + 2] = 200; // lateral direita, em cima
  engine.setMoldura(frame, layout);
  engine.setMolduraAmbi(true);
  engine.tick();
  assert.equal(engine.source, 'ambilight');
  const amb = sent.at(-1)[1];
  assert.ok(amb[0][0] > amb[0][2], 'a LED de baixo puxa a cor de baixo');
  assert.ok(amb[1][2] > amb[1][0], 'a LED de cima puxa a cor de cima');

  // com o Ambilight do gabinete desligado e a pintura escolhida, mostra a pintura
  engine.configure({ ...cfg, ambilight: false, mode: 'paint', paint: ['', '', '00ff00', '0000ff', '', ''] }, DEVICES);
  clearInterval(engine.timer);
  engine.tick();
  assert.equal(engine.source, 'paint');
  assert.deepEqual(sent.at(-1)[1].slice(0, 2), [[0, 255, 0], [0, 0, 255]]);
  // a pintura segue o brilho e o liga/desliga do WLED (sem depender do DDP)
  engine.setWledLevel(true, 51);
  engine.tick();
  assert.deepEqual(sent.at(-1)[1].slice(0, 2), [[0, 51, 0], [0, 0, 51]]);
  engine.setWledLevel(false, 255);
  engine.tick();
  assert.deepEqual(sent.at(-1)[1].slice(0, 2), [[0, 0, 0], [0, 0, 0]]);
});
