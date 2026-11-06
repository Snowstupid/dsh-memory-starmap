#!/usr/bin/env node
/**
 * 独立跑（不装 DSH 也能看）：node bin/serve.js → http://127.0.0.1:8787
 * 和插件用的是同一份 store + 同一个页面。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIndex, graphPayload, nodeDetail, patchOverrides, readOverrides, recall, search } from '../lib/store.js';
import { listRules, readRule, writeRule } from '../lib/rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const PORT = Number(process.env.MOBIUS_PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

let lastReport = null;

function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { req.destroy(); return cb(`too-large: >${limit}B`); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => cb(String(e?.message || e)));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/graph') return json(res, 200, graphPayload(getIndex(), readOverrides()));
  if (p === '/api/meta') return json(res, 200, getIndex().meta);
  if (p === '/api/search') {
    return json(res, 200, { q: q.get('q') || '', hits: search(getIndex(), q.get('q') || '', 12, readOverrides()) });
  }
  if (p === '/api/rules') {
    return json(res, 200, listRules());
  }
  if (p === '/api/rules/file') {
    if (req.method === 'GET') {
      const out = readRule(q.get('path') || '');
      return out.status === 200 ? json(res, 200, out.body) : json(res, out.status, { ok: false, error: out.error });
    }
    return readBody(req, 1024 * 1024, (err, text) => {
      if (err) return json(res, 400, { ok: false, error: err });
      let body;
      try { body = JSON.parse(text); } catch { return json(res, 400, { ok: false, error: 'bad-json' }); }
      const out = writeRule(body);
      return out.status === 200 ? json(res, 200, out.body) : json(res, out.status, { ok: false, ...out });
    });
  }
  if (p === '/api/overrides') {
    const ov = readOverrides();
    if (req.method === 'GET') return json(res, 200, ov);
    return readBody(req, 64 * 1024, (err, text) => {
      if (err) return json(res, 400, { ok: false, error: err });
      let body;
      try { body = JSON.parse(text); } catch { return json(res, 400, { ok: false, error: 'bad-json' }); }
      const out = patchOverrides(body.rev, body.action, body);
      if (out.status === 200) return json(res, 200, out.state);
      json(res, out.status, { ok: false, error: out.error, state: out.state || ov });
    });
  }
  if (p === '/api/recall') {
    const k = Number(q.get('k') || 12) || 12;
    const budget = Number(q.get('budget') || 2200) || 2200;
    return json(res, 200, recall(getIndex(), q.get('q') || '', k, budget, readOverrides()));
  }
  if (p === '/api/report') {
    if (req.method === 'GET') return json(res, 200, lastReport || { ok: false, error: 'no-report-yet' });
    return readBody(req, 128 * 1024, (err, text) => {
      if (err) return json(res, 400, { ok: false, error: err });
      try {
        lastReport = { at: Date.now(), report: JSON.parse(text) };
        json(res, 200, { ok: true });
      } catch {
        json(res, 400, { ok: false, error: 'bad-json' });
      }
    });
  }
  if (p === '/api/node') {
    const d = nodeDetail(getIndex(), q.get('id') || '', readOverrides());
    return d ? json(res, 200, d) : json(res, 404, { ok: false, error: 'not found' });
  }

  const rel = p === '/' || p === '/app' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  res.writeHead(200, { 'cache-control': 'no-store', 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`记忆星图 → http://127.0.0.1:${PORT}`);
});

