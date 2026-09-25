'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runInference } = require('../src/infer');

const IDENTITY_SCRIPT = `// 恒等宏跨量纲复用
sensor len : m;
sensor tim : s;
let id = fun x -> x;
let a = id len;
let b = id tim;
id len * id tim
`;

test('恒等宏跨量纲复用：两次实例化互不影响', () => {
  const r = runInference(IDENTITY_SCRIPT);
  assert.equal(r.ok, true);
  const typesOf = (s) => r.expressions.filter((e) => e.snippet === s).map((e) => e.type);
  assert.ok(typesOf('id len').length > 0);
  assert.ok(typesOf('id len').every((t) => t === 'num<m>'), '宏作用于长度读数应为 num<m>');
  assert.ok(typesOf('id tim').length > 0);
  assert.ok(typesOf('id tim').every((t) => t === 'num<s>'), '宏作用于时间读数应为 num<s>');
  assert.equal(r.output, 'num<m*s>');
  const idGen = r.generalizable.find((g) => g.name === 'id');
  assert.ok(idGen, 'id 应有类型方案');
  assert.match(idGen.scheme, /^∀ /);
  assert.equal(idGen.quantified.length, 1);
});

test('异单位相加：定位两个操作数且不保留成功结论', () => {
  const src = 'sensor a : m;\nsensor b : s;\na + b\n';
  const r = runInference(src);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /单位不匹配/);
  assert.equal(r.error.spans.length, 2);
  const covered = r.error.spans.map((s) => src.slice(s.start, s.end));
  assert.deepEqual(covered, ['a', 'b']);
  assert.match(r.error.spans[0].label, /左操作数/);
  assert.match(r.error.spans[1].label, /右操作数/);
  assert.equal(r.expressions, undefined, '出错响应不得携带旧的成功结论');
});

test('自应用：稳定的无限类型错误与相关位置', () => {
  const src = 'let f = fun x -> x x;\nf\n';
  const r1 = runInference(src);
  const r2 = runInference(src);
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /无限类型/);
  assert.match(r1.error.message, /occurs check/);
  assert.ok(r1.error.spans.length >= 1, '应给出错误位置');
  const xx = r1.error.spans[0];
  assert.equal(src.slice(xx.start, xx.end), 'x x');
  assert.deepEqual(r1.error, r2.error, '重复推断错误应完全一致（稳定）');
});

test('未定义标识符：报错并定位', () => {
  const src = 'foo + 1\n';
  const r = runInference(src);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /未定义标识符「foo」/);
  assert.equal(src.slice(r.error.spans[0].start, r.error.spans[0].end), 'foo');
});

test('乘除组合单位', () => {
  assert.equal(runInference('sensor a : m;\nsensor b : s;\na * b\n').output, 'num<m*s>');
  assert.equal(runInference('sensor a : m;\nsensor b : s;\na / b\n').output, 'num<m*s^-1>');
  assert.equal(runInference('sensor a : m;\na * a\n').output, 'num<m^2>');
  assert.equal(runInference('sensor a : m;\na / a\n').output, 'num<1>');
});

test('加减接受相同单位', () => {
  assert.equal(runInference('sensor a : m;\nsensor b : m;\na + b\n').output, 'num<m>');
  assert.equal(runInference('sensor a : m;\nsensor b : m;\na - b\n').output, 'num<m>');
});

test('数值字面量单位多态；带单位标注的字面量', () => {
  const r = runInference('let f = fun x -> x + 1;\nf\n');
  assert.equal(r.ok, true);
  const m = r.output.match(/^num<('u\d+)> -> num<('u\d+)>$/);
  assert.ok(m, `输出应为单位多态函数，实际：${r.output}`);
  assert.equal(m[1], m[2], '加减要求两侧单位一致');
  assert.equal(runInference('3.5<m/s>\n').output, 'num<m*s^-1>');
  assert.equal(runInference('9.8<m/s^2>\n').output, 'num<m*s^-2>');
});

