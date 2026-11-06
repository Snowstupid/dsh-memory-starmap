/**
 * 冒烟测试：不装 DSH，用一个假的 ctx（只提供 get('webServer') 和一个 effect）
 * 把插件的宿主半边挂到真 http server 上，逐条打接口。
 *
 * 除了接口，还盯着几条**踩过的坑**——这些断言的意义是：同样的 bug 别回来。
 *
 *   node test/smoke.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 用临时 DSH_HOME，别碰真实 ~/.dsh 里的用户数据
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-smoke-'));
process.env.DSH_HOME = tmpHome;
const { apply } = await import('../lib/index.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const SERVE = fs.readFileSync(path.join(HERE, '..', 'bin', 'serve.js'), 'utf8').replace(/\r\n/g, '\n');

const routes = new Map();
let registeredTool = null;
const sections = [];
const fakeCtx = {
  get: (name) => {
    if (name === 'webServer') return { register: ({ path, handler }) => routes.set(path, handler) };
    if (name === 'tools') return { register: (def) => { registeredTool = def; return () => { registeredTool = null; }; } };
    if (name === 'systemPrompt') return { section: (s) => { sections.push(s); return () => {}; } };
    return undefined;
  },
  effect: (fn) => { const d = fn(); return d; },
  logger: { info: (m) => console.log('  [log]', m) },
};

const dispose = apply(fakeCtx);
if (routes.size === 0) {
  console.error('FAIL: 一条路由都没注册上');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const h = routes.get(p);
  if (!h) { res.writeHead(404); return res.end('404'); }
  h(req, res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) { failed++; process.exitCode = 1; }
};

const check = async (p, expect = 200) => {
  const res = await fetch(base + p);
  const text = await res.text();
  ok(res.status === expect, `${p} → ${res.status}`, text.slice(0, 60).replace(/\n/g, ' '));
  return { res, text };
};

// ---------- 接口 ----------
// ---------- 模型侧：工具与提示词 ----------
ok(registeredTool?.name === 'mobius_recall', '注册了工具 mobius_recall');
const recallTool = registeredTool;
// 随机串：写死的词会被索引收录，下一跑就命中了
const probe = `zq${Math.random().toString(36).slice(2, 8)}x${Math.random().toString(36).slice(2, 8)}`;
const noHit = await recallTool.execute({ query: probe });
ok(noHit.found === false && noHit.ok === true, '工具对没聊过的话题返回 found=false');
const hit = await recallTool.execute({ query: '莫比乌斯 八字', budget: 400 });
ok(hit.found === true && hit.used <= 400, '工具能命中且预算生效', `used=${hit.used}`);
ok(sections.some((x) => x.name === 'mobius:index'), '注入了 mobius:index 提示词段');

await check('/mobius/app');
const g = await check('/mobius/api/graph');
const graph = JSON.parse(g.text);
console.log(`      星 ${graph.meta.nodes} 颗 / 线 ${graph.meta.edges} 条`);
await check('/mobius/api/search?q=' + encodeURIComponent('记忆'));
await check('/mobius/api/node?id=' + encodeURIComponent(graph.nodes[0].id));
await check('/mobius/api/node?id=not-a-real-id', 404);

// ---------- 召回：按字数预算裁剪 ----------
const tiny = JSON.parse((await check('/mobius/api/recall?q=' + encodeURIComponent('记忆') + '&k=50&budget=400')).text);
ok(tiny.used <= 400, 'recall 预算 400 字', `used=${tiny.used} 条数=${tiny.hits.length} 丢弃=${tiny.dropped}`);
ok(tiny.text.length > 0 && tiny.dropped > 0, 'recall 确实裁掉了多余的条目');
ok(tiny.used <= 400 && tiny.dropped > 0, 'recall 预算生效');

const roomy = JSON.parse((await check('/mobius/api/recall?q=' + encodeURIComponent('记忆') + '&k=5&budget=100000')).text);
ok(roomy.dropped === 0 && roomy.hits.length <= 5, 'recall 预算充足时不丢条目');

// ---------- 诊断旁路 ----------
const post = await fetch(base + '/mobius/api/report', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'mobius-report', fps: 58.2, nodes: 3 }),
});
ok(post.status === 200, 'POST /api/report → 200');
const got = JSON.parse((await check('/mobius/api/report')).text);
ok(got.report && got.report.fps === 58.2, 'GET /api/report 读回刚才那份', JSON.stringify(got.report || {}));

const bad = await fetch(base + '/mobius/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
ok(bad.status === 400, 'POST /api/report 坏 JSON → 400');

// ---------- 非 loopback 拒绝 ----------
const denied = await new Promise((resolve) => {
  const h = routes.get('/mobius/api/graph');
  const fakeRes = { writeHead: (s) => { resolve(s); }, end: () => {} };
  h({ socket: { remoteAddress: '10.0.0.7' }, url: '/' }, fakeRes);
});
ok(denied === 403, '内网地址访问 → 403', String(denied));

// ---------- 回归断言：踩过的坑 ----------
// 1) 投影函数必须返回拷贝。曾经复用一个对象，结果所有记忆星叠成一颗。
ok(/return \{ x: q\.x, y: q\.y, z: q\.z, s: q\.s \};/.test(PAGE), 'project() 返回的是拷贝，不是共用对象');
ok(!/function project\(p\) \{ return projectXYZ\(p\.x, p\.y, p\.z\); \}/.test(PAGE), 'project() 没有退回共用对象的写法');

// 2) Canvas 合成模式必须复位。曾经 'lighter' 漏到下一帧，背景越叠越白，几秒后整屏发白。
ok(PAGE.includes("globalCompositeOperation = 'source-over';   // 别把这个状态漏到下一帧"), 'drawNodes 结束时复位合成模式');
ok(/function drawSky\(t\) \{\n    \/\/ 每帧先把合成模式复位/.test(PAGE), 'drawSky 开头复位合成模式');

// 3) 静态资源必须禁缓存。曾经改完代码刷不出新页面，白排查半天。
ok(SERVE.includes("'cache-control': 'no-store', 'content-type': MIME"), 'bin/serve.js 静态文件带 no-store');

// 4) 记忆星不能再用"挖暗底"（destination-out）—— 用户明确不要
ok(!PAGE.includes("'destination-out'"), 'drawNodes 不再挖暗底');

// ---------- 写入：隐藏 / 改概要 / rev 并发 ----------
const ov0 = JSON.parse((await check('/mobius/api/overrides')).text);
ok(ov0.rev === 0 && ov0.hidden.length === 0, '空的覆盖层 rev=0');

const postOv = async (body) => {
  const r = await fetch(base + '/mobius/api/overrides', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const victim = graph.nodes[2].id;
const h1 = await postOv({ rev: 0, action: 'hide', id: victim });
ok(h1.status === 200 && h1.body.rev === 1, 'hide 成功且 rev+1');

const g2 = JSON.parse((await check('/mobius/api/graph')).text);
ok(!g2.nodes.some((n) => n.id === victim), '隐藏的条目从图里消失');
ok(g2.meta.hidden === 1, 'meta.hidden 计数正确');
ok(g2.edges.every(([a, b]) => a < g2.nodes.length && b < g2.nodes.length), '边按下标重映射后没有越界');

const stale = await postOv({ rev: 0, action: 'hide', id: victim });
ok(stale.status === 409, '过期 rev → 409');
const noRev = await postOv({ action: 'hide', id: victim });
ok(noRev.status === 400, '缺 rev → 400');

const sum = await postOv({ rev: 1, action: 'summary', id: victim, text: '冒烟测试改过的概要' });
ok(sum.status === 200 && sum.body.summaries[victim] === '冒烟测试改过的概要', '改概要写进去了');
const nd = JSON.parse((await check('/mobius/api/node?id=' + encodeURIComponent(victim))).text);
ok(nd.node.summary === '冒烟测试改过的概要' && nd.node.hidden === true, '详情接口带回了覆盖后的概要与 hidden 标记');

const uh = await postOv({ rev: 2, action: 'unhide', id: victim });
ok(uh.status === 200 && uh.body.hidden.length === 0, 'unhide 恢复');
const rs = await postOv({ rev: 3, action: 'reset' });
ok(rs.status === 200 && Object.keys(rs.body.summaries).length === 0, 'reset 清空');
const badAct = await postOv({ rev: rs.body.rev, action: 'nope' });
ok(badAct.status === 400, '未知 action → 400');

const userFile = path.join(tmpHome, 'mobius-memory.json');
ok(fs.existsSync(userFile), '用户数据落在 $DSH_HOME/mobius-memory.json');
const rawUser = JSON.parse(fs.readFileSync(userFile, 'utf8'));
ok(rawUser.rev === rs.body.rev, '磁盘上的 rev 与内存一致');

dispose?.();
server.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failed ? `有 ${failed} 项失败` : '全部通过');
