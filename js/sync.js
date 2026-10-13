/* ================= 云同步 =================
 * 思路：整库快照 + 逐条三路合并（本地 / 远端 / 上次同步基线）
 *   - 只有一边改动 → 用改动的那边
 *   - 两边都改   → 保留较新的，旧的那份存成「冲突副本」，一个字都不丢
 *   - 删除用 tombstone（墓碑）记录，避免删除被另一端"复活"
 * 传输：JSON（有 CompressionStream 时 gzip+base64，体积约 1/8）
 */
import { db, uid } from './db.js';
import { viaProxy } from './providers.js';

export const SYNC_FILE = 'moge-sync.json';
const GZ_PREFIX = 'MOGE-GZ1:';
const TOMB_KEEP_MS = 90 * 24 * 3600 * 1000;

export const SYNC_PROVIDERS = {
  gist: {
    label: 'GitHub Gist（浏览器可直连，推荐）',
    hint: '需要一个带 gist 权限的 GitHub Token。Gist ID 留空即可，第一次同步会自动创建私有 Gist。',
    fields: ['gistToken', 'gistId'],
    advanced: ['gistApi'],
  },
  worker: {
    label: '自建同步端点（Cloudflare Worker + KV）',
    hint: '免费、不依赖第三方账号。多台设备填同一个「同步地址」和「房间号」即可。部署见 README 方式 C。',
    fields: ['endpoint', 'room', 'token'],
  },
  webdav: {
    label: 'WebDAV（坚果云 / Nextcloud / 群晖）',
    hint: '坚果云等不接受浏览器直连，必须填下面的 CORS 代理地址（可用自建 Worker 或本机 server.mjs）。',
    fields: ['davUrl', 'davUser', 'davPass', 'davProxy'],
  },
};

export const DEFAULT_SYNC = {
  enabled: false,
  provider: 'gist',
  autoMinutes: 5,
  endpoint: '',
  room: '',
  token: '',
  gistToken: '',
  gistId: '',
  gistApi: 'https://api.github.com',
  davUrl: '',
  davUser: '',
  davPass: '',
  davProxy: '',
  deviceId: '',
  lastSyncAt: 0,
  lastResult: '',
};

/* ---------------- 配置 ---------------- */
export async function loadSyncConfig() {
  const saved = await db.getKV('syncConfig', null);
  const cfg = { ...DEFAULT_SYNC, ...(saved || {}) };
  if (!cfg.deviceId) {
    cfg.deviceId = uid('dev');
    cfg.deviceName = guessDeviceName();
    await db.setKV('syncConfig', cfg);
  }
  if (!cfg.deviceName) cfg.deviceName = guessDeviceName();
  return cfg;
}
export async function saveSyncConfig(cfg) {
  await db.setKV('syncConfig', cfg);
  return cfg;
}
function guessDeviceName() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad/i.test(ua) ? 'iPhone'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS/i.test(ua) ? 'Mac'
    : '设备';
  return os + '-' + Math.random().toString(36).slice(2, 5);
}

/* ---------------- 本地库 ---------------- */
export async function libraryFromDB() {
  return {
    projects: await db.all('projects'),
    chapters: await db.all('chapters'),
    tombstones: await db.getKV('tombstones', []),
  };
}

export async function addTombstone(type, id, projectId) {
  const list = await db.getKV('tombstones', []);
  if (!list.some((t) => t.type === type && t.id === id)) {
    list.push({ type, id, projectId: projectId || '', deletedAt: Date.now() });
    await db.setKV('tombstones', list);
  }
}

export async function applyLibrary(merged) {
  const keepP = new Set(merged.projects.map((p) => p.id));
  const keepC = new Set(merged.chapters.map((c) => c.id));
  for (const p of await db.all('projects')) if (!keepP.has(p.id)) await db.del('projects', p.id);
  for (const c of await db.all('chapters')) if (!keepC.has(c.id)) await db.del('chapters', c.id);
  for (const p of merged.projects) await db.put('projects', p);
  for (let i = 0; i < merged.chapters.length; i += 50) {
    await Promise.all(merged.chapters.slice(i, i + 50).map((c) => db.put('chapters', c)));
  }
  await db.setKV('tombstones', merged.tombstones);
}

