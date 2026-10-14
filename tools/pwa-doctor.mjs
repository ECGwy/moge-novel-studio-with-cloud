/* 墨阁 · PWA 安装体检
 * 用法：node tools/pwa-doctor.mjs [url]
 * 作用：用无头 Chrome 的 DevTools 协议检查「能不能装成 App」，
 *       逐条报告 manifest 错误、图标可用性、Service Worker 状态，
 *       并顺手探测 WebAPK 铸造服务（Google）是否可达 —— 国内网络装不上多半是这条。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeProfile, killAndClean, announceSweep } from './temp.mjs';

const URL_ = process.argv[2] || 'http://127.0.0.1:5173/';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome，无法体检'); process.exit(2); }

const PORT = 9336;
announceSweep();
const profile = makeProfile('doctor');
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (b) => (b ? '✅' : '❌');
const warn = (b) => (b ? '✅' : '⚠️ ');

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
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    waiting.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (waiting.has(mid)) { waiting.delete(mid); reject(new Error('CDP 超时: ' + method)); } }, 30000);
  });
  return { send, events };
}

/* 从 PNG 头部读宽高，确认图标是真·192/512 而不是改了名字的小图 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function probe(name, url, timeout = 8000) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    return { name, ok: true, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    return { name, ok: false, err: e.name, ms: Date.now() - t0 };
  }
}

const out = [];
const line = (s = '') => { console.log(s); out.push(s); };

let failed = false;
try {
  const page = await waitChrome();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const { send } = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(3000);

  line('═'.repeat(72));
  line('  墨阁 · PWA 安装体检');
  line('  目标：' + URL_);
  line('═'.repeat(72));

  /* ---------- 1. 运行环境 ---------- */
  const env = await send('Runtime.evaluate', {
    expression: `(async () => {
      const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      return {
        secure: isSecureContext,
        origin: location.origin,
        href: location.href,
        standalone: matchMedia('(display-mode: standalone)').matches,
        swSupported: 'serviceWorker' in navigator,
        swScope: reg ? reg.scope : null,
        swActive: !!(reg && reg.active),
        swState: reg && reg.active ? reg.active.state : null,
        swUrl: reg && reg.active ? reg.active.scriptURL : null,
        controlled: !!navigator.serviceWorker.controller,
        hasManifestLink: !!document.querySelector('link[rel=manifest]'),
        title: document.title,
      };
    })()`, awaitPromise: true, returnByValue: true,
  });
  const E = env.result.value;

  line('\n【1】运行环境');
  line(`  ${ok(E.secure)} 安全上下文 (HTTPS/localhost)：${E.secure}   ${E.secure ? '' : '← 非 https 无法安装'}`);
  line(`  ${ok(E.hasManifestLink)} HTML 里有 <link rel="manifest">`);
  line(`  ${ok(E.swSupported)} 浏览器支持 Service Worker：${E.swSupported}`);
  line(`  ${ok(E.swActive)} Service Worker 已激活：${E.swActive}  状态=${E.swState || '-'}`);
  line(`  ${ok(E.controlled)} 当前页面已被 SW 接管（刷新一次后应为 true）`);
  line(`      SW 地址：${E.swUrl || '未注册'}`);
  if (!E.secure) failed = true;
  if (!E.swActive) failed = true;

  /* ---------- 2. manifest ---------- */
  let manif = null;
  try { manif = await send('Page.getAppManifest'); } catch (e) { /* 老版本 Chrome 无此接口 */ }
  line('\n【2】Web App Manifest');
  if (!manif) {
    line('  ⚠️  这个 Chrome 版本不支持 Page.getAppManifest，跳过');
  } else {
    if (manif.url) {
      line(`  manifest 地址：${manif.url}`);
    } else {
      line('  ❌ 浏览器没有解析到 manifest');
      failed = true;
    }
    const errs = manif.errors || [];
    const warns = manif.warnings || [];
    line(`  ${ok(errs.length === 0)} manifest 错误：${errs.length === 0 ? '无' : errs.length + ' 条'}`);
    for (const e of errs) { line(`      ❌ ${e.message}  (${e.critical ? 'critical' : 'non-critical'})`); failed = true; }
    for (const w of warns) line(`      ⚠️  ${w.message}`);
    const p = manif.parsed || {};
    // 注意：Page.getAppManifest 的 parsed 里只有 scope，完整字段要自己解析 data
    let mf = {};
    if (manif.data) { try { mf = JSON.parse(manif.data); } catch (e) { line('  ❌ manifest JSON 解析失败：' + e.message); failed = true; } }
    if (manif.data) {
      const need = { name: 1, start_url: 1, display: 1, icons: 1 };
      line('  关键字段：');
      for (const k of Object.keys(need)) {
        const v = k === 'icons' ? (Array.isArray(mf.icons) ? mf.icons.length + ' 个' : null) : mf[k];
        line(`      ${ok(v != null)} ${k} = ${JSON.stringify(v)}`);
        if (v == null) failed = true;
      }
      line(`      ${ok(mf.theme_color)} theme_color = ${mf.theme_color}`);
      line(`      ${ok(mf.background_color)} background_color = ${mf.background_color}`);
      line(`      ${ok(mf.id)} id = ${JSON.stringify(mf.id)}`);
      line(`      ${ok(p.scope)} scope = ${JSON.stringify(p.scope)}`);
      line(`      display_override = ${JSON.stringify(mf.display_override || null)}`);
      // 检查 start_url 是否在 scope 内
      try {
        const su = new URL(mf.start_url || '', manif.url || E.href).href;
        const sc = new URL(mf.scope || p.scope || './', manif.url || E.href).href;
        const inside = su.startsWith(sc);
        line(`      ${ok(inside)} start_url 在 scope 内：${su}  ⊂  ${sc}`);
        if (!inside) failed = true;
      } catch (e) { line('      ❌ start_url/scope 无法解析'); failed = true; }
    }
  }

  /* ---------- 3. 图标 ---------- */
  line('\n【3】图标（Android 生成安装包时必须能下载到 ≥192px 的图）');
  const icons = await send('Runtime.evaluate', {
    expression: `(async () => {
      const link = document.querySelector('link[rel=manifest]');
      if (!link) return [];
      const m = await (await fetch(link.href)).json();
      const base = link.href;
      const out = [];
      for (const ic of (m.icons || [])) {
        const abs = new URL(ic.src, base).href;
        let status = 0, type = '', size = null, bytes = 0;
        try {
          const r = await fetch(abs);
          status = r.status;
          type = r.headers.get('content-type') || '';
          const b = new Uint8Array(await r.arrayBuffer());
          bytes = b.length;
          if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
            const dv = new DataView(b.buffer);
            size = { w: dv.getUint32(16), h: dv.getUint32(20) };
          }
        } catch (e) { status = -1; }
        out.push({ src: ic.src, abs, declared: ic.sizes, purpose: ic.purpose || 'any', status, type, size, bytes });
      }
      return out;
    })()`, awaitPromise: true, returnByValue: true,
  });
  const iconList = icons.result.value || [];
  if (!iconList.length) { line('  ❌ 没有图标'); failed = true; }
  let has192 = false, has512 = false, hasMaskable = false;
  for (const ic of iconList) {
    const dims = ic.size ? `${ic.size.w}×${ic.size.h}` : '读不出尺寸';
    const good = ic.status === 200 && ic.size && ic.size.w >= 192;
    if (good) has192 = true;
    if (ic.size && ic.size.w >= 512) has512 = true;
    if (/maskable/.test(ic.purpose)) hasMaskable = true;
    line(`  ${ok(ic.status === 200 && !!ic.size)} ${ic.src}`);
    line(`      声明=${ic.declared} 实际=${dims} 用途=${ic.purpose} HTTP=${ic.status} 类型=${ic.type || '-'} ${Math.round(ic.bytes / 1024)}KB`);
    if (ic.status !== 200) failed = true;
  }
  line(`  ${ok(has192)} 至少有 1 个 ≥192px 的图标（Chrome 安装的硬性要求）`);
  line(`  ${warn(has512)} 有 512px 图标`);
  line(`  ${warn(hasMaskable)} 有 maskable 图标（安卓圆形图标更漂亮）`);
  if (!has192) failed = true;

  /* ---------- 4. 安装性错误 ---------- */
  line('\n【4】Chrome 官方安装性检查');
  let inst = null;
  try { inst = await send('Page.getInstallabilityErrors'); } catch (e) { inst = null; }
  if (!inst) {
    line('  ⚠️  该 Chrome 不支持 Page.getInstallabilityErrors');
  } else {
    const errs = inst.installabilityErrors || [];
    if (!errs.length) {
      line('  ✅ 没有安装性错误 —— 项目文件本身完全符合安装条件');
    } else {
      for (const e of errs) line(`  ❌ ${e.errorId}${e.errorArguments ? ' ' + JSON.stringify(e.errorArguments) : ''}`);
      failed = true;
    }
  }

  /* ---------- 5. Service Worker 预缓存清单 ---------- */
  line('\n【5】Service Worker 预缓存资源是否都能取到');
  const swText = await (await fetch(new URL('sw.js', E.href).href)).text().catch(() => '');
  const assets = [...swText.matchAll(/['"]\.\/([^'"]+)['"]/g)].map((m) => m[1]).filter(Boolean);
  const uniq = [...new Set(assets)];
  let bad = 0;
  for (const a of uniq) {
    const u = new URL(a, E.href).href;
    let st = 0;
    try { st = (await fetch(u)).status; } catch (e) { st = -1; }
    if (st !== 200) { bad++; line(`  ❌ ${a} → HTTP ${st}`); }
  }
  line(`  ${ok(bad === 0)} 清单 ${uniq.length} 项，${bad} 项取不到${bad ? '（SW 会装不上/缓存不全）' : ''}`);
  if (bad) failed = true;

  /* ---------- 6. 安装链路网络（国内失败的真正原因多半在这） ---------- */
  line('\n【6】安卓 Chrome 生成"安装包"要连的 Google 服务（本机网络实测）');
  const probes = await Promise.all([
    probe('WebAPK 铸造服务', 'https://webapk.googleapis.com/'),
    probe('Google Play 服务', 'https://play.googleapis.com/'),
    probe('www.google.com', 'https://www.google.com/generate_204'),
  ]);
  for (const p of probes) {
    line(`  ${p.ok ? '✅' : '❌'} ${p.name.padEnd(18)} ${p.ok ? 'HTTP ' + p.status : '不可达（' + p.err + '）'}  ${p.ms}ms`);
  }
  const mintBlocked = probes.some((p) => !p.ok);
  if (mintBlocked) {
    line('');
    line('  ⚠️  上面有服务不可达。安卓 Chrome 点「安装应用」时，');
    line('      必须让手机访问 Google 的 WebAPK 铸造服务把网页打包成 APK，');
    line('      连不上就会一直转圈、最后报安装失败 —— 这是网络问题，不是项目文件问题。');
  }

  ws.close();
} catch (e) {
  failed = true;
  console.error('体检失败：', e.message);
} finally {
  await killAndClean(chrome, profile);
}

line('\n' + '═'.repeat(72));
line(failed ? '  结论：项目文件存在问题，见上面的 ❌' : '  结论：项目文件本身没有安装性障碍 ✅');
line('═'.repeat(72));
process.exit(failed ? 1 : 0);
