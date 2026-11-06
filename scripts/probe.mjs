import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9778',
  '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-probe2',
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9778/json')).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* 等 */ }
  await sleep(250);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8787/app' });
await sleep(700);
let shot0 = await send('Page.captureScreenshot',{format:'png'});
(await import('node:fs')).writeFileSync('docs/intro-700.png', Buffer.from(shot0.data,'base64'));
await sleep(900);
let shot1 = await send('Page.captureScreenshot',{format:'png'});
(await import('node:fs')).writeFileSync('docs/intro-1600.png', Buffer.from(shot1.data,'base64'));
await sleep(2600);

const r = await send('Runtime.evaluate', {
  expression: 'JSON.stringify({ drawn: window.__drawn || 0, intro: __MOBIUS__.dbg().intro })',
  returnByValue: true,
});
console.log(r.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync('docs/probe.png', Buffer.from(shot.data, 'base64'));
console.log('已截图 docs/probe.png');

const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown');
console.log('异常数', errs.length);
for (const e of errs.slice(0, 3)) {
  console.log(JSON.stringify(e.params.exceptionDetails.exception?.description || e.params).slice(0, 400));
}
ws.close();
chrome.kill();
