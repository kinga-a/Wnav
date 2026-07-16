/**
 * WebStack 导航站 API（EdgeOne Pages Functions）
 *
 * 路由（统一入口，按路径分发）：
 *   GET    /api/data            站点数据（分类+书签+公开设置），带合法 X-API-Key 时含私有书签
 *   POST   /api/login           校验管理密码 { password }
 *   POST   /api/bookmarks       添加书签（需认证）
 *   PUT    /api/bookmarks/:id   更新书签（需认证）
 *   DELETE /api/bookmarks/:id   删除书签（需认证）
 *   GET    /api/settings        读取设置（需认证，含天气 key）
 *   PUT    /api/settings        更新设置（需认证）
 *   GET    /api/weather?city=   和风天气代理（key 存 KV，不暴露给前端；结果缓存 30 分钟）
 *   GET    /api/icon?url=       网站图标 API（抓取 favicon，KV 缓存 7 天，失败回退字母图标）
 *   GET    /api/title?url=      抓取网页标题（"识别"按钮用，支持 GBK 网页）
 *
 * KV 绑定变量名：BOOKMARK_KV（在 EdgeOne Pages 项目设置 → KV 存储中绑定）
 * 环境变量：AUTH_PASSWORD（管理密码，写操作通过 X-API-Key 请求头校验）
 */

import seedData from './seed.js';

const DATA_KEY = 'nav:data';
const SETTINGS_KEY = 'nav:settings';
const WEATHER_CACHE_KEY = 'nav:weather-cache';
const ICON_TTL = 7 * 24 * 3600 * 1000;   // 图标缓存 7 天
const WEATHER_TTL = 30 * 60 * 1000;      // 天气缓存 30 分钟

const DEFAULT_SETTINGS = {
  qweatherKey: '085791e805a24491b43b06cf58ab31e7', // 迁移自原 config.toml，可在设置弹窗中修改
  qweatherCity: '',                               // 城市名（如“北京”），留空默认北京
  qweatherHost: '',                               // 和风专属 API 域名（2024 年后新建项目必填，如 abc123.re.qweatherapi.com），留空用公共域名
  siteTitle: '',                                  // 自定义站点标题，留空用页面默认
};

