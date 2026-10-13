/* 无头 Chrome 冒烟测试（零依赖，走 CDP）
 * 用法：node tools/smoke.mjs [url]
 * 前置：先启动 node server.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moge-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=412,900', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try { const t = await targets(); if (t.length) return t; } catch (_) {}
    await sleep(300);
  }
  throw new Error('Chrome 启动超时');
}

function cdp(ws) {
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      waiting.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (waiting.has(mid)) { waiting.delete(mid); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  return { send, events };
}

const EXPR = `(async () => {
  const R = {};
  const errs = [];
  window.addEventListener('error', e => errs.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', e => errs.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  R.title = document.title;
  R.tabs = document.querySelectorAll('.tab').length;
  R.moge = typeof window.MOGE === 'object';
  R.secure = window.isSecureContext;
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
  R.overlaysHiddenOnBoot = !['drawer', 'aiSheet', 'modalMask', 'aiMask', 'drawerMask', 'toast', 'btnBack']
    .some(id => shown(id));

  // 1. 新建作品
  document.getElementById('btnNewProject').click();
  await sleep(120);
  const inp = document.querySelector('#mInput');
  R.modalOpened = !!inp;
  inp.value = '冒烟测试书';
  document.querySelector('[data-a="1"]').click();
  await sleep(500);
  R.projects = (await MOGE.db.all('projects')).length;
  R.chapters = (await MOGE.db.all('chapters')).length;
  R.activeView = document.querySelector('.view.active').id;

  // 2. 写作 + 自动保存
  const ed = document.getElementById('editor');
  ed.value = '他推开那扇门，风从里面灌出来，带着铁锈的味道。';
  ed.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(1200);
  R.wordCount = document.getElementById('wordCount').textContent;
  R.saveState = document.getElementById('saveState').textContent;
  const chs = await MOGE.db.all('chapters');
  R.persistedLen = chs[0].content.length;
  R.todayStats = (await MOGE.db.getKV('stats:' + new Date().toISOString().slice(0,10), null));

  // 3. 目录抽屉 / 新建章节
  document.getElementById('btnChapters').click();
  await sleep(120);
  R.drawerItems = document.querySelectorAll('#drawerList .ch-item').length;
  document.getElementById('btnCloseDrawer').click();

  // 4. 设定页
  document.querySelector('.tab[data-view="bible"]').click();
  await sleep(150);
  const t = document.getElementById('setTitle');
  t.value = '冒烟测试书·改';
  t.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('btnAddChar').click();
  await sleep(600);
  R.charCards = document.querySelectorAll('#characterList .char').length;
  R.summaryRows = document.querySelectorAll('#summaryList .summary-row').length;
  R.projectTitleSaved = (await MOGE.db.all('projects'))[0].title;

  // 5. AI 面板
  document.querySelector('.tab[data-view="editor"]').click();
  document.getElementById('btnAI').click();
  await sleep(200);
  R.aiChips = document.querySelectorAll('#aiActions .chip').length;
  R.aiOpen = !document.getElementById('aiSheet').hidden;
  R.aiVisible = shown('aiSheet') && getComputedStyle(document.getElementById('aiMask')).display !== 'none';
  R.aiHint = document.getElementById('aiStatus').textContent;
  document.querySelector('#aiActions .chip').click();
  R.selectionTip = document.getElementById('aiSelectionTip').textContent;

  // 5b. AI 输出写回正文（追加 / 插入光标 / 替换选中）
  document.getElementById('aiOutput').value = '【AI段】他听见剑在响。';
  document.getElementById('btnInsertEnd').click();
  await sleep(900);
  R.appendedToEditor = document.getElementById('editor').value.includes('【AI段】他听见剑在响。');
  R.appendedPersisted = (await MOGE.db.all('chapters')).some((c) => (c.content || '').includes('【AI段】他听见剑在响。'));
  R.aiClosedAfterInsert = getComputedStyle(document.getElementById('aiSheet')).display === 'none';

  const ed2 = document.getElementById('editor');
  ed2.focus();
  ed2.setSelectionRange(0, 4);              // 选中开头 4 个字
  ed2.dispatchEvent(new Event('select', { bubbles: true }));
  document.getElementById('btnAI').click();
  await sleep(150);
  R.replaceEnabledWithSelection = !document.getElementById('btnReplaceSel').disabled;
  document.getElementById('aiOutput').value = '【替换后】';
  document.getElementById('btnReplaceSel').click();
  await sleep(700);
  R.replacedSelection = ed2.value.startsWith('【替换后】');
  document.getElementById('btnCloseAI').click();
  await sleep(120);
  R.aiClosedClean = !shown('aiSheet') && !shown('aiMask');

  // 5c. 作品菜单
  document.querySelector('.tab[data-view="library"]').click();
  await sleep(200);
  document.querySelector('.book-menu').click();
  await sleep(200);
  R.bookMenuButtons = document.querySelectorAll('#modalBox [data-c]').length;
  document.querySelector('#modalBox [data-c="cancel"]').click();
  document.querySelector('.tab[data-view="editor"]').click();
  await sleep(150);

  // 6. 设置页 + 备份导出
  document.querySelector('.tab[data-view="settings"]').click();
  await sleep(200);
  R.cfgFields = ['cfgProvider','cfgBaseUrl','cfgApiKey','cfgModel','cfgTemp','cfgContext','cfgSystem','cfgProxy','cfgFontSize']
    .every(id => !!document.getElementById(id));
  R.providerOptions = document.querySelectorAll('#cfgProvider option').length;
  document.getElementById('btnBackup').click();
  await sleep(400);

  // 7. 提示词与上下文组装
  const P = await import('./js/prompts.js');
  R.actions = P.ACTIONS.length;
  const ctx = P.buildContext({
    project: { title: '测试', genre: '悬疑', pov: '第一人称', synopsis: '简介', world: '世界观', style: '文风', characters: [{ name: '阿七', role: '侦探', traits: '冷静' }] },
    chapters: [{ id: 'a', order: 0, title: '一', content: 'x'.repeat(300), summary: '摘要一' }],
    current: { id: 'a', order: 0, title: '一', content: 'x'.repeat(300) },
    ctxChars: 100,
  });
  R.contextOk = ctx.includes('阿七') && ctx.includes('摘要一') && ctx.includes('前文略');
  R.promptLen = P.getAction('continue').build({ context: ctx, project: { chunk: 600 }, instruction: '加速', selection: '', target: '' }).user.length;

  // 8. 服务商模块：错误处理 + 端点拼装
  const PV = await import('./js/providers.js');
  R.providers = Object.keys(PV.PROVIDERS).length;
  let friendly = '';
  try {
    await PV.streamChat({ type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
  } catch (e) { friendly = String(e.message); }
  R.friendlyError = /网络请求失败/.test(friendly);

  // 9. Service Worker
  await sleep(600);
  R.sw = !!(navigator.serviceWorker && await navigator.serviceWorker.getRegistration());

  // 10. 重新载入后数据仍在
  R.errs = errs;
  return R;
})()`;

const results = {};
let failed = false;
try {
  const list = await waitChrome();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const { send, events } = cdp(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(2500);
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    failed = true;
    console.error('页面内异常：', JSON.stringify(r.exceptionDetails, null, 2));
  }
  Object.assign(results, r.result?.value || {});

  // 刷新一次，验证数据持久化 + 离线外壳
  await send('Page.navigate', { url: URL_ });
  await sleep(2200);
  const r2 = await send('Runtime.evaluate', {
    expression: `(async()=>({ projects:(await MOGE.db.all('projects')).length, cards:document.querySelectorAll('.book').length, title:document.querySelector('.book-title')?.textContent, content:(await MOGE.db.all('chapters'))[0].content.slice(0,10) }))()`,
    awaitPromise: true, returnByValue: true,
  });
  results.afterReload = r2.result?.value;

  /* ---------- 阶段二：端到端流式联调（本地 mock AI） ---------- */
  const ev = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
    return r.result?.value;
  };
  const mock = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-mini' }] }));
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (_) {}
      if (payload.stream) {
        res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunks = ['他', '握紧了', '剑柄。', '\n\n', '风', '停了。'];
        let i = 0;
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] }) + '\n\n');
        }, 70);
      } else {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '非流式回复OK' } }] }));
      }
    });
  });
  await new Promise((r) => mock.listen(5199, '127.0.0.1', r));

  const useMock = async (extra) => {
    await ev(`MOGE.db.setKV('settings', Object.assign({}, MOGE.S.settings, ${JSON.stringify({
      provider: 'custom', baseUrl: 'http://127.0.0.1:5199/v1', apiKey: 'test-key', model: 'mock-model',
    })}, ${JSON.stringify(extra)}))`, true);
    await send('Page.navigate', { url: URL_ });
    await sleep(2400);
  };

  // 流式
  await useMock({ stream: true, contextChars: 3000 });
  await ev(`document.getElementById('btnAI').click()`);
  await sleep(200);
  await ev(`document.getElementById('btnGenerate').click()`);
  await sleep(2200);
  results.streamOutput = await ev(`document.getElementById('aiOutput').value`);
  results.streamStatus = await ev(`document.getElementById('aiStatus').textContent`);
  results.streamDone = await ev(`document.getElementById('btnGenerate').disabled === false && !document.getElementById('btnContinueGen').hidden`);

  // 拉取模型列表
  await ev(`document.querySelector('.tab[data-view="settings"]').click()`);
  await sleep(200);
  await ev(`document.getElementById('btnListModels').click()`);
  await sleep(900);
  results.modelListModal = await ev(`(document.querySelector('#modalBox h3')||{}).textContent || ''`);
  await ev(`document.querySelector('#modalBox [data-close]').click()`);

  // 非流式
  await useMock({ stream: false, contextChars: 3000 });
  await ev(`document.getElementById('btnAI').click()`);
  await sleep(200);
  await ev(`document.getElementById('btnGenerate').click()`);
  await sleep(1600);
  results.nonStreamOutput = await ev(`document.getElementById('aiOutput').value`);

  mock.close();

  /* ---------- 阶段三：云同步（多设备 + 冲突） ---------- */
  // 云端模拟器：一个 Worker 端点 + 一个 WebDAV 端点 + 一个 Gist API
  const cloud = { rooms: new Map(), dav: null, gists: new Map(), gistSeq: 0, authed: 0 };
  const cloudSrv = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const json = (o, code = 200) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // Worker 风格：/s/<room>
      if (url.pathname.startsWith('/s/')) {
        const room = url.pathname.slice(3);
        if (req.method === 'GET') {
          if (!cloud.rooms.has(room)) { res.writeHead(404, cors); return res.end('no data'); }
          res.writeHead(200, { ...cors, 'content-type': 'text/plain' });
          return res.end(cloud.rooms.get(room));
        }
        if (req.method === 'PUT') { cloud.rooms.set(room, raw); return json({ ok: true, bytes: raw.length }); }
      }
      // WebDAV 风格：/dav/moge-sync.json（校验 Basic 认证）
      if (url.pathname === '/dav/moge-sync.json') {
        const auth = req.headers.authorization || '';
        if (auth !== 'Basic ' + Buffer.from('moge-user:moge-pass').toString('base64')) {
          res.writeHead(401, { ...cors, 'www-authenticate': 'Basic realm="dav"' });
          return res.end('unauthorized');
        }
        cloud.authed++;
        if (req.method === 'GET') {
          if (cloud.dav == null) { res.writeHead(404, cors); return res.end('not found'); }
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          return res.end(cloud.dav);
        }
        if (req.method === 'PUT') { cloud.dav = raw; res.writeHead(201, cors); return res.end(); }
      }
      // Gist API
      if (url.pathname === '/user') return json({ login: 'moge-tester' });
      if (url.pathname === '/gists' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}');
        const id = 'gist' + (++cloud.gistSeq);
        cloud.gists.set(id, body.files?.['moge-sync.json']?.content || '');
        return json({ id }, 201);
      }
      const m = url.pathname.match(/^\/gists\/([^/]+)$/);
      if (m) {
        const id = m[1];
        if (req.method === 'PATCH') {
          if (!cloud.gists.has(id)) return json({ message: 'Not Found' }, 404);
          const body = JSON.parse(raw || '{}');
          cloud.gists.set(id, body.files?.['moge-sync.json']?.content || '');
          return json({ id });
        }
        if (req.method === 'GET') {
          if (!cloud.gists.has(id)) return json({ message: 'Not Found' }, 404);
          return json({ id, files: { 'moge-sync.json': { content: cloud.gists.get(id), truncated: false } } });
        }
      }
      res.writeHead(404, cors);
      res.end('not found');
    });
  });
  await new Promise((r) => cloudSrv.listen(5200, '127.0.0.1', r));

  const unpackCloud = (s) => (String(s).startsWith('MOGE-GZ1:')
    ? JSON.parse(zlib.gunzipSync(Buffer.from(String(s).slice(9), 'base64')).toString('utf8'))
    : JSON.parse(String(s)));
  const packCloud = (o) => 'MOGE-GZ1:' + zlib.gzipSync(Buffer.from(JSON.stringify(o), 'utf8')).toString('base64');

  const setSync = async (provider, fields) => {
    await ev(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const sel = document.getElementById('syncProvider');
      sel.value = ${JSON.stringify(provider)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(180);
      const f = ${JSON.stringify(fields)};
      for (const k of Object.keys(f)) {
        const el = document.getElementById('sync_' + k);
        if (!el) throw new Error('缺少字段 ' + k);
        el.value = f[k];
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await sleep(120);
      return MOGE.S.syncCfg.provider;
    })()`, true);
  };
  const clearLocal = () => ev(`(async () => {
    await MOGE.db.clear('projects'); await MOGE.db.clear('chapters');
    await MOGE.db.setKV('syncBaseline', null);
    await MOGE.db.setKV('tombstones', []);
    return { p: (await MOGE.db.all('projects')).length };
  })()`, true);

  // 1) 首次上传
  await setSync('worker', { endpoint: 'http://127.0.0.1:5200', room: 'moge-test', token: '' });
  const pushR = await ev(`(async () => { const r = await MOGE.runSync(); return r ? { p: r.projects, c: r.chapters, bytes: r.bytes } : null; })()`, true);
  results.syncPush = pushR;
  results.syncStatusText = await ev(`document.getElementById('syncStatus').textContent`);
  const remoteRaw = cloud.rooms.get('moge-test');
  results.remoteHasData = !!remoteRaw;
  results.remoteBytes = remoteRaw ? remoteRaw.length : 0;
  const remoteSnap = remoteRaw ? unpackCloud(remoteRaw) : null;
  results.remoteChapters = remoteSnap ? remoteSnap.chapters.length : 0;
  results.remoteCompressed = String(remoteRaw).startsWith('MOGE-GZ1:');

  // 2) 模拟另一台设备（本地清空）后同步，应把书拉回来
  await clearLocal();
  const pullR = await ev(`(async () => { const r = await MOGE.runSync(); return r ? { p: r.projects, c: r.chapters } : null; })()`, true);
  results.syncOnNewDevice = pullR;
  results.afterPull = await ev(`(async () => {
    const ps = await MOGE.db.all('projects'); const cs = await MOGE.db.all('chapters');
    return { p: ps.length, c: cs.length, title: ps[0] && ps[0].title, content: cs.map(c => c.content).join('').slice(0, 20) };
  })()`, true);

  // 3) 冲突：两端同时改同一章，云端更新
  const chapterId = await ev(`(async () => (await MOGE.db.all('chapters'))[0].id)()`, true);
  const baseSnap = unpackCloud(cloud.rooms.get('moge-test'));
  const target = baseSnap.chapters.find((c) => c.id === chapterId);
  target.content = '【云端改的】白眠没有回答。';
  target.updatedAt = Date.now() + 60000;
  cloud.rooms.set('moge-test', packCloud(baseSnap));

  await ev(`(async () => {
    const cs = await MOGE.db.all('chapters');
    const c = cs.find(x => x.id === ${JSON.stringify(chapterId)});
    c.content = '【本机改的】沈青焰把剑按回鞘里。';
    c.updatedAt = Date.now();
    await MOGE.db.put('chapters', c);
    await MOGE.db.setKV('syncBaseline', await MOGE.db.getKV('syncBaseline'));
  })()`, true);
  const conflictR = await ev(`(async () => { const r = await MOGE.runSync(); return r ? { conflicts: r.conflicts.length, copies: r.copies } : null; })()`, true);
  results.syncConflict = conflictR;
  results.conflictState = await ev(`(async () => {
    const cs = await MOGE.db.all('chapters');
    return {
      total: cs.length,
      keptCloud: cs.some(c => c.content.includes('云端改的')),
      keptLocalCopy: cs.some(c => c.content.includes('本机改的') && c.title.includes('冲突副本')),
      copyTitles: cs.filter(c => c.title.includes('冲突副本')).map(c => c.title),
    };
  })()`, true);
  results.conflictStatusText = await ev(`document.getElementById('syncStatus').textContent`);

  // 4) 删除同步：本机删章 → 云端也跟着删（墓碑生效）
  const beforeDel = unpackCloud(cloud.rooms.get('moge-test')).chapters.length;
  await ev(`(async () => {
    const cs = await MOGE.db.all('chapters');
    const c = cs[0];
    await MOGE.db.del('chapters', c.id);
    const t = await MOGE.db.getKV('tombstones', []);
    t.push({ type: 'chapter', id: c.id, projectId: c.projectId, deletedAt: Date.now() });
    await MOGE.db.setKV('tombstones', t);
    await MOGE.db.setKV('syncBaseline', { projects: (await MOGE.db.all('projects')), chapters: cs, tombstones: [] });
  })()`, true);
  await ev(`MOGE.runSync()`, true);
  results.deleteSync = { before: beforeDel, after: unpackCloud(cloud.rooms.get('moge-test')).chapters.length };

  // 5) WebDAV 适配器
  await setSync('webdav', {
    davUrl: 'http://127.0.0.1:5200/dav/moge-sync.json', davUser: 'moge-user', davPass: 'moge-pass', davProxy: '',
  });
  const davR = await ev(`(async () => { const r = await MOGE.runSync(); return r ? { p: r.projects, bytes: r.bytes } : null; })()`, true);
  results.davSync = davR;
  results.davStored = cloud.dav ? unpackCloud(cloud.dav).chapters.length : -1;
  results.davAuthed = cloud.authed > 0;
  results.davTest = await ev(`(async () => { try { return await (await import('./js/sync.js')).remoteTest(MOGE.S.syncCfg); } catch (e) { return 'ERR:' + e.message; } })()`, true);

  // 6) Gist 适配器（自动创建 + 更新）
  await setSync('gist', { gistToken: 'test-token', gistId: '', gistApi: 'http://127.0.0.1:5200' });
  const gistR = await ev(`(async () => { const r = await MOGE.runSync(); return { r: r ? { p: r.projects } : null, gistId: MOGE.S.syncCfg.gistId }; })()`, true);
  results.gistSync = gistR;
  results.gistStored = cloud.gists.get(gistR.gistId) ? unpackCloud(cloud.gists.get(gistR.gistId)).projects.length : -1;
  const gistR2 = await ev(`(async () => { const r = await MOGE.runSync(); return { gistId: MOGE.S.syncCfg.gistId, ok: !!r }; })()`, true);
  results.gistUpdate = gistR2;
  results.gistCount = cloud.gists.size;

  // 7) 内置配置教程（GitHub 路径）
  await ev(`document.getElementById('btnSyncGuide').click()`, true);
  await sleep(250);
  results.syncGuide = await ev(`(() => {
    const t = document.getElementById('modalBox');
    return {
      title: (t.querySelector('h3') || {}).textContent || '',
      hasTokenUrl: t.textContent.includes('github.com/settings/tokens/new'),
      hasGistIdHint: t.textContent.includes('Gist ID'),
      hasSecondDevice: t.textContent.includes('另一台设备'),
      hasTokenLink: !!t.querySelector('a[href*="settings/tokens/new"]'),
    };
  })()`, true);
  await ev(`document.querySelector('#modalBox [data-close]').click()`);

  // 8) 错误路径：认证失败
  results.syncErr401 = await ev(`(async () => {
    const S = await import('./js/sync.js');
    try { await S.remoteRead({ provider: 'webdav', davUrl: 'http://127.0.0.1:5200/dav/moge-sync.json', davUser: 'x', davPass: 'y' }); return 'no-error'; }
    catch (e) { return e.message.slice(0, 60); }
  })()`, true);

  cloudSrv.close();

  const consoleErrors = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => a.value || a.description).join(' '));
  const exceptions = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description || ''));
  results.consoleErrors = [...consoleErrors, ...exceptions];

  ws.close();
} catch (e) {
  failed = true;
  console.error('测试失败：', e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

const errs = results.errs || [];
const consoleErrors = results.consoleErrors || [];
const checks = [
  ['页面标题', results.title === '墨阁 · AI 小说工作室'],
  ['4 个底部标签', results.tabs === 4],
  ['MOGE 全局对象已挂载', results.moge === true],
  ['新建弹窗可用', results.modalOpened === true],
  ['作品已入库', results.projects === 1 && results.chapters === 1],
  ['创建后进入写作页', results.activeView === 'view-editor'],
  ['字数统计生效', /字/.test(results.wordCount || '')],
  ['自动保存生效', results.persistedLen > 20 && /已保存/.test(results.saveState || '')],
  ['今日字数已统计', !!(results.todayStats && results.todayStats.words > 0)],
  ['目录抽屉渲染', results.drawerItems === 1],
  ['设定页标题保存', results.projectTitleSaved === '冒烟测试书·改'],
  ['角色卡添加', results.charCards === 1],
  ['章节摘要行渲染', results.summaryRows === 1],
  ['AI 面板打开且有动作', results.aiOpen === true && results.aiChips === 14],
  ['启动时遮罩/抽屉均已隐藏', results.overlaysHiddenOnBoot === true],
  ['AI 面板与遮罩真实可见', results.aiVisible === true],
  ['关闭 AI 后面板真正消失', results.aiClosedClean === true],
  ['AI 输出可追加到正文', results.appendedToEditor === true],
  ['追加内容已落盘', results.appendedPersisted === true],
  ['插入后 AI 面板自动关闭', results.aiClosedAfterInsert === true],
  ['有选中文字时「替换选中」可用', results.replaceEnabledWithSelection === true],
  ['「替换选中」替换正确', results.replacedSelection === true],
  ['作品菜单弹窗', results.bookMenuButtons === 5],
  ['设置项齐全', results.cfgFields === true && results.providerOptions >= 10],
  ['上下文组装正确', results.contextOk === true],
  ['提示词生成正常', results.promptLen > 200],
  ['服务商数量', results.providers === 12],
  ['网络错误友好提示', results.friendlyError === true],
  ['Service Worker 已注册', results.sw === true],
  ['刷新后数据仍在', results.afterReload?.projects === 1 && results.afterReload?.content?.length === 10],
  ['刷新后书架显示书名', results.afterReload?.title === '冒烟测试书·改'],
  ['端到端流式生成（SSE）', results.streamOutput === '他握紧了剑柄。\n\n风停了。'],
  ['流式完成后状态显示成功', /✓/.test(results.streamStatus || '')],
  ['流式完成后可继续写', results.streamDone === true],
  ['拉取模型列表弹窗', /可用模型（2）/.test(results.modelListModal || '')],
  ['非流式生成正常', results.nonStreamOutput === '非流式回复OK'],
  ['云同步：首次上传成功', results.syncPush?.p === 1 && results.syncPush?.bytes > 200],
  ['云同步：gzip 压缩后上传', results.remoteCompressed === true],
  ['云同步：云端已收到数据', results.remoteHasData === true && results.remoteChapters >= 1],
  ['云同步：新设备能拉回全部内容', results.syncOnNewDevice?.p === 1 && results.afterPull?.p === 1 && results.afterPull?.content?.length > 0],
  ['云同步：冲突保留云端新版', results.conflictState?.keptCloud === true],
  ['云同步：冲突生成副本不丢字', results.conflictState?.keptLocalCopy === true],
  ['云同步：冲突计入报告', results.syncConflict?.conflicts >= 1 && results.syncConflict?.copies?.length >= 1],
  ['云同步：删除能同步到云端（墓碑）', results.deleteSync?.after === results.deleteSync?.before - 1],
  ['云同步：WebDAV 适配器可用', results.davSync?.p === 1 && results.davStored >= 0],
  ['云同步：WebDAV 带 Basic 认证', results.davAuthed === true],
  ['云同步：WebDAV 测试连接', /已连通/.test(results.davTest || '')],
  ['云同步：Gist 自动创建', !!results.gistSync?.gistId && results.gistStored === 1],
  ['云同步：Gist 二次同步走更新', results.gistUpdate?.ok === true && results.gistCount === 1],
  ['云同步：认证失败有友好提示', /\[401\]/.test(results.syncErr401 || '')],
  ['云同步：内置配置教程可打开', results.syncGuide?.title?.includes('GitHub') === true && results.syncGuide?.hasTokenUrl === true],
  ['云同步：教程含 Gist ID 与多设备说明', results.syncGuide?.hasGistIdHint === true && results.syncGuide?.hasSecondDevice === true],
  ['云同步：教程里的令牌网址可点', results.syncGuide?.hasTokenLink === true],
  ['无页面报错', errs.length === 0],
  ['无控制台报错', consoleErrors.length === 0],
];

console.log('\n================ 冒烟测试结果 ================');
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}`);
  if (!ok) failed = true;
}
console.log('\n原始数据：');
console.log(JSON.stringify(results, null, 2));
if (errs.length || consoleErrors.length) {
  console.log('\n页面错误：', JSON.stringify({ errs, consoleErrors }, null, 2));
}
console.log(failed ? '\n结果：存在失败项 ❌\n' : '\n结果：全部通过 ✅\n');
process.exit(failed ? 1 : 0);
