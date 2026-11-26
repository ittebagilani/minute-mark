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
  r.chooseMinute('bbbbbbbb', 15);
  assert.equal(r.phase, 'capture');
  assert.equal(r.viewFor('bbbbbbbb').attempts[0].frame, null);
  const first = r.attempts[0].frame;
  r.swapFrame('aaaaaaaa');
  assert.notEqual(r.attempts[0].frame, first);
  assert.throws(() => r.approveFrame('bbbbbbbb'), /picker/);
  r.approveFrame('aaaaaaaa');
  assert.ok(r.viewFor('bbbbbbbb').attempts[0].frame);
  r.guess('bbbbbbbb', 'Neon Harbour'); // wrong spelling
  assert.equal(r.phase, 'minute');
  r.chooseMinute('bbbbbbbb', 40);
  r.approveFrame('aaaaaaaa');
  r.guess('bbbbbbbb', 'neon harbor');
  assert.equal(r.phase, 'reveal');
  assert.equal(r.player('bbbbbbbb').score, 2);
  r.next('aaaaaaaa');
  assert.equal(r.pickerId, 'bbbbbbbb'); assert.equal(r.guesserId, 'cccccccc');
  await r.pick('bbbbbbbb', { movieId: 3 });
  for (const m of [5, 10, 20]) { r.chooseMinute('cccccccc', m); r.approveFrame('bbbbbbbb'); r.guess('cccccccc', 'nope'); }
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