/* ---------------- 基础工具 ---------------- */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function genId(prefix) {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return prefix + '_' + Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 认证（账号+密码 → HMAC 令牌） ----------------
 * 环境变量：
 *   AUTH_USERNAME  管理账号（可选；不设置则登录只校验密码）
 *   AUTH_PASSWORD  管理密码（必须；未设置时一切写操作与私有书签访问均被拒绝）
 * 登录成功后签发 HMAC-SHA256 签名令牌（7 天有效），前端以 X-API-Key 头携带。
 * 修改任一环境变量后，已签发的令牌自动失效。
 * 令牌有效期（毫秒）
 */
const TOKEN_TTL = 7 * 24 * 3600 * 1000;

function utf8ToB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToUtf8(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function tokenSecret(env) {
  return `${env.AUTH_USERNAME || ''}#${env.AUTH_PASSWORD || ''}`;
}

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function issueToken(username, env) {
  const exp = Date.now() + TOKEN_TTL;
  const payload = `${username}@admin|${exp}`;
  const sig = await hmacHex(payload, tokenSecret(env));
  return { token: `${utf8ToB64Url(payload)}.${sig}`, expiresAt: exp };
}

async function verifyToken(token, env) {
  if (!token || !env.AUTH_PASSWORD) return false;
  // 兼容通道：直接携带密码（便于 curl 等 API 调用）
  if (token === env.AUTH_PASSWORD) return true;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload;
  try { payload = b64UrlToUtf8(b64); } catch (e) { return false; }
  const sep = payload.lastIndexOf('|');
  if (sep <= 0) return false;
  const exp = Number(payload.slice(sep + 1));
  if (!exp || Date.now() > exp) return false;
  const expect = await hmacHex(payload, tokenSecret(env));
  return expect === sig;
}

async function isAdmin(request, env) {
  const key = request.headers.get('X-API-Key') || '';
  return verifyToken(key, env);
}

async function requireAdmin(request, env) {
  if (!env.AUTH_PASSWORD) {
    return json({ error: '服务端未配置 AUTH_PASSWORD 环境变量，写操作已禁用' }, 503);
  }
  if (!(await isAdmin(request, env))) {
    return json({ error: '未授权，请先登录', needAuth: true }, 401);
  }
  return null;
}

/* ---------------- KV 数据读写 ---------------- */

async function loadData(env) {
  let raw = await env.BOOKMARK_KV.get(DATA_KEY);
  if (!raw) {
    raw = JSON.stringify(seedData);
    await env.BOOKMARK_KV.put(DATA_KEY, raw);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return JSON.parse(JSON.stringify(seedData));
  }
}

async function saveData(env, data) {
  await env.BOOKMARK_KV.put(DATA_KEY, JSON.stringify(data));
}

async function loadSettings(env) {
  const raw = await env.BOOKMARK_KV.get(SETTINGS_KEY);
  let s = {};
  if (raw) {
    try { s = JSON.parse(raw); } catch (e) { /* 忽略损坏数据 */ }
  }
  return { ...DEFAULT_SETTINGS, ...s };
}

/* 在分类树中查找书签，返回 {cat, group, index, link} */
function findLink(data, id) {
  for (const cat of data.categories || []) {
    const containers = [];
    if (Array.isArray(cat.links)) containers.push({ cat, group: null, list: cat.links });
    for (const g of cat.groups || []) containers.push({ cat, group: g, list: g.links || [] });
    for (const c of containers) {
      const idx = c.list.findIndex((l) => l.id === id);
      if (idx !== -1) return { cat: c.cat, group: c.group, list: c.list, index: idx, link: c.list[idx] };
    }
  }
  return null;
}

/* 解析目标分类：按 id 或按名称新建 */
function resolveTarget(data, body) {
  const { catId, groupId, newCategory, newGroup } = body || {};
  let cat = null;
  if (catId) cat = (data.categories || []).find((c) => c.id === catId) || null;
  if (!cat && newCategory) {
    const name = String(newCategory).trim();
    cat = data.categories.find((c) => c.name === name);
    if (!cat) {
      cat = { id: genId('c'), name };
      data.categories.push(cat);
    }
  }
  if (!cat) return null;
  // 目标为二级分组
  if (groupId || newGroup) {
    if (!Array.isArray(cat.groups)) {
      // 原直挂 links 的分类转为分组形态，旧链接归入同名分组
      const old = cat.links || [];
      cat.groups = [{ id: genId('g'), name: cat.name, links: old }];
      delete cat.links;
    }
    let group = null;
    if (groupId) group = cat.groups.find((g) => g.id === groupId) || null;
    if (!group && newGroup) {
      const name = String(newGroup).trim();
      group = cat.groups.find((g) => g.name === name);
      if (!group) {
        group = { id: genId('g'), name, links: [] };
        cat.groups.push(group);
      }
    }
    if (group) {
      if (!Array.isArray(group.links)) group.links = [];
      return { cat, group, list: group.links };
    }
  }
  // 直挂分类
  if (Array.isArray(cat.links)) return { cat, group: null, list: cat.links };
  // 分组形态但未指定分组：放到第一个分组
  if (Array.isArray(cat.groups) && cat.groups.length) {
    const g = cat.groups[0];
    if (!Array.isArray(g.links)) g.links = [];
    return { cat, group: g, list: g.links };
  }
  cat.links = [];
  return { cat, group: null, list: cat.links };
}

function sanitizeBookmark(input, existing = {}) {
  const b = { ...existing };
  const fields = ['title', 'url', 'backupUrl', 'icon', 'keywords', 'description'];
  for (const f of fields) {
    if (input[f] !== undefined) b[f] = String(input[f] || '').trim();
  }
  if (input.private !== undefined) b.private = !!input.private;
  if (!b.title) throw new Error('链接名称不能为空');
  if (!b.url || !/^https?:\/\//i.test(b.url)) throw new Error('主链接必须是有效的 http(s) 地址');
  if (b.backupUrl && !/^https?:\/\//i.test(b.backupUrl)) throw new Error('备用链接必须是有效的 http(s) 地址');
  return b;
}

/* ---------------- 抓取工具（图标 / 标题） ---------------- */

function checkPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0)/.test(h)) return null;
  return u;
}

async function fetchLimited(url, maxBytes = 262144, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,image/*,*/*;q=0.8',
      },
    });
    if (!resp.ok || !resp.body) return { ok: false, status: resp.status };
    const reader = resp.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    try { await reader.cancel(); } catch (e) { /* 忽略 */ }
    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return { ok: true, status: resp.status, buf, headers: resp.headers, finalUrl: resp.url };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function detectCharset(headers, headText) {
  const ct = headers.get('Content-Type') || '';
  let m = ct.match(/charset=([\w-]+)/i);
  if (m) return m[1].toLowerCase();
  m = headText.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i);
  if (m) return m[1].toLowerCase();
  return 'utf-8';
}

