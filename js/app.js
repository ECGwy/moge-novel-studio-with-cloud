/* ================= 墨阁 · 主程序 ================= */
import { db, uid, countWords, todayKey, fmtTime } from './db.js';
import { PROVIDERS, streamChat, testConnection, fetchModels, normalizeBase } from './providers.js';
import { ACTIONS, getAction, buildContext, defaultSystemPrompt } from './prompts.js';
import {
  SYNC_PROVIDERS, DEFAULT_SYNC, loadSyncConfig, saveSyncConfig,
  syncNow, remoteTest, addTombstone, resetSyncBaseline,
  scheduleSync, markSynced, hasPendingSync,
} from './sync.js';

/* ---------------- 小工具 ---------------- */
const $ = (id) => document.getElementById(id);
const APP_VERSION = '1.1.0';

const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  baseUrl: PROVIDERS.deepseek.baseUrl,
  apiKey: '',
  model: PROVIDERS.deepseek.model,
  temperature: 0.9,
  maxTokens: 2048,
  contextChars: 6000,
  stream: true,
  proxy: '',
  extraHeaders: '',
  system: defaultSystemPrompt(),
  fontSize: 17,
  lineHeight: 1.9,
  breakMinutes: 45,
};

const S = {
  settings: { ...DEFAULT_SETTINGS },
  projects: [],
  allChapters: [],
  chapters: [],
  project: null,
  chapter: null,
  view: 'library',
  sel: { start: 0, end: 0 },
  gen: { action: 'continue', controller: null, running: false, history: [], prompt: '' },
  deferredPrompt: null,
  timeline: 'desc',
  wordCache: new Map(),
  syncCfg: null,
};

