/* 临时目录管理：让测试/截图脚本不再往系统 TEMP 里堆垃圾
 *
 * 背景：无头 Chrome 每次运行都要一个独立的 user-data-dir（约 9~10MB）。
 * 如果 kill 之后立刻删除，Windows 上目录仍被占用，删除会失败并被吞掉，
 * 于是每跑一次就留下一个 10MB 的垃圾目录。
 * 这里统一处理：先等 Chrome 真的退出，再带重试地删；
 * 另外每次启动时顺手清理历史残留（默认只看 2 小时前的，避免误删正在跑的）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'moge-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeProfile(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${tag}-`));
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch (_) {} }
    }
  };
  walk(dir);
  return total;
}

/** 关掉 Chrome 并确保临时目录被删掉。返回是否删干净。 */
export async function killAndClean(child, dir) {
  try { if (child && child.exitCode === null) child.kill(); } catch (_) {}
  // 等进程真正退出（最多 5 秒）
  for (let i = 0; i < 50; i++) {
    if (!child || child.exitCode !== null || child.signalCode) break;
    await sleep(100);
  }
  await sleep(400);
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
    catch (_) { await sleep(500); }
  }
  console.log(`  ⚠️  临时目录没删掉（可能仍被占用），下次启动会自动清理：${dir}`);
  return false;
}

/** 清理历史残留：只删自己造的、且超过 maxAgeMs 没动过的目录 */
export function sweepStaleProfiles(maxAgeMs = 2 * 3600 * 1000) {
  let count = 0, bytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch (_) { return { count, bytes }; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    const p = path.join(os.tmpdir(), e.name);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs < maxAgeMs) continue;
      const size = dirSize(p);
      fs.rmSync(p, { recursive: true, force: true });
      count++; bytes += size;
    } catch (_) {}
  }
  return { count, bytes };
}

/** 在脚本开头调用：清残留并打印一行结果 */
export function announceSweep() {
  const { count, bytes } = sweepStaleProfiles();
  if (count) console.log(`  🧹 清理历史临时目录 ${count} 个，释放 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  return { count, bytes };
}