function decodeBuffer(buf, charset) {
  const tryList = charset.includes('gb') ? [charset, 'gbk', 'utf-8'] : ['utf-8', 'gbk'];
  for (const enc of tryList) {
    try { return new TextDecoder(enc).decode(buf); } catch (e) { /* 尝试下一个 */ }
  }
  return new TextDecoder('utf-8').decode(buf);
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch (e) { return ''; } });
}

/* ---------------- 路由处理 ---------------- */

async function handleGetData(request, env) {
  const [data, settings] = await Promise.all([loadData(env), loadSettings(env)]);
  const admin = await isAdmin(request, env);
  let categories = data.categories || [];
  if (!admin) {
    // 未认证访客不返回私有书签
    categories = categories
      .map((c) => {
        const nc = { ...c };
        if (Array.isArray(nc.links)) nc.links = nc.links.filter((l) => !l.private);
        if (Array.isArray(nc.groups)) {
          nc.groups = nc.groups.map((g) => ({ ...g, links: (g.links || []).filter((l) => !l.private) }));
        }
        return nc;
      })
      .filter((c) => (c.links && c.links.length) || (c.groups && c.groups.some((g) => (g.links || []).length)));
  }
  return json({
    categories,
    admin,
    settings: {
      qweatherCity: settings.qweatherCity,
      siteTitle: settings.siteTitle,
      hasWeatherKey: !!settings.qweatherKey,
      needUsername: !!env.AUTH_USERNAME, // 前端据此决定是否显示账号输入框
    },
  });
}

/* 登录：校验账号+密码（账号由 AUTH_USERNAME 定义，可选），签发 HMAC 令牌 */
async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!env.AUTH_PASSWORD) return json({ error: '服务端未配置 AUTH_PASSWORD 环境变量' }, 503);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (env.AUTH_USERNAME && username !== env.AUTH_USERNAME) {
    return json({ ok: false, error: '账号或密码错误' }, 401);
  }
  if (!password || password !== env.AUTH_PASSWORD) {
    return json({ ok: false, error: '账号或密码错误' }, 401);
  }
  const { token, expiresAt } = await issueToken(env.AUTH_USERNAME ? username : 'admin', env);
  return json({ ok: true, token, expiresAt, needUsername: !!env.AUTH_USERNAME });
}

async function handleAddBookmark(request, env) {
  const deny = await requireAdmin(request, env);
  if (deny) return deny;
  const body = await request.json().catch(() => ({}));
  let bookmark;
  try {
    bookmark = sanitizeBookmark(body.bookmark || body);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  bookmark.id = genId('l');
  bookmark.createdAt = Date.now();
  const data = await loadData(env);
  const target = resolveTarget(data, body);
  if (!target) return json({ error: '目标分类不存在，请指定所属分类' }, 400);
  target.list.push(bookmark);
  await saveData(env, data);
  return json({ ok: true, bookmark, category: { id: target.cat.id, name: target.cat.name, group: target.group ? { id: target.group.id, name: target.group.name } : null } });
}

async function handleUpdateBookmark(request, env, id) {
  const deny = await requireAdmin(request, env);
  if (deny) return deny;
  const body = await request.json().catch(() => ({}));
  const data = await loadData(env);
  const found = findLink(data, id);
  if (!found) return json({ error: '书签不存在' }, 404);
  let updated;
  try {
    updated = sanitizeBookmark(body.bookmark || body, found.link);
  } catch (e) {
    return json({ error: e.message }, 400);
  }
  // 是否移动分类
  const wantMove = body.catId || body.groupId || body.newCategory || body.newGroup;
  if (wantMove) {
    const sameCat = body.catId && body.catId === found.cat.id;
    const sameGroup = !body.groupId || (found.group && body.groupId === found.group.id);
    const noNew = !body.newCategory && !body.newGroup;
    if (!(sameCat && sameGroup && noNew)) {
      found.list.splice(found.index, 1);
      const target = resolveTarget(data, body);
      if (!target) {
        found.list.splice(found.index, 0, found.link); // 回滚
        return json({ error: '目标分类不存在' }, 400);
      }
      target.list.push(updated);
      await saveData(env, data);
      return json({ ok: true, bookmark: updated });
    }
  }
  found.list[found.index] = updated;
  await saveData(env, data);
  return json({ ok: true, bookmark: updated });
}

async function handleDeleteBookmark(request, env, id) {
  const deny = await requireAdmin(request, env);
  if (deny) return deny;
  const data = await loadData(env);
  const found = findLink(data, id);
  if (!found) return json({ error: '书签不存在' }, 404);
  found.list.splice(found.index, 1);
  await saveData(env, data);
  return json({ ok: true });
}

async function handleGetSettings(request, env) {
  const deny = await requireAdmin(request, env);
  if (deny) return deny;
  const settings = await loadSettings(env);
  return json({ settings });
}

async function handlePutSettings(request, env) {
  const deny = await requireAdmin(request, env);
  if (deny) return deny;
  const body = await request.json().catch(() => ({}));
  const current = await loadSettings(env);
  const next = { ...current };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (body[k] !== undefined) next[k] = String(body[k] || '').trim();
  }
  await env.BOOKMARK_KV.put(SETTINGS_KEY, JSON.stringify(next));
  // 天气配置变化时清掉天气缓存
  if (body.qweatherKey !== undefined || body.qweatherCity !== undefined || body.qweatherHost !== undefined) {
    await env.BOOKMARK_KV.delete(WEATHER_CACHE_KEY).catch(() => {});
  }
  return json({ ok: true, settings: { qweatherCity: next.qweatherCity, siteTitle: next.siteTitle, hasWeatherKey: !!next.qweatherKey } });
}

