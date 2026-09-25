'use strict';

const EXAMPLES = {
  identity: `// 校准宏：恒等宏跨量纲复用
sensor len : m;
sensor tim : s;
let id = fun x -> x;
let a = id len;
let b = id tim;
id len * id tim
`,
  conflict: `// 异单位相加：应定位两个操作数
sensor a : m;
sensor b : s;
a + b
`,
  omega: `// 自应用：occurs check 触发无限类型错误
let f = fun x -> x x;
f
`,
  nested: `// 局部宏 g 捕获外层读数 r：两次调用共享同一份量纲
// 分别喂入长度与时间本应矛盾，必须拒绝（不得泛化被捕获读数）
sensor rd : m;
let f = fun r ->
  let g = fun x -> r + x in
  g 1<m> * g 1<s>;
f rd
`,
  units: `sensor d : m;
sensor t : s;
let v = d / t;
let sq = fun x -> x * x;
sq d * v
`,
};

const sourceEl = document.getElementById('source');
const runBtn = document.getElementById('run');
const exampleSel = document.getElementById('example');
const resultsEl = document.getElementById('results');
const errorEl = document.getElementById('error-panel');
const rowsEl = document.getElementById('expr-rows');
const evidenceEl = document.getElementById('evidence');
const outputEl = document.getElementById('output-type');
const genEl = document.getElementById('gen-vars');

let lastResult = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 清除旧结论：提交新推断、编辑脚本或切换示例时调用。 */
function clearPanels() {
  lastResult = null;
  resultsEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  errorEl.innerHTML = '';
  rowsEl.innerHTML = '';
  evidenceEl.innerHTML = '';
  evidenceEl.classList.add('hidden');
}

async function runInfer() {
  clearPanels();
  let res;
  try {
    const r = await fetch('/api/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: sourceEl.value }),
    });
    res = await r.json();
  } catch (e) {
    showError({ message: `请求失败：${e.message}`, spans: [] });
    return;
  }
  if (res.ok) showResults(res);
  else showError(res.error);
}

function showResults(res) {
  lastResult = res;
  resultsEl.classList.remove('hidden');
  outputEl.textContent = res.output;

  genEl.innerHTML = '';
  if (!res.generalizable.length) {
    genEl.innerHTML = '<p class="dim">（无 let 绑定，无可泛化类型变量）</p>';
  } else {
    for (const g of res.generalizable) {
      const div = document.createElement('div');
      div.className = 'gen-item';
      const q = g.quantified.length ? g.quantified.join('、') : '（单态，无可泛化变量）';
      div.innerHTML =
        `<code>${escapeHtml(g.name)} : ${escapeHtml(g.scheme)}</code>` +
        `<span class="dim">可泛化变量：${escapeHtml(q)}</span>`;
      genEl.appendChild(div);
    }
  }

  rowsEl.innerHTML = '';
  for (const e of res.expressions) {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    tr.innerHTML =
      `<td class="pos">${e.line}:${e.col}</td>` +
      `<td><code>${escapeHtml(e.snippet)}</code></td>` +
      `<td>${escapeHtml(e.kind)}</td>` +
      `<td><code class="ty">${escapeHtml(e.type)}</code></td>`;
    tr.addEventListener('click', () => selectExpr(e.id));
    rowsEl.appendChild(tr);
  }
}

function selectExpr(id) {
  for (const tr of rowsEl.children) tr.classList.toggle('selected', Number(tr.dataset.id) === id);
  const e = lastResult.expressions.find((x) => x.id === id);
  if (!e) return;
  evidenceEl.classList.remove('hidden');
  const steps = e.events.length
    ? `<ol>${e.events.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : '<p class="dim">（该表达式无额外约束步骤）</p>';
  evidenceEl.innerHTML =
    `<h3>约束归并依据：<code>${escapeHtml(e.snippet)}</code> ⇒ <code class="ty">${escapeHtml(e.type)}</code></h3>${steps}`;
}

function showError(err) {
  // 出错时不保留任何旧结论：结果区已清空，仅展示错误与冲突源码定位
  errorEl.classList.remove('hidden');
  const source = sourceEl.value;
  let html = `<h2>推断失败</h2><p class="err-msg">${escapeHtml(err.message)}</p>`;
  html += '<p class="dim">存在错误：此前的推断结论已清除，不会保留。</p>';
  if (err.spans && err.spans.length) {
    html += `<div class="src-view"><pre>${markedSource(source, err.spans)}</pre></div>`;
    html += '<ul class="legend">' + err.spans.map((s, i) =>
      `<li><span class="chip mk${i % 6}">${i + 1}</span> 第 ${s.startLine} 行第 ${s.startCol} 列` +
      `${s.label ? `：${escapeHtml(s.label)}` : ''}</li>`).join('') + '</ul>';
  }
  errorEl.innerHTML = html;
}

/** 按区间拆分源码并叠加高亮（支持嵌套区间）。 */
function markedSource(source, spans) {
  const bounds = new Set([0, source.length]);
  for (const s of spans) {
    bounds.add(Math.max(0, Math.min(s.start, source.length)));
    bounds.add(Math.max(0, Math.min(s.end, source.length)));
  }
  const pts = [...bounds].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const text = escapeHtml(source.slice(a, b));
    const covering = [];
    spans.forEach((s, idx) => {
      if (s.start <= a && b <= s.end) covering.push(idx);
    });
    if (!covering.length) html += text;
    else html += `<mark class="${covering.map((i2) => `mk${i2 % 6}`).join(' ')}">${text}</mark>`;
  }
  return html;
}

exampleSel.addEventListener('change', () => {
  sourceEl.value = EXAMPLES[exampleSel.value] || '';
  clearPanels();
});
sourceEl.addEventListener('input', clearPanels);
runBtn.addEventListener('click', runInfer);

sourceEl.value = EXAMPLES.identity;
