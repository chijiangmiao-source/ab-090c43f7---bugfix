'use strict';

const { parse, ParseError } = require('./parser');
const U = require('./units');

class InferError extends Error {
  constructor(message, spans) {
    super(message);
    this.name = 'InferError';
    this.spans = spans || [];
  }
}

/* ---------------- 类型 ----------------
 * { kind:'tvar', id, instance }   类型变量（可绑定）
 * { kind:'num',  unit }           带单位数值
 * { kind:'fun',  param, ret }     单参数函数
 * 类型方案 scheme = { tvars, uvars, type }（let 绑定处泛化）
 */

function newTVar(ctx) {
  return { kind: 'tvar', id: ++ctx.tvarSeq, instance: null, level: ctx.level };
}

function newUVar(ctx) {
  return { id: ++ctx.uvarSeq, instance: null, level: ctx.level };
}

function prune(t) {
  if (t.kind === 'tvar' && t.instance) {
    t.instance = prune(t.instance);
    return t.instance;
  }
  return t;
}

function occursTVar(v, t) {
  t = prune(t);
  if (t.kind === 'tvar') return t === v;
  if (t.kind === 'fun') return occursTVar(v, t.param) || occursTVar(v, t.ret);
  return false;
}

function varsAboveLevel(t, level, tvars, uvars) {
  t = prune(t);
  if (t.kind === 'tvar') {
    if (t.level > level) tvars.add(t);
    return;
  }
  if (t.kind === 'fun') {
    varsAboveLevel(t.param, level, tvars, uvars);
    varsAboveLevel(t.ret, level, tvars, uvars);
    return;
  }
  for (const v of U.resolveMono(t.unit).vars.keys()) {
    if (v.level > level) uvars.add(v);
  }
}

/* ---------------- 命名与渲染（每次推断独立、确定） ---------------- */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

function createRenderCtx() {
  return { tNames: new Map(), uNames: new Map(), tSeq: 0, uSeq: 0 };
}

function nameT(R, v) {
  let name = R.tNames.get(v);
  if (!name) {
    const n = R.tSeq++;
    name = n < 26 ? `'${LETTERS[n]}` : `'t${n - 25}`;
    R.tNames.set(v, name);
  }
  return name;
}

function nameU(R, v) {
  let name = R.uNames.get(v);
  if (!name) {
    name = `'u${++R.uSeq}`;
    R.uNames.set(v, name);
  }
  return name;
}

function renderMono(R, m) {
  return U.renderMono(m, (v) => nameU(R, v));
}

function renderType(R, t) {
  t = prune(t);
  if (t.kind === 'tvar') return nameT(R, t);
  if (t.kind === 'num') return `num<${renderMono(R, t.unit)}>`;
  const pRaw = prune(t.param);
  const p = renderType(R, pRaw);
  const left = pRaw.kind === 'fun' ? `(${p})` : p;
  return `${left} -> ${renderType(R, t.ret)}`;
}

function renderScheme(R, sc) {
  const qs = [...sc.tvars.map((v) => nameT(R, v)), ...sc.uvars.map((v) => nameU(R, v))];
  const body = renderType(R, sc.type);
  return qs.length ? `∀ ${qs.join(' ')}. ${body}` : body;
}

/* ---------------- 合一 ---------------- */

function unify(ctx, t1, t2) {
  const a = prune(t1);
  const b = prune(t2);
  if (a === b) return;
  if (a.kind === 'tvar') {
    if (occursTVar(a, b)) throw new U.UnifyError('occurs', { v: a, t: b });
    a.instance = b;
    log(ctx, `合一约束：${nameT(ctx.R, a)} := ${renderType(ctx.R, b)}`);
    return;
  }
  if (b.kind === 'tvar') {
    if (occursTVar(b, a)) throw new U.UnifyError('occurs', { v: b, t: a });
    b.instance = a;
    log(ctx, `合一约束：${nameT(ctx.R, b)} := ${renderType(ctx.R, a)}`);
    return;
  }
  if (a.kind !== b.kind) throw new U.UnifyError('type-mismatch', { t1: a, t2: b });
  if (a.kind === 'fun') {
    unify(ctx, a.param, b.param);
    unify(ctx, a.ret, b.ret);
    return;
  }
  U.unifyMonos(a.unit, b.unit);
  log(ctx, `单位合一成功：两侧单位归一为 ${renderMono(ctx.R, a.unit)}`);
}

/* ---------------- 泛化与实例化 ---------------- */

function generalize(ctx, type) {
  const tvars = new Set();
  const uvars = new Set();
  varsAboveLevel(type, ctx.level, tvars, uvars);
  return { tvars: [...tvars], uvars: [...uvars], type };
}

