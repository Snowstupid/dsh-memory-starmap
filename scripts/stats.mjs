import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = process.argv[2] || 'http://127.0.0.1:8787/app';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9811',
  '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-stats',
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9811/json')).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* 等 */ }
  await sleep(250);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Page.navigate', { url });
await sleep(4200);
const { result } = await send('Runtime.evaluate', {
  expression: 'JSON.stringify(__MOBIUS__.projStats())',
  returnByValue: true,
});
console.log(result.value);
ws.close();
chrome.kill();
