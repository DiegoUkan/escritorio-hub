// Confere o conteúdo da aba Tutorial (public/guide.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');

test('cada item do checklist tem uma chave única', () => {
  const keys = [...html.matchAll(/data-check="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  assert.equal(new Set(keys).size, keys.length);
});

test('o índice aponta para seções que existem', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const targets = [...html.matchAll(/<a [^>]*href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(targets.length > 0);
  for (const t of targets) assert.ok(ids.has(t), `#${t}`);
});

test('os ícones usados no tutorial existem na página', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const icons = [...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(icons.length > 0);
  for (const i of icons) assert.match(index, new RegExp(`<symbol id="${i}"`), `#${i}`);
});

test('links externos abrem em nova aba com noopener', () => {
  const links = html.match(/<a [^>]*href="http[^>]*>/g) || [];
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.match(link, /target="_blank"/, link);
    assert.match(link, /rel="noopener"/, link);
  }
});

test('o comando do OpenRGB limita o firewall à rede de casa', () => {
  assert.match(html, /-LocalPort 6742[^\n]*-RemoteAddress 192\.168\.1\.0\/24/);
});
