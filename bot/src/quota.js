// Суточный лимит запросов к GC (как у deadlock-api: 40 на аккаунт за 24 часа)
// и пауза после ответа «Rate Limited». Хранится в data/quota.json, переживает перезапуск.
import fs from 'node:fs';

const DAY = 24 * 60 * 60 * 1000;
const RATE_LIMIT_PAUSE = 60 * 60 * 1000;

export class Quota {
  constructor(file, limit) {
    this.file = file;
    this.limit = limit;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* первый запуск */ }
    this.hits = Array.isArray(saved.hits) ? saved.hits : [];
    this.pausedUntil = saved.pausedUntil || 0;
  }

  left(now = Date.now()) {
    this.hits = this.hits.filter((t) => t > now - DAY);
    return now < this.pausedUntil ? 0 : Math.max(0, this.limit - this.hits.length);
  }

  // Когда снова можно будет сделать запрос, мс от now
  waitMs(now = Date.now()) {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    if (this.left(now) > 0) return 0;
    return this.hits[0] + DAY - now;
  }

  take(now = Date.now()) {
    if (this.left(now) <= 0) return false;
    this.hits.push(now);
    this._save();
    return true;
  }

  pause(now = Date.now()) {
    this.pausedUntil = now + RATE_LIMIT_PAUSE;
    this._save();
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify({ hits: this.hits, pausedUntil: this.pausedUntil }));
  }
}