/* ---------------- 打包 / 解包 ---------------- */
export async function packLibrary(lib, cfg) {
  const snap = {
    app: 'moge-novel',
    schema: 2,
    savedAt: Date.now(),
    device: cfg?.deviceName || '',
    projects: lib.projects,
    chapters: lib.chapters,
    tombstones: lib.tombstones || [],
  };
  const json = JSON.stringify(snap);
  const gz = await gzipB64(json);
  return gz ? GZ_PREFIX + gz : json;
}

export async function unpackLibrary(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  let json = s;
  if (s.startsWith(GZ_PREFIX)) json = await gunzipB64(s.slice(GZ_PREFIX.length));
  const snap = JSON.parse(json);
  if (!snap || !Array.isArray(snap.projects)) throw new Error('云端数据格式不正确，可能不是墨阁的同步文件');
  return {
    projects: snap.projects || [],
    chapters: snap.chapters || [],
    tombstones: snap.tombstones || [],
    savedAt: snap.savedAt || 0,
    device: snap.device || '',
  };
}

function b64encode(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function gzipB64(text) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return b64encode(new Uint8Array(buf));
  } catch (e) { return null; }
}
async function gunzipB64(b64) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([b64decode(b64)]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

/* ---------------- 三路合并 ---------------- */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
    return o;
  }
  return v;
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function mergeCollection(type, localArr, remoteArr, baseArr, report) {
  const L = new Map(localArr.map((x) => [x.id, x]));
  const R = new Map(remoteArr.map((x) => [x.id, x]));
  const B = new Map(baseArr.map((x) => [x.id, x]));
  const out = new Map();
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id), r = R.get(id), b = B.get(id);
    if (l && r) {
      if (same(l, r)) { out.set(id, l); continue; }
      const lc = !same(l, b), rc = !same(r, b);
      if (lc && rc) {
        const keepLocal = (l.updatedAt || 0) >= (r.updatedAt || 0);
        const keep = keepLocal ? l : r, lose = keepLocal ? r : l;
        out.set(id, keep);
        report.conflicts.push({ type, id, title: keep.title || keep.name || id, device: keepLocal ? '本机' : '云端' });
        if (type === 'chapter') {
          const copy = {
            ...lose,
            id: uid('c'),
            title: `${lose.title || '未命名'}（冲突副本 ${stamp()}）`,
            updatedAt: Date.now(),
          };
          out.set(copy.id, copy);
          report.copies.push(copy.title);
        }
      } else if (lc) out.set(id, l);
      else if (rc) out.set(id, r);
      else out.set(id, (l.updatedAt || 0) >= (r.updatedAt || 0) ? l : r);
      continue;
    }
    if (l && !r) {
      if (b && same(l, b)) { report.removed.push(id); continue; }      // 云端已删，接受
      out.set(id, l);
      if (b) report.conflicts.push({ type, id, title: l.title || id, device: '云端已删，本机有改动，已保留' });
      continue;
    }
    if (!l && r) {
      if (b && same(r, b)) { report.removed.push(id); continue; }      // 本机已删，接受
      out.set(id, r);
      if (b) report.conflicts.push({ type, id, title: r.title || id, device: '本机已删，云端有改动，已恢复' });
    }
  }
  return [...out.values()];
}

export function mergeLibs(local, remote, baseline) {
  const report = { added: 0, conflicts: [], copies: [], removed: [] };
  const base = baseline || { projects: [], chapters: [], tombstones: [] };
  const projects = mergeCollection('project', local.projects, remote.projects, base.projects, report);
  const keepProject = new Set(projects.map((p) => p.id));
  const chapters = mergeCollection('chapter', local.chapters, remote.chapters, base.chapters, report)
    .filter((c) => keepProject.has(c.projectId));

  // 墓碑：取最新的，并把比墓碑旧的记录删掉
  const tombs = new Map();
  for (const t of [...(local.tombstones || []), ...(remote.tombstones || []), ...(base.tombstones || [])]) {
    const k = t.type + ':' + t.id;
    const cur = tombs.get(k);
    if (!cur || (t.deletedAt || 0) > (cur.deletedAt || 0)) tombs.set(k, t);
  }
  const now = Date.now();
  const tombList = [...tombs.values()].filter((t) => now - (t.deletedAt || 0) < TOMB_KEEP_MS);
  const tombP = new Set(tombList.filter((t) => t.type === 'project').map((t) => t.id));
  const tombC = new Set(tombList.filter((t) => t.type === 'chapter').map((t) => t.id));
  const fProjects = projects.filter((p) => !tombP.has(p.id));
  const fChapters = chapters.filter((c) => !tombC.has(c.id) && !tombP.has(c.projectId));

  report.added = fProjects.length + fChapters.length;
  return { merged: { projects: fProjects, chapters: fChapters, tombstones: tombList }, report };
}

