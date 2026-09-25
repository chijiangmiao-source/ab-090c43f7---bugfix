'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runInference } = require('./infer');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/infer') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let source;
      try {
        ({ source } = JSON.parse(body));
        if (typeof source !== 'string') throw new Error('source 必须是字符串');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: { message: `请求格式错误：${e.message}`, spans: [] } });
        return;
      }
      try {
        sendJson(res, 200, runInference(source));
      } catch (e) {
        sendJson(res, 500, { ok: false, error: { message: `服务器内部错误：${e.message}`, spans: [] } });
      }
    });
    return;
  }

  if (req.method === 'GET') {
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  res.writeHead(405);
  res.end('method not allowed');
});

server.listen(PORT, () => {
  console.log(`校准宏类型推断服务已启动：http://localhost:${PORT}`);
});