let toastTimer = null;
function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob(['\ufeff', text], { type: mime });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function safeName(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

/* ---------------- 弹窗 ---------------- */
function openModal(html) {
  const box = $('modalBox');
  box.innerHTML = html;
  $('modalMask').hidden = false;
  return box;
}
function closeModal() { $('modalMask').hidden = true; $('modalBox').innerHTML = ''; }

function askConfirm(title, text, okText = '确定') {
  return new Promise((resolve) => {
    const box = openModal(
      `<h3>${esc(title)}</h3><p class="muted small">${esc(text)}</p>
       <div class="btn-row"><button class="btn btn-ghost" data-a="0">取消</button>
       <button class="btn btn-primary" data-a="1">${esc(okText)}</button></div>`
    );
    box.querySelectorAll('[data-a]').forEach((b) =>
      b.addEventListener('click', () => { const v = b.dataset.a === '1'; closeModal(); resolve(v); })
    );
  });
}

function askInput(title, { label = '', value = '', placeholder = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    const box = openModal(
      `<h3>${esc(title)}</h3><label class="field"><span>${esc(label)}</span>` +
      (multiline
        ? `<textarea id="mInput" rows="4" placeholder="${esc(placeholder)}"></textarea>`
        : `<input id="mInput" placeholder="${esc(placeholder)}" />`) +
      `</label><div class="btn-row"><button class="btn btn-ghost" data-a="0">取消</button>
       <button class="btn btn-primary" data-a="1">确定</button></div>`
    );
    const input = box.querySelector('#mInput');
    input.value = value;
    setTimeout(() => input.focus(), 50);
    const done = (v) => { closeModal(); resolve(v); };
    box.querySelectorAll('[data-a]').forEach((b) =>
      b.addEventListener('click', () => done(b.dataset.a === '1' ? input.value : null))
    );
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  try {
    const saved = await db.getKV('settings', null);
    if (saved) S.settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) { console.warn('读取设置失败', e); }

  S.projects = (await db.all('projects')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  S.allChapters = await db.all('chapters');
  S.stats = await db.getKV('stats:' + todayKey(), { words: 0 });
  S.syncCfg = await loadSyncConfig();

  bindGlobal();
  renderProviderOptions();
  renderSettings();
  renderSync();
  renderLibrary();
  applyTypography();
  setInterval(breakReminder, 60000);
  $('appVersion').textContent = `版本 ${APP_VERSION} · 数据保存在本机浏览器`;

  if (S.projects.length) {
    const lastId = await db.getKV('lastProject', null);
    const p = S.projects.find((x) => x.id === lastId) || S.projects[0];
    if (p) await openProject(p.id, { silent: true });
  }
  go(S.project ? 'editor' : 'library');

  if (S.syncCfg.enabled && readyToSync(S.syncCfg)) {
    setTimeout(() => runSync({ silent: true }), 2500);   // 启动后台同步一次
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {});
    } catch (e) { console.warn('Service Worker 注册失败', e); }
  }
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

let _breakTimer = 0;
function breakReminder() {
  const mins = Number(S.settings.breakMinutes) || 0;
  if (!mins || S.view !== 'editor') return;
  _breakTimer++;
  if (_breakTimer >= mins) {
    _breakTimer = 0;
    toast('已经连续写了 ' + mins + ' 分钟，起来活动一下吧 ☕', 5000);
  }
}

/* ---------------- 路由 ---------------- */
const TITLES = { library: '墨阁', editor: '写作', bible: '本书设定', settings: '设置' };

/* 章节显示名：标题里已经写了「第X章」就不再重复加序号 */
function chapterLabel(c, i) {
  const t = (c && c.title) || '未命名';
  return /^第\s*[0-9０-９一二三四五六七八九十百千两]+\s*[章回节卷]/.test(t) ? t : `第${i + 1}章　${t}`;
}

function go(view) {
  if (view === 'editor' || view === 'bible') {
    if (!S.project) { toast('先创建或打开一本书'); view = 'library'; }
  }
  S.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('topTitle').textContent = (view === 'editor' || view === 'bible') && S.project ? S.project.title : TITLES[view];
  $('btnBack').hidden = !(view === 'editor' || view === 'bible');
  $('btnAI').hidden = view !== 'editor';
  $('btnFocus').hidden = view !== 'editor';
  if (view === 'library') renderLibrary();
  if (view === 'bible') renderBible();
  if (view === 'settings') renderSettings();
}

/* ---------------- 书架 ---------------- */
const COVERS = [
  ['#7c3aed', '#c084fc'], ['#0ea5e9', '#22d3ee'], ['#f43f5e', '#fb7185'],
  ['#f59e0b', '#fbbf24'], ['#10b981', '#34d399'], ['#6366f1', '#a5b4fc'],
];
function coverOf(p) {
  let h = 0;
  for (const c of String(p.id)) h = (h * 31 + c.charCodeAt(0)) % 997;
  return COVERS[h % COVERS.length];
}

function projectWords(pid) {
  return S.allChapters.filter((c) => c.projectId === pid).reduce((n, c) => n + countWords(c.content), 0);
}

function renderLibrary() {
  const list = $('projectList');
  list.innerHTML = '';
  const empty = $('libEmpty');
  empty.classList.toggle('show', S.projects.length === 0);
  $('libStat').textContent = S.projects.length
    ? `${S.projects.length} 部作品 · 累计 ${S.projects.reduce((n, p) => n + projectWords(p.id), 0).toLocaleString()} 字`
    : '还没有作品';

  for (const p of S.projects) {
    const chs = S.allChapters.filter((c) => c.projectId === p.id);
    const [c1, c2] = coverOf(p);
    const card = el('div', 'book');
    card.innerHTML = `
      <div class="book-cover" style="background:linear-gradient(140deg,${c1},${c2})">${esc((p.title || '书')[0])}</div>
      <div class="book-main">
        <div class="book-title">${esc(p.title || '未命名')}</div>
        <div class="book-sub">${chs.length} 章 · ${projectWords(p.id).toLocaleString()} 字 · ${fmtTime(p.updatedAt)}</div>
        <div class="book-sub">${esc(p.genre || '未设置题材')}</div>
      </div>
      <button class="book-menu">⋮</button>`;
    card.querySelector('.book-main').addEventListener('click', () => openProject(p.id));
    card.querySelector('.book-cover').addEventListener('click', () => openProject(p.id));
    card.querySelector('.book-menu').addEventListener('click', (e) => { e.stopPropagation(); projectMenu(p); });
    list.appendChild(card);
  }
}

async function projectMenu(p) {
  const box = openModal(
    `<h3>${esc(p.title || '未命名')}</h3>
     <div class="btn-row" style="flex-direction:column">
       <button class="btn btn-primary" data-c="open">打开继续写</button>
       <button class="btn btn-ghost" data-c="rename">改书名</button>
       <button class="btn btn-ghost" data-c="txt">导出 TXT</button>
       <button class="btn btn-ghost" data-c="del" style="color:var(--danger)">删除本书</button>
       <button class="btn btn-ghost" data-c="cancel">取消</button>
     </div>`
  );
  box.querySelectorAll('[data-c]').forEach((b) =>
    b.addEventListener('click', async () => {
      const c = b.dataset.c;
      closeModal();
      if (c === 'open') return openProject(p.id);
      if (c === 'txt') return exportProject(p, 'txt');
      if (c === 'rename') {
        const name = await askInput('作品改名', { label: '新书名', value: p.title });
        if (name && name.trim()) {
          p.title = name.trim(); p.updatedAt = Date.now();
          await db.put('projects', p);
          if (S.project && S.project.id === p.id) { $('topTitle').textContent = p.title; }
          renderLibrary(); renderBible();
        }
        return;
      }
      if (c === 'del') {
        if (await askConfirm('删除作品', `《${p.title}》及其全部章节将被永久删除，建议先备份。`, '删除')) {
          for (const ch of S.allChapters.filter((x) => x.projectId === p.id)) {
            await addTombstone('chapter', ch.id, p.id);
            await db.del('chapters', ch.id);
          }
          await addTombstone('project', p.id, p.id);
          await db.del('projects', p.id);
          S.allChapters = S.allChapters.filter((x) => x.projectId !== p.id);
          S.projects = S.projects.filter((x) => x.id !== p.id);
          if (S.project && S.project.id === p.id) { S.project = null; S.chapter = null; S.chapters = []; }
          renderLibrary();
          markDirtyForSync();
          toast('已删除');
          if (!S.project) go('library');
        }
      }
    })
  );
}

async function createProject() {
  const title = await askInput('新建作品', { label: '书名', placeholder: '例如：青焰纪' });
  if (!title || !title.trim()) return;
  const p = {
    id: uid('p'), title: title.trim(), genre: '', pov: '第三人称有限视角',
    synopsis: '', world: '', style: '', characters: [], goal: 2000, chunk: 800,
    aiSystem: '', createdAt: Date.now(), updatedAt: Date.now(),
  };
  await db.put('projects', p);
  S.projects.unshift(p);
  const ch = { id: uid('c'), projectId: p.id, title: '第一章', content: '', summary: '', order: 0, createdAt: Date.now(), updatedAt: Date.now() };
  await db.put('chapters', ch);
  S.allChapters.push(ch);
  await openProject(p.id);
}

/* ---------------- 打开作品 ---------------- */
async function openProject(id, { silent } = {}) {
  const p = S.projects.find((x) => x.id === id);
  if (!p) return;
  S.project = p;
  S.chapters = S.allChapters.filter((c) => c.projectId === id).sort((a, b) => a.order - b.order);
  if (!S.chapters.length) {
    const ch = { id: uid('c'), projectId: id, title: '第一章', content: '', summary: '', order: 0, createdAt: Date.now(), updatedAt: Date.now() };
    await db.put('chapters', ch);
    S.allChapters.push(ch);
    S.chapters = [ch];
  }
  const target = S.chapters.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  loadChapter(target.id);
  renderBible();
  await db.setKV('lastProject', id);
  go('editor');
  if (!silent) toast(`已打开《${p.title}》`);
}

function loadChapter(cid) {
  const c = S.chapters.find((x) => x.id === cid);
  if (!c) return;
  saveChapter();          // 切章前先存旧的
  S.chapter = c;
  $('chapterTitle').value = c.title || '';
  $('editor').value = c.content || '';
  if (!S.wordCache.has(c.id)) S.wordCache.set(c.id, countWords(c.content));
  updateCounts();
  S.sel = { start: 0, end: 0 };
  updateSelTip();
  $('saveState').textContent = '已保存';
  $('saveState').className = 'muted';
  renderChapterDrawer();
  go('editor');
}

/* ---------------- 编辑器 ---------------- */
let saveTimer = null;
let dirty = false;

function markDirty() {
  dirty = true;
  $('saveState').textContent = '编辑中…';
  $('saveState').className = 'muted';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveChapter(), 700);
}

async function saveChapter() {
  clearTimeout(saveTimer);
  const c = S.chapter;
  if (!c || !dirty) return;
  dirty = false;
  const content = $('editor').value;
  const before = S.wordCache.get(c.id) || 0;
  const after = countWords(content);
  c.content = content;
  c.title = $('chapterTitle').value.trim() || c.title || '未命名';
  c.updatedAt = Date.now();
  S.wordCache.set(c.id, after);
  if (S.project) { S.project.updatedAt = Date.now(); await db.put('projects', S.project); }
  await db.put('chapters', c);
  const idx = S.allChapters.findIndex((x) => x.id === c.id);
  if (idx >= 0) S.allChapters[idx] = { ...c };
  if (after > before) addDailyWords(after - before);
  const d = new Date();
  $('saveState').textContent = `已保存 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  updateCounts();
  markDirtyForSync();
}

async function addDailyWords(n) {
  const key = 'stats:' + todayKey();
  S.stats = S.stats || { words: 0 };
  S.stats.words = (S.stats.words || 0) + n;
  await db.setKV(key, S.stats);
}

function updateCounts() {
  const n = countWords($('editor').value);
  $('wordCount').textContent = n.toLocaleString() + ' 字';
  const goal = Number(S.project?.goal) || 0;
  if (goal > 0) {
    const pct = Math.min(100, Math.round((n / goal) * 100));
    $('goalText').textContent = `本章目标 ${goal} 字（${pct}%）`;
    $('goalBar').style.width = pct + '%';
  } else {
    $('goalText').textContent = '';
    $('goalBar').style.width = '0%';
  }
}

function recordSel() {
  const ed = $('editor');
  S.sel = { start: ed.selectionStart || 0, end: ed.selectionEnd || 0 };
  updateSelTip();
}
function selText() {
  const ed = $('editor');
  const { start, end } = S.sel;
  if (end > start) return ed.value.slice(start, end);
  return '';
}
function updateSelTip() {
  const t = selText();
  $('aiSelectionTip').textContent = t ? `已选中 ${countWords(t)} 字，润色/扩写等操作会作用于选中内容。` : '未选中文字时，续写/润色会作用于整章内容。';
  $('btnReplaceSel').disabled = !t;
}

function renderChapterDrawer() {
  const list = $('drawerList');
  list.innerHTML = '';
  $('drawerCount').textContent = `${S.chapters.length} 章 · ${S.chapters.reduce((n, c) => n + countWords(c.content), 0).toLocaleString()} 字`;
  const arr = S.timeline === 'desc' ? S.chapters.slice().reverse() : S.chapters;
  for (const c of arr) {
    const item = el('div', 'ch-item' + (S.chapter && c.id === S.chapter.id ? ' active' : ''));
    item.innerHTML = `
      <div class="ch-main">
        <div class="ch-name">${esc(chapterLabel(c, S.chapters.indexOf(c)))}</div>
        <div class="ch-sub">${countWords(c.content)} 字 · ${fmtTime(c.updatedAt)}</div>
      </div>
      <div class="ch-ops">
        <button data-op="up">▲</button><button data-op="down">▼</button><button data-op="del">✕</button>
      </div>`;
    item.querySelector('.ch-main').addEventListener('click', () => { closeDrawer(); loadChapter(c.id); });
    item.querySelectorAll('[data-op]').forEach((b) =>
      b.addEventListener('click', (e) => { e.stopPropagation(); chapterOp(c, b.dataset.op); })
    );
    list.appendChild(item);
  }
}

async function chapterOp(c, op) {
  const i = S.chapters.indexOf(c);
  if (op === 'up' && i > 0) {
    const prev = S.chapters[i - 1];
    [c.order, prev.order] = [prev.order, c.order];
    await db.put('chapters', c); await db.put('chapters', prev);
    S.chapters.sort((a, b) => a.order - b.order);
  } else if (op === 'down' && i < S.chapters.length - 1) {
    const next = S.chapters[i + 1];
    [c.order, next.order] = [next.order, c.order];
    await db.put('chapters', c); await db.put('chapters', next);
    S.chapters.sort((a, b) => a.order - b.order);
  } else if (op === 'del') {
    if (S.chapters.length <= 1) return toast('至少保留一章');
    if (!(await askConfirm('删除章节', `第${i + 1}章《${c.title}》将被删除。`, '删除'))) return;
    await addTombstone('chapter', c.id, c.projectId);
    await db.del('chapters', c.id);
    S.chapters = S.chapters.filter((x) => x.id !== c.id);
    S.allChapters = S.allChapters.filter((x) => x.id !== c.id);
    S.chapters.forEach((x, k) => { x.order = k; });
    for (const x of S.chapters) await db.put('chapters', x);
    if (S.chapter && S.chapter.id === c.id) loadChapter(S.chapters[0].id);
  }
  renderChapterDrawer();
  renderSummaries();
  markDirtyForSync();
}

async function addChapter() {
  await saveChapter();
  const ch = {
    id: uid('c'), projectId: S.project.id, title: `第${S.chapters.length + 1}章`, content: '', summary: '',
    order: S.chapters.length, createdAt: Date.now(), updatedAt: Date.now(),
  };
  await db.put('chapters', ch);
  S.allChapters.push(ch);
  S.chapters.push(ch);
  closeDrawer();
  loadChapter(ch.id);
  $('chapterTitle').focus();
  $('chapterTitle').select();
  toast('已新建章节');
}

function openDrawer() { $('drawer').hidden = false; $('drawerMask').hidden = false; if (S.chapter) saveChapter(); renderChapterDrawer(); }
function closeDrawer() { $('drawer').hidden = true; $('drawerMask').hidden = true; }

function stepChapter(dir) {
  if (!S.chapter) return;
  const i = S.chapters.indexOf(S.chapter);
  const j = i + dir;
  if (j < 0) return toast('已经是第一章');
  if (j >= S.chapters.length) return toast('已经是最后一章，点「＋」新建');
  loadChapter(S.chapters[j].id);
}

/* ---------------- 设定页 ---------------- */
function renderBible() {
  if (!S.project) return;
  const p = S.project;
  $('setTitle').value = p.title || '';
  $('setGenre').value = p.genre || '';
  $('setPov').value = p.pov || '第三人称有限视角';
  $('setSynopsis').value = p.synopsis || '';
  $('setWorld').value = p.world || '';
  $('setStyle').value = p.style || '';
  $('setGoal').value = p.goal || '';
  $('setChunk').value = p.chunk || '';
  renderChars();
  renderSummaries();
}

function renderChars() {
  const box = $('characterList');
  box.innerHTML = '';
  const list = S.project?.characters || [];
  if (!list.length) box.appendChild(el('p', 'muted small', '还没有角色卡。加几个主要人物，AI 写出来的对话会稳定很多。'));
  list.forEach((c, i) => {
    const card = el('div', 'char');
    card.innerHTML = `
      <div class="char-head">
        <input data-f="name" placeholder="姓名" value="${esc(c.name || '')}" />
        <input data-f="role" placeholder="身份，如：宗门弃徒" value="${esc(c.role || '')}" style="flex:.8;font-weight:400" />
        <button class="icon-btn" data-del="1">✕</button>
      </div>
      <textarea data-f="traits" rows="2" placeholder="性格与说话方式（如：表面散漫，实则记仇，说话爱用反问）">${esc(c.traits || '')}</textarea>
      <textarea data-f="goal" rows="2" placeholder="核心欲望 / 目标" style="margin-top:6px">${esc(c.goal || '')}</textarea>
      <textarea data-f="desc" rows="2" placeholder="其他设定（外貌、背景、与主角的关系与矛盾）" style="margin-top:6px">${esc(c.desc || '')}</textarea>`;
    card.querySelectorAll('[data-f]').forEach((inp) =>
      inp.addEventListener('input', () => { c[inp.dataset.f] = inp.value; saveProjectSoon(); })
    );
    card.querySelector('[data-del]').addEventListener('click', () => {
      S.project.characters.splice(i, 1); saveProjectSoon(); renderChars();
    });
    box.appendChild(card);
  });
}

function renderSummaries() {
  const box = $('summaryList');
  if (!box) return;
  box.innerHTML = '';
  if (!S.chapters.length) { box.appendChild(el('p', 'muted small', '还没有章节。')); return; }
  for (const c of S.chapters) {
    const row = el('div', 'summary-row');
    row.innerHTML = `<b>第${S.chapters.indexOf(c) + 1}章</b><textarea rows="2" placeholder="${esc(c.title || '')} 发生了什么">${esc(c.summary || '')}</textarea>`;
    const ta = row.querySelector('textarea');
    ta.addEventListener('input', () => { c.summary = ta.value; saveChapterMetaSoon(c); });
    box.appendChild(row);
  }
}

let bibleTimer = null;
function saveProjectSoon() {
  clearTimeout(bibleTimer);
  bibleTimer = setTimeout(async () => {
    if (!S.project) return;
    S.project.updatedAt = Date.now();
    await db.put('projects', S.project);
  }, 500);
}
let summaryTimer = null;
function saveChapterMetaSoon(c) {
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(async () => {
    c.updatedAt = c.updatedAt || Date.now();
    await db.put('chapters', c);
    const i = S.allChapters.findIndex((x) => x.id === c.id);
    if (i >= 0) S.allChapters[i] = { ...S.allChapters[i], summary: c.summary };
  }, 500);
}

/* ---------------- AI 配置 ---------------- */
function renderProviderOptions() {
  const sel = $('cfgProvider');
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(PROVIDERS)) {
    const o = el('option', null, esc(v.label));
    o.value = k;
    sel.appendChild(o);
  }
}

function settingsCfg(extra = {}) {
  let headers = {};
  const raw = String(S.settings.extraHeaders || '').trim();
  if (raw) { try { headers = JSON.parse(raw); } catch (e) { toast('自定义请求头不是合法 JSON，已忽略'); } }
  return {
    type: PROVIDERS[S.settings.provider]?.type || 'openai',
    baseUrl: S.settings.baseUrl,
    apiKey: S.settings.apiKey,
    model: S.settings.model,
    temperature: Number(S.settings.temperature),
    maxTokens: Number(S.settings.maxTokens),
    stream: !!S.settings.stream,
    proxy: S.settings.proxy,
    headers,
    ...extra,
  };
}

function renderSettings() {
  const st = S.settings;
  $('cfgProvider').value = st.provider;
  $('cfgBaseUrl').value = st.baseUrl || '';
  $('cfgApiKey').value = st.apiKey || '';
  $('cfgModel').value = st.model || '';
  $('cfgTemp').value = st.temperature;
  $('tempVal').textContent = st.temperature;
  $('cfgMaxTokens').value = st.maxTokens;
  $('cfgContext').value = st.contextChars;
  $('cfgStream').value = st.stream ? '1' : '0';
  $('cfgSystem').value = st.system || '';
  $('cfgProxy').value = st.proxy || '';
  $('cfgHeaders').value = st.extraHeaders || '';
  $('cfgFontSize').value = st.fontSize;
  $('fontVal').textContent = st.fontSize;
  $('cfgLineHeight').value = st.lineHeight;
  $('lhVal').textContent = st.lineHeight;
  $('cfgBreak').value = st.breakMinutes;
  const dl = $('modelList');
  dl.innerHTML = '';
  for (const m of PROVIDERS[st.provider]?.models || []) {
    const o = el('option'); o.value = m; dl.appendChild(o);
  }
  const keyHint = PROVIDERS[st.provider]?.keyHint;
  $('cfgApiKey').placeholder = keyHint || 'sk-...';
}

async function readSettingsForm() {
  const st = S.settings;
  st.provider = $('cfgProvider').value;
  st.baseUrl = $('cfgBaseUrl').value.trim();
  st.apiKey = $('cfgApiKey').value.trim();
  st.model = $('cfgModel').value.trim();
  st.temperature = Number($('cfgTemp').value);
  st.maxTokens = Number($('cfgMaxTokens').value) || 2048;
  st.contextChars = Number($('cfgContext').value) || 6000;
  st.stream = $('cfgStream').value === '1';
  st.system = $('cfgSystem').value;
  st.proxy = $('cfgProxy').value.trim();
  st.extraHeaders = $('cfgHeaders').value.trim();
  st.fontSize = Number($('cfgFontSize').value) || 17;
  st.lineHeight = Number($('cfgLineHeight').value) || 1.9;
  st.breakMinutes = Number($('cfgBreak').value) || 0;
  await db.setKV('settings', st);
  applyTypography();
  $('aiModelTag').textContent = st.model + ' · ' + (PROVIDERS[st.provider]?.label || '');
}

function applyTypography() {
  const ed = $('editor');
  ed.style.fontSize = S.settings.fontSize + 'px';
  ed.style.lineHeight = S.settings.lineHeight;
}

/* ---------------- 云同步 ---------------- */
const SYNC_FIELD_DEFS = {
  gistToken: { label: 'GitHub Token（需要 gist 权限）', type: 'password', placeholder: 'ghp_... 或 github_pat_...' },
  gistId: { label: 'Gist ID（留空则自动创建）', type: 'text', placeholder: '留空即可' },
  gistApi: { label: 'GitHub API 地址（企业版才改）', type: 'text', placeholder: 'https://api.github.com' },
  endpoint: { label: '同步地址', type: 'text', placeholder: 'https://你的worker.workers.dev' },
  room: { label: '房间号（多台设备填一样的）', type: 'text', placeholder: '点右边按钮生成', withRoom: true },
  token: { label: '访问令牌（Worker 设了 TOKEN 才填）', type: 'password', placeholder: '可留空' },
  davUrl: { label: 'WebDAV 文件地址', type: 'text', placeholder: 'https://dav.jianguoyun.com/dav/墨阁/moge-sync.json' },
  davUser: { label: 'WebDAV 账号', type: 'text', placeholder: '邮箱' },
  davPass: { label: 'WebDAV 密码 / 应用密码', type: 'password', placeholder: '建议用应用密码' },
  davProxy: { label: 'CORS 代理地址（WebDAV 必填）', type: 'text', placeholder: 'https://你的worker.workers.dev/?url=' },
};

function syncProviderInfo() {
  return SYNC_PROVIDERS[S.syncCfg?.provider] || SYNC_PROVIDERS.gist;
}

function renderSync() {
  if (!S.syncCfg) return;
  const cfg = S.syncCfg;
  const sel = $('syncProvider');
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(SYNC_PROVIDERS)) {
    const o = el('option', null, esc(v.label));
    o.value = k;
    sel.appendChild(o);
  }
  sel.value = cfg.provider;
  const info = syncProviderInfo();
  $('syncHint').textContent = info.hint;

  const box = $('syncFields');
  box.innerHTML = '';
  for (const f of [...(info.fields || []), ...(info.advanced || [])]) {
    const def = SYNC_FIELD_DEFS[f];
    if (!def) continue;
    const wrap = el('label', 'field');
    wrap.innerHTML = `<span>${esc(def.label)}</span>`;
    const group = el('div', 'input-group');
    const input = el('input');
    input.type = def.type;
    input.id = 'sync_' + f;
    input.placeholder = def.placeholder || '';
    input.value = cfg[f] || '';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.addEventListener('change', () => saveSyncForm());
    group.appendChild(input);
    if (def.type === 'password') {
      const eye = el('button', 'icon-btn', '👁');
      eye.type = 'button';
      eye.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; });
      group.appendChild(eye);
    }
    if (def.withRoom) {
      const gen = el('button', 'icon-btn', '🎲');
      gen.type = 'button';
      gen.title = '生成房间号';
      gen.addEventListener('click', () => {
        input.value = 'moge-' + Math.random().toString(36).slice(2, 8);
        saveSyncForm();
      });
      group.appendChild(gen);
    }
    wrap.appendChild(group);
    box.appendChild(wrap);
  }
  const auto = $('syncAuto');
  auto.value = String(cfg.autoMinutes || 0);
  updateSyncStatus();
}

function updateSyncStatus(extra) {
  const cfg = S.syncCfg || {};
  const last = cfg.lastSyncAt ? fmtTime(cfg.lastSyncAt) : '从未同步';
  const dev = cfg.deviceName ? `本机标识 ${cfg.deviceName}` : '';
  $('syncStatus').textContent = extra || `${cfg.enabled ? '自动同步已开' : '自动同步已关'} · 上次同步：${last}${cfg.lastResult ? ' · ' + cfg.lastResult : ''}${dev ? ' · ' + dev : ''}`;
}

async function saveSyncForm() {
  const cfg = S.syncCfg;
  const info = syncProviderInfo();
  for (const f of [...(info.fields || []), ...(info.advanced || [])]) {
    const input = $('sync_' + f);
    if (input) cfg[f] = input.value.trim();
  }
  cfg.autoMinutes = Number($('syncAuto').value) || 0;
  cfg.enabled = cfg.autoMinutes > 0;
  await saveSyncConfig(cfg);
  updateSyncStatus();
}

function readyToSync(cfg) {
  if (cfg.provider === 'gist') return !!cfg.gistToken;
  if (cfg.provider === 'worker') return !!cfg.endpoint && !!cfg.room;
  if (cfg.provider === 'webdav') return !!cfg.davUrl && !!cfg.davUser && !!cfg.davPass;
  return false;
}

function markDirtyForSync() {
  if (S.syncCfg?.enabled && readyToSync(S.syncCfg)) scheduleSync(() => runSync({ silent: true }), S.syncCfg.autoMinutes);
}

async function reloadFromDB() {
  S.projects = (await db.all('projects')).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  S.allChapters = await db.all('chapters');
  if (S.project) {
    const still = S.projects.find((p) => p.id === S.project.id);
    if (!still) { S.project = null; S.chapter = null; S.chapters = []; go('library'); }
    else {
      S.project = still;
      S.chapters = S.allChapters.filter((c) => c.projectId === still.id).sort((a, b) => a.order - b.order);
      if (!S.chapters.length) { S.project = null; S.chapter = null; go('library'); }
      else if (!S.chapter || !S.chapters.some((c) => c.id === S.chapter.id)) loadChapter(S.chapters[0].id);
    }
  }
  renderLibrary();
  if (S.view === 'bible') renderBible();
  if (S.view === 'editor' && S.project) renderChapterDrawer();
}

async function runSync({ direction = 'both', silent = false } = {}) {
  await saveSyncForm();
  const cfg = S.syncCfg;
  const btn = $('btnSyncNow');
  if (!readyToSync(cfg)) {
    const msg = `请先填写${cfg.provider === 'gist' ? ' GitHub Token' : cfg.provider === 'worker' ? ' 同步地址和房间号' : ' WebDAV 地址、账号和密码'}`;
    if (!silent) { toast(msg); go('settings'); }
    return null;
  }
  await saveChapter();
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '同步中…';
  updateSyncStatus('正在同步…');
  try {
    const r = await syncNow(cfg, { direction, onStep: (s) => updateSyncStatus('正在同步：' + s) });
    markSynced();
    renderSync();
    await reloadFromDB();
    const tail = r.conflicts.length ? `，处理了 ${r.conflicts.length} 处冲突` : '';
    const saved = r.copies.length ? `，另存了 ${r.copies.length} 个冲突副本` : '';
    updateSyncStatus(`✅ 同步完成 · 云端 ${r.projects} 部作品 / ${r.chapters} 章 · ${Math.round(r.bytes / 1024)} KB${tail}${saved} · ${fmtTime(cfg.lastSyncAt)}`);
    if (!silent) toast(`同步完成${tail}${saved}`);
    return r;
  } catch (e) {
    const msg = String(e.message || e);
    updateSyncStatus('✕ 同步失败：' + msg);
    if (!silent) toast(msg.slice(0, 110), 5200);
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function syncGuide() {
  const p = S.syncCfg?.provider || 'gist';
  const body = {
    gist: `
      <h3>用 GitHub 同步（推荐）</h3>
      <p class="small">
      <b>① 生成一个令牌（只做一次）</b><br>
      手机或电脑浏览器打开 <a href="https://github.com/settings/tokens/new" target="_blank" rel="noopener">github.com/settings/tokens/new</a>（需先登录 GitHub 账号）<br>
      · Note 随便写，例如「墨阁同步」<br>
      · Expiration 建议选 <b>No expiration</b>（选 90 天的话到期要重新生成）<br>
      · 权限<b>只勾 <code>gist</code> 这一项</b>，其他一律不要勾<br>
      · 拉到底点 <b>Generate token</b><br>
      · 复制出现的 <code>ghp_...</code> —— <b>这串只显示这一次</b>
      </p>
      <p class="small">
      <b>② 填进墨阁</b><br>
      同步方式选「GitHub Gist」→ GitHub Token 粘贴 →<b> Gist ID 留空</b> → 点「测试连接」<br>
      显示「Token 有效（你的用户名）」就说明通了
      </p>
      <p class="small">
      <b>③ 第一次同步</b><br>
      点「立即同步」，会自动在你的 GitHub 里建一个 <b>secret（不公开列出）Gist</b> 存这本书库。<br>
      同步完成后，上面「Gist ID」那一栏会<b>自动填上一串字符，请把它记下来</b>。
      </p>
      <p class="small">
      <b>④ 另一台设备（手机 ↔ 电脑）</b><br>
      用同一个网址打开墨阁 → 我的 → 云同步 → 填<b>同一个 Token</b> 和<b>同一个 Gist ID</b> → 测试连接 → 立即同步。<br>
      之后每次写完点一下「立即同步」即可；想让它自己同步就把「自动同步」打开。
      </p>
      <p class="muted tiny">
      · Token 只保存在本机浏览器里，只会发给 api.github.com，不会经过任何第三方服务器<br>
      · 只勾了 gist 权限，就算令牌泄露也动不了你的代码仓库；不用了去 <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a> 删掉即可<br>
      · 云端就是你 GitHub 里的一个 Gist，文件名叫 <code>moge-sync.json</code>，请不要手动改它<br>
      · ⚠️ Gist 的 secret 只是"不公开列出"，<b>知道链接的人就能看到内容</b>——别把 Gist 链接发给别人；<br>
      &nbsp;&nbsp;&nbsp;想真正私有请改用「自建同步端点」或「WebDAV」
      </p>`,
    worker: `
      <h3>用自建 Worker 同步</h3>
      <p class="small">
      <b>① 部署 Worker（只做一次）</b><br>
      按 README 第二节 ① 把 <code>proxy/cloudflare-worker.js</code> 部署到 Cloudflare（免费）。<br>
      想用同步还需：控制台 → Storage &amp; Databases → KV → 建一个命名空间 →
      回到 Worker → Settings → Bindings → 添加 KV Namespace，<b>变量名必须填 MOGE_KV</b> → 重新部署。
      </p>
      <p class="small">
      <b>② 验证</b><br>
      浏览器打开 <code>https://你的worker.workers.dev/health</code>，看到 <code>{"ok":true,"kv":true}</code> 就绑好了。
      </p>
      <p class="small">
      <b>③ 填进墨阁</b><br>
      同步地址填 <code>https://你的worker.workers.dev</code>（结尾不加 <code>?url=</code>）<br>
      房间号点 🎲 生成一个，<b>多台设备必须填一模一样的房间号</b>；Worker 设了 TOKEN 就填进「访问令牌」。<br>
      点「测试连接」→「立即同步」。
      </p>
      <p class="muted tiny">这个 Worker 同时还能当 AI 接口的 CORS 代理用，一个部署两用。</p>`,
    webdav: `
      <h3>用 WebDAV（坚果云等）同步</h3>
      <p class="small">
      <b>① 拿应用密码</b><br>
      坚果云网页端 → 头像 → 账户信息 → 安全选项 → <b>添加应用密码</b>，记下这串密码（不是登录密码）。
      </p>
      <p class="small">
      <b>② 建个文件夹</b><br>
      在坚果云里新建文件夹「墨阁」，文件地址就是：<br>
      <code>https://dav.jianguoyun.com/dav/墨阁/moge-sync.json</code><br>
      （最后一段是文件名，墨阁会自己创建）
      </p>
      <p class="small">
      <b>③ 必须填 CORS 代理</b><br>
      坚果云不允许网页直连。把 README 第二节 ① 的 Worker 部署好，代理地址填：<br>
      <code>https://你的worker.workers.dev/?url=</code>
      </p>
      <p class="small">
      <b>④ 填进墨阁</b><br>
      WebDAV 地址 + 坚果云登录邮箱 + 应用密码 + 代理地址 → 测试连接 → 立即同步。<br>
      另一台设备填完全一样的内容即可。
      </p>`,
  }[p];
  openModal(`${body}
    <div class="btn-row"><button class="btn btn-primary" data-close="1">知道了</button></div>`);
}

async function testSync() {  await saveSyncForm();
  const btn = $('btnSyncTest');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '测试中…';
  try {
    const msg = await remoteTest(S.syncCfg);
    updateSyncStatus('✅ ' + msg);
    toast(msg.slice(0, 110), 4200);
  } catch (e) {
    updateSyncStatus('✕ ' + String(e.message || e));
    toast(String(e.message || e).slice(0, 110), 5200);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------------- AI 生成 ---------------- */
function renderActions() {
  const box = $('aiActions');
  box.innerHTML = '';
  for (const a of ACTIONS) {
    const b = el('button', 'chip' + (a.id === S.gen.action ? ' active' : ''), `${a.icon} ${esc(a.label)}`);
    b.addEventListener('click', () => {
      S.gen.action = a.id;
      renderActions();
      $('aiInstruction').placeholder = a.hint + '（可留空）';
    });
    box.appendChild(b);
  }
}

function openAI() {
  if (!S.project) { toast('先打开一本书'); return; }
  renderActions();
  $('aiModelTag').textContent = (S.settings.model || '未配置模型') + ' · ' + (PROVIDERS[S.settings.provider]?.label || '');
  $('aiSheet').hidden = false;
  $('aiMask').hidden = false;
  updateSelTip();
  $('aiStatus').textContent = S.settings.apiKey ? '' : '⚠ 还没有填写 API Key，请到「我的」里配置。';
}
function closeAI() { $('aiSheet').hidden = true; $('aiMask').hidden = true; }

function outText() { return $('aiOutput').value; }
function setOut(t) { $('aiOutput').value = t; $('aiOutput').scrollTop = $('aiOutput').scrollHeight; }

async function generate({ continueFromPrev = false } = {}) {
  const st = S.settings;
  const isLocal = /localhost|127\.0\.0\.1/.test(st.baseUrl || '');
  if (!st.apiKey && !isLocal) { toast('请先在「我的」里填写 API 接口和 Key'); closeAI(); go('settings'); return; }
  if (!st.baseUrl || !st.model) { toast('请先填写接口地址和模型名'); closeAI(); go('settings'); return; }
  if (!S.chapter) { toast('先选择一个章节'); return; }

  await saveChapter();
  const action = getAction(S.gen.action);
  const instruction = $('aiInstruction').value.trim();
  const sel = selText();
  const chapterText = $('editor').value;

  let target = '';
  if (action.need === 'selection') {
    target = sel || chapterText;
    if (!target.trim()) { toast('先写一点内容，或选中要处理的文字'); return; }
    if (target.length > 6000) target = target.slice(-6000);
  }

  const context = buildContext({
    project: S.project,
    chapters: S.chapters,
    current: { ...S.chapter, content: chapterText },
    ctxChars: Number(st.contextChars) || 6000,
  });
  const built = action.build({ context, project: S.project, instruction, selection: sel, target, current: S.chapter });

  let messages;
  if (continueFromPrev && S.gen.history.length) {
    messages = [
      ...S.gen.history,
      { role: 'assistant', content: outText() },
      { role: 'user', content: '继续往下写，直接从断掉的地方接着写，不要重复上面的内容。' },
    ];
  } else {
    messages = [{ role: 'user', content: built.user }];
    S.gen.history = [{ role: 'user', content: built.user }];
  }

  const btn = $('btnGenerate');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 生成中…';
  $('btnStopGen').hidden = false;
  $('btnContinueGen').hidden = true;
  S.gen.controller = new AbortController();
  S.gen.running = true;
  if (!continueFromPrev) setOut('');
  const base = outText();
  $('aiStatus').textContent = `${action.label} · 请求中…`;
  const t0 = Date.now();

  let out = base;
  let received = 0;
  try {
    const text = await streamChat(
      settingsCfg({ system: built.system, messages, stream: st.stream !== false }),
      (delta) => {
        out += delta;
        received += delta.length;
        $('aiOutput').value = out;
        $('aiOutput').scrollTop = $('aiOutput').scrollHeight;
        $('aiStatus').textContent = `${action.label} · 已生成 ${countWords(out)} 字…`;
      },
      S.gen.controller.signal
    );
    if (!received && text) { out = base + text; received = text.length; }
    if (!received) {
      $('aiStatus').textContent = '⚠ 没有收到任何内容：该模型可能不支持流式输出，请到「我的」把「流式输出」改为关闭，或换一个模型再试。';
      toast('没有收到内容，试试关闭流式输出', 4500);
      return;
    }
    $('aiStatus').textContent = `✓ ${action.label} 完成 · ${countWords(out)} 字 · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    S.gen.history.push({ role: 'assistant', content: out });
    if (action.id === 'summary' && S.chapter) {
      S.chapter.summary = out.trim().slice(0, 400);
      await db.put('chapters', S.chapter);
      renderSummaries();
      $('aiStatus').textContent += '  已自动存入本章摘要';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      $('aiStatus').textContent = '已停止。' + (out ? `（已生成 ${countWords(out)} 字）` : '');
    } else {
      const msg = String(e.message || e);
      $('aiStatus').textContent = '✕ ' + msg;
      toast(msg.slice(0, 90), 4200);
    }
  } finally {
    S.gen.running = false;
    S.gen.controller = null;
    btn.disabled = false;
    btn.textContent = '开始生成';
    $('btnStopGen').hidden = true;
    $('btnContinueGen').hidden = !(outText().trim().length > 0);
  }
}

