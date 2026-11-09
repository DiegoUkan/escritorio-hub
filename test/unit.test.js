import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../src/config.js';
import { buildState, relayPayload, summarize } from '../src/wled.js';
import { SpeakerLogic } from '../src/speaker.js';

test('mergeConfig mescla objetos e substitui listas', () => {
  const out = mergeConfig(DEFAULT_CONFIG, { pc: { host: '10.0.0.2' }, wled: [{ id: 'a', name: 'A', host: 'x' }] });
  assert.equal(out.pc.host, '10.0.0.2');
  assert.equal(out.pc.port, 445);
  assert.deepEqual(out.wled, [{ id: 'a', name: 'A', host: 'x' }]);
  assert.equal(DEFAULT_CONFIG.pc.host, '', 'não altera o padrão');
});

test('validateConfig acusa erros', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  const bad = mergeConfig(DEFAULT_CONFIG, { wled: [{ id: 'a b', host: '' }], speaker: { mode: 'x' } });
  assert.equal(validateConfig(bad).length, 3);
});

test('buildState aplica cor em todos os segmentos', () => {
  assert.deepEqual(buildState({ on: true, bri: 300, color: [255, 0, 10], fx: 0 }, [0, 1]), {
    on: true,
    bri: 255,
    seg: [
      { id: 0, col: [[255, 0, 10]], fx: 0 },
      { id: 1, col: [[255, 0, 10]], fx: 0 },
    ],
  });
  assert.deepEqual(buildState({ on: false }), { on: false });
});

test('relayPayload do Multi Relay', () => {
  assert.deepEqual(relayPayload(0, true), { MultiRelay: { relay: 0, on: true } });
});

test('summarize lê /json/si', () => {
  const s = summarize({
    info: { ver: '0.15.5', leds: { count: 98 }, ip: '1.2.3.4', name: 'X' },
    state: { on: true, bri: 80, seg: [{ id: 0, n: 'Base', start: 0, stop: 34, col: [[1, 2, 3, 0]], fx: 5, pal: 2, sx: 10 }] },
  });
  assert.equal(s.leds, 98);
  assert.deepEqual(s.color, [1, 2, 3]);
  assert.equal(s.segments[0].name, 'Base');
});

test('SpeakerLogic: auto liga com o PC e desliga depois do atraso', () => {
  const sp = new SpeakerLogic();
  assert.equal(sp.update({ mode: 'auto', pcOnline: true, offDelaySec: 60, now: 0 }), true);
  assert.equal(sp.update({ mode: 'auto', pcOnline: false, offDelaySec: 60, now: 30_000 }), true);
  assert.equal(sp.update({ mode: 'auto', pcOnline: false, offDelaySec: 60, now: 60_000 }), false);
  assert.equal(sp.update({ mode: 'on', pcOnline: false, offDelaySec: 60, now: 61_000 }), true);
  assert.equal(sp.update({ mode: 'off', pcOnline: true, offDelaySec: 60, now: 62_000 }), false);
});
