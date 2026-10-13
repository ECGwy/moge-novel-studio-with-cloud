/* ================= IndexedDB 数据层 ================= */
const DB_NAME = 'moge-novel';
const DB_VER = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('projects')) {
        d.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('chapters')) {
        const s = d.createObjectStore('chapters', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId', { unique: false });
      }
      if (!d.objectStoreNames.contains('kv')) {
        d.createObjectStore('kv', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then((d) => d.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  async all(store) { return wrap((await tx(store, 'readonly')).getAll()); },
  async get(store, key) { return wrap((await tx(store, 'readonly')).get(key)); },
  async put(store, value) { return wrap((await tx(store, 'readwrite')).put(value)); },
  async del(store, key) { return wrap((await tx(store, 'readwrite')).delete(key)); },
  async clear(store) { return wrap((await tx(store, 'readwrite')).clear()); },
  async byProject(projectId) {
    const os = await tx('chapters', 'readonly');
    return wrap(os.index('projectId').getAll(IDBKeyRange.only(projectId)));
  },
  async getKV(k, fallback = null) {
    const row = await this.get('kv', k);
    return row ? row.v : fallback;
  },
  async setKV(k, v) { return this.put('kv', { k, v }); },
};

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* 中文优先的字数统计：汉字按字计，英文按词计 */
export function countWords(text) {
  if (!text) return 0;
  const cn = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ');
  const en = (rest.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cn + en;
}

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