/* ---------------- 各后端读写 ---------------- */
function authHeaders(cfg) {
  const h = { 'content-type': 'application/json' };
  if (cfg.token) h.authorization = 'Bearer ' + cfg.token;
  return h;
}
function syncUrl(cfg) {
  const base = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('请先填写同步地址');
  if (!cfg.room) throw new Error('请先填写房间号');
  return `${base}/s/${encodeURIComponent(cfg.room)}`;
}
function basic(user, pass) {
  return 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
}
function davTarget(cfg) {
  if (!cfg.davUrl) throw new Error('请先填写 WebDAV 地址');
  return viaProxy(cfg.davUrl, cfg.davProxy);
}

async function httpErr(r, what) {
  let detail = '';
  try { detail = (await r.text()).slice(0, 200); } catch (e) {}
  const hints = {
    401: '认证失败：Token / 密码不对',
    403: '被拒绝：权限不足，或触发了限流',
    404: '云端地址不存在',
    413: '数据太大，云端拒收',
    422: '云端不接受这份数据',
    429: '请求太频繁，稍后再试',
  };
  return new Error(`[${r.status}] ${what}${hints[r.status] ? '：' + hints[r.status] : ''}${detail ? ' · ' + detail : ''}`);
}
function netErr(e, cfg) {
  if (/failed to fetch|networkerror|load failed/i.test(String(e && e.message))) {
    return new Error('网络请求失败：可能是跨域被拦（CORS）或地址/网络不对。' +
      (cfg.provider === 'webdav' ? 'WebDAV 必须填 CORS 代理地址。' : ''));
  }
  return e instanceof Error ? e : new Error(String(e));
}

