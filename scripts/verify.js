'use strict';

/**
 * verify 服务：构建检查 + 代码测试 + HTTP 复核，执行完以退出码报告。
 *   退出码 0：全部通过；非 0：存在失败项。
 * 环境变量 APP_URL 指定被复核服务地址（Compose 中为 http://app:8080）。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

let failures = 0;
const pass = (m) => console.log(`  ✔ ${m}`);
const fail = (m) => {
  failures++;
  console.error(`  ✘ ${m}`);
};

function listJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function buildCheck() {
  console.log('[1/3] 构建检查：语法校验与必备文件');
  const files = [
    ...listJs(path.join(ROOT, 'src')),
    ...listJs(path.join(ROOT, 'test')),
    ...listJs(path.join(ROOT, 'scripts')),
    ...listJs(path.join(ROOT, 'public')),
  ];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status === 0) pass(`node --check ${path.relative(ROOT, f)}`);
    else fail(`node --check ${path.relative(ROOT, f)} 失败：${String(r.stderr).trim()}`);
  }
  for (const f of ['package.json', 'Dockerfile', 'docker-compose.yml', 'public/index.html']) {
    if (fs.existsSync(path.join(ROOT, f))) pass(`必备文件存在：${f}`);
    else fail(`缺少必备文件：${f}`);
  }
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pass('package.json 为合法 JSON');
  } catch (e) {
    fail(`package.json 解析失败：${e.message}`);
  }
}

function unitTests() {
  console.log('[2/3] 代码测试：node --test');
  const r = spawnSync(process.execPath, ['--test', 'test/'], { cwd: ROOT, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) pass('单元测试全部通过');
  else fail(`单元测试未通过（退出码 ${r.status}）`);
}

async function waitHealthy() {
  const deadline = Date.now() + 60000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${APP_URL}/healthz`);
      if (r.ok) return;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`等待服务健康检查超时：${lastErr}`);
}

async function postInfer(source) {
  const r = await fetch(`${APP_URL}/api/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  return r.json();
}

async function httpChecks() {
  console.log(`[3/3] HTTP 复核：${APP_URL}`);
  await waitHealthy();
  pass('健康检查 GET /healthz 通过');

  // 场景一：恒等宏跨量纲复用 —— 两份独立正确类型 + 最终输出类型
  const idScript = [
    'sensor len : m;',
    'sensor tim : s;',
    'let id = fun x -> x;',
    'let a = id len;',
    'let b = id tim;',
    'id len * id tim',
    '',
  ].join('\n');
  const r1 = await postInfer(idScript);
  if (r1.ok) {
    pass('恒等宏脚本推断成功');
    const lenTypes = r1.expressions.filter((e) => e.snippet === 'id len').map((e) => e.type);
    const timTypes = r1.expressions.filter((e) => e.snippet === 'id tim').map((e) => e.type);
    if (lenTypes.length > 0 && lenTypes.every((t) => t === 'num<m>')) {
      pass(`宏作用于长度读数：${lenTypes.length} 处调用均为 num<m>`);
    } else {
      fail(`宏作用于长度读数类型错误：${JSON.stringify(lenTypes)}`);
    }
    if (timTypes.length > 0 && timTypes.every((t) => t === 'num<s>')) {
      pass(`宏作用于时间读数：${timTypes.length} 处调用均为 num<s>`);
    } else {
      fail(`宏作用于时间读数类型错误：${JSON.stringify(timTypes)}`);
    }
    if (r1.output === 'num<m*s>') pass(`最终输出类型：${r1.output}`);
    else fail(`最终输出类型错误：${r1.output}（期望 num<m*s>）`);
    const idGen = (r1.generalizable || []).find((g) => g.name === 'id');
    if (idGen && idGen.scheme.startsWith('∀')) pass(`id 类型方案已泛化：${idGen.scheme}`);
    else fail(`id 类型方案未泛化：${JSON.stringify(idGen)}`);
  } else {
    fail(`恒等宏脚本推断失败：${r1.error && r1.error.message}`);
  }

  // 场景二：异单位相加 —— 定位两个操作数且不保留成功结论
  const conflictSrc = 'sensor a : m;\nsensor b : s;\na + b\n';
  const r2 = await postInfer(conflictSrc);
  if (!r2.ok) {
    pass('异单位相加被拒绝');
    if (/单位不匹配/.test(r2.error.message)) pass(`错误信息：${r2.error.message}`);
    else fail(`错误信息未说明单位不匹配：${r2.error.message}`);
    if (r2.error.spans.length === 2) {
      const covered = r2.error.spans.map((s) => conflictSrc.slice(s.start, s.end));
      if (covered[0] === 'a' && covered[1] === 'b') pass('两个操作数均被定位（a 与 b）');
      else fail(`定位片段异常：${JSON.stringify(covered)}（期望 ["a","b"]）`);
    } else {
      fail(`定位数量异常：${r2.error.spans.length}（期望 2）`);
    }
    if (!('expressions' in r2)) pass('出错响应不携带旧的成功结论');
    else fail('出错响应仍携带 expressions（旧结论未清除）');
  } else {
    fail('异单位相加未被拒绝');
  }

  // 场景三：自应用 —— 稳定的无限类型错误与相关位置
  const omegaSrc = 'let f = fun x -> x x;\nf\n';
  const o1 = await postInfer(omegaSrc);
  const o2 = await postInfer(omegaSrc);
  if (!o1.ok && /无限类型/.test(o1.error.message)) pass(`自应用报无限类型错误：${o1.error.message}`);
  else fail(`自应用错误异常：${JSON.stringify(o1)}`);
  if (o1.error && o1.error.spans.length >= 1) pass(`错误位置已给出（${o1.error.spans.length} 处）`);
  else fail('自应用错误缺少位置');
  if (JSON.stringify(o1.error) === JSON.stringify(o2.error)) pass('重复推断错误稳定一致');
  else fail('重复推断错误不一致（不稳定）');

  // 场景四：嵌套局部宏捕获外层读数 —— 两次异单位调用必须被拒绝，并定位两处调用
  const nestedSrc = [
    'sensor len : m;',
    'sensor tim : s;',
    'let outer = fun r -> let h = fun x -> r + x in h len * h tim',
    '',
  ].join('\n');
  const n1 = await postInfer(nestedSrc);
  const n2 = await postInfer(nestedSrc);
  if (!n1.ok && /单位冲突|单位不匹配/.test(n1.error.message)) {
    pass(`嵌套局部宏矛盾脚本被拒绝：${n1.error.message}`);
  } else if (n1.ok) {
    fail(`嵌套局部宏矛盾脚本被错误推断成功：output=${n1.output}`);
  } else {
    fail(`嵌套局部宏错误信息异常：${n1.error && n1.error.message}`);
  }
  if (n1.error && n1.error.spans.length === 2) {
    const covered = n1.error.spans.map((s) => nestedSrc.slice(s.start, s.end));
    if (covered[0] === 'h len' && covered[1] === 'h tim') {
      pass(`两次调用均被定位（${covered.join('、')}），位置一致`);
    } else {
      fail(`定位片段异常：${JSON.stringify(covered)}（期望 ["h len","h tim"]）`);
    }
    if (n1.error.spans[0].startLine === 3 && n1.error.spans[1].startLine === 3) {
      pass(`调用行列定位一致（第 3 行：${n1.error.spans[0].startCol} 列、${n1.error.spans[1].startCol} 列）`);
    } else {
      fail(`调用行列定位异常：${JSON.stringify(n1.error.spans.map((s) => [s.startLine, s.startCol]))}`);
    }
  } else {
    fail(`嵌套局部宏定位数量异常：${n1.error && n1.error.spans.length}（期望 2）`);
  }
  if (!('expressions' in n1) && !('generalizable' in n1) && !('output' in n1)) {
    pass('嵌套局部宏失败响应不携带成功表达式、泛化变量与输出结论');
  } else {
    fail('嵌套局部宏失败响应仍保留成功结论');
  }
  if (JSON.stringify(n1.error) === JSON.stringify(n2.error)) pass('嵌套局部宏重复推断失败结果与定位一致');
  else fail('嵌套局部宏重复推断结果不一致（不稳定）');

  // 场景四补充：捕获读数但两次调用同单位 —— 应正常成立（回归不误报）
  const nestedOkSrc = 'sensor len : m;\nlet outer = fun r -> let h = fun x -> r + x in h len * h len\n';
  const nr = await postInfer(nestedOkSrc);
  if (nr.ok && nr.output === 'num<m> -> num<m^2>') pass(`同单位双调用仍成立：${nr.output}`);
  else fail(`同单位双调用回归异常：${JSON.stringify(nr).slice(0, 200)}`);
}

(async () => {
  console.log('== 校准宏页面验证 ==');
  buildCheck();
  unitTests();
  try {
    await httpChecks();
  } catch (e) {
    fail(`HTTP 复核异常：${e.message}`);
  }
  console.log(failures === 0 ? '== 全部验证通过 ==' : `== 验证失败：${failures} 项 ==`);
  process.exit(failures === 0 ? 0 : 1);
})();
