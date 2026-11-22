// Desenho padrão do gabinete: panorâmico de duas câmaras, de frente (como o do escritório).
// viewBox 344 x 308 = DEFAULT_ASPECT de cabinet-geom.js. As hélices giram (CSS .cab-blades).

const W = 344;
const H = 308;

function fan(x, y, s) {
  const c = s / 2;
  const R = s * 0.4;
  const blade = `M0 0 C ${R * 0.3} ${-R * 0.35}, ${R * 0.8} ${-R * 0.3}, ${R} ${-R * 0.05} C ${R * 0.7} ${R * 0.1}, ${R * 0.3} ${R * 0.08}, 0 0`;
  const blades = Array.from({ length: 7 }, (_, i) => `<path d="${blade}" transform="rotate(${(i * 360) / 7})"/>`).join('');
  return `<g>
    <rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.12}" fill="#10141c" stroke="#2a3142"/>
    <circle cx="${x + c}" cy="${y + c}" r="${s * 0.43}" fill="#0b0e14" stroke="#1d2330"/>
    <g transform="translate(${x + c} ${y + c})"><g class="cab-blades" fill="#283044">${blades}</g>
    <circle r="${s * 0.12}" fill="#1a1f2b" stroke="#2e364a"/></g></g>`;
}

const flatFan = (x, y, w) => `<rect x="${x}" y="${y}" width="${w}" height="26" rx="4" fill="#10141c" stroke="#2a3142"/>
  <ellipse cx="${x + w / 2}" cy="${y + 15}" rx="${w * 0.4}" ry="8" fill="#0b0e14" stroke="#1d2330"/>`;

const fins = Array.from({ length: 48 }, (_, i) => `<line x1="${22 + i * 4}" y1="14" x2="${22 + i * 4}" y2="26"/>`).join('');
const grille = Array.from({ length: 10 }, (_, i) => `<line x1="242" y1="${236 + i * 6}" x2="326" y2="${236 + i * 6}"/>`).join('');

export const CABINET_ART = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="cab-art" preserveAspectRatio="none" aria-hidden="true">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="7" fill="#0c0f15" stroke="#3a4152" stroke-width="2"/>
  <rect x="8" y="8" width="214" height="292" fill="#0f131b"/>
  <rect x="222" y="6" width="8" height="296" fill="#1b202b"/>
  <rect x="230" y="8" width="108" height="292" fill="#0d1017"/>
  <rect x="18" y="18" width="196" height="206" rx="3" fill="#121722" stroke="#1d2331"/>
  <g stroke="#252c3c">${fins}</g>
  <rect x="18" y="12" width="196" height="16" rx="2" fill="none" stroke="#283043" stroke-width="0.6"/>
  <path d="M131 60 C131 44 106 42 106 28" stroke="#262c39" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M143 61 C145 44 168 40 168 28" stroke="#262c39" stroke-width="5" fill="none" stroke-linecap="round"/>
  <circle cx="137" cy="78" r="20" fill="#cfd4dd"/><circle cx="137" cy="78" r="10" fill="#e9ecf1"/>
  <rect x="173" y="40" width="7" height="64" rx="1.5" fill="#1f2536" stroke="#2c344a" stroke-width="0.5"/>
  <rect x="184" y="40" width="7" height="64" rx="1.5" fill="#1f2536" stroke="#2c344a" stroke-width="0.5"/>
  <path d="M27 116 C62 124 102 112 152 124" stroke="#1c2230" stroke-width="2" fill="none"/>
  <rect x="22" y="134" width="190" height="40" rx="3" fill="#191e2b" stroke="#2b3246"/>
  <rect x="22" y="170" width="190" height="4" fill="#232a3b"/>
  <text x="34" y="158" fill="#5f6a80" font-size="10" letter-spacing="2" font-family="sans-serif">GEFORCE RTX</text>
  <rect x="12" y="236" width="206" height="4" fill="#1b202b"/>
  ${fan(26, 36, 56)}${fan(238, 24, 92)}${fan(238, 124, 92)}
  ${flatFan(22, 260, 60)}${flatFan(87, 260, 60)}${flatFan(152, 260, 60)}
  <rect x="234" y="228" width="100" height="68" rx="3" fill="#11141c" stroke="#232a39"/>
  <g stroke="#1a1f2a" stroke-width="2">${grille}</g>
  <polygon points="12,8 62,8 18,104 8,104" fill="#ffffff" opacity="0.03"/>
  <polygon points="242,8 272,8 234,80 234,44" fill="#ffffff" opacity="0.03"/>
</svg>`;

// Mapa sugerido para o desenho padrão (o do escritório): o usuário confere com "Acender" e ajusta.
// Coordenadas normalizadas (u = x / 344, v = y / 308).
const n = (x, y) => [Math.round((x / W) * 10000) / 10000, Math.round((y / H) * 10000) / 10000];
// No PC do escritório: cada fan tem 6 LEDs em barras nas laterais, e a barra da esquerda repete a da
// direita. Os 2 fans da lateral (barras em pé) ficam no JARGB 2 e os 3 da base (esquerda → direita) no
// JARGB 1, todos em paralelo (cópias). O JARGB 3 repete o mesmo sinal na bomba do processador, no
// centro do fan traseiro e no centro dos 3 fans do topo (embaixo do radiador).
const bar = (a, b) => ({ shape: 'line', to: 6, pts: [n(...a), n(...b)] });
export const SUGGESTED = {
  DRAM: [{ shape: 'line', pts: [n(182, 44), n(182, 100)] }],
  'JARGB 1': [bar([25, 263], [79, 263]), bar([90, 263], [144, 263]), bar([155, 263], [209, 263])],
  'JARGB 2': [bar([242, 108], [242, 32]), bar([326, 108], [326, 32]), bar([242, 208], [242, 132]), bar([326, 208], [326, 132])],
  // a bomba tem 8 LEDs; os centros dos fans, 6 (os LEDs 9-12 da zona não existem)
  'JARGB 3': [
    { shape: 'ring', to: 8, pts: [n(137, 78), n(137, 63)] },
    { shape: 'ring', to: 6, pts: [n(54, 64), n(54, 55)] },
    { shape: 'line', to: 6, pts: [n(36, 32), n(66, 32)] },
    { shape: 'line', to: 6, pts: [n(101, 32), n(131, 32)] },
    { shape: 'line', to: 6, pts: [n(166, 32), n(196, 32)] },
  ],
};
