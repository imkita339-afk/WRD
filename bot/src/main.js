// Steam-бот WHO RUINED?
//   node src/main.js              — работать: ждать запросы прокси
//   node src/main.js --match ID   — загрузить один матч и вывести сводку (проверка)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeadlockGC } from './steam.js';
import { Quota } from './quota.js';
import { fetchMatch } from './match.js';
import { connectHub } from './hub.js';
import { ask, log } from './util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const tokenFile = path.join(DATA, 'refresh-token.txt');
const botTokenFile = path.join(DATA, 'bot-token.txt');

const quota = new Quota(path.join(DATA, 'quota.json'), config.dailyLimit);
const gc = new DeadlockGC({ tokenFile });

let credentials = null;
if (!fs.existsSync(tokenFile)) {
  log('Первый вход. Используйте отдельный Steam-аккаунт с доступом к Deadlock, не основной.');
  const accountName = await ask('Логин Steam: ');
  const password = await ask('Пароль (не отображается): ', { hidden: true });
  credentials = { accountName, password };
}
gc.start(credentials);
credentials = null;

const testIdx = process.argv.indexOf('--match');
if (testIdx > 0) {
  const id = Number(process.argv[testIdx + 1]);
  gc.once('ready', async () => {
    try {
      const r = await fetchMatch(gc, quota, id);
      if (r.status !== 'ok') log(`Матч ${id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
      else {
        const mi = r.match.match_info;
        log(`Матч ${id}: ${mi.players.length} игроков, ${Math.round(mi.duration_s / 60)} мин, победила команда ${mi.winning_team}.`);
      }
    } catch (e) {
      log(`Матч ${id}: ошибка ${e.message}`);
    }
    log(`Осталось запросов на сутки: ${quota.left()}`);
    gc.client.logOff();
    setTimeout(() => process.exit(0), 1000);
  });
} else {
  if (!fs.existsSync(botTokenFile)) {
    log(`Нет ${botTokenFile} — токена для связи с прокси. Он создаётся при настройке (см. README).`);
    process.exit(2);
  }
  const token = fs.readFileSync(botTokenFile, 'utf8').trim();
  gc.once('ready', () => connectHub({ url: config.proxy, token, gc, quota }));
}
