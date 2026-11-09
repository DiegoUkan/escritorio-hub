import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/guide.html', import.meta.url), 'utf8');

test('cada passo do tutorial tem um id único', () => {
  const ids = [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length);
});

test('links externos do tutorial abrem em nova aba com noopener', () => {
  const links = html.match(/<a [^>]*href="http[^>]*>/g) || [];
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
  }
});

test('o comando do OpenRGB limita o firewall à rede de casa', () => {
  assert.match(html, /-LocalPort 6742[^\n]*-RemoteAddress 192\.168\.1\.0\/24/);
});
