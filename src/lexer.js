'use strict';

class ParseError extends Error {
  constructor(message, spans) {
    super(message);
    this.name = 'ParseError';
    this.spans = spans || [];
  }
}

const KEYWORDS = new Set(['sensor', 'let', 'in', 'fun']);
const PUNCTS = ':;=()+-*/^<>';

function isDigit(c) {
  return c >= '0' && c <= '9';
}

/** 将源码切分为带位置（start/end 偏移）的 token 序列。 */
function tokenize(source) {
  const tokens = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      let j = i;
      while (j < n && isDigit(source[j])) j++;
      if (source[j] === '.') {
        j++;
        while (j < n && isDigit(source[j])) j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k++;
        if (k < n && isDigit(source[k])) {
          while (k < n && isDigit(source[k])) k++;
          j = k;
        }
      }
      tokens.push({ type: 'num', value: source.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j++;
      const word = source.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? 'kw' : 'ident', value: word, start: i, end: j });
      i = j;
      continue;
    }
    if (c === '-' && source[i + 1] === '>') {
      tokens.push({ type: 'punct', value: '->', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (PUNCTS.includes(c)) {
      tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new ParseError(`无法识别的字符「${c}」`, [
      { start: i, end: i + 1, label: '无法识别的字符' },
    ]);
  }
  tokens.push({ type: 'eof', value: '(文件结束)', start: n, end: n });
  return tokens;
}

module.exports = { tokenize, ParseError };