/* ---------------- 天气代理 ---------------- */

async function handleWeather(request, env, url) {
  const settings = await loadSettings(env);
  if (!settings.qweatherKey) return json({ disabled: true, error: '未配置和风天气 Key' });

  const city = (url.searchParams.get('city') || settings.qweatherCity || '北京').trim();
  const cacheRaw = await env.BOOKMARK_KV.get(WEATHER_CACHE_KEY);
  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw);
      if (cache.city === city && Date.now() - cache.ts < WEATHER_TTL) {
        return json({ ...cache.payload, cached: true });
      }
    } catch (e) { /* 缓存损坏则重取 */ }
  }

  const key = settings.qweatherKey;
  // 和风 2024 年后新建项目需使用专属 API 域名（控制台可查），旧项目仍可用公共域名
  const host = (settings.qweatherHost || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const geoBase = host ? `https://${host}` : 'https://geoapi.qweather.com';
  const devBase = host ? `https://${host}` : 'https://devapi.qweather.com';
  // 1) 城市 → LocationID
  const geoResp = await fetch(
    `${geoBase}/v2/city/lookup?location=${encodeURIComponent(city)}&key=${encodeURIComponent(key)}&number=1`,
    { headers: { Accept: 'application/json' } }
  ).then((r) => r.json()).catch(() => null);
  if (!geoResp || geoResp.code !== '200' || !geoResp.location || !geoResp.location.length) {
    return json({ error: `城市「${city}」查询失败`, code: geoResp && geoResp.code }, 502);
  }
  const loc = geoResp.location[0];
  // 2) 实时天气
  const nowResp = await fetch(
    `${devBase}/v7/weather/now?location=${encodeURIComponent(loc.id)}&key=${encodeURIComponent(key)}`,
    { headers: { Accept: 'application/json' } }
  ).then((r) => r.json()).catch(() => null);
  if (!nowResp || nowResp.code !== '200') {
    return json({ error: '天气查询失败', code: nowResp && nowResp.code }, 502);
  }
  const payload = {
    city: loc.name,
    adm: loc.adm1,
    temp: nowResp.now.temp,
    feelsLike: nowResp.now.feelsLike,
    text: nowResp.now.text,
    icon: nowResp.now.icon,
    windDir: nowResp.now.windDir,
    humidity: nowResp.now.humidity,
    updateTime: nowResp.updateTime,
  };
  await env.BOOKMARK_KV.put(WEATHER_CACHE_KEY, JSON.stringify({ city, ts: Date.now(), payload })).catch(() => {});
  return json(payload);
}

/* ---------------- 图标 API ---------------- */

