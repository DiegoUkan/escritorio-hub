// Configuração do hub, salva em DATA_DIR/config.json (volume do Docker).
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  // Dispositivos com WLED (ESP32). "host" pode ser IP ou nome .local
  wled: [
    { id: 'monitor', name: 'Monitor', host: '192.168.1.251' },
  ],
  // PC gamer: o hub tenta abrir uma conexão TCP nessa porta para saber se está ligado.
  // 445 (compartilhamento do Windows) costuma estar aberta. Use IP fixo (reserva no roteador).
  pc: { name: 'PC Gamer', host: '', port: 445 },
  // Caixa de som ligada num relé do WLED (usermod Multi Relay)
  speaker: {
    enabled: true,
    mode: 'auto',        // auto | on | off
    wled: 'monitor',     // id do WLED que tem o relé
    relay: 0,            // índice do relé no Multi Relay
    offDelaySec: 60,     // espera o PC ficar offline esse tempo antes de desligar
  },
  // OpenRGB no PC (servidor SDK ligado, porta padrão 6742)
  openrgb: { enabled: false, host: '', port: 6742 },
  pollSec: 5,
};

export function mergeConfig(base, patch) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!Array.isArray(cfg.wled)) errors.push('wled deve ser uma lista');
  else {
    const ids = new Set();
    cfg.wled.forEach((d, i) => {
      if (!d || typeof d.id !== 'string' || !/^[a-z0-9_-]+$/i.test(d.id)) errors.push(`wled[${i}].id inválido (use letras, números, - ou _)`);
      else if (ids.has(d.id)) errors.push(`wled[${i}].id repetido: ${d.id}`);
      else ids.add(d.id);
      if (!d || typeof d.host !== 'string' || !d.host.trim()) errors.push(`wled[${i}].host vazio`);
    });
  }
  if (!['auto', 'on', 'off'].includes(cfg.speaker?.mode)) errors.push('speaker.mode deve ser auto, on ou off');
  const port = Number(cfg.pc?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('pc.port inválida');
  const poll = Number(cfg.pollSec);
  if (!(poll >= 1 && poll <= 300)) errors.push('pollSec deve estar entre 1 e 300');
  return errors;
}

export class ConfigStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.config = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return mergeConfig(DEFAULT_CONFIG, raw);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[config] arquivo inválido, usando padrão:', err.message);
      const cfg = structuredClone(DEFAULT_CONFIG);
      this.#write(cfg);
      return cfg;
    }
  }

  #write(cfg) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get() {
    return this.config;
  }

  // Aplica um patch parcial; retorna lista de erros (vazia se salvou)
  update(patch) {
    const next = mergeConfig(this.config, patch);
    const errors = validateConfig(next);
    if (errors.length) return errors;
    this.#write(next);
    this.config = next;
    return [];
  }
}
