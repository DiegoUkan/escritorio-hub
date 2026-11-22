// Ponte com o servidor SDK do OpenRGB (rodando no PC gamer).
import openrgb from 'openrgb-sdk';

const { Client } = openrgb;

export class OpenRGBBridge {
  constructor() {
    this.client = null;
    this.target = '';
    this.devices = [];
    this.profiles = [];
    this.connected = false;
    this.error = '';
    this.busy = false;
    this.known = [];         // últimos dispositivos vistos (ficam mesmo com o PC desligado)
    this.seq = 0;            // muda a cada conexão nova (o gabinete reenvia tudo)
    this.direct = new Set(); // dispositivos já colocados no modo Direct nesta conexão
  }

  async #connect(host, port) {
    this.#drop();
    const client = new Client('escritorio-hub', port, host);
    client.on('disconnect', () => {
      this.connected = false;
    });
    client.on('error', () => {
      this.connected = false;
    });
    await client.connect(2000);
    this.client = client;
    this.target = `${host}:${port}`;
    this.connected = true;
    this.direct.clear();
    this.seq++;
  }

  #drop() {
    try {
      this.client?.disconnect();
    } catch {}
    this.client = null;
    this.connected = false;
  }

  // Chamado a cada ciclo: conecta se preciso e atualiza a lista de dispositivos.
  async sync({ enabled, host, port }) {
    if (!enabled || !host) {
      this.#drop();
      this.devices = [];
      this.error = '';
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.connected || this.target !== `${host}:${port}`) await this.#connect(host, port);
      const all = await this.client.getAllControllerData();
      this.devices = all.map((d) => ({
        id: d.deviceId,
        name: d.name,
        type: d.type,
        leds: d.leds.length,
        hasDirect: d.modes.some((m) => m.name === 'Direct'),
        zones: d.zones.map((z) => ({ name: z.name, leds: z.ledsCount })),
      }));
      if (this.devices.length) this.known = this.devices; // o mapa do gabinete continua com o PC desligado
      this.profiles = await this.client.getProfileList().catch(() => []);
      this.error = '';
    } catch (err) {
      this.#drop();
      this.devices = [];
      this.error = err?.message || String(err);
    } finally {
      this.busy = false;
    }
  }

  #requireClient() {
    if (!this.connected || !this.client) throw new Error('OpenRGB não conectado');
    return this.client;
  }

  // Modo Direct uma vez por conexão: é nele que o OpenRGB aceita cor por LED
  async #ensureDirect(client, d) {
    if (this.direct.has(d.id)) return;
    this.direct.add(d.id);
    if (!d.hasDirect) return;
    try {
      await client.updateMode(d.id, 'Direct');
    } catch {
      // alguns dispositivos não têm modo Direct; tenta pintar mesmo assim
    }
  }

  // Pinta uma cor sólida em um dispositivo (ou em todos, se deviceId for undefined)
  async setColor([r, g, b], deviceId) {
    const client = this.#requireClient();
    const color = { red: r, green: g, blue: b };
    const targets = deviceId === undefined ? this.devices : this.devices.filter((d) => d.id === deviceId);
    for (const d of targets) {
      await this.#ensureDirect(client, d);
      client.updateLeds(d.id, Array(d.leds).fill(color));
    }
    return targets.length;
  }

  // Cor de cada LED de um dispositivo: colors = [[r,g,b], ...] na ordem do OpenRGB
  setLeds(deviceId, colors) {
    const client = this.#requireClient();
    const d = this.devices.find((x) => x.id === deviceId);
    if (!d) throw new Error(`dispositivo ${deviceId} não encontrado`);
    if (!this.direct.has(d.id)) this.#ensureDirect(client, d);
    client.updateLeds(d.id, colors.map(([red, green, blue]) => ({ red, green, blue })));
  }

  loadProfile(name) {
    this.#requireClient().loadProfile(name);
  }

  status() {
    return { connected: this.connected, error: this.error, devices: this.devices, profiles: this.profiles };
  }
}
