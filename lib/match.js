// Title matching: strict on the words, forgiving on case, punctuation,
// accents, "&" vs "and", a leading article, and Roman vs Arabic numerals.

const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
const ARTICLES = new Set(['the', 'a', 'an']);

function normalizeTitle(s) {
  if (typeof s !== 'string') return '';
  let t = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '') // "Schindler's" -> "schindlers"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let words = t.split(' ').filter(Boolean);
  // Roman numerals only count as numbers after the first word ("Rocky II"),
  // so a title like "I, Robot" or "X-Men" is left alone.
  words = words.map((w, i) => (i > 0 && ROMAN[w] ? ROMAN[w] : w));
  if (words.length > 1 && ARTICLES.has(words[0])) words = words.slice(1);
  return words.join(' ');
}

function isCorrectGuess(guess, titles) {
  const g = normalizeTitle(guess);
  if (!g) return false;
  return titles.filter(Boolean).some((t) => normalizeTitle(t) === g);
}

module.exports = { normalizeTitle, isCorrectGuess };