function substType(t, tMap, uMap) {
  t = prune(t);
  if (t.kind === 'tvar') return tMap.get(t) || t;
  if (t.kind === 'num') return { kind: 'num', unit: U.substMono(t.unit, uMap) };
  return { kind: 'fun', param: substType(t.param, tMap, uMap), ret: substType(t.ret, tMap, uMap) };
}

/** let 绑定的每次引用都重新实例化类型方案（新鲜变量，互不影响）。 */
function instantiate(ctx, sc) {
  if (sc.tvars.length === 0 && sc.uvars.length === 0) return sc.type;
  const tMap = new Map();
  for (const v of sc.tvars) tMap.set(v, newTVar(ctx));
  const uMap = new Map();
  for (const v of sc.uvars) uMap.set(v, U.monoVar(newUVar(ctx)));
  return substType(sc.type, tMap, uMap);
}

/* ---------------- 推断上下文与证据日志 ---------------- */

function newCtx() {
  return {
    level: 0,
    tvarSeq: 0,
    uvarSeq: 0,
    R: createRenderCtx(),
    stack: [],
    events: new Map(),
    nodeType: new Map(),
    lets: [],
  };
}

function pushEvent(ctx, nodeId, msg) {
  let arr = ctx.events.get(nodeId);
  if (!arr) {
    arr = [];
    ctx.events.set(nodeId, arr);
  }
  arr.push(msg);
}

function log(ctx, msg) {
  const top = ctx.stack[ctx.stack.length - 1];
  if (top) pushEvent(ctx, top.id, msg);
}

const spanOf = (node, label) => ({ start: node.span.start, end: node.span.end, label });

/* ---------------- 主推断 ---------------- */

function inferNode(ctx, env, node) {
  ctx.stack.push(node);
  try {
    const t = dispatch(ctx, env, node);
    ctx.nodeType.set(node.id, t);
    return t;
  } catch (e) {
    if (e instanceof U.UnifyError) throw enrichUnify(ctx, e, node);
    throw e;
  } finally {
    ctx.stack.pop();
  }
}

function dispatch(ctx, env, node) {
  const R = ctx.R;
  switch (node.kind) {
    case 'sensor': {
      const t = { kind: 'num', unit: node.unit };
      env.set(node.name, { tvars: [], uvars: [], type: t });
      log(ctx, `传感器声明「${node.name}」：${renderType(R, t)}`);
      return t;
    }
    case 'num': {
      if (node.unit) {
        const t = { kind: 'num', unit: node.unit };
        log(ctx, `数值 ${node.text}：标注单位，类型 ${renderType(R, t)}`);
        return t;
      }
      const t = { kind: 'num', unit: U.monoVar(newUVar(ctx)) };
      log(ctx, `数值 ${node.text}：引入单位变量 ${renderMono(R, t.unit)}，具体单位由上下文约束确定`);
      return t;
    }
    case 'ident': {
      const sc = env.get(node.name);
      if (!sc) {
        throw new InferError(`未定义标识符「${node.name}」`, [
          spanOf(node, `未定义标识符「${node.name}」`),
        ]);
      }
      const t = instantiate(ctx, sc);
      if (sc.tvars.length || sc.uvars.length) {
        log(
          ctx,
          `引用「${node.name}」：类型方案 ${renderScheme(R, sc)} 重新实例化为 ${renderType(R, t)}（每次引用独立实例化，互不影响）`,
        );
      } else {
        log(ctx, `引用「${node.name}」：${renderType(R, t)}`);
      }
      return t;
    }
    case 'fun': {
      const tv = newTVar(ctx);
      log(ctx, `引入参数「${node.param}」：类型变量 ${nameT(R, tv)}`);
      const env2 = new Map(env);
      env2.set(node.param, { tvars: [], uvars: [], type: tv });
      const tb = inferNode(ctx, env2, node.body);
      const ft = { kind: 'fun', param: tv, ret: tb };
      log(ctx, `函数类型归并：${renderType(R, ft)}`);
      return ft;
    }
    case 'app': {
      const tf = inferNode(ctx, env, node.func);
      const ta = inferNode(ctx, env, node.arg);
      const beta = newTVar(ctx);
      log(ctx, `调用约束：函数类型 ${renderType(R, tf)} 须与 ${renderType(R, ta)} -> ${nameT(R, beta)} 合一`);
      try {
        unify(ctx, tf, { kind: 'fun', param: ta, ret: beta });
      } catch (e) {
        if (e instanceof U.UnifyError) throw appError(ctx, node, e, tf, ta);
        throw e;
      }
      log(ctx, `调用结果类型：${renderType(R, beta)}`);
      return beta;
    }
    case 'neg': {
      const te = inferNode(ctx, env, node.expr);
      const t = { kind: 'num', unit: U.monoVar(newUVar(ctx)) };
      try {
        unify(ctx, te, t);
      } catch (e) {
        if (e instanceof U.UnifyError) {
          throw new InferError(`取负运算要求数值类型，但此处为 ${renderType(R, te)}`, [
            spanOf(node.expr, `非数值类型：${renderType(R, te)}`),
          ]);
        }
        throw e;
      }
      return t;
    }
    case 'binop':
      return inferBinop(ctx, env, node);
    case 'let': {
      ctx.level++;
      let tv;
      try {
        tv = inferNode(ctx, env, node.value);
      } finally {
        ctx.level--;
      }
      const sc = generalize(ctx, tv);
      ctx.lets.push({ name: node.name, scheme: sc });
      const qn = [...sc.tvars.map((v) => nameT(R, v)), ...sc.uvars.map((v) => nameU(R, v))];
      log(
        ctx,
        qn.length
          ? `let 绑定「${node.name}」：泛化变量 ${qn.join('、')}，得到类型方案 ${renderScheme(R, sc)}；每次引用将独立实例化`
          : `let 绑定「${node.name}」：类型 ${renderScheme(R, sc)}（无可泛化变量）`,
      );
      if (node.body === null) {
        env.set(node.name, sc);
        return tv;
      }
      const env2 = new Map(env);
      env2.set(node.name, sc);
      return inferNode(ctx, env2, node.body);
    }
    default:
      throw new Error(`未知节点类型：${node.kind}`);
  }
}

