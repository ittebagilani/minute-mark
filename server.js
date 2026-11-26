const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room, makeCode } = require('./lib/game');
const { GENRES, createProvider, demoSvg } = require('./lib/movies');

const PORT = Number(process.env.PORT) || 3000;
const provider = createProvider();
const rooms = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/api/meta', (_req, res) => res.json({ genres: GENRES, provider: provider.name, year: new Date().getFullYear() }));
app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/demo/poster/:id.svg', (req, res) => res.type('image/svg+xml').send(demoSvg(req.params.id, 0, true)));
app.get('/demo/frame/:id/:n.svg', (req, res) => res.type('image/svg+xml').send(demoSvg(req.params.id, Number(req.params.n) || 0, false)));

// Frames captured from a picker's own video file, served to the room.
app.get('/frame/:code/:name', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  const data = room && room.frameData(req.params.name);
  if (!data) return res.status(404).end();
  const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(data);
  res.set('Cache-Control', 'private, max-age=3600');
  res.type(m[1]).send(Buffer.from(m[2], 'base64'));
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });

function broadcast(room) {
  for (const [sid, s] of io.of('/').sockets) {
    if (s.data.code === room.code) s.emit('state', room.viewFor(s.data.playerId));
  }
}

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,40}$/.test(id);
}

io.on('connection', (socket) => {
  const guard = (fn) => async (payload = {}, ack = () => {}) => {
    if (typeof ack !== 'function') ack = () => {};
    try {
      const out = await fn(payload || {});
      ack({ ok: true, ...(out || {}) });
    } catch (e) {
      ack({ ok: false, error: e.message || 'Something went wrong.' });
    }
  };

  const currentRoom = () => {
    const room = rooms.get(socket.data.code);
    if (!room) throw new Error('That room has closed. Start a new one.');
    return room;
  };

  const enter = (room, playerId, name) => {
    if (!validId(playerId)) throw new Error('Refresh the page and try again.');
    if (socket.data.code && socket.data.code !== room.code) leaveCurrent();
    room.join(playerId, name);
    socket.data.code = room.code;
    socket.data.playerId = playerId;
    broadcast(room);
    return { code: room.code };
  };

  const leaveCurrent = () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const pid = socket.data.playerId;
    socket.data.code = null;
    // Another tab of the same player may still be connected.
    const stillHere = [...io.of('/').sockets.values()].some((s) => s.data.code === room.code && s.data.playerId === pid);
    if (!stillHere) room.leave(pid);
    broadcast(room);
  };

  socket.on('create', guard(({ playerId, name }) => {
    const room = new Room(makeCode(new Set(rooms.keys())), provider);
    rooms.set(room.code, room);
    return enter(room, playerId, name);
  }));

  socket.on('join', guard(({ code, playerId, name }) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) throw new Error('No room with that code. Check the letters with your host.');
    if (!room.player(playerId) && !['lobby', 'over'].includes(room.phase) && room.players.length >= 16) throw new Error('This room is full.');
    return enter(room, playerId, name);
  }));

  socket.on('leave', guard(() => leaveCurrent()));

  const act = (event, fn) => socket.on(event, guard(async (p) => {
    const room = currentRoom();
    const out = await fn(room, socket.data.playerId, p);
    broadcast(room);
    return out;
  }));

  act('settings', (r, id, p) => r.updateSettings(id, p));
  act('start', (r, id) => r.start(id));
  act('pick', (r, id, p) => r.pick(id, p));
  act('minute', (r, id, p) => r.chooseMinute(id, p.minute));
  act('frame', (r, id, p) => r.submitFrame(id, p.dataUrl));
  act('swap', (r, id) => r.swapFrame(id));
  act('approve', (r, id) => r.approveFrame(id));
  act('guess', (r, id, p) => r.guess(id, p.text));
  act('giveup', (r, id) => r.giveUp(id));
  act('skip', (r, id) => r.skip(id));
  act('next', (r, id) => r.next(id));
  act('lobby', (r, id) => r.backToLobby(id));
  act('kick', (r, id, p) => {
    r.kick(id, p.playerId);
    for (const s of io.of('/').sockets.values()) {
      if (s.data.code === r.code && s.data.playerId === p.playerId) { s.data.code = null; s.emit('kicked'); }
    }
  });

  // Movie browsing for the picker only, limited to the host's filters.
  socket.on('browse', guard(async ({ query, page }) => {
    const room = currentRoom();
    if (socket.data.playerId !== room.pickerId || room.phase !== 'pick') throw new Error('Only the picker can browse movies now.');
    const q = String(query || '').trim().slice(0, 80);
    const pg = Math.min(50, Math.max(1, Number(page) || 1));
    const out = q ? await provider.search(room.settings, q) : await provider.discover(room.settings, pg);
    return out;
  }));

  socket.on('disconnect', () => leaveCurrent());
});

// Close rooms nobody has touched for 3 hours.
setInterval(() => {
  const cutoff = Date.now() - 3 * 3600e3;
  for (const [code, room] of rooms) {
    if (room.touched < cutoff && room.connected().length === 0) rooms.delete(code);
  }
}, 10 * 60e3).unref();

server.listen(PORT, () => {
  console.log(`Frame Drop running on http://localhost:${PORT} (movies: ${provider.name})`);
});
