'use strict';

const { tokenize, ParseError } = require('./lexer');
const U = require('./units');

/**
 * 语法：
 *   程序     := 语句*
 *   语句     := sensor 名 : 单位 ; | let 名 = 表达式 ; | 表达式 ;
 *              （最后一条语句的分号可省略）
 *   表达式   := let 名 = 表达式 in 表达式 | fun 名 -> 表达式 | 加减
 *   加减     := 乘除 (('+'|'-') 乘除)*
 *   乘除     := 调用 (('*'|'/') 调用)*
 *   调用     := 一元 (一元)*            —— 并置即函数调用
 *   一元     := '-' 一元 | 原子
 *   原子     := 数 ('<' 单位 '>')? | 标识符 | '(' 表达式 ')'
 *   单位     := 因子 (('*'|'/') 因子)*
 *   因子     := '1' | 标识符 ('^' '-'? 整数)? | '(' 单位 ')'
 */
function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;
  let nextId = 1;
  const nodes = [];

  const peek = () => tokens[pos];

  function errorAt(t, msg) {
    return new ParseError(msg, [{ start: t.start, end: t.end, label: `「${t.value}」附近` }]);
  }

  function expectPunct(p) {
    const t = peek();
    if (t.type !== 'punct' || t.value !== p) {
      throw errorAt(t, `语法错误：期望「${p}」，却遇到「${t.value}」`);
    }
    pos++;
    return t;
  }

  function expectIdent() {
    const t = peek();
    if (t.type !== 'ident') throw errorAt(t, `语法错误：期望标识符，却遇到「${t.value}」`);
    pos++;
    return t;
  }

  function expectKw(kw) {
    const t = peek();
    if (t.type !== 'kw' || t.value !== kw) {
      throw errorAt(t, `语法错误：期望「${kw}」，却遇到「${t.value}」`);
    }
    pos++;
    return t;
  }

  function mkNode(kind, props, start, end) {
    const node = { id: nextId++, kind, span: { start, end }, ...props };
    nodes.push(node);
    return node;
  }

  // ---- 单位 ----
  function parseUnit() {
    let u = parseUnitFactor();
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && (t.value === '*' || t.value === '/')) {
        pos++;
        const f = parseUnitFactor();
        u = t.value === '*' ? U.monoMul(u, f) : U.monoDiv(u, f);
      } else {
        return u;
      }
    }
  }

  function parseUnitFactor() {
    const t = peek();
    if (t.type === 'num') {
      if (t.value !== '1') throw errorAt(t, '语法错误：单位中的数值只能是 1（无量纲）');
      pos++;
      return U.monoUnit();
    }
    if (t.type === 'ident') {
      pos++;
      let exp = 1;
      if (peek().type === 'punct' && peek().value === '^') {
        pos++;
        let sign = 1;
        if (peek().type === 'punct' && peek().value === '-') {
          pos++;
          sign = -1;
        }
        const nt = peek();
        if (nt.type !== 'num' || !/^\d+$/.test(nt.value)) {
          throw errorAt(nt, '语法错误：单位指数须为整数');
        }
        pos++;
        exp = sign * parseInt(nt.value, 10);
      }
      return U.monoBase(t.value, exp);
    }
    if (t.type === 'punct' && t.value === '(') {
      pos++;
      const u = parseUnit();
      expectPunct(')');
      return u;
    }
    throw errorAt(t, `语法错误：期望单位（如 m、s、m/s、m^2、1），却遇到「${t.value}」`);
  }

  // ---- 表达式 ----
  function parseExpr() {
    const t = peek();
    if (t.type === 'kw' && t.value === 'let') {
      pos++;
      const name = expectIdent();
      expectPunct('=');
      const value = parseExpr();
      expectKw('in');
      const body = parseExpr();
      return mkNode('let', { name: name.value, value, body }, t.start, body.span.end);
    }
    if (t.type === 'kw' && t.value === 'fun') {
      pos++;
      const param = expectIdent();
      expectPunct('->');
      const body = parseExpr();
      return mkNode(
        'fun',
        { param: param.value, paramSpan: { start: param.start, end: param.end }, body },
        t.start,
        body.span.end,
      );
    }
    return parseAdd();
  }

  function parseAdd() {
    let left = parseMul();
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && (t.value === '+' || t.value === '-')) {
        pos++;
        const right = parseMul();
        left = mkNode('binop', { op: t.value, left, right }, left.span.start, right.span.end);
      } else {
        return left;
      }
    }
  }

  function parseMul() {
    let left = parseApp();
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && (t.value === '*' || t.value === '/')) {
        pos++;
        const right = parseApp();
        left = mkNode('binop', { op: t.value, left, right }, left.span.start, right.span.end);
      } else {
        return left;
      }
    }
  }

  function startsAtom(t) {
    return t.type === 'num' || t.type === 'ident' || (t.type === 'punct' && t.value === '(');
  }

  function parseApp() {
    let fn = parseUnary();
    while (startsAtom(peek())) {
      const arg = parseUnary();
      fn = mkNode('app', { func: fn, arg }, fn.span.start, arg.span.end);
    }
    return fn;
  }

  function parseUnary() {
    const t = peek();
    if (t.type === 'punct' && t.value === '-') {
      pos++;
      const e = parseUnary();
      return mkNode('neg', { expr: e }, t.start, e.span.end);
    }
    return parseAtom();
  }

  function parseAtom() {
    const t = peek();
    if (t.type === 'num') {
      pos++;
      let unit = null;
      let end = t.end;
      if (peek().type === 'punct' && peek().value === '<') {
        pos++;
        unit = parseUnit();
        end = expectPunct('>').end;
      }
      return mkNode('num', { text: t.value, value: parseFloat(t.value), unit }, t.start, end);
    }
    if (t.type === 'ident') {
      pos++;
      return mkNode('ident', { name: t.value }, t.start, t.end);
    }
    if (t.type === 'punct' && t.value === '(') {
      pos++;
      const e = parseExpr();
      expectPunct(')');
      return e;
    }
    throw errorAt(t, `语法错误：期望表达式，却遇到「${t.value}」`);
  }

  // ---- 语句 ----
  function parseStatement() {
    const t = peek();
    let stmt;
    if (t.type === 'kw' && t.value === 'sensor') {
      pos++;
      const name = expectIdent();
      expectPunct(':');
      const unit = parseUnit();
      stmt = mkNode('sensor', { name: name.value, unit }, t.start, tokens[pos - 1].end);
    } else if (t.type === 'kw' && t.value === 'let') {
      pos++;
      const name = expectIdent();
      expectPunct('=');
      const value = parseExpr();
      if (peek().type === 'kw' && peek().value === 'in') {
        // let … in … 表达式形式
        pos++;
        const body = parseExpr();
        stmt = mkNode('let', { name: name.value, value, body }, t.start, body.span.end);
      } else {
        stmt = mkNode('let', { name: name.value, value, body: null }, t.start, value.span.end);
      }
    } else {
      stmt = parseExpr();
    }
    const nt = peek();
    if (nt.type === 'punct' && nt.value === ';') {
      pos++;
    } else if (nt.type !== 'eof') {
      throw errorAt(nt, '语法错误：语句之间需要「;」分隔');
    }
    return stmt;
  }

  const statements = [];
  while (peek().type !== 'eof') {
    if (peek().type === 'punct' && peek().value === ';') {
      pos++;
      continue;
    }
    statements.push(parseStatement());
  }
  return { statements, nodes, source };
}

module.exports = { parse, ParseError };