test('let 多态：同一宏用于具体量纲与多态字面量', () => {
  const r = runInference('sensor a : m;\nlet id = fun x -> x;\nlet p = id a;\nlet q = id 1.5;\nq\n');
  assert.equal(r.ok, true);
  assert.match(r.output, /^num<'u\d+>$/);
  const p = r.generalizable.find((g) => g.name === 'p');
  assert.equal(p.scheme, 'num<m>');
  assert.equal(p.quantified.length, 0);
});

test('高阶单位多态：fun x -> x * x', () => {
  const r = runInference('sensor a : m;\nlet sq = fun x -> x * x;\nsq a\n');
  assert.equal(r.ok, true);
  assert.equal(r.output, 'num<m^2>');
  const sq = r.generalizable.find((g) => g.name === 'sq');
  assert.match(sq.scheme, /^∀ 'u\d+\. num<'u\d+> -> num<'u\d+\^2>$/);
});

test('传感器复合单位声明', () => {
  assert.equal(runInference('sensor v : m/s;\nv\n').output, 'num<m*s^-1>');
  assert.equal(runInference('sensor a : m^2;\na\n').output, 'num<m^2>');
  assert.equal(runInference('sensor x : 1;\nx\n').output, 'num<1>');
});

test('let-in 表达式形式', () => {
  const r = runInference('let id = fun x -> x in id 1\n');
  assert.equal(r.ok, true);
  assert.match(r.output, /^num<'u\d+>$/);
});

test('调用非函数：类型不匹配并定位', () => {
  const r = runInference('sensor a : m;\na a\n');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /类型不匹配|非函数/);
  assert.ok(r.error.spans.length >= 1);
});

test('实参单位与形参不符：单位不匹配', () => {
  const r = runInference('sensor a : m;\nsensor b : s;\nlet f = fun x -> x + a;\nf b\n');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /单位不匹配/);
});

test('解析错误定位', () => {
  const r = runInference('let = 1;\n');
  assert.equal(r.ok, false);
  assert.ok(r.error.spans.length >= 1);
});

test('成功表达式携带约束归并依据（事件）', () => {
  const r = runInference(IDENTITY_SCRIPT);
  const app = r.expressions.find((e) => e.snippet === 'id len');
  assert.ok(app, '应存在调用表达式 id len');
  assert.ok(app.events.some((s) => /约束|合一/.test(s)), '调用节点应记录合一约束');
  assert.ok(app.events.some((s) => /最终归约类型：num<m>/.test(s)));
  const idRef = r.expressions.find((e) => e.kind === '标识符' && e.snippet === 'id');
  assert.ok(idRef.events.some((s) => /实例化/.test(s)), '宏引用应记录方案实例化');
});

test('推断确定性：同一脚本两次结果完全一致', () => {
  const a = runInference(IDENTITY_SCRIPT);
  const b = runInference(IDENTITY_SCRIPT);
  assert.deepEqual(a, b);
});

const NESTED_CAPTURE_SCRIPT = `// 局部宏捕获外层读数：两次调用把同一读数约束为 m 与 s
sensor len : m;
sensor tim : s;
let outer = fun r -> let h = fun x -> r + x in h len * h tim
`;

test('嵌套局部宏：捕获外层读数时两次异单位调用被稳定拒绝并定位两处调用', () => {
  const r = runInference(NESTED_CAPTURE_SCRIPT);
  assert.equal(r.ok, false, '本应矛盾的脚本不能推断成功');
  assert.match(r.error.message, /单位冲突|单位不匹配/);
  assert.match(r.error.message, /m/);
  assert.match(r.error.message, /s/);
  // 定位两次调用 h len 与 h tim（共同约束同一份被捕获读数）
  const covered = r.error.spans.map((s) => NESTED_CAPTURE_SCRIPT.slice(s.start, s.end));
  assert.ok(covered.includes('h len'), `应定位第一次调用：${JSON.stringify(covered)}`);
  assert.ok(covered.includes('h tim'), `应定位第二次调用：${JSON.stringify(covered)}`);
  const lenSpan = r.error.spans.find((s) => NESTED_CAPTURE_SCRIPT.slice(s.start, s.end) === 'h len');
  const timSpan = r.error.spans.find((s) => NESTED_CAPTURE_SCRIPT.slice(s.start, s.end) === 'h tim');
  assert.ok(lenSpan.start < timSpan.start, '调用位置按源码顺序给出');
  // 失败时清除本次请求的成功表达式、泛化变量与输出结论
  assert.equal(r.expressions, undefined);
  assert.equal(r.generalizable, undefined);
  assert.equal(r.output, undefined);
});

test('嵌套局部宏：重复推断失败结果与定位完全一致', () => {
  const a = runInference(NESTED_CAPTURE_SCRIPT);
  const b = runInference(NESTED_CAPTURE_SCRIPT);
  assert.deepEqual(a, b, '两次推断的失败结果须完全一致（稳定）');
});

test('嵌套局部宏：捕获读数但两次调用同单位仍成立（不误报）', () => {
  const src = 'sensor len : m;\nlet outer = fun r -> let h = fun x -> r + x in h len * h len\n';
  const r = runInference(src);
  assert.equal(r.ok, true);
  assert.equal(r.output, 'num<m> -> num<m^2>');
});

test('嵌套局部宏：未捕获外层读数的内层宏仍可泛化（保持 let 多态）', () => {
  const src = 'sensor len : m;\nsensor tim : s;\nlet outer = fun r -> let h = fun x -> x in h len * h tim\n';
  const r = runInference(src);
  assert.equal(r.ok, true);
  const h = r.generalizable.find((g) => g.name === 'h');
  assert.ok(h, '内层 let 绑定仍应给出类型方案');
  assert.match(h.scheme, /^∀ /, '未捕获外层读数的局部宏应被泛化');
});
