const test = require('node:test');
const assert = require('node:assert');
const { isCorrectGuess, normalizeTitle } = require('../lib/match');
const { pickStillIndex, DemoProvider } = require('../lib/movies');
const { Room } = require('../lib/game');

test('title matching is strict on words, loose on formatting', () => {
  assert.ok(isCorrectGuess('the avengers', ['The Avengers']));
  assert.ok(isCorrectGuess('Avengers', ['The Avengers']));
  assert.ok(isCorrectGuess('AVENGERS!!', ['The Avengers']));
  assert.ok(!isCorrectGuess('Avengers', ['Avengers: Endgame']));
  assert.ok(isCorrectGuess('avengers endgame', ['Avengers: Endgame']));
  assert.ok(isCorrectGuess('Rocky 2', ['Rocky II']));
  assert.ok(isCorrectGuess('Amelie', ['Amélie']));
  assert.ok(isCorrectGuess('fast and furious', ['Fast & Furious']));
  assert.ok(isCorrectGuess('schindlers list', ["Schindler's List"]));
  assert.ok(!isCorrectGuess('Rocky', ['Rocky II']));
  assert.ok(!isCorrectGuess('', ['Up']));
  assert.equal(normalizeTitle('I, Robot'), 'i robot');
});

test('still index spreads across runtime and avoids repeats', () => {
  assert.equal(pickStillIndex(1, 120, 10), 0);
  assert.equal(pickStillIndex(119, 120, 10), 9);
  assert.equal(pickStillIndex(60, 120, 10), 5);
  assert.equal(pickStillIndex(61, 120, 10, [5]), 6);
});

test('a full game with rotation and scoring', async () => {
  const r = new Room('ABCD', new DemoProvider());
  r.join('aaaaaaaa', 'Ann'); r.join('bbbbbbbb', 'Ben'); r.join('cccccccc', 'Cat');
  assert.equal(r.hostId, 'aaaaaaaa');
  assert.throws(() => r.start('bbbbbbbb'), /host/);
  r.updateSettings('aaaaaaaa', { yearFrom: 2000, yearTo: 2020, genres: [28, 35], laps: 1 });
  r.start('aaaaaaaa');
  assert.equal(r.totalRounds, 3);
  assert.equal(r.pickerId, 'aaaaaaaa'); assert.equal(r.guesserId, 'bbbbbbbb');
  // guesser can't see the movie
  await r.pick('aaaaaaaa', { movieId: 2 });
  assert.equal(r.viewFor('bbbbbbbb').movie, null);
  assert.equal(r.viewFor('aaaaaaaa').movie.title, 'Neon Harbor');
  assert.equal(r.phase, 'capture');
  assert.equal(r.viewFor('bbbbbbbb').attempts[0].frame, null);
  const first = r.attempts[0].frame;
  r.swapFrame('aaaaaaaa');
  assert.notEqual(r.attempts[0].frame, first);
  assert.throws(() => r.approveFrame('bbbbbbbb'), /picker/);
  r.approveFrame('aaaaaaaa');
  assert.ok(r.viewFor('bbbbbbbb').attempts[0].frame);
  r.guess('bbbbbbbb', 'Neon Harbour'); // wrong spelling
  assert.equal(r.phase, 'capture');
  r.approveFrame('aaaaaaaa');
  r.guess('bbbbbbbb', 'neon harbor');
  assert.equal(r.phase, 'reveal');
  assert.equal(r.player('bbbbbbbb').score, 2);
  r.next('aaaaaaaa');
  assert.equal(r.pickerId, 'bbbbbbbb'); assert.equal(r.guesserId, 'cccccccc');
  await r.pick('bbbbbbbb', { movieId: 3 });
  for (let k = 0; k < 3; k++) { r.approveFrame('bbbbbbbb'); r.guess('cccccccc', 'nope'); }
  assert.equal(r.player('bbbbbbbb').score, 1 + 2);
  r.next('aaaaaaaa');
  assert.equal(r.pickerId, 'cccccccc'); assert.equal(r.guesserId, 'aaaaaaaa');
  r.skip('aaaaaaaa');
  r.next('aaaaaaaa');
  assert.equal(r.phase, 'over');
});

test('file mode needs a frame from the picker', async () => {
  const r = new Room('WXYZ', new DemoProvider());
  r.join('aaaaaaaa', 'Ann'); r.join('bbbbbbbb', 'Ben');
  r.start('aaaaaaaa');
  await r.pick('aaaaaaaa', { customTitle: 'The Avengers', useFile: true, fileRuntime: 143 * 60 });
  assert.equal(r.movie.runtime, 143);
  r.chooseMinute('bbbbbbbb', 15);
  assert.equal(r.phase, 'capture');
  assert.throws(() => r.submitFrame('bbbbbbbb', 'data:image/jpeg;base64,AAAA'), /picker/);
  r.submitFrame('aaaaaaaa', 'data:image/jpeg;base64,AAAA');
  assert.equal(r.phase, 'guess');
  const name = r.attempts[0].frame.split('/').pop();
  assert.equal(r.frameData(name), 'data:image/jpeg;base64,AAAA');
  r.guess('bbbbbbbb', 'avengers');
  assert.equal(r.player('bbbbbbbb').score, 3);
});

