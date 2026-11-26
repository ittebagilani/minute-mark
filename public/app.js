/* Minute Mark client. The server owns the game; this file draws each
   player's view and sends their actions. */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const $bar = document.getElementById('barRight');
  const $toast = document.getElementById('toast');

  // ---- identity (kept per browser) ----------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    sset(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  function randomId() {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  }
  let playerId = store.sget('mm-player') || store.get('mm-player');
  if (!playerId || !/^[a-zA-Z0-9_-]{8,40}$/.test(playerId)) playerId = randomId();
  // Each tab is its own player, so two tabs on one computer can both play.
  store.sset('mm-player', playerId);

  const S = {
    meta: { genres: [], provider: 'demo', year: new Date().getFullYear() },
    view: null,
    lastJson: '',
    browse: { query: '', page: 1, results: [], totalPages: 1, loading: false, selected: null, error: '', forRound: null },
    file: { file: null, url: null, duration: 0, video: null, useFile: false, customTitle: '' },
    minute: null,
    captured: new Set(),
    busy: false,
  };

  // ---- helpers -------------------------------------------------------------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (typeof u === 'string' && (/^https:\/\//.test(u) || /^\/[a-z]/.test(u)) ? u : '');
  const tc = (min) => {
    const h = Math.floor(min / 60), m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  };
  const tcHtml = (min) => {
    const h = Math.floor(min / 60), m = min % 60;
    return `<span class="h">${String(h).padStart(2, '0')}:</span>${String(m).padStart(2, '0')}<span class="s">:00</span>`;
  };
  const nameOf = (id) => S.view?.players.find((p) => p.id === id)?.name || 'Someone';
  const me = () => S.view?.you;
  const isHost = () => S.view && S.view.hostId === me();

  let toastTimer;
  function toast(msg, err = false) {
    $toast.textContent = msg;
    $toast.className = 'toast' + (err ? ' err' : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, err ? 4200 : 2400);
  }

  // ---- socket --------------------------------------------------------------
  const socket = io({ transports: ['websocket', 'polling'] });

  function send(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(15000).emit(event, payload, (err, res) => {
        if (err) { toast('The server did not answer. Check your connection.', true); return resolve({ ok: false }); }
        if (!res.ok) toast(res.error, true);
        resolve(res);
      });
    });
  }

  socket.on('connect', async () => {
    const code = store.sget('mm-room');
    const name = store.get('mm-name');
    if (code && name) {
      const res = await send('join', { code, name, playerId });
      if (!res.ok) { store.sset('mm-room', null); S.view = null; render(true); }
    }
  });
  socket.on('disconnect', () => toast('Connection lost. Reconnecting…', true));
  socket.on('state', (v) => {
    const json = JSON.stringify(v);
    if (json === S.lastJson) return;
    S.lastJson = json;
    S.view = v;
    store.sset('mm-room', v.code);
    render();
    afterState();
  });
  socket.on('kicked', () => {
    store.sset('mm-room', null);
    S.view = null;
    S.lastJson = '';
    render(true);
    toast('The host removed you from the room.', true);
  });

  fetch('/api/meta').then((r) => r.json()).then((m) => { S.meta = m; render(true); }).catch(() => {});

  // ---- render --------------------------------------------------------------
  function render() {
    // Keep whatever the player is typing across re-renders.
    const a = document.activeElement;
    const keep = a && a.id && $app.contains(a) ? { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;

    renderBar();
    const v = S.view;
    if (!v) $app.innerHTML = homeView();
    else if (v.phase === 'lobby') $app.innerHTML = lobbyView();
    else $app.innerHTML = gameView();

    mountPlayers();
    if (!document.getElementById('guessInput')) sug.items = [];
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) {
        if ('value' in el && el.type !== 'range' && el.type !== 'file' && el.type !== 'checkbox') el.value = keep.value;
        el.focus({ preventScroll: true });
        try { if (keep.start != null) el.setSelectionRange(keep.start, keep.end); } catch { /* not a text input */ }
      }
    }
    if (sug.items.length && document.activeElement?.id === 'guessInput') drawSuggest();
  }

  // ---- guess autocomplete ----------------------------------------------------
  const sug = { items: [], active: -1, timer: 0, seq: 0, last: '' };
  function hideSuggest() {
    sug.items = []; sug.active = -1; sug.seq++;
    clearTimeout(sug.timer);
    const ul = document.getElementById('suggestList');
    if (ul) { ul.hidden = true; ul.innerHTML = ''; }
    document.getElementById('guessInput')?.setAttribute('aria-expanded', 'false');
  }
  function drawSuggest() {
    const ul = document.getElementById('suggestList');
    const input = document.getElementById('guessInput');
    if (!ul || !input) return;
    if (!sug.items.length) { ul.hidden = true; ul.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); return; }
    ul.innerHTML = sug.items.map((m, i) => `<li role="option" id="sug${i}" data-sug="${i}" aria-selected="${i === sug.active}" class="${i === sug.active ? 'on' : ''}">
      <span>${esc(m.title)}</span>${m.year ? `<span class="sug-year">${m.year}</span>` : ''}</li>`).join('');
    ul.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (sug.active >= 0) input.setAttribute('aria-activedescendant', `sug${sug.active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function querySuggest(text) {
    const q = text.trim();
    clearTimeout(sug.timer);
    if (q.length < 2) { hideSuggest(); return; }
    if (q === sug.last && sug.items.length) return;
    const seq = ++sug.seq;
    sug.timer = setTimeout(async () => {
      const res = await send('suggest', { query: q });
      if (seq !== sug.seq) return; // a newer keystroke won
      sug.last = q;
      sug.items = res.ok ? (res.results || []) : [];
      sug.active = -1;
      drawSuggest();
    }, 180);
  }
  function chooseSuggest(i) {
    const m = sug.items[i];
    const input = document.getElementById('guessInput');
    if (!m || !input) return;
    input.value = m.title;
    sug.last = m.title;
    hideSuggest();
    input.focus();
  }
  $app.addEventListener('pointerdown', (e) => {
    const li = e.target.closest?.('[data-sug]');
    if (li) { e.preventDefault(); chooseSuggest(Number(li.dataset.sug)); }
    else if (!e.target.closest?.('.combo')) hideSuggest();
  });

  function renderBar() {
    const v = S.view;
    $bar.innerHTML = v
      ? `<span class="chip-code" title="Room code">${esc(v.code)}</span><button class="btn btn-sm btn-ghost" data-act="leave">Leave</button>`
      : '';
  }

  // ---- home ----------------------------------------------------------------
  function homeView() {
    const params = new URLSearchParams(location.search);
    const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const name = store.get('mm-name') || '';
    return `
    <section class="home">
      <div class="home-hero">
        <p class="eyebrow">A party game for 2 to 16 film fans</p>
        <h1>One frame.<br><span>Name the film.</span></h1>
        <p class="lede">One player secretly picks a movie. The next sees one frozen moment from its trailer or clips and has three tries to name the exact title.</p>
        <ol class="how">
          <li><span><b>The host sets the shelf:</b> a year or range of years and any mix of genres.</span></li>
          <li><span><b>The picker</b> chooses a movie in secret from that shelf.</span></li>
          <li><span><b>The guesser</b> sees a random paused moment from the movie's official trailer or clips. Every miss shows a new moment.</span></li>
          <li><span><b>Exact title wins:</b> 3 points on the first try, 2 on the second, 1 on the third. Stump them and the picker scores 1.</span></li>
        </ol>
      </div>
      <div class="panel stack">
        <label class="field">Your name
          <input class="input" id="nameInput" maxlength="20" autocomplete="nickname" placeholder="e.g. Sam" value="${esc(name)}">
        </label>
        <button class="btn btn-primary btn-big" data-act="create">Create a room</button>
        <div class="or">or join one</div>
        <label class="field">Room code
          <input class="input input-code" id="codeInput" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" value="${esc(code)}">
        </label>
        <button class="btn btn-big" data-act="join">Join room</button>
      </div>
    </section>`;
  }

  // ---- lobby ---------------------------------------------------------------
  function genreNames(ids) {
    const map = Object.fromEntries(S.meta.genres.map((g) => [g.id, g.name]));
    return ids.map((id) => map[id]).filter(Boolean);
  }

  function playersList(withKick) {
    const v = S.view;
    return `<ul class="players">${v.players.map((p) => `
      <li class="player${p.connected ? '' : ' off'}">
        <span class="dot" aria-hidden="true"></span>
        <span class="name">${esc(p.name)}</span>
        ${p.id === v.hostId ? '<span class="tag tag-host">Host</span>' : ''}
        ${p.id === v.you ? '<span class="tag tag-you">You</span>' : ''}
        ${withKick && isHost() && p.id !== v.you ? `<button class="btn btn-sm btn-ghost btn-danger" data-act="kick" data-id="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button>` : ''}
      </li>`).join('')}</ul>`;
  }

  function lobbyView() {
    const v = S.view, s = v.settings, host = isHost();
    const link = `${location.origin}/?room=${v.code}`;
    const n = v.players.filter((p) => p.connected).length;
    const yearMax = S.meta.year;
    const genreButtons = S.meta.genres.map((g) => `
      <button class="genre" data-act="genre" data-id="${g.id}" aria-pressed="${s.genres.includes(g.id)}" ${host ? '' : 'disabled'}>${esc(g.name)}</button>`).join('');
    return `
    <section class="lobby">
      <div class="stack">
        <div class="panel code-card">
          <span class="eyebrow">Room code</span>
          <div class="code-big">${esc(v.code)}</div>
          <p class="muted">Friends open this site and type the code, or use the link.</p>
          <div class="row" style="justify-content:center">
            <button class="btn btn-sm" data-act="copy" data-text="${esc(link)}">Copy invite link</button>
          </div>
        </div>
        <div class="panel stack">
          <div class="roundline"><h3>Players</h3><span class="muted mono">${n}/16</span></div>
          ${playersList(true)}
        </div>
      </div>
      <div class="panel stack">
        <div>
          <p class="eyebrow">${host ? 'You are the host' : `${esc(nameOf(v.hostId))} is the host`}</p>
          <h2>Tonight's shelf</h2>
        </div>
        <div class="years">
          <label class="field">From year
            <input class="input mono" id="yearFrom" type="number" min="1920" max="${yearMax}" value="${s.yearFrom}" ${host ? '' : 'disabled'}>
          </label>
          <label class="field">To year
            <input class="input mono" id="yearTo" type="number" min="1920" max="${yearMax}" value="${s.yearTo}" ${host ? '' : 'disabled'}>
          </label>
          <label class="field">Turns each
            <select class="input" id="laps" ${host ? '' : 'disabled'}>
              ${[1, 2, 3, 4, 5].map((k) => `<option value="${k}" ${k === s.laps ? 'selected' : ''}>${k}</option>`).join('')}
            </select>
          </label>
        </div>
        <p class="notice">Same year in both boxes for a single year. Each player picks ${s.laps === 1 ? 'once' : s.laps + ' times'} and guesses ${s.laps === 1 ? 'once' : s.laps + ' times'}: ${n * s.laps} rounds with ${n} players.</p>
        <div class="stack" style="gap:10px">
          <div class="roundline"><span class="eyebrow">Genres</span><span class="muted" style="font-size:13px">${s.genres.length ? s.genres.length + ' picked' : 'None picked means any genre'}</span></div>
          <div class="genres">${genreButtons}</div>
        </div>
        ${S.meta.provider === 'demo' ? '<p class="notice">Demo mode: this server has no movie database key, so the shelf holds 8 made-up films. Pickers can still use their own video files for real movies.</p>' : ''}
        <div class="row">
          ${host
            ? `<button class="btn btn-primary btn-big" data-act="start" ${n < 2 ? 'disabled' : ''}>Start the game</button>
               ${n < 2 ? '<span class="muted">Waiting for at least one more player.</span>' : ''}`
            : '<div class="wait"><span class="reel-spin" aria-hidden="true"></span>Waiting for the host to start.</div>'}
        </div>
      </div>
    </section>`;
  }

  // ---- game ----------------------------------------------------------------
  function gameView() {
    const v = S.view;
    return `
    <section class="game">
      <div class="stage">
        ${v.phase !== 'over' ? roundHeader() : ''}
        ${stageView()}
      </div>
      <aside class="board">
        <div class="panel stack" style="gap:12px">
          <h3>Scores</h3>
          ${scoreList()}
          ${isHost() && !['reveal', 'over'].includes(v.phase) ? '<button class="btn btn-sm btn-ghost" data-act="skip">Skip this round</button>' : ''}
        </div>
      </aside>
    </section>`;
  }

  function scoreList() {
    const v = S.view;
    const sorted = [...v.players].sort((a, b) => b.score - a.score);
    return `<ol class="score-list">${sorted.map((p, i) => {
      const role = p.id === v.pickerId ? 'Picker' : p.id === v.guesserId ? 'Guesser' : '';
      return `<li class="score-row${p.id === v.you ? ' me' : ''}"${p.connected ? '' : ' style="opacity:.5"'}>
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(p.name)}${p.id === v.you ? ' (you)' : ''}${role && !['over'].includes(v.phase) ? `<span class="sub">${role}</span>` : ''}${p.connected ? '' : '<span class="sub">Offline</span>'}</span>
        <span class="pts">${p.score}</span>
      </li>`;
    }).join('')}</ol>`;
  }

  function roundHeader() {
    const v = S.view;
    return `<div class="roundline">
      <div><p class="eyebrow">Round ${v.round} of ${v.totalRounds}</p></div>
      <div class="roles">
        <span class="role">Picker <b>${esc(nameOf(v.pickerId))}</b></span>
        <span class="role">·</span>
        <span class="role">Guesser <b>${esc(nameOf(v.guesserId))}</b></span>
      </div>
    </div>`;
  }

  // ---- frames: an image, or a paused moment of the official trailer --------

  const LOADING = '<span class="load"><span class="reel-spin" aria-hidden="true"></span><span>Loading the moment…</span></span>';
  // 'slow': the moment plays muted at quarter speed (no YouTube play icon).
  // 'frozen': one paused frame; YouTube draws a play icon, hidden by a dot.
  const MOMENT_MODE = 'slow';
  // Seconds of footage in each slow-motion loop (4x longer on screen at 0.25x).
  const LOOP_SECONDS = 2;

  function momentHtml(a, opts = {}) {
    const v = S.view;
    if (a.kind === 'trailer') {
      if (!a.video || a.at == null) return '<div class="screen wide"><div class="waiting">No moment yet</div></div>';
      return `<div class="screen wide${opts.small ? ' small' : ''}">
        <div class="yt-crop"><div class="yt-slot" data-key="${esc(a.video)}" data-src="${a.source === 'clip' ? 'CLIP' : 'TRAILER'}" data-at="${Number(a.at)}"></div></div>
        <div class="yt-shield" aria-hidden="true"></div>
        <div class="yt-cover">${LOADING}</div>
      </div>`;
    }
    // Only own-file rounds show a timecode (the guesser chose that minute).
    return `<div class="screen${opts.anim ? ' reveal-in' : ''}">
      ${safeUrl(a.frame) ? `<img src="${esc(safeUrl(a.frame))}" alt="${opts.alt || 'A frame from the secret movie'}">` : '<div class="waiting">No frame</div>'}
      ${a.minute ? `<span class="tc">${tc(a.minute)}</span>` : ''}
    </div>`;
  }

  let ytReady = null;
  function loadYouTube() {
    if (ytReady) return ytReady;
    ytReady = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.onerror = () => { ytReady = null; reject(new Error('YouTube blocked')); };
      document.head.appendChild(tag);
    });
    return ytReady;
  }

  // Mount a muted player for each trailer slot, jump to the moment, let it
  // render one frame, then pause. The shield on top blocks clicks so nobody
  // can scrub, unpause or open the video on YouTube.
  async function mountPlayers() {
    const slots = [...$app.querySelectorAll('.yt-slot:not([data-mounted])')];
    if (!slots.length) return;
    let YT;
    try { YT = await loadYouTube(); } catch {
      slots.forEach((el) => { const c = el.closest('.screen').querySelector('.yt-cover'); if (c) c.textContent = 'YouTube could not load here. Check that it is not blocked.'; });
      return;
    }
    for (const el of slots) {
      if (!el.isConnected) continue;
      el.dataset.mounted = '1';
      const screen = el.closest('.screen');
      const frac = Number(el.dataset.at) || 0;
      let target = 0, paused = false, ready = false, shown = false, loopTimer = null;
      if (MOMENT_MODE === 'frozen') screen.classList.add('frozen');
      const reveal = () => { clearTimeout(stuck); screen.classList.add('yt-on'); };
      const roll = (p) => { p.mute(); p.seekTo(target, true); p.playVideo(); };
      // Some browsers block autoplay. If the moment hasn't appeared after a few
      // seconds, offer a tap: a click on our own button counts as permission.
      const stuck = setTimeout(() => {
        if (screen.classList.contains('yt-on') || !screen.isConnected) return;
        const c = screen.querySelector('.yt-cover');
        if (!c) return;
        c.innerHTML = '<button class="btn btn-primary" type="button">Tap to show the moment</button>';
        c.querySelector('button').addEventListener('click', () => {
          c.innerHTML = LOADING;
          if (ready) roll(player);
        });
      }, 4000);
      const player = new YT.Player(el, {
        videoId: el.dataset.key,
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, cc_load_policy: 0 },
        events: {
          onReady: (e) => {
            const dur = e.target.getDuration() || 150;
            // Skip the studio logos at the start and the title card at the end.
            target = dur > 40 ? 10 + frac * (dur - 22) : frac * dur * 0.8;
            ready = true;
            roll(e.target);
          },
          onStateChange: (e) => {
            if (MOMENT_MODE === 'slow') {
              if (e.data === YT.PlayerState.PLAYING) {
                e.target.setPlaybackRate(0.25);
                // First start waits a moment for the rate change; a loop restart
                // (about 0.3 s of buffering) shows again straight away.
                if (shown) reveal(); else { shown = true; setTimeout(reveal, 400); }
                // After LOOP_SECONDS of footage, go back to the start of the
                // moment, behind the loading cover.
                clearInterval(loopTimer);
                loopTimer = setInterval(() => {
                  if (!screen.isConnected) return clearInterval(loopTimer);
                  if (e.target.getCurrentTime() > target + LOOP_SECONDS) {
                    screen.classList.remove('yt-on');
                    e.target.seekTo(target, true);
                  }
                }, 250);
              } else if (e.data === YT.PlayerState.ENDED) {
                screen.classList.remove('yt-on');
                roll(e.target);
              }
              return;
            }
            if (e.data === YT.PlayerState.PLAYING && !paused) {
              paused = true;
              setTimeout(() => {
                e.target.pauseVideo();
                e.target.seekTo(target, true);
                setTimeout(reveal, 350);
              }, 250);
            }
          },
          onError: () => { const c = screen.querySelector('.yt-cover'); if (c) c.textContent = 'This trailer cannot be shown here. The picker can reroll or the host can skip.'; },
        },
      });
    }
  }

  function waiting(text) {
    return `<div class="panel"><div class="wait"><span class="reel-spin" aria-hidden="true"></span><span>${text}</span></div></div>`;
  }

  function stageView() {
    const v = S.view, you = v.you;
    const picker = you === v.pickerId, guesser = you === v.guesserId;
    switch (v.phase) {
      case 'pick':
        return picker ? pickView() : waiting(`<b>${esc(nameOf(v.pickerId))}</b> is secretly choosing a movie.`);
      case 'minute':
        return (guesser ? minuteView() : waiting(`<b>${esc(nameOf(v.guesserId))}</b> is choosing a minute to look at.`) + pickerNote()) + reel();
      case 'capture':
        return captureView() + reel(true);
      case 'guess':
        return guessView() + reel(true);
      case 'reveal':
        return revealView();
      case 'over':
        return overView();
      default:
        return '';
    }
  }

  function pickerNote() {
    const v = S.view;
    if (v.you !== v.pickerId || !v.movie) return '';
    return `<p class="notice">Your secret pick: <b>${esc(v.movie.title)}</b>${v.movie.year ? ` (${v.movie.year})` : ''}. Keep a straight face.</p>`;
  }

  // Picker: choose a movie from the host's shelf.
  function pickView() {
    const v = S.view, b = S.browse, f = S.file;
    const genres = genreNames(v.settings.genres);
    const sel = b.selected;
    const shelf = `${v.settings.yearFrom === v.settings.yearTo ? v.settings.yearFrom : `${v.settings.yearFrom} to ${v.settings.yearTo}`} · ${genres.length ? esc(genres.join(', ')) : 'any genre'}`;
    const grid = b.loading && !b.results.length
      ? '<p class="muted">Loading movies…</p>'
      : b.error ? `<p class="muted">${esc(b.error)}</p>`
      : b.results.length ? `<div class="movies">${b.results.map((m) => `
          <button class="movie" data-act="select" data-id="${m.id}" aria-pressed="${sel && sel.id === m.id}">
            <span class="poster">${safeUrl(m.poster) ? `<img src="${esc(safeUrl(m.poster))}" alt="" loading="lazy">` : ''}</span>
            <span class="t">${esc(m.title)}</span>
            <span class="y">${esc(m.year || '')}</span>
          </button>`).join('')}</div>`
      : '<p class="muted">No movies found on this shelf. Try another search.</p>';
    const canLock = (sel || (f.useFile && f.customTitle.trim())) && (!f.useFile || f.file);
    return `
    <div class="panel stack">
      <div>
        <p class="eyebrow">Your turn to pick · only you can see this</p>
        <h2>Choose a movie</h2>
        <p class="muted">Shelf: ${shelf}</p>
      </div>
      <form class="browser-tools" data-form="search">
        <input class="input" id="searchInput" placeholder="Search a title on this shelf" value="${esc(b.query)}" autocomplete="off">
        <button class="btn" type="submit">Search</button>
      </form>
      ${b.query ? `<button class="btn btn-sm btn-ghost" data-act="clearSearch" style="justify-self:start">Back to popular picks</button>` : ''}
      ${grid}
      ${!b.query && b.page < b.totalPages && b.results.length ? `<button class="btn btn-sm" data-act="more" style="justify-self:start" ${b.loading ? 'disabled' : ''}>More movies</button>` : ''}
      <div class="filebox">
        <label class="check">
          <input type="checkbox" id="useFile" ${f.useFile ? 'checked' : ''}>
          <span><b>Use my own video file for exact frames.</b><br><span class="muted">The game grabs the real frame at the guesser's minute from a movie file on this device. The file never leaves your computer; only the single frame is shared. Keep this tab open until the round ends.</span></span>
        </label>
        ${f.useFile ? `
          <input class="input" type="file" id="videoFile" accept="video/*">
          ${f.file ? `<p class="muted">Loaded <b>${esc(f.file.name)}</b> (${Math.round(f.duration / 60)} min).</p>` : '<p class="muted">Choose the movie file (MP4 or WebM play best).</p>'}
          ${!sel ? `<label class="field">Not on the list? Type its exact title
            <input class="input" id="customTitle" maxlength="120" placeholder="Exact movie title" value="${esc(f.customTitle)}">
          </label>` : ''}` : ''}
      </div>
      ${sel ? `<div class="chosen">${safeUrl(sel.poster) ? `<img src="${esc(safeUrl(sel.poster))}" alt="">` : '<span></span>'}<div><p class="eyebrow">Selected</p><h3>${esc(sel.title)}</h3><p class="muted mono">${esc(sel.year || '')}</p></div></div>` : ''}
      <div class="row">
        <button class="btn btn-primary btn-big" data-act="lock" ${canLock && !S.busy ? '' : 'disabled'}>Lock it in</button>
        ${!canLock ? `<span class="muted">${f.useFile && !f.file ? 'Choose your video file first.' : 'Tap a poster to select a movie.'}</span>` : ''}
      </div>
    </div>`;
  }

  // Guesser: pick the minute.
  function minuteView() {
    const v = S.view;
    const max = v.runtime || 120;
    const used = v.attempts.map((a) => a.minute);
    if (S.minute == null || S.minute > max || used.includes(S.minute)) {
      S.minute = Math.min(max, 15);
      while (used.includes(S.minute) && S.minute < max) S.minute++;
    }
    const tryNo = v.attempts.length + 1;
    const marks = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.max(1, Math.round(p * max)));
    return `
    <div class="panel stack">
      <div class="roundline">
        <div>
          <p class="eyebrow">Your call · try ${tryNo} of ${v.maxAttempts} · worth ${v.points[tryNo - 1]} point${v.points[tryNo - 1] === 1 ? '' : 's'}</p>
          <h2>Pick a minute</h2>
        </div>
        ${pips()}
      </div>
      <p class="muted">This film runs about ${max} minutes. Choose any minute and you'll see the frame at that mark.</p>
      <div class="dial">
        <div class="timecode" id="tcOut" aria-live="polite">${tcHtml(S.minute)}</div>
        <input type="range" id="minuteRange" min="1" max="${max}" value="${S.minute}" aria-label="Minute">
        <div class="ticks">${marks.map((m) => `<span>${m}m</span>`).join('')}</div>
        <div class="row">
          <label class="field" style="width:130px">Minute
            <input class="input mono" type="number" id="minuteNum" min="1" max="${max}" value="${S.minute}">
          </label>
          <button class="btn btn-primary btn-big" data-act="minute" style="align-self:end" ${S.busy ? 'disabled' : ''}>Show minute <span id="minuteLabel">${S.minute}</span></button>
        </div>
        ${used.length ? `<p class="muted">Already seen: ${used.map((m) => `minute ${m}`).join(', ')}</p>` : ''}
      </div>
    </div>`;
  }

  function pips() {
    const v = S.view;
    const done = v.attempts.filter((a) => a.guess != null).length;
    return `<div class="attempt-pips" aria-label="${done} of ${v.maxAttempts} tries used">${Array.from({ length: v.maxAttempts }, (_, i) => `<span class="pip${i < done ? ' used' : i === done ? ' now' : ''}"></span>`).join('')}</div>`;
  }

  function captureView() {
    const v = S.view;
    const last = v.attempts[v.attempts.length - 1];
    if (v.you === v.pickerId && !v.useFile) {
      const trailer = last.kind === 'trailer';
      return `${momentHtml(last, { alt: 'Candidate frame' })}
        <div class="panel stack">
          <div>
            <p class="eyebrow">Only you can see this · try ${v.attempts.length} of ${v.maxAttempts}</p>
            <h2>Check the ${trailer ? 'moment' : 'frame'}</h2>
          </div>
          <p class="muted">${trailer
            ? `A random moment from ${last.source === 'clip' ? 'an official clip' : 'the official trailer'}, playing silently in slow motion. If it shows the title, a logo or anything that gives the movie away, roll a new one.`
            : 'This movie has no trailer, so this is a still from the movie database. If it gives the movie away (fan posters, title cards), swap it.'}</p>
          <div class="row">
            <button class="btn btn-primary btn-big" data-act="approve">Show it to ${esc(nameOf(v.guesserId))}</button>
            <button class="btn" data-act="swap" ${trailer || v.stillsLeft > 0 ? '' : 'disabled'}>${trailer ? 'Roll another moment' : 'Swap for another still'}</button>
            ${trailer ? '' : `<span class="muted">${v.stillsLeft > 0 ? `${v.stillsLeft} more to choose from` : 'No more stills'}</span>`}
          </div>
        </div>`;
    }
    if (v.you === v.pickerId) {
      const ready = !!S.file.file;
      return `<div class="panel stack">
        <p class="eyebrow">Grabbing the frame</p>
        <h2>Minute ${last.minute}</h2>
        ${ready
          ? '<div class="wait"><span class="reel-spin" aria-hidden="true"></span>Capturing the frame from your video…</div>'
          : `<p class="muted">Your video file was unloaded (the page reloaded). Choose it again to send the frame.</p>
             <input class="input" type="file" id="videoFile" accept="video/*">`}
      </div>`;
    }
    return `<div class="screen"><div class="waiting">${v.useFile ? `Rolling to ${tc(last.minute)}…<br>${esc(nameOf(v.pickerId))} is grabbing the frame.` : `${esc(nameOf(v.pickerId))} is picking a moment for you…`}</div></div>`;
  }

  function guessView() {
    const v = S.view;
    const last = v.attempts[v.attempts.length - 1];
    const tryNo = v.attempts.length;
    const guesser = v.you === v.guesserId;
    return `
    ${momentHtml(last, { anim: true })}
    ${guesser ? `
      <form class="panel stack" data-form="guess">
        <div class="roundline">
          <p class="eyebrow">Try ${tryNo} of ${v.maxAttempts} · worth ${v.points[tryNo - 1]} point${v.points[tryNo - 1] === 1 ? '' : 's'}</p>
          ${pips()}
        </div>
        <label class="field" for="guessInput">The exact movie title</label>
        <div class="combo">
          <input class="input" id="guessInput" maxlength="120" autocomplete="off" placeholder="Start typing a title" autofocus
            role="combobox" aria-autocomplete="list" aria-controls="suggestList" aria-expanded="false">
          <ul class="suggest" id="suggestList" role="listbox" hidden></ul>
        </div>
        <p class="muted" style="font-size:14px">Pick from the list as you type. Sequels need their number or subtitle.</p>
        <div class="row">
          <button class="btn btn-primary btn-big" type="submit" ${S.busy ? 'disabled' : ''}>Lock in guess</button>
          <button class="btn btn-ghost" type="button" data-act="giveup">Give up</button>
        </div>
      </form>`
    : `${waiting(`<b>${esc(nameOf(v.guesserId))}</b> is studying the frame. Try ${tryNo} of ${v.maxAttempts}.`)}${pickerNote()}`}`;
  }

  function reel(skipLast) {
    const v = S.view;
    const list = v.attempts.filter((a) => a.guess != null && (a.frame || a.kind === 'trailer'));
    if (!list.length) return '';
    return `<div class="stack" style="gap:10px"><p class="eyebrow">Frames so far</p><div class="reel">${list.map((a) => `
      <div class="reel-item">
        <div class="thumb">${a.kind === 'trailer' ? `<span class="thumb-label">${a.source === 'clip' ? 'Clip' : 'Trailer'} moment</span>` : safeUrl(a.frame) ? `<img src="${esc(safeUrl(a.frame))}" alt="Earlier frame" loading="lazy">` : ''}</div>
        <div class="cap">${a.minute ? `<span class="mono">${tc(a.minute)}</span> · ` : ''}${a.correct ? '<span class="ok">✓</span>' : '<span class="x">✗</span>'} ${esc(a.guess)}</div>
      </div>`).join('')}</div></div>`;
  }

  function revealView() {
    const v = S.view, r = v.result || {}, m = v.movie;
    const guesser = esc(nameOf(v.guesserId)), picker = esc(nameOf(v.pickerId));
    let verdict, line;
    if (r.how === 'solved') {
      verdict = '<div class="verdict ok">Got it!</div>';
      line = `${guesser} named it on try ${v.attempts.length} for <b>${r.points} point${r.points === 1 ? '' : 's'}</b>.`;
    } else if (r.how === 'stumped') {
      verdict = '<div class="verdict x">Stumped</div>';
      line = `${picker} stumped ${guesser} and scores <b>${r.points} point</b>.`;
    } else {
      verdict = '<div class="verdict">Skipped</div>';
      line = 'The host skipped this round. No points.';
    }
    const canNext = [v.hostId, v.pickerId, v.guesserId].includes(v.you);
    const last = v.round >= v.totalRounds;
    return `
    <div class="panel stack">
      ${verdict}
      <p class="lede">${line}</p>
      ${m ? `<div class="reveal-card">
        ${safeUrl(m.poster) ? `<img src="${esc(safeUrl(m.poster))}" alt="Poster of ${esc(m.title)}">` : '<span></span>'}
        <div class="stack" style="gap:6px"><p class="eyebrow">The movie was</p><h2>${esc(m.title)}</h2>
        <p class="muted">${[m.year, m.runtime ? m.runtime + ' min' : '', (m.genres || []).join(', ')].filter(Boolean).map(esc).join(' · ')}</p>
        ${v.trailer ? `<a class="btn btn-sm" style="justify-self:start" href="https://www.youtube.com/watch?v=${esc(v.trailer)}" target="_blank" rel="noopener">Watch the trailer</a>` : ''}</div>
      </div>` : ''}
      <div class="row">
        ${canNext ? `<button class="btn btn-primary btn-big" data-act="next">${last ? 'See final scores' : 'Next round'}</button>` : '<span class="muted">Waiting for the host to continue.</span>'}
      </div>
    </div>
    ${reel()}`;
  }

  function overView() {
    const v = S.view;
    const sorted = [...v.players].sort((a, b) => b.score - a.score);
    const top = sorted[0];
    const tie = sorted.filter((p) => p.score === top.score);
    const rows = v.history.map((h) => `<tr>
      <td class="mono">${h.round}</td><td>${esc(h.title)}${h.year ? ` <span class="muted">(${h.year})</span>` : ''}</td>
      <td>${esc(nameOf(h.pickerId))}</td><td>${esc(nameOf(h.guesserId))}</td>
      <td>${h.how === 'solved' ? `Solved, +${h.points}` : h.how === 'stumped' ? `Stumped, picker +${h.points}` : 'Skipped'}</td></tr>`).join('');
    return `
    <div class="panel stack">
      <p class="eyebrow">Final scores</p>
      <h1 style="font-size:clamp(40px,7vw,72px)">${tie.length > 1 ? 'A tie at the top' : `${esc(top.name)} wins`}</h1>
      <p class="lede">${tie.length > 1 ? esc(tie.map((p) => p.name).join(' and ')) + ` share ${top.score} points.` : `${top.score} point${top.score === 1 ? '' : 's'} after ${v.totalRounds} rounds.`}</p>
      ${v.history.length ? `<div class="table-wrap"><table class="history">
        <thead><tr><th>Rd</th><th>Movie</th><th>Picker</th><th>Guesser</th><th>Result</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ''}
      <div class="row">
        ${isHost() ? '<button class="btn btn-primary btn-big" data-act="start">Play again</button><button class="btn" data-act="lobby">Change the shelf</button>' : '<span class="muted">The host can start another game.</span>'}
      </div>
    </div>`;
  }

  // ---- side effects after each state --------------------------------------
  function afterState() {
    const v = S.view;
    if (!v) return;
    const roundKey = `${v.code}-${v.round}-${v.totalRounds}`;
    if (v.phase === 'pick' && v.you === v.pickerId && S.browse.forRound !== roundKey) {
      S.browse = { query: '', page: 1, results: [], totalPages: 1, loading: false, selected: null, error: '', forRound: roundKey };
      S.file.useFile = false;
      S.file.customTitle = '';
      loadMovies(1);
    }
    if (v.phase === 'minute' && v.you === v.guesserId) S.minute = null;
    if (v.phase === 'capture' && v.you === v.pickerId && v.useFile) captureFrame();
  }

  async function loadMovies(page, append = false) {
    const b = S.browse;
    b.loading = true; b.error = '';
    render();
    const res = await send('browse', { query: b.query, page });
    b.loading = false;
    if (res.ok) {
      b.results = append ? dedupe([...b.results, ...res.results]) : res.results;
      b.totalPages = res.totalPages || 1;
      b.page = page;
    } else {
      b.error = res.error || 'Could not load movies.';
    }
    render();
  }
  const dedupe = (list) => list.filter((m, i) => list.findIndex((x) => x.id === m.id) === i);

  // ---- local video file (exact frames) -------------------------------------
  function loadVideoFile(file) {
    const f = S.file;
    if (f.url) URL.revokeObjectURL(f.url);
    f.file = null; f.duration = 0;
    if (!file) { render(); return; }
    const video = document.createElement('video');
    video.muted = true; video.preload = 'auto'; video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      if (!isFinite(video.duration) || video.duration < 120) { toast('That video is too short or cannot be read. Try an MP4 or WebM file.', true); return; }
      f.file = file; f.url = url; f.video = video; f.duration = video.duration;
      render();
      afterState();
    };
    video.onerror = () => toast('This browser cannot play that file. MP4 (H.264) or WebM work best.', true);
    video.src = url;
  }

  async function captureFrame() {
    const v = S.view, f = S.file;
    const last = v.attempts[v.attempts.length - 1];
    if (!last || last.frame) return;
    const key = `${v.code}-${v.round}-${v.attempts.length}`;
    if (S.captured.has(key) || !f.video) return;
    S.captured.add(key);
    try {
      const video = f.video;
      const t = Math.min(video.duration - 0.5, last.minute * 60);
      await new Promise((resolve, reject) => {
        const done = () => { video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done);
        setTimeout(() => reject(new Error('seek timeout')), 15000);
        video.currentTime = t;
      });
      const w = Math.min(1280, video.videoWidth || 1280);
      const h = Math.round(w * (video.videoHeight / video.videoWidth || 9 / 16));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      let dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (dataUrl.length > 2_000_000) dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      const res = await send('frame', { dataUrl });
      if (!res.ok) S.captured.delete(key);
    } catch (e) {
      S.captured.delete(key);
      toast('Could not grab that frame from your video. Choose the file again.', true);
    }
  }

  // ---- events --------------------------------------------------------------
  function needName() {
    const el = document.getElementById('nameInput');
    const name = (el?.value || '').trim();
    if (!name) { toast('Enter your name first.', true); el?.focus(); return null; }
    store.set('mm-name', name);
    return name;
  }

  $app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    const v = S.view;
    switch (act) {
      case 'create': {
        const name = needName(); if (!name) return;
        await send('create', { name, playerId });
        history.replaceState(null, '', '/');
        break;
      }
      case 'join': {
        const name = needName(); if (!name) return;
        const code = (document.getElementById('codeInput').value || '').trim().toUpperCase();
        if (code.length !== 4) return toast('Room codes have 4 letters.', true);
        await send('join', { code, name, playerId });
        break;
      }
      case 'copy': {
        const text = el.dataset.text;
        try { await navigator.clipboard.writeText(text); toast('Invite link copied'); } catch { prompt('Copy this link', text); }
        break;
      }
      case 'genre': {
        const id = Number(el.dataset.id);
        const g = new Set(v.settings.genres);
        g.has(id) ? g.delete(id) : g.add(id);
        await send('settings', { ...v.settings, genres: [...g] });
        break;
      }
      case 'kick': await send('kick', { playerId: el.dataset.id }); break;
      case 'start': await send('start'); break;
      case 'lobby': await send('lobby'); break;
      case 'skip': await send('skip'); break;
      case 'next': await send('next'); break;
      case 'giveup': await send('giveup'); break;
      case 'swap': await send('swap'); break;
      case 'approve': await send('approve'); break;
      case 'select': {
        const m = S.browse.results.find((x) => x.id === Number(el.dataset.id));
        S.browse.selected = S.browse.selected && S.browse.selected.id === m.id ? null : m;
        render();
        break;
      }
      case 'more': loadMovies(S.browse.page + 1, true); break;
      case 'clearSearch': S.browse.query = ''; loadMovies(1); break;
      case 'lock': {
        const b = S.browse, f = S.file;
        S.busy = true; render();
        await send('pick', {
          movieId: b.selected ? b.selected.id : null,
          customTitle: b.selected ? '' : f.customTitle,
          useFile: f.useFile,
          fileRuntime: f.useFile ? f.duration : 0,
        });
        S.busy = false; render();
        break;
      }
      case 'minute': {
        S.busy = true; render();
        await send('minute', { minute: S.minute });
        S.busy = false; render();
        break;
      }
    }
  });

  $bar.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="leave"]')) return;
    await send('leave');
    store.sset('mm-room', null);
    S.view = null; S.lastJson = '';
    render();
  });

  $app.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target.dataset.form;
    if (form === 'search') {
      S.browse.query = document.getElementById('searchInput').value.trim();
      loadMovies(1);
    } else if (form === 'guess') {
      const input = document.getElementById('guessInput');
      const text = input.value.trim();
      if (!text) return toast('Type a movie title.', true);
      hideSuggest();
      S.busy = true; render();
      const res = await send('guess', { text });
      S.busy = false;
      if (res.ok && ['minute', 'capture'].includes(S.view.phase)) toast(`"${text}" is not it. ${S.view.useFile ? 'Pick another minute.' : 'Here comes another moment.'}`, true);
      render();
    }
  });

  $app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'minuteRange' || t.id === 'minuteNum') {
      const max = S.view?.runtime || 120;
      const n = Math.max(1, Math.min(max, Math.round(Number(t.value)) || 1));
      S.minute = n;
      const out = document.getElementById('tcOut'); if (out) out.innerHTML = tcHtml(n);
      const lab = document.getElementById('minuteLabel'); if (lab) lab.textContent = n;
      const other = document.getElementById(t.id === 'minuteRange' ? 'minuteNum' : 'minuteRange');
      if (other && document.activeElement !== other) other.value = n;
    } else if (t.id === 'customTitle') {
      S.file.customTitle = t.value;
      const btn = $app.querySelector('[data-act="lock"]');
      if (btn) btn.disabled = !(S.file.file && t.value.trim());
    } else if (t.id === 'codeInput') {
      t.value = t.value.toUpperCase().replace(/[^A-Z]/g, '');
    } else if (t.id === 'searchInput') {
      S.browse.query = t.value; // remembered, applied on submit
    } else if (t.id === 'guessInput') {
      querySuggest(t.value);
    }
  });

  $app.addEventListener('change', async (e) => {
    const t = e.target, v = S.view;
    if (t.id === 'useFile') { S.file.useFile = t.checked; render(); }
    else if (t.id === 'videoFile') loadVideoFile(t.files[0]);
    else if (['yearFrom', 'yearTo', 'laps'].includes(t.id) && isHost()) {
      const s = { ...v.settings };
      s[t.id] = Number(t.value);
      if (t.id === 'yearFrom' && s.yearTo < s.yearFrom) s.yearTo = s.yearFrom;
      await send('settings', s);
    }
  });

  $app.addEventListener('keydown', (e) => {
    if (e.target.id === 'guessInput' && sug.items.length) {
      const n = sug.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sug.active = e.key === 'ArrowDown' ? (sug.active + 1) % n : (sug.active <= 0 ? n - 1 : sug.active - 1);
        drawSuggest();
        return;
      }
      if (e.key === 'Enter' && sug.active >= 0) { e.preventDefault(); chooseSuggest(sug.active); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
    }
    if (e.key === 'Enter' && e.target.id === 'codeInput') $app.querySelector('[data-act="join"]').click();
    if (e.key === 'Enter' && e.target.id === 'nameInput') {
      const code = document.getElementById('codeInput')?.value;
      $app.querySelector(`[data-act="${code && code.length === 4 ? 'join' : 'create'}"]`).click();
    }
    if (e.key === 'Enter' && e.target.id === 'minuteNum') $app.querySelector('[data-act="minute"]')?.click();
  });

  render();
})();
