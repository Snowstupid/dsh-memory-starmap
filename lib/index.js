/**
 * 宿主半边：在 DSH 的 webServer 上挂 /mobius/* 路由。
 *
 * 页面 + 3 个数据接口，只读本地会话存档，只对 loopback 开放。
 * 路由注册模式抄自 dsh-meow-constellation（webServer 可能晚于插件就绪）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIndex, graphPayload, nodeDetail, readOverrides, recall, patchOverrides, search } from './store.js';
import { applyModelSurface, modelStatus } from './model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'public', 'index.html');
const BRAND = path.join(HERE, '..', 'public', 'brand.jpg');

const BASE = '/mobius';
const APP_ROUTE = `${BASE}/app`;
const BRAND_ROUTE = `${BASE}/brand.jpg`;
const API_GRAPH = `${BASE}/api/graph`;
const API_SEARCH = `${BASE}/api/search`;
const API_NODE = `${BASE}/api/node`;
const API_RECALL = `${BASE}/api/recall`;
const REPORT_ROUTE = `${BASE}/api/report`;
const OVERRIDES_ROUTE = `${BASE}/api/overrides`;
const STATUS_ROUTE = `${BASE}/api/status`;

let lastReport = null;

/** 读请求体，有上限（诊断上报 128KB 足够）。 */
function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) {
      req.destroy();
      return cb(`too-large: >${limit}B`);
    }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => cb(String(e?.message || e)));
}

function send(res, status, payload, contentType = 'application/json; charset=utf-8') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

/** 只允许本机访问：记忆内容不出局域网。 */
function allowed(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const q = (req, key) => new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get(key);

export function apply(ctx) {
  const log = (m) => { try { ctx?.logger?.info?.(m); } catch { /* ignore */ } };

  const routes = [
    [APP_ROUTE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      try {
        send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
      } catch (e) {
        send(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }],
    [BRAND_ROUTE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      try {
        const img = fs.readFileSync(BRAND);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=3600' });
        res.end(img);
      } catch (e) {
        send(res, 404, { ok: false, error: String(e?.message || e) });
      }
    }],
    [API_GRAPH, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      try { send(res, 200, graphPayload(getIndex(), readOverrides())); }
      catch (e) { send(res, 500, { ok: false, error: String(e?.message || e) }); }
    }],
    [API_SEARCH, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      try {
        const text = q(req, 'q') || '';
        send(res, 200, { q: text, hits: search(getIndex(), text, 12, readOverrides()) });
      } catch (e) { send(res, 500, { ok: false, error: String(e?.message || e) }); }
    }],
    [API_NODE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      try {
        const d = nodeDetail(getIndex(), q(req, 'id') || '', readOverrides());
        if (!d) return send(res, 404, { ok: false, error: 'not found' });
        send(res, 200, d);
      } catch (e) { send(res, 500, { ok: false, error: String(e?.message || e) }); }
    }],
    [API_RECALL, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      try {
        const text = q(req, 'q') || '';
        const k = Number(q(req, 'k') || 12) || 12;
        const budget = Number(q(req, 'budget') || 2200) || 2200;
        send(res, 200, recall(getIndex(), text, k, budget, readOverrides()));
      } catch (e) { send(res, 500, { ok: false, error: String(e?.message || e) }); }
    }],
    [STATUS_ROUTE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      let meta = null;
      try { meta = getIndex().meta; } catch { /* ignore */ }
      send(res, 200, { ok: true, model: modelStatus, index: meta });
    }],
    [OVERRIDES_ROUTE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      const ov = readOverrides();
      if (req.method === 'GET') return send(res, 200, ov);
      readBody(req, 64 * 1024, (err, text) => {
        if (err) return send(res, 400, { ok: false, error: err });
        let body;
        try { body = JSON.parse(text); } catch { return send(res, 400, { ok: false, error: 'bad-json' }); }
        const out = patchOverrides(body.rev, body.action, body);
        if (out.status === 200) return send(res, 200, out.state);
        send(res, out.status, { ok: false, error: out.error, state: out.state || ov });
      });
    }],
    [REPORT_ROUTE, (req, res) => {
      if (!allowed(req)) return send(res, 403, { ok: false, error: 'loopback only' });
      // 诊断旁路：页面每 5 秒把帧率/画布状态推上来，只存内存、不落盘、不碰索引
      if (req.method === 'GET') {
        return send(res, 200, lastReport || { ok: false, error: 'no-report-yet' });
      }
      readBody(req, 128 * 1024, (err, text) => {
        if (err) return send(res, 400, { ok: false, error: err });
        try {
          lastReport = { at: Date.now(), report: JSON.parse(text) };
          send(res, 200, { ok: true });
        } catch {
          send(res, 400, { ok: false, error: 'bad-json' });
        }
      });
    }],
  ];

  // 模型侧：一个按需调用的工具 + 一行提示词索引
  try {
    applyModelSurface(ctx, {
      getIndex,
      search: (index, query, topn) => search(index, query, topn, readOverrides()),
      hidden: () => new Set(readOverrides().hidden),
      log,
    });
  } catch (e) {
    log(`mobius: 模型侧注册失败 ${String(e?.message || e)}`);
  }

  // 启动后先把索引建起来，免得第一次打开面板时干等
  setTimeout(() => {
    try { getIndex(); log('mobius-memory: 索引预热完成'); }
    catch (e) { log(`mobius-memory: 预热失败 ${e?.message || e}`); }
  }, 1500);

  let timer = 0;
  const register = (attempt) => {
    const webServer = ctx?.get?.('webServer');
    if (webServer && typeof webServer.register === 'function') {
      for (const [p, handler] of routes) {
        try {
          const mount = () => webServer.register({ kind: 'exact', path: p, handler });
          if (typeof ctx.effect === 'function') ctx.effect(mount, `mobius-memory: GET ${p}`);
          else mount();
        } catch (e) {
          log(`mobius-memory: 路由 ${p} 注册失败: ${e?.message || e}`);
        }
      }
      log('mobius-memory: 星图页面与数据接口已注册');
      return;
    }
    if (attempt < 20) timer = setTimeout(() => register(attempt + 1), 1000);
    else log('mobius-memory: webServer 20s 内未就绪');
  };
  register(0);
  return () => clearTimeout(timer);
}

export { APP_ROUTE, API_GRAPH, API_SEARCH, API_NODE, API_RECALL, REPORT_ROUTE, OVERRIDES_ROUTE, STATUS_ROUTE };
