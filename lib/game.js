// Game rules and room state. Pure logic: the server feeds it player actions
// and broadcasts each player's view of the result.

const { isCorrectGuess } = require('./match');
const { pickStillIndex, GENRE_NAME } = require('./movies');

const MAX_ATTEMPTS = 3;
const POINTS = [3, 2, 1]; // by attempt number
const STUMP_POINTS = 1; // picker scores when the guesser misses every try
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

function makeCode(taken) {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!taken.has(c)) return c;
  }
  throw new Error('No room codes left');
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20);
  if (!n) throw new Error('Enter a name first.');
  return n;
}

class Room {
  constructor(code, provider) {
    this.code = code;
    this.provider = provider;
    this.players = []; // {id, name, score, connected}
    this.hostId = null;
    this.settings = { yearFrom: 2000, yearTo: 2024, genres: [], laps: 1 };
    this.phase = 'lobby'; // lobby | pick | minute | capture | guess | reveal | over
    this.round = 0;
    this.totalRounds = 0;
    this.pickerId = null;
    this.guesserId = null;
    this.movie = null;
    this.useFile = false;
    this.attempts = [];
    this.result = null;
    this.history = [];
    this.touched = Date.now();
    this.version = 0;
  }

  // ---- players -----------------------------------------------------------
  player(id) { return this.players.find((p) => p.id === id); }
  connected() { return this.players.filter((p) => p.connected); }

  join(id, name) {
    let p = this.player(id);
    if (p) {
      p.connected = true;
      if (name) p.name = cleanName(name);
    } else {
      if (this.players.length >= 16) throw new Error('This room is full (16 players).');
      p = { id, name: cleanName(name), score: 0, connected: true };
      this.players.push(p);
    }
    if (!this.hostId || !this.player(this.hostId)?.connected) this.hostId = id;
    this.bump();
    return p;
  }

  leave(id) {
    const p = this.player(id);
    if (!p) return;
    p.connected = false;
    if (this.phase === 'lobby') this.players = this.players.filter((x) => x.id !== id);
    if (this.hostId === id) this.hostId = this.connected()[0]?.id || null;
    this.bump();
  }

  kick(by, targetId) {
    this.requireHost(by);
    if (targetId === by) throw new Error('You cannot remove yourself.');
    this.players = this.players.filter((p) => p.id !== targetId);
    if (targetId === this.pickerId || targetId === this.guesserId) this.endRound(null, 'skipped');
    this.bump();
  }

  requireHost(id) { if (id !== this.hostId) throw new Error('Only the host can do that.'); }

  // ---- lobby -------------------------------------------------------------
  updateSettings(by, s) {
    this.requireHost(by);
    if (this.phase !== 'lobby' && this.phase !== 'over') throw new Error('Settings are locked during a game.');
    const now = new Date().getFullYear();
    let yf = Math.round(Number(s.yearFrom)), yt = Math.round(Number(s.yearTo));
    if (!Number.isFinite(yf)) yf = this.settings.yearFrom;
    if (!Number.isFinite(yt)) yt = yf;
    yf = Math.min(now, Math.max(1920, yf));
    yt = Math.min(now, Math.max(1920, yt));
    if (yt < yf) [yf, yt] = [yt, yf];
    const genres = Array.isArray(s.genres) ? [...new Set(s.genres.map(Number).filter((g) => GENRE_NAME[g]))] : this.settings.genres;
    const laps = Math.min(5, Math.max(1, Math.round(Number(s.laps)) || 1));
    this.settings = { yearFrom: yf, yearTo: yt, genres, laps };
    this.bump();
  }

  start(by) {
    this.requireHost(by);
    if (this.phase !== 'lobby' && this.phase !== 'over') throw new Error('The game has already started.');
    const n = this.connected().length;
    if (n < 2) throw new Error('You need at least 2 players to start.');
    for (const p of this.players) p.score = 0;
    this.players = this.players.filter((p) => p.connected);
    this.totalRounds = n * this.settings.laps;
    this.round = 0;
    this.history = [];
    this.beginRound();
  }

  beginRound() {
    const conn = this.connected();
    if (conn.length < 2) { this.phase = 'over'; this.bump(); return; }
    this.pickerId = conn[this.round % conn.length].id;
    this.guesserId = conn[(this.round + 1) % conn.length].id;
    this.movie = null;
    this.useFile = false;
    this.attempts = [];
    this.result = null;
    this.phase = 'pick';
    this.bump();
  }