function inferBinop(ctx, env, node) {
  const R = ctx.R;
  const tl = inferNode(ctx, env, node.left);
  const tr = inferNode(ctx, env, node.right);
  if (node.op === '+' || node.op === '-') {
    // 加减：两侧须为相同单位的数值
    const t = { kind: 'num', unit: U.monoVar(newUVar(ctx)) };
    log(ctx, `「${node.op}」约束：两侧须为相同单位的数值；左侧 ${renderType(R, tl)}，右侧 ${renderType(R, tr)}`);
    try {
      unify(ctx, tl, t);
      unify(ctx, tr, t);
    } catch (e) {
      if (e instanceof U.UnifyError) throw binopError(ctx, node, e, tl, tr);
      throw e;
    }
    log(ctx, `「${node.op}」结果类型：${renderType(R, t)}`);
    return t;
  }
  // 乘除：组合单位
  const ua = U.monoVar(newUVar(ctx));
  const ub = U.monoVar(newUVar(ctx));
  try {
    unify(ctx, tl, { kind: 'num', unit: ua });
    unify(ctx, tr, { kind: 'num', unit: ub });
  } catch (e) {
    if (e instanceof U.UnifyError) throw binopError(ctx, node, e, tl, tr);
    throw e;
  }
  const ru = node.op === '*' ? U.monoMul(ua, ub) : U.monoDiv(ua, ub);
  log(ctx, `「${node.op}」单位组合：${renderMono(R, ua)} ${node.op} ${renderMono(R, ub)} ⇒ ${renderMono(R, ru)}`);
  return { kind: 'num', unit: ru };
}

/* ---------------- 错误加工（定位源码片段） ---------------- */

function binopError(ctx, node, e, tl, tr) {
  const R = ctx.R;
  const lSpan = spanOf(node.left, `左操作数：${renderType(R, tl)}`);
  const rSpan = spanOf(node.right, `右操作数：${renderType(R, tr)}`);
  if (e.kind === 'unit-mismatch') {
    return new InferError(
      `单位不匹配：「${node.op}」要求两侧单位相同，但左操作数为 ${renderType(R, tl)}、右操作数为 ${renderType(R, tr)}`,
      [lSpan, rSpan],
    );
  }
  if (e.kind === 'type-mismatch') {
    const badLeft = prune(tl).kind !== 'num';
    const badT = badLeft ? tl : tr;
    return new InferError(
      `「${node.op}」的操作数须为数值类型，但${badLeft ? '左' : '右'}侧为 ${renderType(R, badT)}`,
      [spanOf(badLeft ? node.left : node.right, `非数值类型：${renderType(R, badT)}`)],
    );
  }
  return enrichUnify(ctx, e, node);
}

function appError(ctx, node, e, tf, ta) {
  const R = ctx.R;
  if (e.kind === 'occurs') {
    return new InferError(
      `无限类型：类型变量 ${nameT(R, e.v)} 出现在 ${renderType(R, e.t)} 中，自应用无法构造有限类型（occurs check 失败）`,
      [spanOf(node, '自应用调用'), spanOf(node.func, '被调用表达式'), spanOf(node.arg, '实参')],
    );
  }
  if (e.kind === 'type-mismatch') {
    return new InferError(`类型不匹配：试图调用非函数类型 ${renderType(R, tf)}`, [
      spanOf(node.func, `非函数类型：${renderType(R, tf)}`),
      spanOf(node.arg, `实参：${renderType(R, ta)}`),
    ]);
  }
  if (e.kind === 'unit-mismatch') {
    return new InferError(
      `单位不匹配：实参单位与形参要求不符（${renderMono(R, e.u1)} 与 ${renderMono(R, e.u2)}）`,
      [spanOf(node.arg, `实参：${renderType(R, ta)}`), spanOf(node.func, `形参要求：${renderType(R, tf)}`)],
    );
  }
  return enrichUnify(ctx, e, node);
}