function stopGen() {
  if (S.gen.controller) S.gen.controller.abort();
}

async function insertOut(mode) {
  const text = outText().trim();
  if (!text) return toast('还没有可插入的内容');
  if (!S.chapter) return;
  const ed = $('editor');
  let value = ed.value;
  let caret = null;
  if (mode === 'end') {
    value = value.replace(/\s+$/, '');
    value = (value ? value + '\n\n' : '') + text + '\n';
    caret = value.length;
  } else if (mode === 'cursor') {
    const p = S.sel.end || ed.value.length;
    value = ed.value.slice(0, p) + (ed.value.slice(0, p).endsWith('\n') ? '' : '\n\n') + text + ed.value.slice(p);
    caret = p + text.length + 2;
  } else if (mode === 'replace') {
    const { start, end } = S.sel;
    if (end <= start) return toast('没有选中文字');
    value = ed.value.slice(0, start) + text + ed.value.slice(end);
    caret = start + text.length;
  }
  ed.value = value;
  if (caret != null) { ed.focus(); ed.setSelectionRange(caret, caret); S.sel = { start: caret, end: caret }; }
  markDirty();
  await saveChapter();
  toast('已写入正文');
  closeAI();
}

/* ---------------- 导出 / 备份 ---------------- */
function chaptersOf(pid) {
  return S.allChapters.filter((c) => c.projectId === pid).sort((a, b) => a.order - b.order);
}