function letterIcon(host) {
  const ch = (host || '?').replace(/^www\./, '').charAt(0).toUpperCase();
  const colors = ['#f1404b', '#f27242', '#e4c600', '#4dabf7', '#845ef7', '#20c997', '#fd7e14'];
  let h = 0;
  for (const c of host || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const bg = colors[h % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="${bg}"/><text x="32" y="43" font-size="32" font-family="Arial,Helvetica,sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${ch}</text></svg>`;
  return new Response(svg, {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
}

async function fetchImageAsBase64(iconUrl) {
  const r = await fetchLimited(iconUrl, 204800, 8000);
  if (!r.ok || !r.buf || !r.buf.length) return null;
  const ct = (r.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (ct && !/image|octet-stream|icon/.test(ct)) return null;
  // base64 编码
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < r.buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, r.buf.subarray(i, Math.min(i + CHUNK, r.buf.length)));
  }
  return { b64: btoa(bin), contentType: ct || 'image/x-icon' };
}

async function handleIcon(request, env, url, ctx) {
  const raw = url.searchParams.get('url') || '';
  const u = checkPublicUrl(raw);
  if (!u) return json({ error: '无效的 url 参数' }, 400);
  const host = u.hostname;
  const cacheKey = 'icon:' + host;

  const cacheRaw = await env.BOOKMARK_KV.get(cacheKey);
  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw);
      if (Date.now() - cache.ts < ICON_TTL) {
        const bin = atob(cache.b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return new Response(buf, {
          status: 200,
          headers: { 'Content-Type': cache.contentType, 'Cache-Control': 'public, max-age=86400', 'X-Icon-Cache': 'hit' },
        });
      }
    } catch (e) { /* 缓存损坏则重取 */ }
  }

  // 候选 1：/favicon.ico
  const origin = u.origin;
  let result = await fetchImageAsBase64(origin + '/favicon.ico');
  // 候选 2：解析首页 HTML 中的 <link rel="icon">
  if (!result) {
    const page = await fetchLimited(origin + '/', 262144, 8000);
    if (page.ok) {
      const charset = detectCharset(page.headers, '');
      const html = decodeBuffer(page.buf, charset);
      const linkRe = /<link[^>]*>/gi;
      let m;
      const candidates = [];
      while ((m = linkRe.exec(html))) {
        const tag = m[0];
        if (!/rel\s*=\s*["'][^"']*(icon|apple-touch-icon)/i.test(tag)) continue;
        const hrefM = tag.match(/href\s*=\s*["']([^"']+)["']/i);
        if (hrefM) candidates.push(hrefM[1]);
      }
      for (const href of candidates.slice(0, 3)) {
        try {
          const abs = new URL(href, page.finalUrl || origin + '/').href;
          result = await fetchImageAsBase64(abs);
          if (result) break;
        } catch (e) { /* 尝试下一个 */ }
      }
    }
  }
  if (!result) return letterIcon(host);

  const cacheValue = JSON.stringify({ ts: Date.now(), ...result });
  const write = env.BOOKMARK_KV.put(cacheKey, cacheValue).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;

  const bin = atob(result.b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Response(buf, {
    status: 200,
    headers: { 'Content-Type': result.contentType, 'Cache-Control': 'public, max-age=86400' },
  });
}

/* ---------------- 标题识别 ---------------- */

async function handleTitle(request, env, url) {
  const raw = url.searchParams.get('url') || '';
  const u = checkPublicUrl(raw);
  if (!u) return json({ error: '无效的 url 参数' }, 400);
  const page = await fetchLimited(u.href, 262144, 10000);
  if (!page.ok) return json({ error: '页面抓取失败：' + (page.error || page.status) }, 502);
  // 先用前 4KB 粗判 charset，再整体解码
  let headText = '';
  try { headText = new TextDecoder('utf-8').decode(page.buf.subarray(0, 4096)); } catch (e) { /* 忽略 */ }
  const charset = detectCharset(page.headers, headText);
  const html = decodeBuffer(page.buf, charset);
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return json({ error: '未找到页面标题' }, 404);
  const title = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return json({ title });
}

/* ---------------- 入口 ---------------- */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
      },
    });
  }

  if (!env.BOOKMARK_KV) {
    return json({ error: '未绑定 KV 空间：请在 EdgeOne Pages 项目设置中绑定变量名为 BOOKMARK_KV 的 KV 命名空间' }, 503);
  }

  try {
    if (path === 'data' && method === 'GET') return await handleGetData(request, env);
    if (path === 'login' && method === 'POST') return await handleLogin(request, env);
    if (path === 'bookmarks' && method === 'POST') return await handleAddBookmark(request, env);
    const bmMatch = path.match(/^bookmarks\/([\w-]+)$/);
    if (bmMatch && method === 'PUT') return await handleUpdateBookmark(request, env, bmMatch[1]);
    if (bmMatch && method === 'DELETE') return await handleDeleteBookmark(request, env, bmMatch[1]);
    if (path === 'settings' && method === 'GET') return await handleGetSettings(request, env);
    if (path === 'settings' && method === 'PUT') return await handlePutSettings(request, env);
    if (path === 'weather' && method === 'GET') return await handleWeather(request, env, url);
    if (path === 'icon' && method === 'GET') return await handleIcon(request, env, url, context);
    if (path === 'title' && method === 'GET') return await handleTitle(request, env, url);
    return json({ error: '接口不存在：/api/' + path }, 404);
  } catch (e) {
    return json({ error: '服务端错误：' + (e && e.message ? e.message : String(e)) }, 500);
  }
}
