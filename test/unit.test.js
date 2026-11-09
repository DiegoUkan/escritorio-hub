import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_CONFIG, mergeConfig, normalizeConfig, validateConfig } from '../src/config.js';
import { buildState, frameModeOf, frameModeState, frameSides, relayPayload, summarize } from '../src/wled.js';
import { buildEffects, buildPalettes, paletteStops, parseFxData } from '../src/wled-lists.js';
import { decodeLiveFrame } from '../src/live.js';
import { SpeakerLogic } from '../src/speaker.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/wled-0.15.5.json', import.meta.url), 'utf8'));

test('mergeConfig mescla objetos e substitui listas', () => {
  const out = mergeConfig(DEFAULT_CONFIG, { pc: { host: '10.0.0.2' }, wled: [{ id: 'a', name: 'A', host: 'x' }] });
  assert.equal(out.pc.host, '10.0.0.2');
  assert.equal(out.pc.port, 445);
  assert.deepEqual(out.wled, [{ id: 'a', name: 'A', host: 'x' }]);
  assert.equal(DEFAULT_CONFIG.pc.host, '', 'não altera o padrão');
});

test('normalizeConfig completa layout e favoritos de configurações antigas', () => {
  const old = { ...structuredClone(DEFAULT_CONFIG), wled: [{ id: 'monitor', name: 'Monitor', host: 'x' }, { id: 'pc', name: 'PC', host: 'y' }] };
  delete old.favorites;
  const cfg = normalizeConfig(old);
  assert.deepEqual(cfg.wled[0].layout, { type: 'frame', bottom: 34, right: 15, top: 34, left: 15 });
  assert.deepEqual(cfg.wled[1].layout, { type: 'strip' });
  assert.ok(cfg.favorites.effects.includes('Solid'));
});

test('validateConfig acusa erros', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  const bad = mergeConfig(DEFAULT_CONFIG, { wled: [{ id: 'a b', host: '', layout: { type: 'frame', bottom: -1, right: 1, top: 1, left: 1 } }], speaker: { mode: 'x' } });
  assert.equal(validateConfig(bad).length, 4);
});

test('buildState aplica cor em todos os segmentos e respeita o slot', () => {
  assert.deepEqual(buildState({ on: true, bri: 300, color: [255, 0, 10] }, [0, 1]), {
    on: true,
    bri: 255,
    seg: [
      { id: 0, col: [[255, 0, 10]] },
      { id: 1, col: [[255, 0, 10]] },
    ],
  });
  // cor de fundo (slot 1) não mexe na principal
  assert.deepEqual(buildState({ color: [1, 2, 3], slot: 1 }).seg[0].col, [null, [1, 2, 3]]);
  // trocar efeito pede os valores padrão dele
  assert.deepEqual(buildState({ fx: 9 }).seg[0], { id: 0, fx: 9, fxdef: true });
  assert.deepEqual(buildState({ c3: 99, ix: 10 }).seg[0], { id: 0, ix: 10, c3: 31 });
  assert.deepEqual(buildState({ on: false }), { on: false });
});

test('moldura inteira ou 4 lados: segmentos do WLED', () => {
  const layout = { type: 'frame', bottom: 34, right: 15, top: 34, left: 15 };
  const sides = frameSides(layout, 98);
  assert.deepEqual(sides.map((s) => [s.name, s.start, s.stop]), [['Base', 0, 34], ['Direita', 34, 49], ['Topo', 49, 83], ['Esquerda', 83, 98]]);
  assert.deepEqual(frameSides({ ...layout, right: 0 }, 98).map((s) => s.name), ['Base', 'Topo', 'Esquerda'], 'lado sem LEDs não vira segmento');
  assert.equal(frameModeOf(sides, layout, 98), 'sides');
  assert.equal(frameModeOf([{ id: 0, start: 0, stop: 98 }], layout, 98), 'full');
  assert.equal(frameModeOf([{ id: 0, start: 0, stop: 50 }, { id: 1, start: 50, stop: 98 }], layout, 98), 'custom');

  const look = { on: true, bri: 255, col: [[1, 2, 3], [0, 0, 0], [0, 0, 0]], fx: 9, sx: 200, ix: 90, pal: 11, c1: 1, c2: 2, c3: 3 };
  const fourSides = sides.map((s, id) => ({ id, start: s.start, stop: s.stop, ...look }));
  const full = frameModeState('full', layout, 98, fourSides);
  assert.deepEqual(full.seg[0], { id: 0, start: 0, stop: 98, n: 'Moldura', sel: true }, 'o segmento 0 cresce e mantém o efeito');
  assert.deepEqual(full.seg.slice(1), [{ id: 1, stop: 0 }, { id: 2, stop: 0 }, { id: 3, stop: 0 }], 'os outros lados são apagados');

  const back = frameModeState('sides', layout, 98, [{ id: 0, start: 0, stop: 98, ...look }]);
  assert.equal(back.seg.length, 4);
  assert.deepEqual(back.seg.map((s) => [s.n, s.start, s.stop]), [['Base', 0, 34], ['Direita', 34, 49], ['Topo', 49, 83], ['Esquerda', 83, 98]]);
  for (const s of back.seg.slice(1)) {
    assert.equal(s.fx, 9, 'lados novos copiam o efeito do principal');
    assert.equal(s.pal, 11);
    assert.deepEqual(s.col, look.col);
  }
});

