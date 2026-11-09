// Prévia ao vivo das LEDs: o hub abre UM websocket com cada WLED (pedindo {"lv":true})
// e repassa os quadros para os navegadores via Server-Sent Events.
// Assim o WLED só tem um cliente de "live view", não importa quantas páginas estejam abertas.

// Quadro binário do WLED: 'L', versão (1 = fita, 2 = matriz com largura/altura), depois RGB RGB RGB...
export function decodeLiveFrame(buf) {
  if (!buf || buf.length < 2 || buf[0] !== 0x4c) return null;
  let pos = 2;
  let w = 0;
  let h = 0;
  if (buf[1] === 2) {
    w = buf[2];
    h = buf[3];
    pos = 4;
  }
  const n = Math.floor((buf.length - pos) / 3);
  return { hex: Buffer.from(buf.subarray(pos, pos + n * 3)).toString('hex'), w, h };
}

export class LiveStream {
  // getHost: () => host atual do WLED; onState: recebe {state, info} quando o WLED avisa mudanças
  constructor(getHost, onState) {
    this.getHost = getHost;
    this.onState = onState;
    this.clients = new Set();
    this.ws = null;
    this.retryTimer = null;
    this.lastFrame = null;
  }

  add(res) {
    this.clients.add(res);
    if (this.lastFrame) res.write(`data: ${this.lastFrame}\n\n`);
    if (!this.ws && !this.retryTimer) this.#open();
  }

  remove(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) this.close();
  }

  #broadcast(text) {
    for (const res of this.clients) res.write(text);
  }

  #open() {
    const host = this.getHost();
    if (!host) return;
    let ws;
    try {
      ws = new WebSocket(`ws://${host}/ws`);
    } catch {
      this.#retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ lv: true })));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.state && msg.info) this.onState?.(msg);
        } catch {}
        return;
      }
      const frame = decodeLiveFrame(new Uint8Array(ev.data));
      if (!frame) return;
      this.lastFrame = frame.hex;
      this.#broadcast(`data: ${frame.hex}\n\n`);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this.clients.size) this.#retry();
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {}
    });
  }

  #retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.clients.size && !this.ws) this.#open();
    }, 3000);
  }

  close() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.lastFrame = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ lv: false }));
      ws.close();
    } catch {}
  }

  // fecha as páginas conectadas (usado quando o dispositivo some da configuração)
  shutdown() {
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.close();
  }
}
