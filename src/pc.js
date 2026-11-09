// Detecta se o PC está ligado tentando abrir uma conexão TCP numa porta conhecida.
import net from 'node:net';

export function checkTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
