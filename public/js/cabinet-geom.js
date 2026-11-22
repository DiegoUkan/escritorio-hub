// Geometria do mapa do gabinete. Usado pela página (editor e desenho) e pelo servidor (ordem dos
// efeitos e Ambilight), para os dois calcularem as mesmas posições.
//
// Coordenadas normalizadas: u (0 = esquerda, 1 = direita) e v (0 = topo, 1 = base) sobre a imagem
// de fundo. As formas são calculadas num espaço "corrigido" (x = u * aspecto), para um anel não
// virar elipse numa foto retangular.
//
// Um "trecho" (place) liga as LEDs [from, to) de uma zona do OpenRGB a uma forma:
//   line   pts: [início, fim]
//   ring   pts: [centro, ponto da borda onde começa a LED 1]
//   rect   pts: [canto inicial, canto oposto]  (contorno, ex.: fan com LED na moldura)
//   points pts: um ponto por LED
// rev inverte o sentido. Dois trechos com as mesmas LEDs = cópias (fans espelhados por hub/splitter).

export const DEFAULT_ASPECT = 344 / 308; // proporção do desenho padrão do gabinete (cabinet-art.js)

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function shapePoints(place, n, aspect = DEFAULT_ASPECT) {
  if (!(n > 0)) return [];
  const A = aspect > 0 ? aspect : DEFAULT_ASPECT;
  const pts = (place?.pts ?? []).map(([u, v]) => [u * A, v]);
  const back = ([x, y]) => [clamp01(x / A), clamp01(y)];
  const order = (list) => (place?.rev ? list.reverse() : list);
  const t = (i) => (n === 1 ? 0.5 : (i + 0.5) / n);

  switch (place?.shape) {
    case 'line': {
      if (pts.length < 2) return [];
      const [a, b] = pts;
      return order(Array.from({ length: n }, (_, i) => [a[0] + (b[0] - a[0]) * t(i), a[1] + (b[1] - a[1]) * t(i)])).map(back);
    }
    case 'ring': {
      if (pts.length < 2) return [];
      const [c, e] = pts;
      const r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      const a0 = Math.atan2(e[1] - c[1], e[0] - c[0]);
      const dir = place.rev ? -1 : 1;
      return Array.from({ length: n }, (_, i) => {
        const a = a0 + (dir * i * 2 * Math.PI) / n;
        return back([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
      });
    }
    case 'rect': {
      if (pts.length < 2) return [];
      const [p, q] = pts;
      // contorno começando no canto p, indo primeiro na horizontal até q.x
      const corners = [p, [q[0], p[1]], q, [p[0], q[1]]];
      const segs = corners.map((c, i) => [c, corners[(i + 1) % 4]]);
      const lens = segs.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
      const total = lens.reduce((s, l) => s + l, 0) || 1;
      const out = Array.from({ length: n }, (_, i) => {
        let d = ((i + 0.5) / n) * total;
        for (let k = 0; k < 4; k++) {
          if (d <= lens[k] || k === 3) {
            const [a, b] = segs[k];
            const f = lens[k] ? Math.min(1, d / lens[k]) : 0;
            return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
          }
          d -= lens[k];
        }
        return p;
      });
      return order(out).map(back);
    }
    case 'points': {
      const out = Array.from({ length: n }, (_, i) => pts[i] ?? null);
      return order(out).map((p) => (p ? back(p) : null));
    }
    default:
      return [];
  }
}

// Lista das LEDs físicas do OpenRGB, na ordem do SDK (dispositivo, depois zona, depois LED),
// com as posições de cada uma no mapa (várias, quando há cópias).
// devices: [{ id, name, zones: [{ name, leds }] }]
export function buildLeds(devices, zonesCfg = [], aspect = DEFAULT_ASPECT) {
  const leds = [];
  for (const d of devices ?? []) {
    let idx = 0;
    for (const z of d.zones ?? []) {
      const start = leds.length;
      for (let i = 0; i < z.leds; i++) leds.push({ device: d.id, deviceName: d.name, zone: z.name, index: idx + i, zi: i, places: [] });
      const cfg = zonesCfg.find((c) => c.device === d.name && c.zone === z.name);
      for (const place of cfg?.places ?? []) {
        const from = Math.max(0, Math.min(z.leds, Number(place.from) || 0));
        const to = Math.max(from, Math.min(z.leds, Number.isFinite(Number(place.to)) ? Number(place.to) : z.leds));
        shapePoints(place, to - from, aspect).forEach((p, k) => {
          if (p) leds[start + from + k].places.push(p);
        });
      }
      idx += z.leds;
    }
  }
  for (const l of leds) {
    l.mapped = l.places.length > 0;
    l.u = l.mapped ? l.places.reduce((s, p) => s + p[0], 0) / l.places.length : null;
    l.v = l.mapped ? l.places.reduce((s, p) => s + p[1], 0) / l.places.length : null;
  }
  return leds;
}

// Ordem das LEDs virtuais do WLED: virtual[k] = índice da LED física que mostra o pixel k.
// up = de baixo para cima, right = da esquerda para a direita, around = em volta do centro,
// wire = ordem dos cabos (a do OpenRGB). LEDs sem posição vão para o fim.
export function virtualOrder(leds, order = 'up', aspect = DEFAULT_ASPECT) {
  const idx = leds.map((_, i) => i);
  if (order === 'wire') return idx;
  const mapped = idx.filter((i) => leds[i].mapped);
  const rest = idx.filter((i) => !leds[i].mapped);
  let key;
  if (order === 'right') key = (l) => l.u * 1000 - l.v;
  else if (order === 'around') {
    const cu = mapped.reduce((s, i) => s + leds[i].u, 0) / (mapped.length || 1);
    const cv = mapped.reduce((s, i) => s + leds[i].v, 0) / (mapped.length || 1);
    // começa embaixo e gira no sentido horário (na tela): base, esquerda, topo, direita
    key = (l) => (-Math.atan2((l.u - cu) * aspect, l.v - cv) + 2 * Math.PI) % (2 * Math.PI);
  } else key = (l) => -l.v * 1000 + l.u; // up
  mapped.sort((a, b) => key(leds[a]) - key(leds[b]) || a - b);
  return [...mapped, ...rest];
}
