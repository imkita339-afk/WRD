// Связь с прокси: бот сам держит WebSocket к воркеру (входящие порты и белый IP не нужны).
// Воркер присылает {type:'match', reqId, id}, бот отвечает {type:'result', reqId, status, gz?}.
import zlib from 'node:zlib';
import { fetchMatch } from './match.js';
import { log } from './util.js';

const PING_EVERY = 30000;
const RECENT_TTL = 10 * 60 * 1000;    // повторный запрос того же матча не тратит лимит

export function connectHub({ url, token, gc, quota }) {
  const recent = new Map();
  let queue = Promise.resolve();
  let backoff = 1000;

  async function handle(id) {
    const hit = recent.get(id);
    if (hit && hit.at > Date.now() - RECENT_TTL) return hit.reply;
    let reply;
    try {
      const r = await fetchMatch(gc, quota, id);
      reply = { status: r.status, retryAfter: r.retryAfter, detail: r.detail };
      if (r.status === 'ok') reply.gz = zlib.gzipSync(JSON.stringify(r.match)).toString('base64');
    } catch (e) {
      reply = { status: 'error', detail: e.message };
    }
    log(`Матч ${id}: ${reply.status}${reply.detail ? ` (${reply.detail})` : ''} · осталось на сутки: ${quota.left()}`);
    if (reply.status !== 'error' && reply.status !== 'offline') recent.set(id, { at: Date.now(), reply });
    return reply;
  }

  function open() {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    let ping;
    ws.addEventListener('open', () => {
      backoff = 1000;
      log('Подключились к прокси, ждём запросы.');
      ping = setInterval(() => ws.send('ping'), PING_EVERY);
    });
    ws.addEventListener('message', (ev) => {
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type !== 'match' || !/^\d{1,12}$/.test(String(msg.id))) return;
      // Запросы к GC — по одному, чтобы не ловить Rate Limited
      queue = queue.then(async () => {
        const reply = await handle(Number(msg.id));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', reqId: msg.reqId, ...reply }));
      });
    });
    ws.addEventListener('close', (ev) => {
      clearInterval(ping);
      if (ev.code === 4001) log('Прокси отклонил токен бота — проверьте BOT_TOKEN в воркере.');
      log(`Связь с прокси прервана, переподключение через ${Math.round(backoff / 1000)} с.`);
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
    ws.addEventListener('error', () => { /* за ним всегда следует close */ });
  }

  open();
}