function enrichUnify(ctx, e, node) {
  const R = ctx.R;
  switch (e.kind) {
    case 'occurs':
      return new InferError(
        `无限类型：类型变量 ${nameT(R, e.v)} 出现在 ${renderType(R, e.t)} 中（occurs check 失败）`,
        [spanOf(node, '约束冲突位置')],
      );
    case 'type-mismatch':
      return new InferError(
        `类型不匹配：${renderType(R, e.t1)} 与 ${renderType(R, e.t2)} 无法统一`,
        [spanOf(node, '类型冲突位置')],
      );
    case 'unit-mismatch':
      return new InferError(
        `单位不匹配：${renderMono(R, e.u1)} 与 ${renderMono(R, e.u2)} 无法统一`,
        [spanOf(node, '单位冲突位置')],
      );
    case 'occurs-unit':
      return new InferError('无限单位类型：单位变量出现在其自身定义中（occurs check 失败）', [
        spanOf(node, '单位冲突位置'),
      ]);
    default:
      return new InferError(`类型错误：${e.message}`, [spanOf(node, '错误位置')]);
  }
}

/* ---------------- 程序级入口 ---------------- */

function inferProgram(ctx, statements) {
  const env = new Map();
  let last = null;
  for (const st of statements) last = inferNode(ctx, env, st);
  return last;
}

const KIND_LABEL = {
  sensor: '传感器声明',
  let: 'let 绑定',
  num: '数值',
  ident: '标识符',
  fun: '函数（单参数）',
  app: '调用',
  binop: '四则运算',
  neg: '取负',
};

function lineColIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo] + 1 };
  };
}

function snippet(source, node) {
  const s = source.slice(node.span.start, node.span.end).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function fmtSpans(source, spans) {
  const lc = lineColIndex(source);
  return (spans || []).map((s) => {
    const a = lc(s.start);
    const b = lc(Math.max(s.start, s.end - 1));
    return {
      start: s.start,
      end: s.end,
      label: s.label || '',
      startLine: a.line,
      startCol: a.col,
      endLine: b.line,
      endCol: b.col + 1,
    };
  });
}

function errorResult(source, message, spans) {
  // 出错响应不携带任何成功结论（expressions 等），由页面清除旧结论
  return { ok: false, error: { message, spans: fmtSpans(source, spans) } };
}

/** 对源码完成「解析 + Hindley–Milner 主类型推断」，返回 API 形状的结果。 */
function runInference(source) {
  let prog;
  try {
    prog = parse(source);
  } catch (e) {
    if (e instanceof ParseError) return errorResult(source, e.message, e.spans);
    throw e;
  }
  const ctx = newCtx();
  let last;
  try {
    last = inferProgram(ctx, prog.statements);
  } catch (e) {
    if (e instanceof InferError) return errorResult(source, e.message, e.spans);
    if (e instanceof U.UnifyError) {
      const ie = enrichUnify(ctx, e, { span: { start: 0, end: source.length } });
      return errorResult(source, ie.message, ie.spans);
    }
    throw e;
  }
  const R = ctx.R;
  const lc = lineColIndex(source);
  for (const node of prog.nodes) {
    const t = ctx.nodeType.get(node.id);
    if (t) pushEvent(ctx, node.id, `最终归约类型：${renderType(R, t)}`);
  }
  const expressions = prog.nodes
    .slice()
    .sort((a, b) => a.span.start - b.span.start || a.id - b.id)
    .map((node) => {
      const pos = lc(node.span.start);
      const t = ctx.nodeType.get(node.id);
      return {
        id: node.id,
        kind: node.kind === 'binop' ? `四则运算「${node.op}」` : KIND_LABEL[node.kind],
        snippet: snippet(source, node),
        line: pos.line,
        col: pos.col,
        type: t ? renderType(R, t) : '—',
        events: ctx.events.get(node.id) || [],
      };
    });
  const generalizable = ctx.lets.map((l) => ({
    name: l.name,
    scheme: renderScheme(R, l.scheme),
    quantified: [...l.scheme.tvars.map((v) => nameT(R, v)), ...l.scheme.uvars.map((v) => nameU(R, v))],
  }));
  return {
    ok: true,
    expressions,
    generalizable,
    output: last ? renderType(R, last) : '（无输出表达式）',
  };
}

module.exports = { runInference, InferError };
