/**
 * 排查用：连 CDP，把页面上的关键状态和 JS 异常抓回来。
 *   node scripts/debug-page.mjs [url]
 */
import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8787/app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9444', '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-dbg',
  '--window-size=1600,900', URL_TARGET,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9444/json');
      const list = await r.json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch { /* 等待 */ }
    await sleep(250);
  }
  throw new Error('CDP 起不来');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: myId, method, params }));
});

await send('Runtime.enable');
await send('Log.enable');
await sleep(3000);

const { result } = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const img = document.querySelector('.brand-img');
    const cv = document.getElementById('cv');
    const r = img ? img.getBoundingClientRect() : null;
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      canvasAttr: cv ? [cv.width, cv.height] : null,
      canvasBox: cv ? (() => { const b = cv.getBoundingClientRect(); return [b.width, b.height]; })() : null,
      imgRect: r ? [r.x, r.y, r.width, r.height] : null,
      imgStyle: img ? { blend: getComputedStyle(img).mixBlendMode, w: getComputedStyle(img).width } : null,
      brandBox: (() => { const b = document.getElementById('brand').getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })(),
      nodes: window.__DEBUG_NODES ?? null,
      scrollH: document.body.scrollHeight,
    };
  })()`,
});

console.log(JSON.stringify(result.value, null, 2));
const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
console.log('--- 异常 ---');
for (const e of errs.slice(0, 6)) console.log(JSON.stringify(e.params).slice(0, 400));

ws.close();
chrome.kill();
