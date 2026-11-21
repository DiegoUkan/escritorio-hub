// Garante que o openrgb-sdk (com a correção de scripts/patch-openrgb-sdk.js) lê dispositivos
// do OpenRGB 1.x que mandam flags que a biblioteca não conhece.
import test from 'node:test';
import assert from 'node:assert/strict';
import deviceModule from 'openrgb-sdk/dist/device.js';

const Device = deviceModule.default; // módulo CommonJS: a classe fica em exports.default

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (s) => Buffer.concat([u16(s.length + 1), Buffer.from(s + '\0')]);

// Monta o pacote de um dispositivo no protocolo 5, com os flags que quiser.
function devicePacket({ modeFlags, zoneFlags, deviceFlags }) {
  const mode = Buffer.concat([
    str('Direct'), u32(0), u32(modeFlags),
    u32(0), u32(0), u32(0), u32(0), // velocidade min/max, brilho min/max
    u32(0), u32(0), u32(0), u32(0), // cor min/max, velocidade, brilho
    u32(0), u32(0), u16(0), // direção, modo de cor, nenhuma cor
  ]);
  const zone = Buffer.concat([
    str('JARGB 1'), u32(1), u32(0), u32(120), u32(2), // tipo linear, min, max, 2 LEDs
    u16(0), u16(0), u32(zoneFlags), // sem matriz, sem segmentos, flags
  ]);
  const leds = Buffer.concat([str('LED 1'), u32(0), str('LED 2'), u32(0)]);
  return Buffer.concat([
    u32(0), u32(0), // tamanho (ignorado), tipo placa-mãe
    str('MSI MYSTIC LIGHT'), str('MSI'), str('desc'), str('1.0'), str(''), str('HID'),
    u16(1), u32(0), mode,
    u16(1), zone,
    u16(2), leds,
    u16(2), u32(0), u32(0), // cores
    u16(0), u32(deviceFlags), // nomes alternativos, flags do dispositivo
  ]);
}

test('lê zonas ARGB da MSI com flags novos do OpenRGB 1.x', () => {
  // flags que a placa MSI do PC manda nas zonas JAF / JARGB
  const d = new Device(devicePacket({ modeFlags: 0, zoneFlags: 0b1000000111110, deviceFlags: 1 }), 1, 5);
  assert.equal(d.name, 'MSI MYSTIC LIGHT');
  assert.equal(d.leds.length, 2);
  assert.equal(d.zones[0].name, 'JARGB 1');
  assert.equal(d.zones[0].flags, 0b1000000111110);
});

test('lê modos e dispositivos com flags acima dos que a biblioteca conhece', () => {
  const d = new Device(devicePacket({ modeFlags: 1 << 12, zoneFlags: 0, deviceFlags: 1 << 12 }), 0, 5);
  assert.equal(d.modes[0].name, 'Direct');
  assert.equal(d.flags, 1 << 12);
});
