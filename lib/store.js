/**
 * 数据层：把 DSH 的会话存档变成一张莫比乌斯带上的星图。
 *
 * 取样思路来自 memory-star（分块 → 词表 → IDF → 沿边扩一圈），
 * 衰减思路来自 constellation-engine，分层与面板来自 dsh-meow-constellation。
 * 这里只做"存 + 查"，不碰 UI。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const SESS_ROOT = process.env.MOBIUS_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.mobius');
const CACHE_FILE = path.join(CACHE_DIR, 'index.json');
const SESS_CACHE = path.join(CACHE_DIR, 'sessions');
const SCHEMA = 9;   // 节点字段变了就加一，旧缓存自动作废

// 用户数据放 DSH_HOME（重装插件不丢），缓存才放插件目录
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const USER_FILE = path.join(DSH_HOME, 'mobius-memory.json');
const MAX_HIDDEN = 5000;
const MAX_SUMMARY = 200;

const STOP = new Set([
  '什么', '这个', '那个', '我们', '你们', '他们', '可以', '没有', '一个', '就是',
  '还是', '因为', '所以', '但是', '如果', '现在', '已经', '这样', '那样', '自己',
  '一下', '不是', '然后', '东西', '时候', '问题', '需要', '应该', '可能', '知道',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'you', 'are', 'was', 'have',
  'not', 'but', 'all', 'can', 'will', 'file', 'true', 'false', 'null',
]);

const EXPAND = {
  记得: ['记忆', '之前', '上次', '聊过'],
  记忆: ['记得', '记住', '忘', '记得我'],
  星图: ['莫比乌斯', '星座', '节点', '连线'],
  莫比乌斯: ['星图', '环', '带', '扭转'],
  插件: ['plugin', 'dsh', '面板'],
  幻灯片: ['ppt', '演示', 'slides'],
  论文: ['paper', '文献', 'pdf'],
};

export const LAYERS = [
  { id: 'soul', name: '身份', color: '#ffd27a', v: -0.72,
    kw: ['我是', '我叫', '我的名字', '我喜欢', '我习惯', '我一般', '我个人'] },
  { id: 'rules', name: '规矩', color: '#7fe6ff', v: -0.44,
    kw: ['不要', '别用', '必须', '以后', '记住', '规矩', '统一', '禁用', '禁止', '默认'] },
  { id: 'project', name: '项目', color: '#b39dff', v: -0.15,
    kw: ['.js', '.py', '.md', 'dsh', '插件', '代码', '仓库', '部署', '构建', '脚本', '接口'] },
  { id: 'event', name: '事件', color: '#ff9ecb', v: 0.15,
    kw: ['今天', '昨天', '刚才', '上次', '做了', '发生', '试了', '跑了', '报错'] },
  { id: 'fact', name: '知识', color: '#8ef0c9', v: 0.44,
    kw: ['原理', '算法', '定义', '数据', '结论', '研究', '论文', '公式', '方法'] },
  { id: 'feeling', name: '感受', color: '#ffb07a', v: 0.72,
    kw: ['喜欢', '讨厌', '烦', '爽', '累', '开心', '难受', '想要', '希望'] },
];

export function tokenize(s) {
  const low = String(s || '').toLowerCase();
  const toks = new Set();
  for (const m of low.matchAll(/[a-z0-9_]{2,}/g)) toks.add(m[0]);
  const han = (low.match(/[\u4e00-\u9fff]/g) || []).join('');
  for (let i = 0; i < han.length - 1; i++) toks.add(han.slice(i, i + 2));
  for (const t of [...toks]) if (STOP.has(t)) toks.delete(t);
  return toks;
}

export function classify(text) {
  let best = 'fact', bestScore = 0;
  for (const L of LAYERS) {
    let s = 0;
    for (const k of L.kw) if (text.includes(k)) s += k.length >= 3 ? 2 : 1;
    if (s > bestScore) { bestScore = s; best = L.id; }
  }
  return best;
}

function importance(text, layer) {
  const base = { soul: 0.75, rules: 0.85, project: 0.6, event: 0.5, fact: 0.55, feeling: 0.6 }[layer] ?? 0.5;
  const hits = (text.match(/记住|重要|以后|必须|别忘|关键|核心|注意/g) || []).length;
  return Math.min(1, base + hits * 0.05);
}

export function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const cuts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { cuts.push(i); i += 4; }
  let text = '';
  for (let k = 0; k < cuts.length; k++) {
    const seg = buf.subarray(cuts[k], k + 1 < cuts.length ? cuts[k + 1] : buf.length);
    try { text += zlib.zstdDecompressSync(seg).toString('utf8'); } catch { /* 半帧，跳过 */ }
  }
  const recs = [];
  for (const line of text.split('\n')) {
    // 绝大部分行是 tool/call 与 tool/result，先做廉价的字符串判断
    if (line.indexOf('"user/message"') === -1
      && line.indexOf('"assistant/message"') === -1
      && line.indexOf('"session/title"') === -1
      && line.indexOf('"turn/start"') === -1
      && line.indexOf('"type":"session"') === -1) continue;
    try { recs.push(JSON.parse(line)); } catch { /* 截断行，跳过 */ }
  }
  return recs;
}

