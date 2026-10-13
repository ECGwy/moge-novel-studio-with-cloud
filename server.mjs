#!/usr/bin/env node
/* 墨阁本地服务器：静态托管 + CORS 代理（零依赖）
 * 用法： node server.mjs [端口]
 * 手机与电脑连同一个 Wi-Fi，浏览器打开下面打印的 http://192.168.x.x:端口
 * 想装成真正的 App（可用离线），建议部署到 https 静态托管，见 README。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '86400',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function handleProxy(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return send(res, 400, 'missing ?url=', CORS);
  if (req.method === 'OPTIONS') return send(res, 204, '', CORS);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest'].includes(k)) continue;
    headers[k] = v;
  }

  try {
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'follow' });
    const out = {};
    for (const [k, v] of upstream.headers) {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
      out[k] = v;
    }
    res.writeHead(upstream.status, { ...out, ...CORS, 'cache-control': 'no-store' });
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    send(res, 502, 'proxy error: ' + (e?.message || e), CORS);
  }
}

function handleStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, '404 Not Found: ' + rel, { 'content-type': 'text/plain; charset=utf-8' });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
      'service-worker-allowed': '/',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__proxy') return handleProxy(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  handleStatic(req, res, url);
});

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  墨阁 · 本地服务已启动\n');
  console.log('  电脑访问:   http://localhost:' + PORT + '/');
  for (const ip of lanIPs()) console.log('  手机访问:   http://' + ip + ':' + PORT + '/   （需同一 Wi-Fi）');
  console.log('\n  AI 直连被浏览器拦截时，在「我的 → 高级选项 → CORS 代理」填：');
  console.log('    http://<电脑IP>:' + PORT + '/__proxy?url=\n');
  console.log('  按 Ctrl+C 停止\n');
});