function projectToText(p, { md = false } = {}) {
  const chs = chaptersOf(p.id);
  const lines = [];
  if (md) {
    lines.push(`# ${p.title || '未命名'}`);
    if (p.genre) lines.push(`> 题材：${p.genre}`);
    if (p.synopsis) lines.push(`> ${p.synopsis}`);
    lines.push('');
    chs.forEach((c, i) => { lines.push(`## 第${i + 1}章 ${c.title || ''}`, '', c.content || '', ''); });
  } else {
    lines.push(`《${p.title || '未命名'}》`);
    if (p.genre || p.synopsis) lines.push([p.genre, p.synopsis].filter(Boolean).join('｜'));
    lines.push('');
    chs.forEach((c, i) => {
      lines.push('', `第${i + 1}章　${c.title || ''}`, '');
      lines.push(c.content || '');
    });
  }
  return lines.join('\n');
}

function exportProject(p, kind) {
  if (!p) return;
  const chs = chaptersOf(p.id);
  if (!chs.some((c) => (c.content || '').trim())) { toast('这本还没有内容'); return; }
  const body = projectToText(p, { md: kind === 'md' });
  download(`${safeName(p.title)}.${kind === 'md' ? 'md' : 'txt'}`, body, kind === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8');
  toast('已导出，请在通知栏/下载里查看');
}

function exportAllTxt() {
  const body = S.projects.map((p) => projectToText(p, { md: false })).join('\n\n\n' + '='.repeat(30) + '\n\n\n');
  if (!body.trim()) return toast('还没有内容');
  download('墨阁全部作品.txt', body);
  toast('已导出全部作品');
}

async function backup() {
  const chapters = await db.all('chapters');
  const projects = await db.all('projects');
  const settings = { ...S.settings };
  const data = { app: 'moge-novel', version: 1, exportedAt: new Date().toISOString(), projects, chapters, settings };
  download(`墨阁备份_${todayKey()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('备份已生成（含 API Key，请妥善保管）');
}

function restoreFrom(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(String(reader.result)); } catch (e) { return toast('文件不是合法的 JSON'); }
    if (!data || !Array.isArray(data.projects)) return toast('这不是墨阁的备份文件');
    const ok = await askConfirm('恢复备份', `将导入 ${data.projects.length} 部作品、${(data.chapters || []).length} 个章节，并覆盖当前全部数据。`, '覆盖导入');
    if (!ok) return;
    await db.clear('projects'); await db.clear('chapters');
    for (const p of data.projects) await db.put('projects', p);
    for (const c of data.chapters || []) await db.put('chapters', c);
    if (data.settings) { S.settings = { ...DEFAULT_SETTINGS, ...data.settings }; await db.setKV('settings', S.settings); }
    toast('恢复完成，正在重新载入…');
    setTimeout(() => location.reload(), 900);
  };
  reader.readAsText(file, 'utf-8');
}

/* ---------------- 安装 ---------------- */
function updateInstallUI() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const btn = $('btnInstall');
  const state = $('installState');
  if (standalone) {
    btn.disabled = true;
    btn.textContent = '已安装 ✓';
    state.textContent = '当前已经是以 App 模式运行。';
    return;
  }
  if (S.deferredPrompt) {
    btn.disabled = false;
    btn.textContent = '安装到主屏幕';
    state.textContent = '点击后会弹出 Chrome 的安装确认框。';
  } else {
    btn.disabled = true;
    btn.textContent = '安装到主屏幕';
    state.textContent = isSecureContext
      ? '若按钮不可点：在 Chrome 右上角「⋮」→「添加到主屏幕 / 安装应用」。'
      : '当前不是 HTTPS/localhost 环境，Chrome 不允许安装。请用 https 打开本页，或从 Chrome 菜单选「添加到主屏幕」。';
  }
}

async function doInstall() {
  if (!S.deferredPrompt) { toast('请用 Chrome 菜单「⋮ → 安装应用 / 添加到主屏幕」'); return; }
  S.deferredPrompt.prompt();
  const { outcome } = await S.deferredPrompt.userChoice;
  S.deferredPrompt = null;
  toast(outcome === 'accepted' ? '安装中…请看系统提示' : '已取消安装');
  updateInstallUI();
}

function helpModal() {
  openModal(`
    <h3>使用说明</h3>
    <p class="small">
    1. <b>新建作品</b>：书架 →「＋ 新书」。<br>
    2. <b>配置 AI</b>：我的 → AI 接口，选服务商、粘贴 API Key、点「测试连接」。<br>
    3. <b>让 AI 帮你写</b>：写作页点右上角 ✦ → 选「续写 / 润色 / 大纲…」→ 开始生成；生成的内容可先修改，再「追加到本章末尾」。<br>
    4. <b>记住前情</b>：在设定页写下世界观、角色卡；每写完一章可用「章节摘要」动作生成摘要并保存，AI 就不会前后矛盾。<br>
    5. <b>多设备同步</b>：我的 → 云同步，选一种云端（推荐 GitHub Gist），填好点「立即同步」。手机和电脑连同一个云端就能接着写；同一章两端都改过时会保留较新的，另一份自动存成「冲突副本」，不会丢字。<br>
    6. <b>导出</b>：我的 → 数据，可导出 TXT / Markdown；建议常做 JSON 备份。<br>
    7. <b>安装</b>：Chrome 菜单「⋮ → 安装应用」，之后可从桌面图标直接打开，离线也能写。
    </p>
    <div class="btn-row"><button class="btn btn-primary" data-close="1">知道了</button></div>
  `);
}

/* ---------------- 事件绑定 ---------------- */
function bindGlobal() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { saveChapter(); go(t.dataset.view); }));
  $('btnBack').addEventListener('click', () => { saveChapter(); go('library'); });
  $('btnFocus').addEventListener('click', () => {
    document.body.classList.toggle('focus');
    $('btnFocus').textContent = document.body.classList.contains('focus') ? '⤡' : '⛶';
    toast(document.body.classList.contains('focus') ? '已进入专注模式，点右上角 ⤡ 退出' : '已退出专注模式');
  });

  // 书架
  $('btnNewProject').addEventListener('click', createProject);
  $('btnNewProject2').addEventListener('click', createProject);

  // 编辑器
  const ed = $('editor');
  ed.addEventListener('input', () => { markDirty(); updateCounts(); });
  ed.addEventListener('select', recordSel);
  ed.addEventListener('keyup', recordSel);
  ed.addEventListener('mouseup', recordSel);
  ed.addEventListener('blur', recordSel);
  $('chapterTitle').addEventListener('input', markDirty);
  $('chapterTitle').addEventListener('blur', saveChapter);
  $('btnChapters').addEventListener('click', openDrawer);
  $('btnCloseDrawer').addEventListener('click', closeDrawer);
  $('drawerMask').addEventListener('click', closeDrawer);
  $('btnDrawerOrder').addEventListener('click', () => { S.timeline = S.timeline === 'desc' ? 'asc' : 'desc'; renderChapterDrawer(); });
  $('btnAddChapter').addEventListener('click', addChapter);
  $('btnAddChapter2').addEventListener('click', addChapter);
  $('btnPrevChapter').addEventListener('click', () => stepChapter(-1));
  $('btnNextChapter').addEventListener('click', () => stepChapter(1));
  $('btnAIContext').addEventListener('click', openAI);

  // 设定
  const bindP = (id, field, num) => $(id).addEventListener('input', () => {
    if (!S.project) return;
    S.project[field] = num ? Number($(id).value) || 0 : $(id).value;
    saveProjectSoon();
    if (id === 'setTitle') $('topTitle').textContent = S.project.title || '写作';
  });
  bindP('setTitle', 'title');
  bindP('setGenre', 'genre');
  bindP('setSynopsis', 'synopsis');
  bindP('setWorld', 'world');
  bindP('setStyle', 'style');
  bindP('setGoal', 'goal', true);
  bindP('setChunk', 'chunk', true);
  $('setPov').addEventListener('change', () => { if (S.project) { S.project.pov = $('setPov').value; saveProjectSoon(); } });
  $('btnAddChar').addEventListener('click', () => {
    if (!S.project) return;
    S.project.characters = S.project.characters || [];
    S.project.characters.push({ name: '', role: '', traits: '', goal: '', desc: '' });
    saveProjectSoon(); renderChars();
  });

  // AI 面板
  $('btnAI').addEventListener('click', openAI);
  $('btnCloseAI').addEventListener('click', closeAI);
  $('aiMask').addEventListener('click', closeAI);
  $('btnGenerate').addEventListener('click', () => generate());
  $('btnStopGen').addEventListener('click', stopGen);
  $('btnContinueGen').addEventListener('click', () => generate({ continueFromPrev: true }));
  $('btnInsertEnd').addEventListener('click', () => insertOut('end'));
  $('btnInsertCursor').addEventListener('click', () => insertOut('cursor'));
  $('btnReplaceSel').addEventListener('click', () => insertOut('replace'));
  $('btnCopyOut').addEventListener('click', async () => {
    const t = outText();
    if (!t) return toast('没有内容');
    try { await navigator.clipboard.writeText(t); toast('已复制'); }
    catch (e) { $('aiOutput').select(); toast('已全选，长按复制即可'); }
  });
  $('btnClearOut').addEventListener('click', () => { setOut(''); $('btnContinueGen').hidden = true; });
  $('btnSaveSummary').addEventListener('click', async () => {
    const t = outText().trim();
    if (!t || !S.chapter) return toast('没有内容');
    S.chapter.summary = t.slice(0, 400);
    await db.put('chapters', S.chapter);
    renderSummaries();
    toast('已存为本章摘要');
  });

  // 设置
  $('cfgProvider').addEventListener('change', () => {
    const key = $('cfgProvider').value;
    const pv = PROVIDERS[key];
    if (pv) {
      if (pv.baseUrl) $('cfgBaseUrl').value = pv.baseUrl;
      if (pv.model) $('cfgModel').value = pv.model;
      $('cfgApiKey').placeholder = pv.keyHint || 'sk-...';
      const dl = $('modelList'); dl.innerHTML = '';
      for (const m of pv.models || []) { const o = el('option'); o.value = m; dl.appendChild(o); }
    }
    readSettingsForm();
  });
  ['cfgBaseUrl', 'cfgModel', 'cfgStream', 'cfgContext', 'cfgMaxTokens', 'cfgSystem', 'cfgProxy', 'cfgHeaders', 'cfgBreak']
    .forEach((id) => $(id).addEventListener('change', readSettingsForm));
  $('cfgApiKey').addEventListener('change', readSettingsForm);
  $('cfgTemp').addEventListener('input', () => { $('tempVal').textContent = $('cfgTemp').value; });
  $('cfgTemp').addEventListener('change', readSettingsForm);
  $('cfgFontSize').addEventListener('input', () => { $('fontVal').textContent = $('cfgFontSize').value; S.settings.fontSize = Number($('cfgFontSize').value); applyTypography(); });
  $('cfgFontSize').addEventListener('change', readSettingsForm);
  $('cfgLineHeight').addEventListener('input', () => { $('lhVal').textContent = $('cfgLineHeight').value; S.settings.lineHeight = Number($('cfgLineHeight').value); applyTypography(); });
  $('cfgLineHeight').addEventListener('change', readSettingsForm);
  $('btnToggleKey').addEventListener('click', () => {
    const i = $('cfgApiKey');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('btnToggleKey').textContent = i.type === 'password' ? '👁' : '🙈';
  });
  $('btnSaveAI').addEventListener('click', async () => { await readSettingsForm(); toast('已保存'); });
  $('btnTestAI').addEventListener('click', async () => {
    await readSettingsForm();
    const btn = $('btnTestAI');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 测试中…';
    try {
      const reply = await testConnection(settingsCfg());
      toast('连接成功，模型回复：' + (reply || '(空)'), 4000);
    } catch (e) {
      toast('失败：' + String(e.message || e).slice(0, 120), 5000);
    } finally { btn.disabled = false; btn.textContent = '测试连接'; }
  });
  $('btnListModels').addEventListener('click', async () => {
    await readSettingsForm();
    const btn = $('btnListModels');
    btn.disabled = true; btn.textContent = '…';
    try {
      const list = await fetchModels(settingsCfg());
      const dl = $('modelList'); dl.innerHTML = '';
      for (const m of list) { const o = el('option'); o.value = m; dl.appendChild(o); }
      if (list.length) {
        toast(`拉取到 ${list.length} 个模型，点模型输入框选一个`);
        openModal(`<h3>可用模型（${list.length}）</h3><div style="max-height:50vh;overflow:auto" class="small">${list.slice(0, 200).map(esc).join('<br>')}</div>
          <div class="btn-row"><button class="btn btn-primary" data-close="1">关闭</button></div>`);
      } else toast('没有拉到模型，请检查 Key 权限');
    } catch (e) { toast('拉取失败：' + String(e.message || e).slice(0, 120), 5000); }
    finally { btn.disabled = false; btn.textContent = '⇩'; }
  });

  // 云同步
  $('syncProvider').addEventListener('change', async () => {
    S.syncCfg.provider = $('syncProvider').value;
    await saveSyncConfig(S.syncCfg);
    renderSync();
  });
  $('syncAuto').addEventListener('change', () => saveSyncForm());
  $('btnSyncNow').addEventListener('click', () => runSync());
  $('btnSyncTest').addEventListener('click', testSync);
  $('btnSyncGuide').addEventListener('click', syncGuide);
  $('btnSyncPush').addEventListener('click', () => runSync({ direction: 'push' }));
  $('btnSyncPull').addEventListener('click', async () => {
    await saveSyncForm();
    if (!readyToSync(S.syncCfg)) return toast('请先填完同步配置');
    const ok = await askConfirm('仅下载覆盖本机', '会用云端数据覆盖本机全部作品（本机独有的作品会被删除）。确定继续吗？', '覆盖本机');
    if (ok) runSync({ direction: 'pull' });
  });
  $('btnSyncReset').addEventListener('click', async () => {
    if (!(await askConfirm('重置同步基线', '重置后下一次同步会当作全新设备做一次完整比对（不会删数据，只会多一次全量上传）。', '重置'))) return;
    await resetSyncBaseline();
    toast('已重置，下次同步会重新全量比对');
  });

  // 数据
  $('btnExportTxt').addEventListener('click', () => exportProject(S.project, 'txt'));
  $('btnExportMd').addEventListener('click', () => exportProject(S.project, 'md'));
  $('btnExportAll').addEventListener('click', exportAllTxt);
  $('btnBackup').addEventListener('click', backup);
  $('btnRestore').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) restoreFrom(f); e.target.value = ''; });
  $('btnHelp').addEventListener('click', helpModal);
  $('modalMask').addEventListener('click', (e) => { if (e.target === $('modalMask')) closeModal(); });
  document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

  // 安装
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.deferredPrompt = e; updateInstallUI(); });
  window.addEventListener('appinstalled', () => { S.deferredPrompt = null; toast('安装成功，可以从桌面图标打开了'); updateInstallUI(); });
  $('btnInstall').addEventListener('click', doInstall);
  updateInstallUI();

  // 保存时机
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveChapter();
      if (hasPendingSync() && S.syncCfg?.enabled) runSync({ silent: true });
    }
  });
  window.addEventListener('beforeunload', () => { if (dirty) { try { saveChapter(); } catch (e) {} } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveChapter().then(() => toast('已保存')); }
    if (e.key === 'Escape') { if (!$('aiSheet').hidden) closeAI(); else if (!$('drawer').hidden) closeDrawer(); else if (!$('modalMask').hidden) closeModal(); }
  });
}

window.MOGE = { S, db, countWords, buildContext, runSync, reloadFromDB, renderSync };

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#f88;padding:12px;white-space:pre-wrap">启动失败：${esc(e && e.stack || e)}</pre>`);
});
