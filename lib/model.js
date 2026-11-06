/**
 * 模型侧接口：一个工具 + 一行系统提示。
 *
 * 设计约束（都在下面的文案里写死了，改之前先看 README 的「风险」一节）：
 * - 只按需调用，不做每轮自动注入；
 * - 返回的是**原文摘录**，带日期和"谁说的"，用户说的算事实、助手说的只是当时的判断；
 * - 默认 800 字预算，超时就放弃；
 * - 没搜到就说没搜到，不许拿"最近几条"冒充命中（兜底会显式标出来）。
 */

const TOOL_NAME = 'mobius_recall';

/** 注册结果，供 /mobius/api/status 查询（宿主里看不到日志时靠它） */
export const modelStatus = {
  tool: false,
  prompt: false,
  toolName: TOOL_NAME,
  services: { tools: false, systemPrompt: false },
  tries: 0,
  lastError: null,
  mountedAt: null,
};
const DEFAULT_BUDGET = 800;
const DEFAULT_LIMIT = 5;
const MAX_BUDGET = 2000;
const MIN_SCORE = 0.04;        // 分数门槛
const MIN_COVERAGE = 0.25;     // 命中的查询词至少要占四分之一
const MIN_KNOWN = 0.5;         // 查询词里至少一半得是索引里出现过的
const TIMEOUT_MS = 400;

const PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '要回忆的词，用名词短语（"莫比乌斯 撤销"），不要写整句问句。留空则返回最近几条。',
    },
    limit: {
      type: 'integer',
      description: `最多返回几条，1-12，默认 ${DEFAULT_LIMIT}。`,
    },
    budget: {
      type: 'integer',
      description: `返回文本的字数上限，200-${MAX_BUDGET}，默认 ${DEFAULT_BUDGET}。`,
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '是否执行成功（索引不可用时为 false）。' },
    found: { type: 'boolean', description: '是否有命中；false 时 text 会直说没找到。' },
    fallback: { type: 'boolean', description: 'true 表示这不是命中结果，而是"最近几条"兜底。' },
    used: { type: 'integer', description: '返回文本的字数。' },
    dropped: { type: 'integer', description: '因预算被裁掉的条数。' },
    text: { type: 'string', description: '给模型看的记忆摘录。' },
  },
  additionalProperties: false,
};

function fmtDate(ms) {
  try { return new Date(ms).toISOString().slice(0, 10); } catch { return '?'; }
}