  // ---- round -------------------------------------------------------------
  async pick(by, { movieId, customTitle, fileRuntime, useFile }) {
    if (this.phase !== 'pick') throw new Error('It is not time to pick a movie.');
    if (by !== this.pickerId) throw new Error('Only the picker chooses the movie.');
    const runtimeFromFile = Number(fileRuntime) > 0 ? Math.floor(Number(fileRuntime) / 60) : null;
    if (movieId) {
      const d = await this.provider.details(movieId);
      if (this.phase !== 'pick') throw new Error('The round moved on.');
      if (!useFile && !(d.videos && d.videos.length) && d.frames.length === 0) throw new Error('This movie has no trailer or stills. Pick another, or use your own video file.');
      this.movie = { ...d, runtime: (useFile && runtimeFromFile) || d.runtime };
    } else {
      const title = String(customTitle || '').trim().slice(0, 120);
      if (!title) throw new Error('Pick a movie from the list or type its exact title.');
      if (!useFile) throw new Error('A typed-in movie needs your own video file for the frames.');
      this.movie = { id: null, title, originalTitle: title, year: null, runtime: runtimeFromFile || 120, poster: null, genres: [], frames: [] };
    }
    this.movie.runtime = Math.max(2, this.movie.runtime);
    this.useFile = !!useFile;
    if (this.useFile) {
      this.phase = 'minute';
      this.bump();
    } else {
      this.newMoment();
    }
  }

  chooseMinute(by, minute) {
    if (this.phase !== 'minute') throw new Error('It is not time to choose a minute.');
    if (by !== this.guesserId) throw new Error('Only the guesser chooses the minute.');
    const m = Math.round(Number(minute));
    if (!Number.isFinite(m) || m < 1 || m > this.movie.runtime) throw new Error(`Choose a minute between 1 and ${this.movie.runtime}.`);
    if (this.attempts.some((a) => a.minute === m)) throw new Error('You already saw that minute. Choose another.');
    const attempt = { minute: m, frame: null, guess: null, correct: null, still: null };
    if (this.useFile) {
      this.attempts.push(attempt);
      this.phase = 'capture';
    } else {
      // The picker previews the still first and can swap it out if it gives
      // the title away (fan posters, title cards).
      attempt.still = pickStillIndex(m, this.movie.runtime, this.movie.frames.length, this.usedStills());
      attempt.frame = this.movie.frames[attempt.still];
      attempt.rejected = [];
      this.attempts.push(attempt);
      this.phase = 'capture';
    }
    this.bump();
  }

  // Movie-database rounds: a random moment from the official trailer (or a
  // random still when there is no trailer). The picker previews it first.
  newMoment() {
    const a = { minute: null, frame: null, guess: null, correct: null, still: null, rejected: [] };
    if (this.movie.videos && this.movie.videos.length) {
      a.kind = 'trailer';
      this.rollVideo(a);
    } else {
      a.kind = 'still';
      a.still = this.randomStill();
      a.frame = this.movie.frames[a.still];
    }
    this.attempts.push(a);
    this.phase = 'capture';
    this.bump();
  }

  // Pick a video (trailer or clip), favouring ones not shown yet this round,
  // and a random point in it.
  rollVideo(a) {
    const vids = this.movie.videos;
    const seen = this.attempts.map((x) => x.video).concat(a.video ? [a.video] : []);
    const fresh = vids.filter((v) => !seen.includes(v.key));
    const pool = fresh.length ? fresh : vids;
    const v = pool[Math.floor(Math.random() * pool.length)];
    a.video = v.key;
    a.source = v.kind;
    a.at = Math.random();
  }