function textOfMessage(rec) {
  const c = rec?.data?.content || rec?.data?.message?.content;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  return parts.join('\n').trim();
}

function isNoise(rec) {
  const src = rec?.data?.source;
  if (src?.kind === 'reme-memory') return true;
  if (src?.form === 'instructions') return true;
  const t = textOfMessage(rec);
  if (!t) return true;
  if (t.startsWith('#')) return true;
  if (/system-reminder|<available_skills>/.test(t)) return true;
  // 每次对话开头那些"运行时上下文"注入块，不是记忆
  if (/^Current runtime context/i.test(t)) return true;
  if (/^Time sampled while preparing/i.test(t)) return true;
  if (/^This snapshot supersedes/i.test(t)) return true;
  if (t.length < 18) return true;
  return false;
}

function clip(text, n = 420) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 概要：取第一句中文（或前 44 个字），星图上只显示这个，点开才给全文。 */
function summarize(text, fallback = '', n = 44) {
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    // 子代理转来的消息，开头是 "Agent <id> sent a message: "，剥掉
    .replace(/^Agent\s+[0-9a-f-]{8,}\s+sent a message:\s*/i, '')
    .replace(/[#*`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return fallback;
  const parts = t.split(/(?<=[。！？!?；;])/).filter((x) => x.trim());
  let picked = (parts.find((x) => /[\u4e00-\u9fff]{4,}/.test(x)) || parts[0] || t).trim();
  // 整句没有中文又带长 hash/id：这种当标签没意义，退回会话标题
  if (!/[\u4e00-\u9fff]/.test(picked) && /[0-9a-fA-F]{6,}/.test(picked)) return fallback || '';
  const s = picked.length > n ? picked.slice(0, n) : picked;
  return s.length < t.length ? s.replace(/[。！？!?；;]$/, '') + '…' : s;
}

/** 只列文件、只看 mtime，不解压（用于判断缓存是否过期）。 */
export function listSessionFiles() {
  const out = [];
  if (!fs.existsSync(SESS_ROOT)) return out;
  for (const ws of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(SESS_ROOT, ws.name);
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue;
      const dir = path.join(wsDir, sd.name);
      let file;
      try { file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl.zstd')); } catch { continue; }
      if (!file) continue;
      const full = path.join(dir, file);
      try {
        out.push({
          id: sd.name,
          workspace: ws.name.replace(/^-+|-+$/g, ''),
          file: full,
          mtime: fs.statSync(full).mtimeMs,
        });
      } catch { /* 读不到就跳过 */ }
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** 指纹：文件数 + mtime 之和，用于判断要不要重建索引。 */
export function sessionSignature(files = listSessionFiles()) {
  let sum = 0;
  for (const f of files) sum += Math.round(f.mtime);
  return `${files.length}:${sum}`;
}

/** 扫一遍所有会话（含解压，慢）。 */
export function collectSessions() {
  return listSessionFiles().map((f) => ({ ...f, recs: decodeSession(f.file) }));
}

/** 单个会话提取出的节点，按 mtime 缓存，没变就不重解。 */
function extractNodes(file) {
  const cacheFile = path.join(SESS_CACHE, `${file.id}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (hit && hit.v === SCHEMA && hit.mtime === file.mtime && Array.isArray(hit.nodes)) return hit.nodes;
  } catch { /* 没有缓存 */ }

  const recs = decodeSession(file.file);
  let title = '';
  let sessionTime = null;
  for (const r of recs) {
    if (r.type === 'session/title' && r.data?.title) title = r.data.title;
    if (r.type === 'session' && r.data?.createdAt) sessionTime = r.data.createdAt;
  }
  // 子代理会话的标题就是一串 id，当标签没意义
  if (/^Agent\s+[0-9a-f]{6,}/i.test(title)) title = '子代理会话';

  const nodes = [];
  let turn = 0;
  let ordinal = 0;
  for (const r of recs) {
    if (r.type === 'turn/start') turn = r.data?.turn ?? turn;
    const isUser = r.type === 'user/message';
    const isAsst = r.type === 'assistant/message';
    if (!isUser && !isAsst) continue;
    if (isNoise(r)) continue;
    const body = textOfMessage(r);
    if (body.length < 18) continue;
    const level = classify(body);
    ordinal++;
    // 有些记录没有 time 字段；如果都退回会话时间，节点会全叠在同一个点上。
    // 用"基准时间 + 序号"保证每颗星都有各自的时刻。
    const base = r.time || sessionTime || file.mtime;
    nodes.push({
      id: `${file.id.slice(-6)}-${r.seq ?? nodes.length}`,
      session: file.id,
      sessionTitle: title || '（无题）',
      workspace: file.workspace,
      role: isUser ? 'user' : 'assistant',
      turn,
      time: base + (r.time ? 0 : ordinal),
      level,
      text: clip(body, 520),
      summary: summarize(body, title),
      imp: importance(body, level),
    });
  }

  try {
    fs.mkdirSync(SESS_CACHE, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ v: SCHEMA, mtime: file.mtime, nodes }));
  } catch { /* 缓存写不了不影响 */ }
  return nodes;
}

/** 建索引：会话 → 星（节点）+ 连线。 */
export function buildIndex(files) {
  const list = files || listSessionFiles();
  const nodes = [];
  for (const f of list) for (const n of extractNodes(f)) nodes.push(n);

  // 时间映射到莫比乌斯带的参数 u。
  // 按"排名"而不是绝对时间摊开：对话是一阵一阵的，按时间会把一天的消息挤成一坨，
  // 排名保证每颗星在带上都有自己的一段，先后顺序不变。
  const lane = Object.fromEntries(LAYERS.map((l) => [l.id, l.v]));
  const byTime = nodes.slice().sort((a, b) => (a.time - b.time) || (a.id < b.id ? -1 : 1));
  const total = Math.max(1, byTime.length);
  byTime.forEach((n, i) => {
    n.u = ((i + 0.5) / total) * Math.PI * 2;
    n.v = lane[n.level] ?? 0;
    n.tokens = [...tokenize(n.text + ' ' + n.sessionTitle)];
  });

  // 同一时刻的节点现在已经有各自的弧长位置了，不需要再挤开

  const tokSets = nodes.map((n) => new Set(n.tokens));
  const tok2ids = new Map();
  nodes.forEach((n, i) => {
    for (const t of n.tokens) {
      if (!tok2ids.has(t)) tok2ids.set(t, []);
      tok2ids.get(t).push(i);
    }
  });

  const edges = [];
  const seen = new Set();
  const pushEdge = (a, b, w) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([a, b, Number(w.toFixed(3))]);
  };
  const overlap = (a, b) => {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let c = 0;
    for (const t of small) if (large.has(t)) c++;
    return c;
  };

  nodes.forEach((n, i) => {
    const cand = new Set();
    for (const t of n.tokens.slice(0, 60)) {
      const list2 = tok2ids.get(t);
      if (!list2) continue;
      for (let k = 0; k < list2.length && k < 24; k++) cand.add(list2[k]);
    }
    cand.delete(i);
    const scored = [];
    for (const j of cand) {
      const inter = overlap(tokSets[i], tokSets[j]);
      const w = inter / Math.max(1, Math.min(tokSets[i].size, tokSets[j].size));
      if (w >= 0.1) scored.push([w, j]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [w, j] of scored.slice(0, 4)) pushEdge(i, j, w);
  });

  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i].session === nodes[i - 1].session) pushEdge(i - 1, i, 0.35);
  }

  return {
    builtAt: Date.now(),
    meta: {
      sessions: list.length,
      nodes: nodes.length,
      edges: edges.length,
      span: [byTime[0]?.time ?? 0, byTime[byTime.length - 1]?.time ?? 0],
      layers: LAYERS.map(({ id, name, color, v }) => ({ id, name, color, v })),
    },
    nodes,
    edges,
  };
}

// ---------- 单例 + 磁盘缓存 ----------

let cached = null;
let cachedSig = '';
let rebuilding = false;

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!raw || !raw.nodes || raw.v !== SCHEMA) return null;
    return raw;
  } catch { return null; }
}

function writeCache(sig, index) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      v: SCHEMA, sig, builtAt: index.builtAt, meta: index.meta, nodes: index.nodes, edges: index.edges,
    }));
  } catch { /* 写不了就算了 */ }
}

/** 后台重建，不挡请求。 */
function rebuildLater(files, sig) {
  if (rebuilding) return;
  rebuilding = true;
  setTimeout(() => {
    try {
      const idx = buildIndex(files);
      cached = idx;
      cachedSig = sig;
      writeCache(sig, idx);
    } catch { /* 重建失败就继续用旧索引 */ }
    rebuilding = false;
  }, 30);
}

export function getIndex(force = false) {
  const files = listSessionFiles();
  const sig = sessionSignature(files);
  if (!force && cached && cachedSig === sig) return cached;

  if (!force) {
    const disk = readCache();
    if (disk && disk.sig === sig) {
      cached = { builtAt: disk.builtAt, meta: disk.meta, nodes: disk.nodes, edges: disk.edges };
      cachedSig = sig;
      return cached;
    }
    if (cached) {
      // 有旧的就先给旧的，新的在后台慢慢建
      rebuildLater(files, sig);
      return cached;
    }
    if (disk) {
      cached = { builtAt: disk.builtAt, meta: disk.meta, nodes: disk.nodes, edges: disk.edges };
      cachedSig = disk.sig;
      rebuildLater(files, sig);
      return cached;
    }
  }

  const idx = buildIndex(files);
  cached = idx;
  cachedSig = sig;
  writeCache(sig, idx);
  return idx;
}

// ---------- 用户覆盖层（隐藏 / 改概要）----------
//
// 这是唯一会被写的东西，所以单独一个文件、带 rev：
// 缺 rev → 400 client-outdated，rev 过期 → 409 stale。
// 开着的旧页面不可能把别处刚做的改动盖回去。

const EMPTY_OVERRIDES = Object.freeze({ rev: 0, hidden: [], summaries: {} });

function normalizeOverrides(raw) {
  const hidden = Array.isArray(raw?.hidden)
    ? raw.hidden.filter((x) => typeof x === 'string').slice(0, MAX_HIDDEN)
    : [];
  const summaries = {};
  if (raw && typeof raw.summaries === 'object' && raw.summaries) {
    for (const [k, v] of Object.entries(raw.summaries)) {
      if (typeof v === 'string' && v.trim()) summaries[k] = v.trim().slice(0, MAX_SUMMARY);
    }
  }
  return {
    rev: Number.isInteger(raw?.rev) && raw.rev >= 0 ? raw.rev : 0,
    hidden,
    summaries,
  };
}

let ovCache = null;
let ovMtime = -1;

/** 读覆盖层；文件不存在等于空（不为了读一眼就建文件）。 */
export function readOverrides() {
  try {
    const st = fs.statSync(USER_FILE);
    if (ovCache && st.mtimeMs === ovMtime) return ovCache;
    const raw = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    ovCache = normalizeOverrides(raw);
    ovMtime = st.mtimeMs;
    return ovCache;
  } catch {
    return EMPTY_OVERRIDES;
  }
}

function persist(next) {
  fs.mkdirSync(DSH_HOME, { recursive: true });
  fs.writeFileSync(USER_FILE, JSON.stringify(next, null, 2));
  ovCache = next;
  ovMtime = fs.statSync(USER_FILE).mtimeMs;
  return next;
}

/**
 * 带 rev 校验地改一次覆盖层。
 * @returns {{status:number, state?:object, error?:string}}
 */
export function patchOverrides(expectedRev, action, payload = {}) {
  if (expectedRev === undefined || expectedRev === null || expectedRev === '') {
    return { status: 400, error: 'client-outdated' };
  }
  const cur = readOverrides();
  if (Number(expectedRev) !== cur.rev) {
    return { status: 409, error: 'stale', state: cur };
  }

  const next = { rev: cur.rev + 1, hidden: [...cur.hidden], summaries: { ...cur.summaries } };
  const id = typeof payload.id === 'string' ? payload.id : '';

  switch (action) {
    case 'hide': {
      if (!id) return { status: 400, error: 'bad-id' };
      if (!next.hidden.includes(id)) {
        next.hidden.push(id);
        if (next.hidden.length > MAX_HIDDEN) next.hidden = next.hidden.slice(-MAX_HIDDEN);
      }
      break;
    }
    case 'unhide': {
      next.hidden = next.hidden.filter((x) => x !== id);
      break;
    }
    case 'summary': {
      if (!id) return { status: 400, error: 'bad-id' };
      const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_SUMMARY) : '';
      if (text) next.summaries[id] = text;
      else delete next.summaries[id];
      break;
    }
    case 'reset': {
      next.hidden = [];
      next.summaries = {};
      break;
    }
    default:
      return { status: 400, error: 'bad-action' };
  }

  return { status: 200, state: persist(next) };
}

// ---------- 检索 ----------

export function search(index, query, topn = 12, ov = readOverrides()) {
  const q0 = new Set(tokenize(query));
  const extra = new Set();
  for (const [k, vs] of Object.entries(EXPAND)) {
    if (query.includes(k)) for (const v of vs) for (const t of tokenize(v)) extra.add(t);
  }
  for (const t of q0) extra.delete(t);
  if (!q0.size && !extra.size) return [];

  const n = index.nodes.length;
  const df = new Map();
  for (const t of [...q0, ...extra]) df.set(t, 0);
  for (const node of index.nodes) {
    for (const t of df.keys()) if (node.tokens.includes(t)) df.set(t, df.get(t) + 1);
  }
  const idf = new Map();
  let idfSum = 0;
  for (const [t, d] of df) {
    const w = d === 0 ? 0 : Math.max(0, Math.log((n + 1) / (d + 0.5)));
    idf.set(t, w);
    idfSum += w;
  }
  if (!idfSum) idfSum = 1;

  const now = Date.now();
  const scored = [];
  index.nodes.forEach((node, i) => {
    let s = 0;
    for (const t of q0) if (node.tokens.includes(t)) s += idf.get(t);
    for (const t of extra) if (node.tokens.includes(t)) s += idf.get(t) * 0.42;
    if (!s) return;
    const ageDays = (now - node.time) / 86400000;
    const decay = 0.55 + 0.45 * Math.exp(-Math.max(0, ageDays) / 180);
    scored.push({ i, score: (s / idfSum) * decay * (0.8 + node.imp * 0.4) });
  });
  scored.sort((a, b) => b.score - a.score);

  // 沿边扩一圈：直接命中拿全分，邻居拿四成
  const hit = new Map(scored.slice(0, 120).map((s) => [s.i, s.score]));
  const boosted = new Map(hit);
  for (const [a, b, w] of index.edges) {
    if (hit.has(a) && !boosted.has(b)) boosted.set(b, hit.get(a) * w * 0.4);
    if (hit.has(b) && !boosted.has(a)) boosted.set(a, hit.get(b) * w * 0.4);
  }
  // 自己在面板里隐藏掉的条目，不再出现在检索结果里
  const hidden = new Set(ov.hidden);
  return [...boosted.entries()]
    .filter(([i]) => !hidden.has(index.nodes[i].id))
    .map(([i, score]) => ({ id: index.nodes[i].id, index: i, score: Number(score.toFixed(4)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topn);
}

/**
 * 给模型用的召回格式。
 * 按**字数预算**裁剪而不是按条数：从最相关的往后排，装不下就停，
 * 被裁掉的仍然留在索引里，换个 query 还能搜到。
 */
export function recall(index, query, k = 12, budget = 2200, ov = readOverrides()) {
  const hits = search(index, query, k, ov);
  if (!hits.length) return { text: '', hits: [], used: 0, budget, dropped: 0 };

  const open = '<memory>以下是这个人以前说过的相关片段（按相关度排序）：';
  const close = '</memory>';
  const kept = [];
  let used = open.length + close.length + 1;

  for (const h of hits) {
    const n = index.nodes[h.index];
    const line = `${kept.length + 1}. [${new Date(n.time).toISOString().slice(0, 10)} · ${n.sessionTitle}] ${n.text}`;
    const room = budget - used - 1;
    if (line.length > room) {
      // 一条都还没进去、但空间尚可：截断这一条塞进去，总比整段空着强
      if (!kept.length && room > 160) {
        const cut = line.slice(0, room - 1) + '…';
        used += cut.length + 1;
        kept.push({ ...h, line: cut });
      }
      break;
    }
    used += line.length + 1;
    kept.push({ ...h, line });
  }

  if (!kept.length) return { text: '', hits: [], used: 0, budget, dropped: hits.length };

  const text = [open, ...kept.map((x) => x.line), close].join('\n');
  return {
    text,
    hits: kept.map(({ line, ...h }) => h),
    used: text.length,
    budget,
    dropped: hits.length - kept.length,
  };
}

/**
 * 星图数据。隐藏的节点会被摘掉，边按下标重映射（客户端用的就是下标）。
 */
export function graphPayload(index, ov = readOverrides()) {
  const hidden = new Set(ov.hidden);
  const keep = [];
  const remap = new Map();
  index.nodes.forEach((n, i) => {
    if (hidden.has(n.id)) return;
    remap.set(i, keep.length);
    keep.push(n);
  });

  const nodes = keep.map(({ tokens, ...n }) => ({
    ...n,
    summary: ov.summaries[n.id] || n.summary,
    text: n.text.length > 160 ? n.text.slice(0, 160) + '…' : n.text,
  }));

  const edges = [];
  for (const [a, b, w] of index.edges) {
    const na = remap.get(a), nb = remap.get(b);
    if (na === undefined || nb === undefined) continue;
    edges.push([na, nb, w]);
  }

  return {
    meta: {
      ...index.meta,
      nodes: keep.length,          // 可见的条数
      total: index.nodes.length,   // 索引里的总条数
      edges: edges.length,
      hidden: index.nodes.length - keep.length,
      rev: ov.rev,
    },
    nodes,
    edges,
  };
}

export function nodeDetail(index, id, ov = readOverrides()) {
  const idx = index.nodes.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const { tokens, ...node } = index.nodes[idx];
  const hidden = new Set(ov.hidden);
  const related = index.edges
    .filter(([a, b]) => a === idx || b === idx)
    .map(([a, b, w]) => {
      const other = index.nodes[a === idx ? b : a];
      return { id: other.id, w, text: other.text.slice(0, 80), hidden: hidden.has(other.id) };
    })
    .filter((r) => !r.hidden)
    .sort((x, y) => y.w - x.w)
    .slice(0, 8);
  return {
    node: { ...node, summary: ov.summaries[id] || node.summary, hidden: hidden.has(id) },
    related,
    rev: ov.rev,
  };
}
