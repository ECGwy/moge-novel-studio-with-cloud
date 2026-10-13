/* 墨阁 · 一体化 Cloudflare Worker
 *
 * 一个 Worker 干两件事：
 *   1) AI 接口转发代理 —— 解决浏览器直连被 CORS 拦截（Kimi、Claude、坚果云 WebDAV 等）
 *   2) 小说云同步端点   —— 用 KV 存整库快照，多台设备填同一个「房间号」即可同步
 *
 * 部署（详见 README 方式 C）：
 *   - 新建 Worker，把本文件整段粘进去，Deploy
 *   - 想用云同步：Storage & Databases → KV → 建一个命名空间，
 *     回到 Worker → Settings → Bindings → 添加 KV Namespace，变量名必须是 MOGE_KV
 *   - 建议加环境变量 TOKEN（一串随机字符），可同时保护代理与同步端点
 *
 * App 里怎么填：
 *   CORS 代理（AI 用）    https://<worker>.workers.dev/?url=
 *   同步方式「自建同步端点」的同步地址  https://<worker>.workers.dev
 *   房间号                随便起一个，多设备填一样的（同步端点用）
 *   访问令牌              就是环境变量 TOKEN（没设就留空）
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
  'access-control-max-age': '86400',
};

const STRIP = new Set([
  'host', 'origin', 'referer', 'connection', 'content-length',
  'accept-encoding', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
]);

const MAX_SNAPSHOT = 24 * 1024 * 1024;   // KV 单值上限 25MB，留点余量

function text(body, status = 200) {
  return new Response(body, { status, headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' } });
}

function sameToken(env, url, request) {
  const want = env && env.TOKEN;
  if (!want) return true;
  const qp = url.searchParams.get('token');
  if (qp && qp === want) return true;
  const auth = request.headers.get('authorization') || '';
  return auth === 'Bearer ' + want;
}

/* ---------- 云同步：/s/<房间号> ---------- */
async function handleSync(request, env, url) {
  const room = decodeURIComponent(url.pathname.replace(/^\/s\/?/, ''));
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(room)) {
    return text('moge sync: 房间号只能是 3-64 位字母/数字/._-', 400);
  }
  if (!sameToken(env, url, request)) return text('moge sync: token 不正确', 403);

  const kv = env && env.MOGE_KV;
  if (!kv) {
    return text(
      'moge sync: 这个 Worker 还没有绑定 KV。\n' +
      '请在 Cloudflare 控制台建一个 KV 命名空间，并在 Worker 的 Settings → Bindings 里\n' +
      '添加 KV Namespace，变量名填 MOGE_KV，然后重新部署。',
      501
    );
  }

  const key = 'room:' + room;

  if (request.method === 'GET' || request.method === 'HEAD') {
    const body = await kv.get(key);
    if (body == null) return text('moge sync: 房间还没有数据', 404);
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'x-moge-room': room },
    });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    if (!body) return text('moge sync: 空数据', 400);
    if (body.length > MAX_SNAPSHOT) return text('moge sync: 数据超过 24MB，建议拆书同步', 413);
    try { JSON.parse(body); } catch (e) { return text('moge sync: 数据不是合法 JSON', 400); }
    await kv.put(key, body, { metadata: { savedAt: Date.now(), size: body.length } });
    return new Response(JSON.stringify({ ok: true, room, bytes: body.length }), {
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
    });
  }

  if (request.method === 'DELETE') {
    await kv.delete(key);
    return new Response(JSON.stringify({ ok: true, deleted: room }), {
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return text('moge sync: 只支持 GET / PUT / DELETE', 405);
}

/* ---------- AI 接口转发：/?url=<encoded> ---------- */
async function handleProxy(request, env, url) {
  const target = url.searchParams.get('url');
  if (!target) {
    return text('moge proxy: 缺少 ?url= 参数', 400);
  }
  if (!sameToken(env, url, request)) return text('moge proxy: token 不正确', 403);
  if (!/^https?:\/\//i.test(target)) return text('moge proxy: 只支持 http(s) 地址', 400);

  const headers = new Headers(request.headers);
  for (const h of STRIP) headers.delete(h);

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'follow',
    });
  } catch (e) {
    return text('moge proxy: 上游请求失败 - ' + (e && e.message), 502);
  }

  const out = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  out.delete('content-encoding');
  out.delete('content-length');
  out.delete('content-security-policy');
  out.delete('content-security-policy-report-only');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname.startsWith('/s/') || url.pathname === '/s') {
      return handleSync(request, env, url);
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, kv: !!(env && env.MOGE_KV), token: !!(env && env.TOKEN) }), {
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return handleProxy(request, env, url);
  },
};