  randomStill() {
    const used = this.usedStills();
    const free = this.movie.frames.map((_, i) => i).filter((i) => !used.includes(i));
    const pool = free.length ? free : this.movie.frames.map((_, i) => i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  usedStills() {
    return this.attempts.flatMap((a) => [a.still, ...(a.rejected || [])]).filter((x) => x != null);
  }

  swapFrame(by) {
    if (this.phase !== 'capture' || this.useFile) throw new Error('No frame to swap right now.');
    if (by !== this.pickerId) throw new Error('Only the picker can swap the frame.');
    const a = this.attempts[this.attempts.length - 1];
    if (a.kind === 'trailer') {
      this.rollVideo(a);
      this.bump();
      return;
    }
    const used = this.usedStills();
    const n = this.movie.frames.length;
    if (used.length >= n) throw new Error('That was the last still for this movie. Show it, or skip the round.');
    a.rejected.push(a.still);
    a.still = a.minute ? pickStillIndex(a.minute, this.movie.runtime, n, [...used]) : this.randomStill();
    a.frame = this.movie.frames[a.still];
    this.bump();
  }

  approveFrame(by) {
    if (this.phase !== 'capture' || this.useFile) throw new Error('No frame to approve right now.');
    if (by !== this.pickerId) throw new Error('Only the picker approves the frame.');
    this.phase = 'guess';
    this.bump();
  }

  submitFrame(by, dataUrl) {
    if (this.phase !== 'capture') throw new Error('No frame is needed right now.');
    if (by !== this.pickerId) throw new Error('Only the picker sends the frame.');
    if (typeof dataUrl !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new Error('That frame is not a valid image.');
    if (dataUrl.length > 2_500_000) throw new Error('That frame is too large.');
    const i = this.attempts.length - 1;
    const a = this.attempts[i];
    a.frameData = dataUrl;
    a.frame = `/frame/${this.code}/${i}-${Math.random().toString(36).slice(2, 10)}`;
    this.phase = 'guess';
    this.bump();
  }

  guess(by, text) {
    if (this.phase !== 'guess') throw new Error('It is not time to guess.');
    if (by !== this.guesserId) throw new Error('Only the guesser can guess this round.');
    const g = String(text || '').trim().slice(0, 120);
    if (!g) throw new Error('Type a movie title.');
    const a = this.attempts[this.attempts.length - 1];
    a.guess = g;
    a.correct = isCorrectGuess(g, [this.movie.title, this.movie.originalTitle, ...(this.movie.altTitles || [])]);
    if (a.correct) {
      this.endRound(this.guesserId, 'solved');
    } else if (this.attempts.length >= MAX_ATTEMPTS) {
      this.endRound(this.pickerId, 'stumped');
    } else if (this.useFile) {
      this.phase = 'minute';
      this.bump();
    } else {
      this.newMoment();
    }
  }

  giveUp(by) {
    if (by !== this.guesserId) throw new Error('Only the guesser can give up.');
    if (!['minute', 'guess', 'capture'].includes(this.phase)) throw new Error('Nothing to give up on.');
    this.endRound(this.pickerId, 'stumped');
  }

  skip(by) {
    this.requireHost(by);
    if (['lobby', 'reveal', 'over'].includes(this.phase)) throw new Error('Nothing to skip.');
    this.endRound(null, 'skipped');
  }

  endRound(winnerId, how) {
    let points = 0;
    if (how === 'solved') points = POINTS[this.attempts.length - 1] || 1;
    if (how === 'stumped') points = STUMP_POINTS;
    const w = winnerId && this.player(winnerId);
    if (w) w.score += points;
    this.result = { how, winnerId: w ? w.id : null, points };
    this.history.push({
      round: this.round + 1,
      title: this.movie?.title || '(no movie)',
      year: this.movie?.year || null,
      pickerId: this.pickerId,
      guesserId: this.guesserId,
      how,
      points,
    });
    this.phase = 'reveal';
    this.bump();
  }

  next(by) {
    if (this.phase !== 'reveal') throw new Error('Finish the round first.');
    if (![this.hostId, this.pickerId, this.guesserId].includes(by)) throw new Error('The host moves the game on.');
    this.round += 1;
    if (this.round >= this.totalRounds) {
      this.phase = 'over';
      this.bump();
    } else {
      this.beginRound();
    }
  }

  backToLobby(by) {
    this.requireHost(by);
    this.phase = 'lobby';
    this.players = this.players.filter((p) => p.connected);
    for (const p of this.players) p.score = 0;
    this.pickerId = this.guesserId = null;
    this.movie = null;
    this.attempts = [];
    this.result = null;
    this.bump();
  }

  frameData(name) {
    const a = this.attempts.find((x) => x.frame && x.frame.endsWith('/' + name));
    return a ? a.frameData : null;
  }

  bump() { this.version += 1; this.touched = Date.now(); }

  // ---- what each player may see -----------------------------------------
  viewFor(id) {
    const showMovie = id === this.pickerId || this.phase === 'reveal' || this.phase === 'over';
    const m = this.movie;
    return {
      code: this.code,
      you: id,
      hostId: this.hostId,
      players: this.players.map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected })),
      settings: this.settings,
      phase: this.phase,
      round: this.round + 1,
      totalRounds: this.totalRounds,
      pickerId: this.pickerId,
      guesserId: this.guesserId,
      maxAttempts: MAX_ATTEMPTS,
      points: POINTS,
      useFile: this.useFile,
      runtime: m ? m.runtime : null,
      movie: m && showMovie ? { id: m.id, title: m.title, year: m.year, poster: m.poster, genres: m.genres, runtime: m.runtime } : null,
      attempts: this.attempts.map((a, i) => {
        // While the picker previews a moment, only the picker sees it.
        const hidden = this.phase === 'capture' && i === this.attempts.length - 1 && id !== this.pickerId;
        return {
          kind: a.kind || (this.useFile ? 'file' : 'still'),
          minute: a.minute,
          frame: hidden ? null : a.frame,
          at: hidden ? null : a.at ?? null,
          video: hidden ? null : a.video || null,
          source: hidden ? null : a.source || null,
          guess: a.guess,
          correct: a.correct,
        };
      }),
      trailer: m && showMovie && m.trailerKey ? m.trailerKey : null,
      stillsLeft: m && !this.useFile && !(m.videos && m.videos.length) ? m.frames.length - this.usedStills().length : null,
      result: this.result,
      history: this.history,
      provider: this.provider.name,
    };
  }
}

module.exports = { Room, makeCode, MAX_ATTEMPTS, POINTS };
