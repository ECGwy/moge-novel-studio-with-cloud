/* 生成界面预览截图：node tools/shots.mjs [url] [outDir] */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = process.argv[2] || 'http://127.0.0.1:5173/';
const OUT = process.argv[3] || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'preview');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
const PORT = 9334;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-shots-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (t.length) return t.find((x) => x.type === 'page');
    } catch (_) {}
    await sleep(300);
  }
  throw new Error('Chrome 启动超时');
}

function cdp(ws) {
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    waiting.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (waiting.has(mid)) { waiting.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
  });
}

const SEED = `(async () => {
  const { db } = await import('./js/db.js');
  await db.clear('projects'); await db.clear('chapters');
  const now = Date.now();
  const p = {
    id:'p_demo', title:'青焰纪', genre:'玄幻 · 悬疑', pov:'第三人称有限视角',
    synopsis:'落魄铸剑师沈青焰为找回被夺走的记忆，混入仙门做卧底。',
    world:'九州之上，仙门以「剑契」御剑。剑契一旦断裂，持剑者将失去与之相关的一段记忆。三十年前那场「断契之夜」，天下名剑尽折。',
    style:'短句为主，画面感强，少用成语；对话口语化，节奏快，每章结尾留钩子。',
    characters:[
      {name:'沈青焰', role:'铸剑师', traits:'表面懒散爱开玩笑，实则记仇；说话喜欢用反问', goal:'找回被剑契夺走的记忆', desc:'左手腕有一道环形旧疤，怕火却靠火吃饭'},
      {name:'白眠', role:'仙门执事', traits:'温柔，永远差半步说真话', goal:'守住断契之夜的秘密', desc:'认得沈青焰那把没开锋的剑，却假装不认识'}
    ],
    goal:2000, chunk:800, aiSystem:'', createdAt:now, updatedAt:now,
  };
  await db.put('projects', p);
  const chs = [
    {t:'第一章 断契', s:'沈青焰在废剑冢捡到一柄没开锋的剑，剑上刻着自己的名字。', c:'雨下了一夜。\\n\\n沈青焰是被铁锈味呛醒的。\\n\\n废剑冢在城外三十里，堆着三百年里所有折断的剑。官府不管，仙门不收，只有他这种没出息的铸剑师会来这儿捡破烂。\\n\\n他扒开一层湿透的稻草，手指碰到一截冰。\\n\\n不是铁。是剑。\\n\\n剑身没开锋，剑脊上却刻着两个字——青焰。\\n\\n他愣了很久，久到雨水顺着下巴滴进领口。\\n\\n「这名字……」他笑了一下，笑得比哭难看，「谁这么不要脸，跟我一个名。」\\n\\n剑没有回答。但剑柄在他掌心里，很轻地，热了一下。'},
    {t:'第二章 仙门来人', s:'白眠上门收剑，沈青焰用假话套出了断契之夜的一角。', c:'第二天清早，门口站着个撑伞的人。\\n\\n白衣，笑意很浅，伞是新的。\\n\\n「沈师傅？」对方声音温和，「听说你昨夜，从剑冢里带回一样东西。」\\n\\n沈青焰把门开了一半，又懒洋洋地靠回去：「仙门的人，连我做什么梦都要管？」\\n\\n「不管梦。」白眠说，「只管剑。」\\n\\n「那你看走眼了。」沈青焰往院里一让，「我这儿全是破铜烂铁。」\\n\\n白眠的目光在他左手的疤上停了半息。\\n\\n就半息。\\n\\n沈青焰记下了。'},
    {t:'第三章 火里的名字', s:'炉火中浮现出三十年前的画面，沈青焰第一次怀疑自己的记忆是假的。', c:''},
  ];
  const ids = ['c1','c2','c3'];
  chs.forEach((x, i) => {});
  for (let i = 0; i < chs.length; i++) {
    await db.put('chapters', { id: ids[i], projectId: 'p_demo', title: chs[i].t, content: chs[i].c, summary: chs[i].s, order: i, createdAt: now + i, updatedAt: now + i });
  }
  await db.setKV('lastProject', 'p_demo');
  await db.setKV('settings', {
    provider:'deepseek', baseUrl:'https://api.deepseek.com/v1', apiKey:'',
    model:'deepseek-chat', temperature:0.9, maxTokens:2048, contextChars:6000, stream:true,
    proxy:'', extraHeaders:'', system:'', fontSize:17, lineHeight:1.9, breakMinutes:45,
  });
  location.reload();
})()`;