function roleLabel(role) {
  return role === 'user' ? '用户说的' : '助手当时说的';
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 把命中的节点拼成一段带信任等级和日期的摘录。 */
function compose(hits, { budget, fallback }) {
  const open = fallback
    ? '<memory source="本地对话索引" mode="recent-fallback" note="没有命中，下面是最近几条，不代表与本轮相关">'
    : '<memory source="本地对话索引" note="原文摘录，可能已过时；和本轮说法冲突时以本轮为准。用户说的算事实，助手说的只是当时的判断。">';
  const close = '</memory>';
  const lines = [];
  let used = open.length + close.length + 1;

  for (const h of hits) {
    const n = h.node;
    const line = `${lines.length + 1}. [${fmtDate(n.time)} · ${roleLabel(n.role)} · ${clip(n.sessionTitle, 18)}] ${clip(n.text, 200)}`;
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    lines.push(line);
  }

  if (!lines.length) return { text: '', used: 0, dropped: hits.length };
  return {
    text: [open, ...lines, close].join('\n'),
    used: open.length + close.length + 1 + lines.reduce((s, l) => s + l.length + 1, 0),
    dropped: hits.length - lines.length,
  };
}

/**
 * 注册工具与提示词段。宿主没有对应服务时安静跳过。
 * @param ctx Cordis 上下文
 * @param deps { getIndex, search, log }
 */
export function applyModelSurface(ctx, deps) {
  const log = deps.log || (() => {});
  if (process.env.MOBIUS_TOOL === '0') {
    log('mobius: MOBIUS_TOOL=0，跳过工具与提示词注册');
    return;
  }

  // 宿主服务可能比插件晚就绪：最多等 20 秒，别因为一次拿不到就永久放弃
  const RETRY = Number(process.env.MOBIUS_TOOL_RETRY || 60) || 0;
  let tries = 0;
  let timer = 0;
  const attempt = () => {
    tries++;
    modelStatus.tries = tries;
    // 三种取法都试一遍；cordis 对"没声明的服务"可能直接抛，所以每一步都包起来
    const pick = (name) => {
      for (const read of [
        () => ctx?.get?.(name),
        () => ctx?.root?.get?.(name),
        () => ctx?.[name],
      ]) {
        try {
          const v = read();
          if (v) return v;
        } catch (e) {
          modelStatus.lastError = `${name}: ${String(e?.message || e)}`;
        }
      }
      return undefined;
    };
    const tools = pick('tools');
    const prompt = pick('systemPrompt');
    modelStatus.services = { tools: Boolean(tools), systemPrompt: Boolean(prompt) };
    const toolsReady = tools && typeof tools.register === 'function';
    const promptReady = prompt && typeof prompt.section === 'function';
    if (!toolsReady || !promptReady) {
      if (tries < RETRY) {
        timer = setTimeout(attempt, 1000);
        return;
      }
      log('mobius: 20 秒内没等到 tools / systemPrompt 服务，模型侧跳过');
    }
    mount(toolsReady ? tools : undefined, promptReady ? prompt : undefined);
  };

  const mount = (tools, prompt) => {
    if (!tools) {
      log('mobius: 宿主没有 tools 服务，跳过工具注册');
    } else {
    try {
      const dispose = tools.register({
        name: TOOL_NAME,
        description: [
          '在本地历史对话索引里翻旧事。适合："我们之前定过什么""上次那个 bug 怎么修的""用户定过什么规矩"。',
          '不适合：当下的事实、外部资料、需要现查的东西——那些用别的工具。',
          '返回的是历史原文摘录（带日期和"谁说的"），可能已过时；用户说过的话算事实，助手说过的只算当时的判断。',
          '不要用它给自己的判断找依据（"我之前说过 X 所以 X 对"这种循环论证不成立）。',
          '搜索按词法匹配，换个说法可能搜不到，搜不到就换词再试一次。',
        ].join(''),
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args, value) => [{ type: 'text', text: value.text || '（没有可用的记忆）' }],
        },
        timeoutMs: 5000,
        execute: async (rawArgs) => {
          const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          const limit = Math.min(12, Math.max(1, Number(args.limit) || DEFAULT_LIMIT));
          const budget = Math.min(MAX_BUDGET, Math.max(200, Number(args.budget) || DEFAULT_BUDGET));

          let index;
          try {
            index = deps.getIndex();
          } catch (e) {
            return { ok: false, found: false, fallback: false, used: 0, dropped: 0, text: `索引不可用：${String(e?.message || e)}` };
          }

          // 空 query：明确按"最近几条"兜底，并标出来
          if (!query) {
            const recent = index.nodes
              .filter((n) => !deps.hidden?.().has(n.id))
              .slice()
              .sort((a, b) => b.time - a.time)
              .slice(0, limit)
              .map((n) => ({ node: n }));
            const out = compose(recent, { budget, fallback: true });
            return { ok: true, found: false, fallback: true, used: out.used, dropped: out.dropped, text: out.text };
          }

          const started = Date.now();
          let hits = [];
          try {
            hits = deps.search(index, query, limit * 3)
              .filter((h) => h.score >= MIN_SCORE && h.coverage >= MIN_COVERAGE && h.known >= MIN_KNOWN)
              .slice(0, limit);
          } catch (e) {
            return { ok: false, found: false, fallback: false, used: 0, dropped: 0, text: `检索失败：${String(e?.message || e)}` };
          }
          if (Date.now() - started > TIMEOUT_MS) {
            return { ok: false, found: false, fallback: false, used: 0, dropped: 0, text: '索引响应过慢，这次先不查。' };
          }
          if (!hits.length) {
            return {
              ok: true, found: false, fallback: false, used: 0, dropped: 0,
              text: '没有足够相关的记录。换个词再试，或者直接说"没查到"。',
            };
          }

          const withNodes = hits.map((h) => ({ ...h, node: index.nodes[h.index] }));
          const out = compose(withNodes, { budget, fallback: false });
          return { ok: true, found: true, fallback: false, used: out.used, dropped: out.dropped, text: out.text };
        },
      });
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'mobius: recall tool');
      modelStatus.tool = true;
      modelStatus.mountedAt = Date.now();
      log('mobius: 已注册工具 mobius_recall');
    } catch (e) {
      modelStatus.lastError = String(e?.message || e);
      log(`mobius: 注册工具失败 ${String(e?.message || e)}`);
    }
    }

  if (prompt) {
    try {
      const dispose = prompt.section({
        name: 'mobius:index',
        order: 480,
        text: () => {
          try {
            const meta = deps.getIndex().meta;
            return [
              '【本地对话索引】',
              `这里有一份你与用户的历史对话索引（${meta.sessions} 个会话 / ${meta.total ?? meta.nodes} 条记录）。`,
              '需要回忆"之前定过什么、上次怎么修的、用户立过什么规矩"时，调用 mobius_recall 查（用名词，别用整句）。',
              '它给的是原文摘录、可能过时；和本轮说法冲突时以本轮为准，用户说过的话优先于助手说过的。',
              '查当下事实、外部资料、需要现查的东西，不要用它。',
            ].join('');
          } catch {
            return '';
          }
        },
      });
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'mobius: index section');
      modelStatus.prompt = true;
      log('mobius: 已注入提示词索引段');
    } catch (e) {
      log(`mobius: 注入提示词失败 ${String(e?.message || e)}`);
    }
  } else {
    log('mobius: 宿主没有 systemPrompt 服务，跳过提示词注入');
  }
  };

  attempt();
  return () => clearTimeout(timer);
}
