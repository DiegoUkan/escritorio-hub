// Corrige um bug do openrgb-sdk 0.6.0 (roda sozinho depois do npm install/ci).
//
// A biblioteca transforma os flags de modo, zona e dispositivo numa lista com
// `Array(nomes.length - bits.length)`. O OpenRGB 1.x manda flags que ela não conhece
// (as zonas ARGB da MSI vêm com 0b1000000111110, por exemplo), a conta fica negativa
// e a leitura do dispositivo inteiro quebra com "Invalid array length".
// Aqui a conta passa a usar Math.max(0, ...): os flags novos são só ignorados.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../node_modules/openrgb-sdk/dist/device.js', import.meta.url));
const BUG = /Array\((\w+)\.length - flagcheck_str\.length\)/g;
const FIX = 'Array(Math.max(0, $1.length - flagcheck_str.length))';

if (!existsSync(file)) {
  console.warn('[patch-openrgb-sdk] openrgb-sdk não instalado, nada a corrigir');
  process.exit(0);
}

const src = readFileSync(file, 'utf8');
const count = (src.match(BUG) || []).length;
if (count > 0) {
  writeFileSync(file, src.replace(BUG, FIX));
  console.log(`[patch-openrgb-sdk] ${count} leituras de flags corrigidas`);
} else if (src.includes('Math.max(0, flags')) {
  console.log('[patch-openrgb-sdk] já corrigido');
} else {
  // A biblioteca mudou: melhor falhar o build do que subir um hub que quebra com o OpenRGB.
  console.error('[patch-openrgb-sdk] não achei o trecho a corrigir em openrgb-sdk/dist/device.js; revise o script');
  process.exit(1);
}
