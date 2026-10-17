/*
 * WHO RUINED? — API-прокси на Cloudflare Workers.
 *
 * Стоит между сайтом и api.deadlock-api.com:
 *  - с API-ключом (секрет DEADLOCK_API_KEY) грузит новые матчи из Steam: 300 в час на ключ;
 *    без ключа берёт только матчи из базы deadlock-api.com, а на остальные отвечает 404
 *    с X-WR-Direct: 1 — сайт загружает их напрямую, с лимитом на IP посетителя;
 *  - навсегда хранит матчи в KV (метаданные завершённого матча не меняются),
 *    повторные открытия не трогают deadlock-api.com вовсе;
 *  - держит справочники в KV и отдаёт их, даже когда deadlock-api.com лежит;
 *  - отвечает на любые ошибки с CORS-заголовками, чтобы сайт видел настоящий статус.
 * Пропускает только эндпоинты, которые нужны сайту, — ключ нельзя использовать для чужих запросов.
 */

const MATCH_RE = /^\/v1\/matches\/(\d{1,12})\/metadata$/;
const ASSET_RE = /^\/v1\/assets\/(heroes|items|ranks)$/;
const PLAYERS_RE = /^\/v1\/players\/(steam|rank)$/;
const ACCOUNT_IDS_RE = /^\d{1,12}(,\d{1,12}){0,23}$/;

const ASSET_FRESH = 6 * 60 * 60 * 1000;      // справочник старше 6 часов обновляется из апстрима
const UPSTREAM_TIMEOUT = 25000;
const PASS_HEADERS = ['retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  'ratelimit-period', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (!cors) return json({ error: 'origin_not_allowed' }, 403, {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405, cors);

    if (url.pathname === '/') return json({ ok: true }, 200, cors);

    let m;
    try {
      if ((m = url.pathname.match(MATCH_RE))) return await match(m[1], request, env, ctx, cors);
      if ((m = url.pathname.match(ASSET_RE))) return await asset(m[1], env, ctx, cors);
      if ((m = url.pathname.match(PLAYERS_RE))) {
        const ids = url.searchParams.get('account_ids') || '';
        if (!ACCOUNT_IDS_RE.test(ids)) return json({ error: 'bad_account_ids' }, 400, cors);
        const res = await upstream(`/v1/players/${m[1]}?account_ids=${ids}`, env);
        return relay(res, await res.text(), cors, 'public, max-age=3600');
      }
    } catch (e) {
      return upstreamDown(e, cors);
    }
    return json({ error: 'not_found' }, 404, cors);
  },
};

// ---------- матч: KV навсегда, апстрим только при промахе ----------
async function match(id, request, env, ctx, cors) {
  const key = 'm:' + id;
  const stored = await env.MATCHES.get(key, { type: 'arrayBuffer', cacheTtl: 86400 });
  if (stored) return jsonText(await gunzip(stored), 200, cors, 'hit', 'public, max-age=604800, immutable');

  // Промах кэша тратит квоту апстрима и запись в KV — ограничиваем частоту на IP
  if (env.LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'too_many_new_matches' }, 429, { ...cors, 'Retry-After': '60' });
  }

  // Без ключа из Steam не грузим: все воркеры выходят к deadlock-api.com с общего адреса,
  // и лимит 3 матча в час на IP был бы общим для всех. Такие матчи сайт берёт напрямую.
  const steam = !!env.DEADLOCK_API_KEY;
  const res = await upstream(`/v1/matches/${id}/metadata${steam ? '' : '?disable_steam=true'}`, env);
  const text = await res.text();
  if (res.ok && isCompleteMatch(text)) {
    ctx.waitUntil(gzip(text).then((buf) => env.MATCHES.put(key, buf)));
    return jsonText(text, 200, cors, 'miss', 'public, max-age=604800, immutable');
  }
  if (res.status === 404 && !steam) {
    return json({ error: 'not_in_database' }, 404, { ...cors, 'X-WR-Direct': '1' });
  }
  return relay(res, text, cors, 'no-store');
}

function isCompleteMatch(text) {
  try {
    const d = JSON.parse(text);
    const mi = d && (d.match_info || d);
    return !!(mi && Array.isArray(mi.players) && mi.players.length);
  } catch (e) {
    return false;
  }
}

// ---------- справочники: свежие из KV, при сбое апстрима — устаревшие из KV ----------
async function asset(name, env, ctx, cors) {
  const key = 'a:' + name;
  const { value, metadata } = await env.MATCHES.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 3600 });
  const age = value && metadata ? Date.now() - metadata.t : Infinity;
  if (value && age < ASSET_FRESH) return jsonText(await gunzip(value), 200, cors, 'hit', 'public, max-age=3600');

  let res, text;
  try {
    res = await upstream(`/v1/assets/${name}`, env);
    text = await res.text();
  } catch (e) {
    if (value) return jsonText(await gunzip(value), 200, cors, 'stale', 'public, max-age=300');
    throw e;
  }
  if (res.ok) {
    ctx.waitUntil(gzip(text).then((buf) => env.MATCHES.put(key, buf, { metadata: { t: Date.now() } })));
    return jsonText(text, 200, cors, 'miss', 'public, max-age=3600');
  }
  if (value) return jsonText(await gunzip(value), 200, cors, 'stale', 'public, max-age=300');
  return relay(res, text, cors, 'no-store');
}

// ---------- апстрим ----------
class UpstreamDown extends Error {}

async function upstream(path, env) {
  const headers = { Accept: 'application/json' };
  if (env.DEADLOCK_API_KEY) headers['X-API-KEY'] = env.DEADLOCK_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT);
  let res;
  try {
    res = await fetch((env.UPSTREAM || 'https://api.deadlock-api.com') + path, { headers, signal: ctrl.signal });
  } catch (e) {
    throw new UpstreamDown(e && e.name === 'AbortError' ? 'timeout' : 'unreachable');
  } finally {
    clearTimeout(timer);
  }
  // Ошибки Cloudflare перед deadlock-api.com (502, 504, 520–530) — сервер недоступен
  if (res.status === 502 || res.status === 504 || (res.status >= 520 && res.status <= 530)) {
    throw new UpstreamDown('status ' + res.status);
  }
  return res;
}

function upstreamDown(e, cors) {
  if (e instanceof UpstreamDown) return json({ error: 'upstream_down', detail: e.message }, 502, cors);
  return json({ error: 'proxy_error' }, 500, cors);
}

// Ответ апстрима как есть: статус, тело и заголовки лимитов
function relay(res, text, cors, cacheControl) {
  const headers = { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl };
  PASS_HEADERS.forEach((h) => {
    const v = res.headers.get(h);
    if (v != null) headers[h] = v;
  });
  return new Response(text, { status: res.status, headers });
}

// ---------- CORS ----------
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  const base = {
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Expose-Headers': PASS_HEADERS.join(', ') + ', x-wr-cache, x-wr-direct',
    'Access-Control-Max-Age': '86400',
  };
  if (!allowed.length) return { ...base, 'Access-Control-Allow-Origin': '*' };
  if (!origin || !allowed.includes(origin)) return null;
  return { ...base, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

// ---------- утилиты ----------
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function jsonText(text, status, cors, cacheState, cacheControl) {
  return new Response(text, {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl, 'X-WR-Cache': cacheState },
  });
}

async function gzip(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}

async function gunzip(buf) {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