test('relayPayload do Multi Relay', () => {
  assert.deepEqual(relayPayload(0, true), { MultiRelay: { relay: 0, on: true } });
});

test('summarize lê /json/si', () => {
  const s = summarize({
    info: { ver: '0.15.5', leds: { count: 98 }, ip: '1.2.3.4', name: 'X' },
    state: { on: true, bri: 80, seg: [{ id: 0, n: 'Base', start: 0, stop: 34, col: [[1, 2, 3, 0], [4, 5, 6]], fx: 5, pal: 2, sx: 10, ix: 20 }] },
  });
  assert.equal(s.leds, 98);
  assert.deepEqual(s.color, [1, 2, 3]);
  assert.deepEqual(s.colors, [[1, 2, 3], [4, 5, 6], [0, 0, 0]]);
  assert.equal(s.ix, 20);
  assert.equal(s.segments[0].name, 'Base');
});

test('parseFxData segue as regras da interface do WLED', () => {
  // Breathe: "!;!,!;!;01" -> velocidade, duas cores, usa paleta, 0D/1D
  const breathe = parseFxData('!;!,!;!;01');
  assert.deepEqual(breathe.sliders.map((s) => s.label), ['Velocidade']);
  assert.deepEqual(breathe.colors.map((c) => c.label), ['Principal', 'Fundo']);
  assert.equal(breathe.palette, true);
  // Fire 2012: rótulos próprios traduzidos, sem cores
  const fire = parseFxData('Cooling,Spark rate,,2D Blur,Boost;;!;1;sx=64,ix=160,m12=1,c2=128');
  assert.deepEqual(fire.sliders.map((s) => [s.key, s.label]), [['sx', 'Resfriamento'], ['ix', 'Faíscas'], ['c2', '2D Blur'], ['c3', 'Reforço']]);
  assert.equal(fire.sliders.find((s) => s.key === 'c3').max, 31);
  assert.deepEqual(fire.colors, []);
  // sem metadados: dois sliders, três cores e paleta
  const plain = parseFxData('');
  assert.equal(plain.sliders.length, 2);
  assert.equal(plain.colors.length, 3);
  assert.equal(plain.palette, true);
  // Solid: só a cor principal
  const solid = parseFxData('', 0);
  assert.deepEqual([solid.sliders.length, solid.colors.length, solid.palette], [0, 1, false]);
  // 2D e áudio
  assert.equal(parseFxData('Speed,,Fade,Blur;;!;2').is2D, true);
  assert.equal(parseFxData('!,!;!,!;!;1v').audio, true);
});

test('buildEffects usa a lista real do WLED 0.15.5 e esconde efeitos só 2D', () => {
  const fx = buildEffects(FIX.eff, FIX.fxdata);
  assert.ok(fx.length > 100);
  assert.ok(!fx.some((e) => e.name === 'RSVD'));
  assert.ok(!fx.some((e) => e.is2D));
  const aurora = fx.find((e) => e.name === 'Aurora');
  assert.ok(aurora && aurora.palette);
  for (const name of DEFAULT_CONFIG.favorites.effects) assert.ok(fx.some((e) => e.name === name), `efeito favorito padrão existe: ${name}`);
});

test('buildPalettes monta as paradas de cor de cada paleta', () => {
  const pals = buildPalettes(FIX.pal, FIX.palx);
  assert.equal(pals.length, FIX.pal.length);
  const sunset = pals.find((p) => p.name === 'Sunset');
  assert.ok(sunset.stops.length >= 2 && sunset.stops.every((s) => s.rgb));
  assert.deepEqual(pals.find((p) => p.id === 2).stops.map((s) => s.ref), ['c1', 'c1']); // "* Color 1" vira gradiente da cor 1
  assert.deepEqual(paletteStops([[0, 1, 2, 3], [255, 4, 5, 6]]), [{ pos: 0, rgb: [1, 2, 3] }, { pos: 100, rgb: [4, 5, 6] }]);
  for (const name of DEFAULT_CONFIG.favorites.palettes) assert.ok(pals.some((p) => p.name === name), `paleta favorita padrão existe: ${name}`);
});

test('decodeLiveFrame lê o quadro binário do WLED', () => {
  assert.deepEqual(decodeLiveFrame(Uint8Array.from([0x4c, 1, 255, 0, 16, 1, 2, 3])), { hex: 'ff0010010203', w: 0, h: 0 });
  assert.deepEqual(decodeLiveFrame(Uint8Array.from([0x4c, 2, 2, 1, 9, 9, 9, 8, 8, 8])), { hex: '090909080808', w: 2, h: 1 });
  assert.equal(decodeLiveFrame(Uint8Array.from([0x7b, 0x22])), null);
});

test('SpeakerLogic: auto liga com o PC e desliga depois do atraso', () => {
  const sp = new SpeakerLogic();
  assert.equal(sp.update({ mode: 'auto', pcOnline: true, offDelaySec: 60, now: 0 }), true);
  assert.equal(sp.update({ mode: 'auto', pcOnline: false, offDelaySec: 60, now: 30_000 }), true);
  assert.equal(sp.update({ mode: 'auto', pcOnline: false, offDelaySec: 60, now: 60_000 }), false);
  assert.equal(sp.update({ mode: 'on', pcOnline: false, offDelaySec: 60, now: 61_000 }), true);
  assert.equal(sp.update({ mode: 'off', pcOnline: true, offDelaySec: 60, now: 62_000 }), false);
});
