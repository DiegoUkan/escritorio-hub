// Biblioteca de efeitos e paletas, com favoritos no topo e o restante em ordem alfabética.
import { $, $$, escapeHtml, fold, paletteCss } from './util.js';

const ICON = (id) => `<svg><use href="#i-${id}"/></svg>`;

function sortRest(kind, items) {
  const firstId = 0; // "Solid" e "Default" ficam no começo, como no WLED
  return [...items].sort((a, b) => {
    if (a.id === firstId) return -1;
    if (b.id === firstId) return 1;
    if (kind === 'palettes') {
      const sa = a.name.startsWith('*');
      const sb = b.name.startsWith('*');
      if (sa !== sb) return sa ? -1 : 1;
    }
    return a.name.localeCompare(b.name, 'pt-BR');
  });
}

export class Library {
  constructor({ onPick, onFav }) {
    this.onPick = onPick;
    this.onFav = onFav;
    this.tab = 'effects';
    this.query = '';
    this.lists = null;
    this.fav = { effects: [], palettes: [] };
    this.active = { effects: -1, palettes: -1 };
    this.colors = [[255, 255, 255], [0, 0, 0], [0, 0, 0]];
    this.renderKey = '';
    this.el = $('#library');
    this.favBox = $('#tiles-fav');
    this.restBox = $('#tiles-rest');
    this.favBox.dataset.empty = 'Nenhum favorito ainda.';
    this.restBox.dataset.empty = 'Nada encontrado.';

    $$('.lib-tab', this.el).forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab;
        $$('.lib-tab', this.el).forEach((x) => x.classList.toggle('active', x === b));
        this.render(true);
      }),
    );
    $('#search').addEventListener('input', (e) => {
      this.query = fold(e.target.value.trim());
      this.render(true);
    });
    $('#lib-scroll').addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      const id = Number(tile.dataset.id);
      if (e.target.closest('.star')) {
        const btn = e.target.closest('.star');
        this.onFav(this.tab, tile.dataset.name, btn.getAttribute('aria-pressed') !== 'true');
      } else if (e.target.closest('.tile-main')) {
        this.onPick(this.tab, id);
      }
    });
  }

  setLists(lists) {
    this.lists = lists;
    $('#count-effects').textContent = lists ? lists.effects.length : '';
    $('#count-palettes').textContent = lists ? lists.palettes.length : '';
    this.render();
  }

  setFavorites(fav) {
    if (!fav) return;
    this.fav = fav;
    this.render();
  }

  setActive(fx, pal) {
    this.active = { effects: fx, palettes: pal };
    const cur = this.active[this.tab];
    $$('.tile', $('#lib-scroll')).forEach((t) => t.classList.toggle('active', Number(t.dataset.id) === cur));
  }

  setColors(colors) {
    const key = JSON.stringify(colors);
    if (key === this.colorsKey) return;
    this.colorsKey = key;
    this.colors = colors;
    // só as paletas que dependem das cores atuais precisam ser redesenhadas
    $$('.pal-bar[data-dynamic]', this.el).forEach((bar) => {
      const p = this.lists?.palettes.find((x) => x.id === Number(bar.dataset.id));
      if (p) bar.style.background = paletteCss(p.stops, this.colors, p.id);
    });
  }

  setNote(text) {
    const note = $('#lib-note');
    note.hidden = !text;
    note.textContent = text || '';
  }

  setPaletteUsed(used) {
    this.paletteUsed = used;
    this.el.classList.toggle('dim', !used);
    this.updateNote();
  }

  updateNote() {
    $('#lib-scroll').hidden = !this.lists;
    if (this.offline) return this.setNote('Dispositivo offline: os efeitos e paletas aparecem quando ele voltar.');
    if (!this.lists) return this.setNote('Carregando efeitos e paletas…');
    if (this.tab === 'palettes' && this.paletteUsed === false) return this.setNote('O efeito atual não usa paleta. Escolha um efeito com o ícone de paleta para ver a diferença.');
    this.setNote('');
  }

  setOffline(off) {
    this.offline = off;
    this.updateNote();
  }

  tileHtml(item) {
    const kind = this.tab;
    const fav = this.fav[kind].includes(item.name);
    const active = this.active[kind] === item.id;
    let body;
    if (kind === 'effects') {
      const tags = item.audio ? `${ICON('music')}` : '';
      body = `<span class="tile-name">${escapeHtml(item.name)}</span><span class="tile-tags">${tags}</span>`;
    } else {
      const dynamic = item.stops.some((s) => !s.rgb) ? ' data-dynamic' : '';
      body = `<span class="pal-bar" data-id="${item.id}"${dynamic} style="background:${paletteCss(item.stops, this.colors, item.id)}"></span><span class="tile-name">${escapeHtml(item.name)}</span>`;
    }
    return `<div class="tile${active ? ' active' : ''}" data-id="${item.id}" data-name="${escapeHtml(item.name)}">
      <button class="tile-main" title="${escapeHtml(item.name)}">${body}</button>
      <button class="star" aria-pressed="${fav}" aria-label="${fav ? 'Remover dos favoritos' : 'Favoritar'} ${escapeHtml(item.name)}">${ICON('star')}</button>
    </div>`;
  }

  render(force = false) {
    const key = JSON.stringify([this.tab, this.query, this.fav, !!this.lists, this.lists?.effects.length, this.lists?.palettes.length]);
    if (!force && key === this.renderKey) return;
    this.renderKey = key;
    this.favBox.classList.toggle('palettes', this.tab === 'palettes');
    this.restBox.classList.toggle('palettes', this.tab === 'palettes');
    this.updateNote();
    if (!this.lists) {
      this.favBox.innerHTML = '';
      this.restBox.innerHTML = '';
      return;
    }
    const items = this.lists[this.tab];
    const match = (it) => !this.query || fold(it.name).includes(this.query);
    const favNames = this.fav[this.tab];
    const favItems = favNames.map((n) => items.find((it) => it.name === n)).filter(Boolean).filter(match);
    const rest = sortRest(this.tab, items.filter((it) => !favNames.includes(it.name) && match(it)));
    this.favBox.innerHTML = favItems.map((it) => this.tileHtml(it)).join('');
    this.restBox.innerHTML = rest.map((it) => this.tileHtml(it)).join('');
    $('#rest-title').textContent = favItems.length || !this.query ? `Todos (${rest.length})` : `Resultados (${rest.length})`;
  }
}