test('trailer rounds use random moments the picker can reroll', async () => {
  const prov = new DemoProvider();
  const orig = prov.details.bind(prov);
  prov.details = async (id) => ({ ...(await orig(id)), trailerKey: 'abcDEF12345', videos: [{ key: 'abcDEF12345', kind: 'trailer' }, { key: 'clipKEY0001', kind: 'clip' }] });
  const r = new Room('TRLR', prov);
  r.join('aaaaaaaa', 'Ann'); r.join('bbbbbbbb', 'Ben');
  r.start('aaaaaaaa');
  await r.pick('aaaaaaaa', { movieId: 4 });
  assert.equal(r.phase, 'capture');
  const v = r.viewFor('bbbbbbbb');
  assert.equal(v.attempts[0].at, null);
  assert.equal(v.attempts[0].kind, 'trailer');
  const first = r.attempts[0].video;
  r.swapFrame('aaaaaaaa');
  assert.notEqual(r.attempts[0].video, first); // rerolls to the unseen video
  assert.equal(r.viewFor('bbbbbbbb').attempts[0].video, null);
  r.approveFrame('aaaaaaaa');
  assert.ok(['abcDEF12345', 'clipKEY0001'].includes(r.viewFor('bbbbbbbb').attempts[0].video));
  assert.equal(r.viewFor('bbbbbbbb').trailer, null);
  assert.ok(r.viewFor('bbbbbbbb').attempts[0].at >= 0);
  r.guess('bbbbbbbb', 'wrong');
  assert.equal(r.phase, 'capture');
  assert.equal(r.attempts.length, 2);
  r.approveFrame('aaaaaaaa');
  r.guess('bbbbbbbb', 'orbit of glass');
  assert.equal(r.player('bbbbbbbb').score, 2);
});

test('clip verification rejects sequels, TV and wrong years', () => {
  const { verifyClip } = require('../lib/movies');
  const dk = { names: ['dark knight'], rivals: ['dark knight rises', 'dark knight returns part 1'], year: 2008 };
  assert.ok(verifyClip('The Dark Knight (2008) - Hospital Explosion Scene (8/10) | Movieclips', dk));
  assert.ok(!verifyClip('The Dark Knight Rises (2012) - Bane Fight Scene | Movieclips', dk));
  assert.ok(!verifyClip('The Dark Knight (2012) scene', dk));
  assert.ok(!verifyClip('Batman Begins (2005) - Training Scene', dk));
  assert.ok(!verifyClip('The Dark Knight Season 2 Episode 4', dk));
  const fargo = { names: ['fargo'], rivals: [], year: 1996, tvSameName: true };
  assert.ok(!verifyClip('Fargo - Best Scene', fargo));
  assert.ok(verifyClip('Fargo (1996) - Wood Chipper Scene | Movieclips', fargo));
  const { normalizeTitle: nt } = require('../lib/match');
  const hp = { names: [nt("Harry Potter and the Philosopher's Stone"), nt("Harry Potter and the Sorcerer's Stone")], rivals: [], year: 2001 };
  assert.ok(verifyClip("Harry Potter and the Sorcerer's Stone (2001) - Gringotts Scene", hp));
  assert.ok(!verifyClip('Harry Potter and the Chamber of Secrets (2002) - Dobby', hp));
});

test('solo game: the computer picks, the player guesses', async () => {
  const r = new Room('SOLO', new DemoProvider(), { solo: true });
  let pushes = 0; r.onAsync = () => { pushes++; };
  r.join('aaaaaaaa', 'Ann');
  assert.throws(() => r.join('bbbbbbbb', 'Ben'), /solo/);
  r.updateSettings('aaaaaaaa', { yearFrom: 1990, yearTo: 2024, genres: [], rounds: 5, guessTime: 30 });
  r.start('aaaaaaaa');
  assert.equal(r.totalRounds, 5);
  assert.equal(r.pickerId, 'cpu');
  await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(pushes >= 1);
  assert.equal(r.phase, 'guess'); // no picker to vet the frame
  assert.ok(r.deadline > Date.now());
  assert.equal(r.viewFor('aaaaaaaa').movie, null);
  const first = r.movie.id;
  r.guess('aaaaaaaa', r.movie.title);
  assert.equal(r.phase, 'reveal');
  assert.equal(r.player('aaaaaaaa').score, 3);
  r.next('aaaaaaaa');
  await new Promise((ok) => setTimeout(ok, 20));
  assert.notEqual(r.movie.id, first); // no repeats in one game
});

test('timers: a guess runs out, and a slow picker gets a computer pick', async () => {
  const r = new Room('TIME', new DemoProvider());
  r.join('aaaaaaaa', 'Ann'); r.join('bbbbbbbb', 'Ben');
  r.updateSettings('aaaaaaaa', { yearFrom: 1990, yearTo: 2024, genres: [], laps: 1, pickTime: 15, guessTime: 20 });
  r.start('aaaaaaaa');
  assert.ok(r.deadline);
  await r.tick(r.deadline + 1); // picker too slow
  assert.equal(r.phase, 'capture');
  assert.match(r.notice, /computer picked/);
  r.tick(r.deadline + 1); // frame not checked in time: shown anyway
  assert.equal(r.phase, 'guess');
  r.tick(r.deadline + 1); // guess too slow: counts as a miss
  assert.equal(r.attempts[0].guess, '(out of time)');
  assert.equal(r.attempts[0].correct, false);
  assert.equal(r.attempts.length, 2);
  assert.throws(() => r.updateSettings('aaaaaaaa', { pickTime: 0 }), /locked/);
});
