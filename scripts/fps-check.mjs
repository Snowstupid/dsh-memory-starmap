/**
 * 量帧率：连 CDP 往页面里塞一个 rAF 计数器，跑 3 秒读回来。
 *   node scripts/fps-check.mjs [url]
 */
import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8787/app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9555', '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-fps',
  '--window-size=1600,900', URL_TARGET,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9555/json')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch { /* 等 */ }
    await sleep(250);
  }
  throw new Error('CDP 起不来');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: myId, method, params }));
});

await send('Runtime.enable');
await sleep(2500);   // 等首屏数据加载完

await send('Runtime.evaluate', {
  expression: `(() => {
    window.__frames = 0;
    window.__t0 = performance.now();
    const tick = () => { window.__frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`,
});

await sleep(3000);

const { result } = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const dt = (performance.now() - window.__t0) / 1000;
    return { frames: window.__frames, seconds: Number(dt.toFixed(2)), fps: Number((window.__frames / dt).toFixed(1)) };
  })()`,
});

console.log(JSON.stringify(result.value));
ws.close();
chrome.kill();