export async function remoteRead(cfg) {
  try {
    if (cfg.provider === 'gist') {
      if (!cfg.gistId) return null;
      const api = String(cfg.gistApi || 'https://api.github.com').replace(/\/+$/, '');
      const r = await fetch(`${api}/gists/${encodeURIComponent(cfg.gistId)}`, {
        headers: { authorization: 'Bearer ' + cfg.gistToken, accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      if (r.status === 404) return null;
      if (!r.ok) throw await httpErr(r, '读取 Gist');
      const j = await r.json();
      const f = (j.files || {})[SYNC_FILE] || Object.values(j.files || {})[0];
      if (!f) return null;
      let content = f.content;
      if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
      return await unpackLibrary(content);
    }
    if (cfg.provider === 'worker') {
      const r = await fetch(syncUrl(cfg), { headers: authHeaders(cfg), cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw await httpErr(r, '读取云端');
      return await unpackLibrary(await r.text());
    }
    const r = await fetch(davTarget(cfg), {
      headers: { authorization: basic(cfg.davUser, cfg.davPass) },
      cache: 'no-store',
    });
    if (r.status === 404) return null;
    if (!r.ok) throw await httpErr(r, '读取 WebDAV 文件');
    return await unpackLibrary(await r.text());
  } catch (e) {
    throw netErr(e, cfg);
  }
}

export async function remoteWrite(cfg, payload) {
  try {
    if (cfg.provider === 'gist') {
      const api = String(cfg.gistApi || 'https://api.github.com').replace(/\/+$/, '');
      const headers = {
        authorization: 'Bearer ' + cfg.gistToken,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      };
      if (cfg.gistId) {
        const r = await fetch(`${api}/gists/${encodeURIComponent(cfg.gistId)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ files: { [SYNC_FILE]: { content: payload } } }),
        });
        if (!r.ok) throw await httpErr(r, '更新 Gist');
        return {};
      }
      const r = await fetch(`${api}/gists`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: '墨阁 · 小说同步数据（请勿手动删除）',
          public: false,
          files: { [SYNC_FILE]: { content: payload } },
        }),
      });
      if (!r.ok) throw await httpErr(r, '创建 Gist');
      const j = await r.json();
      return { gistId: j.id };
    }
    if (cfg.provider === 'worker') {
      const r = await fetch(syncUrl(cfg), { method: 'PUT', headers: authHeaders(cfg), body: payload });
      if (!r.ok) throw await httpErr(r, '写入云端');
      return {};
    }
    const r = await fetch(davTarget(cfg), {
      method: 'PUT',
      headers: { authorization: basic(cfg.davUser, cfg.davPass), 'content-type': 'application/json' },
      body: payload,
    });
    if (!r.ok && r.status !== 201 && r.status !== 204) throw await httpErr(r, '写入 WebDAV');
    return {};
  } catch (e) {
    throw netErr(e, cfg);
  }
}

export async function remoteTest(cfg) {
  if (cfg.provider === 'gist') {
    if (!cfg.gistToken) throw new Error('请先填写 GitHub Token');
    const api = String(cfg.gistApi || 'https://api.github.com').replace(/\/+$/, '');
    let r;
    try {
      r = await fetch(`${api}/user`, { headers: { authorization: 'Bearer ' + cfg.gistToken }, cache: 'no-store' });
    } catch (e) { throw netErr(e, cfg); }
    if (!r.ok) throw await httpErr(r, '校验 Token');
    const j = await r.json();
    const has = await remoteRead(cfg).catch(() => null);
    return `Token 有效（${j.login}）${has ? '，云端已有数据：' + has.projects.length + ' 部作品' : '，云端还没有数据，首次同步会自动创建'}`;
  }
  if (cfg.provider === 'worker') {
    const has = await remoteRead(cfg);
    return has ? `已连通，云端有 ${has.projects.length} 部作品 / ${has.chapters.length} 章` : '已连通，云端还是空的';
  }
  await remoteRead(cfg).catch((e) => {
    if (/\[404\]/.test(e.message)) return null;
    throw e;
  });
  return '已连通 WebDAV（文件不存在也没关系，首次同步会创建）';
}

/* ---------------- 一次完整同步 ---------------- */
export async function syncNow(cfg, { direction = 'both', onStep } = {}) {
  const step = (s) => { if (onStep) onStep(s); };
  const local = await libraryFromDB();
  const baseline = await db.getKV('syncBaseline', null) || { projects: [], chapters: [], tombstones: [] };

  step('读取云端…');
  const remote = await remoteRead(cfg);

  let merged, report = { conflicts: [], copies: [], removed: [] };

  if (direction === 'push' || !remote) {
    merged = { projects: local.projects, chapters: local.chapters, tombstones: local.tombstones };
  } else if (direction === 'pull') {
    merged = { projects: remote.projects, chapters: remote.chapters, tombstones: remote.tombstones };
  } else {
    step('合并…');
    const r = mergeLibs(local, remote, baseline);
    merged = r.merged;
    report = r.report;
  }

  step('写入本机…');
  await applyLibrary(merged);

  const payload = await packLibrary(merged, cfg);
  step(`上传中（${Math.round(payload.length / 1024)} KB）…`);
  const res = await remoteWrite(cfg, payload);
  if (res.gistId) cfg.gistId = res.gistId;

  await db.setKV('syncBaseline', merged);
  cfg.lastSyncAt = Date.now();
  cfg.lastResult = report.conflicts.length
    ? `同步完成，${report.conflicts.length} 处冲突已处理`
    : '同步完成';
  await saveSyncConfig(cfg);

  return {
    projects: merged.projects.length,
    chapters: merged.chapters.length,
    bytes: payload.length,
    conflicts: report.conflicts,
    copies: report.copies,
    pulled: remote ? remote.projects.length + remote.chapters.length : 0,
  };
}

/* 解绑：清掉基线，下次同步当新设备处理（不删本地数据） */
export async function resetSyncBaseline() {
  await db.setKV('syncBaseline', null);
}

/* ---------------- 后台同步调度 ----------------
 * 第一次改动时开始计时，到点同步一次；期间继续写不会把计时推后，
 * 否则一直写就一直同步不了。
 */
let timer = null;
let pending = false;
export function scheduleSync(runFn, minutes) {
  if (!minutes) return;
  if (pending) return;                 // 已排队，不重置计时
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => { if (pending) { pending = false; runFn(); } }, minutes * 60 * 1000);
}
export function markSynced() { pending = false; clearTimeout(timer); }
export function hasPendingSync() { return pending; }