const shots = [];
let ws, send;
try {
  const page = await waitChrome();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  send = cdp(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    shots.push(file);
    console.log('  →', file);
  };
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(expression.slice(0, 60) + ' → ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 200));
    return r.result?.value;
  };

  await send('Page.navigate', { url: URL_ });
  await sleep(2500);
  const seeded = await send('Runtime.evaluate', { expression: SEED, awaitPromise: true, returnByValue: true });
  if (seeded.exceptionDetails) throw new Error(JSON.stringify(seeded.exceptionDetails).slice(0, 400));
  await sleep(2800);

  // 启动后默认回到上次打开的作品（写作页），先去书架
  await ev(`document.querySelector('.tab[data-view="library"]').click()`);
  await sleep(400);
  await shot('01-书架');

  await ev(`document.querySelector('.book-main').click()`);
  await sleep(700);
  await ev(`document.getElementById('editor').value = document.getElementById('editor').value + '\\n\\n他吹灭灯，把剑放在膝上。\\n\\n黑暗里，那两个字亮了。'; document.getElementById('editor').dispatchEvent(new Event('input',{bubbles:true}));`);
  await sleep(400);
  await shot('02-写作');

  await ev(`document.getElementById('btnAI').click(); document.getElementById('aiOutput').value = '白眠的手指在袖中收紧了。\\n\\n「你昨夜烧的是松木。」他说，「可你身上有沉铁的味道。」\\n\\n沈青焰低头闻了闻自己的袖子，笑得没心没肺：「那是穷味。」\\n\\n「穷味不会让剑鸣。」\\n\\n院子里忽然安静下来。屋檐最后一滴水落进石臼，叮的一声，像谁敲了一下钟。'; document.getElementById('aiStatus').textContent='✓ 续写 完成 · 128 字 · 3.2s';`);
  await sleep(400);
  await shot('03-AI助手');

  await ev(`document.getElementById('btnCloseAI').click(); document.querySelector('.tab[data-view="bible"]').click();`);
  await sleep(500);
  await shot('04-设定');

  await ev(`document.querySelector('.tab[data-view="settings"]').click();`);
  await sleep(500);
  await shot('05-我的');

  await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const sel = document.getElementById('syncProvider');
    sel.value = 'webdav'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    document.getElementById('syncStatus').textContent = '✅ 同步完成 · 云端 1 部作品 / 3 章 · 42 KB · 2026-10-13 22:40';
    document.querySelector('#syncProvider').scrollIntoView({ block: 'start' });
  })()`, true);
  await sleep(500);
  await shot('05b-云同步');

  await ev(`(async () => {
    const sel = document.getElementById('syncProvider');
    sel.value = 'gist'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    document.getElementById('btnSyncGuide').click();
  })()`, true);
  await sleep(500);
  await shot('05c-GitHub同步教程');
  await ev(`document.querySelector('#modalBox [data-close]').click()`);

  await ev(`document.querySelector('.tab[data-view="editor"]').click(); document.getElementById('btnChapters').click();`);
  await sleep(500);
  await shot('06-目录');

  await ev(`document.getElementById('btnCloseDrawer').click(); document.getElementById('btnFocus').click();`);
  await sleep(500);
  await shot('07-专注模式');
} catch (e) {
  console.error('截图失败：', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (_) {}
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}
console.log('共 ' + shots.length + ' 张 ->', OUT);
