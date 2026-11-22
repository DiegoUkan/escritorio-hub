// Servidor SDK do OpenRGB falso para os testes: responde o básico do protocolo (versão 5) e guarda
// as cores que o hub manda para cada dispositivo.
import net from 'node:net';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = (s) => Buffer.concat([u16(Buffer.byteLength(s) + 1), Buffer.from(s + '\0')]);

// Pacote de um dispositivo no protocolo 5. flags novas do OpenRGB 1.x nas zonas, como a MSI real.
export function devicePacket({ name, zones, modes = ['Direct'], zoneFlags = 0b1000000111110 }) {
  const mode = (m) => Buffer.concat([str(m), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u16(0)]);
  const zone = (z) => Buffer.concat([str(z.name), u32(1), u32(0), u32(240), u32(z.leds), u16(0), u16(0), u32(zoneFlags)]);
  const leds = zones.flatMap((z) => Array.from({ length: z.leds }, (_, i) => Buffer.concat([str(`${z.name}, LED ${i + 1}`), u32(0)])));
  const total = zones.reduce((s, z) => s + z.leds, 0);
  const body = Buffer.concat([
    // tamanho, tipo, nome, fabricante, descrição, versão, serial, local
    u32(0), u32(0), str(name), str('Vendor'), str('desc'), str('1.0'), str(''), str('HID'),
    u16(modes.length), u32(0), ...modes.map(mode),
    u16(zones.length), ...zones.map(zone),
    u16(total), ...leds,
    u16(total), ...Array.from({ length: total }, () => u32(0)),
    u16(0), u32(1),
  ]);
  body.writeUInt32LE(body.length, 0);
  return body;
}

export function startFakeOpenRGB(devices) {
  const updates = {}; // deviceId -> [[r,g,b], ...] última cor de cada LED
  const counts = {};  // deviceId -> quantos updateLeds chegaram
  const modes = [];
  const reply = (sock, dev, cmd, body = Buffer.alloc(0)) => {
    const head = Buffer.alloc(16);
    head.write('ORGB', 0, 'ascii');
    head.writeUInt32LE(dev, 4);
    head.writeUInt32LE(cmd, 8);
    head.writeUInt32LE(body.length, 12);
    sock.write(Buffer.concat([head, body]));
  };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16) {
        const len = buf.readUInt32LE(12);
        if (buf.length < 16 + len) return;
        const dev = buf.readUInt32LE(4);
        const cmd = buf.readUInt32LE(8);
        const body = buf.subarray(16, 16 + len);
        buf = buf.subarray(16 + len);
        if (cmd === 40) reply(sock, 0, 40, u32(5));
        else if (cmd === 0) reply(sock, 0, 0, u32(devices.length));
        else if (cmd === 1) reply(sock, dev, 1, devicePacket(devices[dev]));
        else if (cmd === 150) reply(sock, 0, 150, Buffer.concat([u32(6), u16(1), str('todo o gabinete')]));
        else if (cmd === 1101) modes.push(dev);
        else if (cmd === 1050) {
          const n = body.readUInt16LE(4);
          updates[dev] = Array.from({ length: n }, (_, i) => [body[6 + i * 4], body[7 + i * 4], body[8 + i * 4]]);
          counts[dev] = (counts[dev] ?? 0) + 1;
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, updates, counts, modes, close: () => server.close() })),
  );
}
