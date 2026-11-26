// Movie data. Uses TMDB when TMDB_API_KEY (v3 key or v4 read token) is set,
// otherwise a small built-in demo catalog so the game runs out of the box.

const GENRES = [
  { id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }, { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' }, { id: 10751, name: 'Family' }, { id: 14, name: 'Fantasy' },
  { id: 36, name: 'History' }, { id: 27, name: 'Horror' }, { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' }, { id: 10749, name: 'Romance' }, { id: 878, name: 'Science Fiction' },
  { id: 53, name: 'Thriller' }, { id: 10752, name: 'War' }, { id: 37, name: 'Western' },
];
const GENRE_NAME = Object.fromEntries(GENRES.map((g) => [g.id, g.name]));

const IMG = 'https://image.tmdb.org/t/p/';

// Spread the stills across the running time: minute m of a film with N stills
// shows still floor(m / runtime * N). Repeated minutes in one round step to an
// unused still so a second try never shows the same picture.
function pickStillIndex(minute, runtime, count, used = []) {
  if (count <= 0) return -1;
  const rt = Math.max(1, runtime || 120);
  let idx = Math.min(count - 1, Math.max(0, Math.floor((minute / rt) * count)));
  if (used.length >= count) return idx;
  for (let step = 0; step < count; step++) {
    const cand = (idx + step) % count;
    if (!used.includes(cand)) return cand;
  }
  return idx;
}

function yearOf(date) {
  return date ? Number(String(date).slice(0, 4)) || null : null;
}

function inFilters(m, f) {
  const y = m.year;
  if (f.yearFrom && (!y || y < f.yearFrom)) return false;
  if (f.yearTo && (!y || y > f.yearTo)) return false;
  if (f.genres && f.genres.length && !(m.genreIds || []).some((g) => f.genres.includes(g))) return false;
  return true;
}

class TmdbProvider {
  constructor(key) {
    this.key = key.trim();
    this.bearer = this.key.length > 40; // v4 read access tokens are long JWTs
    this.cache = new Map();
    this.name = 'tmdb';
  }

  async get(path, params = {}) {
    const url = new URL('https://api.themoviedb.org/3' + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    if (!this.bearer) url.searchParams.set('api_key', this.key);
    const ck = url.toString();
    const hit = this.cache.get(ck);
    if (hit && hit.t > Date.now() - 6 * 3600e3) return hit.v;
    const res = await fetch(url, {
      headers: this.bearer ? { Authorization: 'Bearer ' + this.key, accept: 'application/json' } : { accept: 'application/json' },
    });
    if (!res.ok) throw new Error('TMDB ' + res.status);
    const v = await res.json();
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(ck, { t: Date.now(), v });
    return v;
  }

  slim(r) {
    return {
      id: r.id,
      title: r.title,
      year: yearOf(r.release_date),
      poster: r.poster_path ? IMG + 'w185' + r.poster_path : null,
      genreIds: r.genre_ids || [],
    };
  }

  async discover(f, page = 1) {
    const d = await this.get('/discover/movie', {
      sort_by: 'popularity.desc',
      include_adult: 'false',
      'vote_count.gte': 300,
      with_genres: (f.genres || []).join('|'),
      'primary_release_date.gte': f.yearFrom ? `${f.yearFrom}-01-01` : '',
      'primary_release_date.lte': f.yearTo ? `${f.yearTo}-12-31` : '',
      page,
    });
    return { results: d.results.map((r) => this.slim(r)), totalPages: Math.min(d.total_pages || 1, 50) };
  }

  async search(f, query) {
    const d = await this.get('/search/movie', { query, include_adult: 'false' });
    return { results: d.results.map((r) => this.slim(r)).filter((m) => inFilters(m, f)), totalPages: 1 };
  }

  async details(id) {
    const d = await this.get(`/movie/${Number(id)}`, { append_to_response: 'images', include_image_language: 'null' });
    // Textless backdrops are real stills; sort by path for a stable "timeline".
    let stills = (d.images?.backdrops || []).filter((b) => !b.iso_639_1);
    if (stills.length < 3) stills = d.images?.backdrops || [];
    const frames = stills.map((b) => b.file_path).sort().map((p) => IMG + 'w1280' + p);
    return {
      id: d.id,
      title: d.title,
      originalTitle: d.original_title,
      year: yearOf(d.release_date),
      runtime: d.runtime || 120,
      poster: d.poster_path ? IMG + 'w342' + d.poster_path : null,
      genres: (d.genres || []).map((g) => g.name),
      genreIds: (d.genres || []).map((g) => g.id),
      frames,
    };
  }
}

// Demo catalog: invented films with generated stills, for trying the game
// without a TMDB key (and for tests).
const DEMO = [
  { id: 1, title: 'The Lighthouse Keeper', year: 2004, runtime: 112, genreIds: [18, 9648] },
  { id: 2, title: 'Neon Harbor', year: 2012, runtime: 128, genreIds: [28, 53] },
  { id: 3, title: 'Paper Moons II', year: 2015, runtime: 98, genreIds: [35, 10749] },
  { id: 4, title: 'Orbit of Glass', year: 2019, runtime: 141, genreIds: [878, 12] },
  { id: 5, title: 'Wolves & Wheat', year: 1998, runtime: 104, genreIds: [37, 18] },
  { id: 6, title: 'The Quiet Basement', year: 2021, runtime: 95, genreIds: [27, 53] },
  { id: 7, title: 'Saltwater Kids', year: 2008, runtime: 101, genreIds: [10751, 12, 16] },
  { id: 8, title: 'Midnight Ledger', year: 2016, runtime: 119, genreIds: [80, 18] },
];

class DemoProvider {
  constructor() { this.name = 'demo'; }
  slim(m) { return { id: m.id, title: m.title, year: m.year, poster: `/demo/poster/${m.id}.svg`, genreIds: m.genreIds }; }
  async discover(f) {
    const list = DEMO.filter((m) => inFilters(m, f));
    return { results: (list.length ? list : DEMO).map((m) => this.slim(m)), totalPages: 1 };
  }
  async search(f, q) {
    const n = q.toLowerCase();
    return { results: DEMO.filter((m) => m.title.toLowerCase().includes(n)).map((m) => this.slim(m)), totalPages: 1 };
  }
  async details(id) {
    const m = DEMO.find((x) => x.id === Number(id));
    if (!m) throw new Error('Unknown movie');
    return {
      ...m,
      originalTitle: m.title,
      poster: `/demo/poster/${m.id}.svg`,
      genres: m.genreIds.map((g) => GENRE_NAME[g]),
      frames: Array.from({ length: 12 }, (_, i) => `/demo/frame/${m.id}/${i}.svg`),
    };
  }
}

function demoSvg(id, n, poster) {
  const hue = (Number(id) * 47 + Number(n) * 13) % 360;
  const w = poster ? 342 : 1280, h = poster ? 513 : 536;
  const shapes = Array.from({ length: 7 }, (_, k) => {
    const x = ((Number(id) * 97 + k * 181 + Number(n) * 53) % w);
    const y = ((Number(id) * 31 + k * 113 + Number(n) * 71) % h);
    const r = 30 + ((k * 37 + Number(n) * 11) % 120);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="hsl(${(hue + k * 25) % 360} 60% ${30 + k * 6}%)" opacity=".7"/>`;
  }).join('');
  const label = poster ? `DEMO FILM ${id}` : `demo still ${n + 1}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${hue} 35% 14%)"/>${shapes}<text x="24" y="${h - 24}" font-family="monospace" font-size="${poster ? 20 : 28}" fill="#fff" opacity=".6">${label}</text></svg>`;
}

function createProvider() {
  const key = process.env.TMDB_API_KEY || process.env.TMDB_TOKEN;
  return key ? new TmdbProvider(key) : new DemoProvider();
}

module.exports = { GENRES, GENRE_NAME, createProvider, pickStillIndex, demoSvg, inFilters, DemoProvider };
