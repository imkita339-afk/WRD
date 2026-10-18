'use strict';

/*
 * WHO RUINED? — Deadlock Match Forensics
 * Загрузка данных матча, определение ролей, скоринг и рендер страницы.
 * Вспомогательные модули (i18n, кэш, история, карточка, «адвокат») — в extras.js.
 */
(function () {
  const WR = window.WR;
  const { t, tf, esc } = WR;

  // ======================================================================
  // Конфиг: все коэффициенты модели оценки в одном месте
  // ======================================================================
  const CFG = {
    // Свой прокси (worker/) из index.html, иначе — напрямую к deadlock-api.com
    api: (window.WR_API || 'https://api.deadlock-api.com').replace(/\/+$/, ''),
    direct: 'https://api.deadlock-api.com',  // картинки рангов, новые матчи и запасной путь
    assetsTTL: 24 * 60 * 60 * 1000,   // справочники героев/предметов/рангов — 24 часа
    requestTimeout: 45000,            // с запасом на загрузку матча через своего Steam-бота
    proxyStoreDelay: 5000,            // через сколько мс после прямой загрузки матча просить прокси сохранить его
    defaultCooldown: 60,              // пауза при 429/503 без Retry-After, секунды
    teams: { 0: 'Amber Hand', 1: 'Sapphire Flame' },

    // Ориентир souls/min для 30-минутной игры в среднем ранге
    spm: { carry: 1200, spirit: 1150, tank: 1050, support: 950 },
    // Чем дольше игра, тем выше нормальный souls/min
    durationMul: { refMin: 30, base: 0.75, perRef: 0.25, min: 0.75, max: 1.2 },
    // Калибровка по среднему рангу лобби: центр — Ritualist (6)
    rankMul: { center: 6, step: 0.025, min: 0.85, max: 1.15 },

    // Ориентиры долей команды по роли
    dmgShare: { carry: 0.20, spirit: 0.19, tank: 0.15, support: 0.12 },
    objShare: { carry: 0.19, spirit: 0.17, tank: 0.16, support: 0.12 },
    kp: { carry: 0.55, spirit: 0.55, tank: 0.55, support: 0.60 },
    utilPerMin: 90,                   // хил союзников + срезанный хил врагов в минуту

    // Веса компонентов штрафа по роли (utility — только support)
    weights: {
      carry:   { farm: 0.30, fight: 0.30, error: 0.22, obj: 0.18, utility: 0 },
      spirit:  { farm: 0.28, fight: 0.31, error: 0.23, obj: 0.18, utility: 0 },
      tank:    { farm: 0.20, fight: 0.33, error: 0.26, obj: 0.21, utility: 0 },
      support: { farm: 0.10, fight: 0.27, error: 0.23, obj: 0.12, utility: 0.28 },
    },
    scoreScale: 125,                  // сумма взвешенных штрафов (0..1) → очки

    farm: { start: 0.95, span: 0.35 },              // штраф растёт ниже 95% ориентира
    fight: { dmgSpan: 0.5, kpSpan: 0.35, fdStart: 0.8, fdSpan: 0.8, mix: [0.5, 0.3, 0.2] },
    error: { lateWeight: 0.8, lateFrom: 1500, relStart: 0.85, relSpan: 0.8, per10Start: 2.0, per10Span: 2.5, mix: [0.6, 0.4] },
    obj: { span: 0.6 },
    reasonMin: 0.15,                  // компонент с меньшим штрафом в причины не попадает

    waste: { nwRatio: 1.1, dmgRatio: 0.9, objRatio: 0.9, penalty: 10 },

    // Сигналы по предметам; имена ищутся в справочнике предметов API
    items: {
      cap: 10,
      defensive: {
        minMinutes: 30, penalty: 5,
        names: ['Bullet Resilience', 'Spirit Resilience', 'Fortitude', 'Metal Skin', 'Colossus', 'Plated Armor',
          'Witchmail', "Diviner's Kevlar", 'Juggernaut', 'Cheat Death', 'Divine Barrier', 'Ethereal Shift',
          'Unstoppable', 'Spellbreaker', 'Leech', 'Counterspell'],
      },
      antiHeal: { minEnemyHealPerMin: 1500, penalty: 4, names: ['Healbane', 'Toxic Bullets', 'Decay', 'Inhibitor'] },
      antiCC: { minMinutes: 25, deathsPer10: 3, penalty: 3, names: ['Debuff Reducer', 'Dispel Magic', 'Unstoppable'] },
      lateTier: { minMinutes: 35, minTier: 4, penalty: 4 },
    },

    role: {
      minSpend: 4000,
      confSpan: 1.2,
      supportBias: -0.5,
      heroPrior: {
        marksman: { carry: 0.35 },
        assassin: { carry: 0.2 },
        mystic: { spirit: 0.35 },
        brawler: { tank: 0.35 },
      },
      fallbackOrder: ['carry', 'carry', 'spirit', 'spirit', 'tank', 'support'],
    },

    afk: { spmRatio: 0.45, minDmgShare: 0.03, minMinutes: 10 },
    fightGap: 15,                     // смерти с разрывом ≤15 с — одна драка
    fightMinDeaths: 2,
    phases: [
      { key: 'lane', from: 0, to: 600 },
      { key: 'mid', from: 600, to: 1500 },
      { key: 'late', from: 1500, to: Infinity },
    ],
    phaseSwing: 1500,                 // изменение разницы souls, при котором фаза считается выигранной/проигранной
    objAfterFight: 90,                // объект, павший в течение N с после драки, связывается с ней
    confidence: { base: 45, timeline: 12, deaths: 10, objectives: 8, role: 12, gap: 7, min: 45, max: 94 },
    levels: [[75, 'Очень высокое', 4], [55, 'Высокое', 3], [35, 'Умеренное', 2], [20, 'Небольшое', 1], [0, 'Низкое', 0]],
    rankNames: ['Obscurus', 'Initiate', 'Seeker', 'Acolyte', 'Sentinel', 'Mystic', 'Ritualist', 'Emissary',
      'Oracle', 'Phantom', 'Ascendant', 'Eternus'],
    maxEpisodes: 10,
    episodeCaps: { fight: 5, solo: 2, obj: 4, boss: 2 },
  };

  const ROLE_LABEL = { carry: 'Carry / Core', spirit: 'Spirit Core', tank: 'Frontline / Tank', support: 'Support / Utility' };
  const COMP_LABEL = { farm: 'Экономика', fight: 'Драки', error: 'Цена смертей', obj: 'Объекты', utility: 'Поддержка' };
  const SLOT_ORDER = { weapon: 0, vitality: 1, spirit: 2 };

  // team_objective_id → тип объекта (ECitadelTeamObjective)
  function objType(id) {
    if (id >= 1 && id <= 4) return 'Guardian';
    if (id >= 5 && id <= 8) return 'Walker';
    if (id === 10 || id === 11) return 'Shrine';
    if (id >= 12 && id <= 15) return 'Base Guardian';
    if (id === 0 || id === 9) return 'Patron';
    return 'Objective';
  }
  const OBJ_WEIGHT = { Guardian: 1.2, Walker: 2, 'Base Guardian': 2.5, Shrine: 3, Patron: 3, Objective: 1 };
  const OBJ_WHY = {
    Guardian: 'Открывает линию: сопернику — souls и контроль карты.',
    Walker: 'Walker — ключевой объект линии: без него база становится уязвимой.',
    'Base Guardian': 'Base Guardian защищает вход на базу — дальше путь к Shrines и Patron.',
    Shrine: 'Shrines защищают Patron: без них поражение уже близко.',
    Patron: 'Финальный объект — матч решён.',
    Objective: 'Потеря объекта сдвигает карту в пользу соперника.',
  };

  // ======================================================================
  // Утилиты
  // ======================================================================
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : Number(x) || 0);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const clamp01 = (x) => clamp(isFinite(x) ? x : 0, 0, 1);
  const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
  const mean = (arr, f) => (arr.length ? sum(arr, f) / arr.length : 0);
  const pct = (x) => Math.round((x || 0) * 100);
  const fmt = WR.num;
  const time = WR.time;
  const $ = (id) => document.getElementById(id);
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
  const img = (src, alt, cls) => {
    const s = safeUrl(src);
    return s ? `<img src="${esc(s)}" alt="${esc(alt || '')}"${cls ? ` class="${cls}"` : ''} loading="lazy" decoding="async">`
      : `<img alt=""${cls ? ` class="${cls}"` : ''} src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`;
  };
  const teamSpan = (team) => `<span class="team-${team}">${esc(CFG.teams[team] || '')}</span>`;
  const kda = (p) => `${p.k}/${p.d}/${p.a}`;

  // ======================================================================
  // API
  // ======================================================================
  class ApiError extends Error {
    constructor(kind, status, retryAfter) {
      super(kind);
      this.kind = kind;
      this.status = status || 0;
      this.retryAfter = retryAfter || 0;
    }
  }

  async function apiReachable() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(CFG.api + '/v1/assets/ranks', { signal: ctrl.signal });
      return r.ok;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function api(path, base = CFG.api) {
    const until = WR.cooldown.get();
    if (until > Date.now()) throw new ApiError('rate', 429, Math.ceil((until - Date.now()) / 1000));
    if (navigator.onLine === false) throw new ApiError('offline');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.requestTimeout);
    let res;
    try {
      res = await fetch(base + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      if (navigator.onLine === false) throw new ApiError('offline');
      // Свой прокси не отвечает — идём к deadlock-api.com напрямую
      if (base !== CFG.direct) return api(path, CFG.direct);
      if (e && e.name === 'AbortError') throw new ApiError('timeout');
      // Ошибки Cloudflare (502/530 и т. п.) приходят без CORS-заголовков и выглядят как обрыв сети.
      // Если закэшированный справочник отвечает — сеть в порядке, лежит сервер API.
      throw new ApiError((await apiReachable()) ? 'down' : 'network');
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      try { return await res.json(); } catch (e) { throw new ApiError('data', res.status); }
    }
    const ra = parseInt(res.headers.get('Retry-After') || '', 10);
    // Часовой лимит на загрузку новых матчей из Steam (3 в час на IP): остальные запросы
    // при этом работают, поэтому общую паузу не ставим
    const period = parseInt(res.headers.get('RateLimit-Period') || '', 10);
    if (res.status === 429 && period >= 600) throw new ApiError('steamlimit', 429, ra > 0 ? ra : period);
    // «Steam is busy»: долгий Retry-After относится только к загрузке этого матча из Steam
    if (res.status === 503 && ra >= 120) throw new ApiError('steambusy', 503, ra);
    if (res.status === 429 || (res.status === 503 && ra > 0)) {
      const s = ra > 0 ? ra : CFG.defaultCooldown;
      WR.cooldown.set(Date.now() + s * 1000);
      throw new ApiError('rate', res.status, s);
    }
    // Прокси отвечает 502, когда сам deadlock-api.com недоступен
    if (res.status === 502) throw new ApiError('down', 502);
    // Прокси без ключа: матча нет в базе deadlock-api.com, грузить из Steam надо напрямую
    if (res.status === 404 && res.headers.get('X-WR-Direct')) throw new ApiError('direct', 404);
    if (res.status === 404) throw new ApiError('notfound', 404);
    if (res.status === 400) throw new ApiError('bad', 400);
    if (res.status === 503) throw new ApiError('unavailable', 503);
    throw new ApiError('server', res.status);
  }

  // ---------- справочники ----------
  const slimHeroes = (arr) => (Array.isArray(arr) ? arr : []).map((h) => {
    const im = h.images || {};
    return {
      id: h.id, name: h.name, type: h.hero_type || null,
      card: im.icon_hero_card_webp || im.icon_hero_card || '',
      small: im.icon_image_small_webp || im.icon_image_small || im.icon_hero_card_webp || '',
    };
  });
  const slimItems = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((i) => i && i.type === 'upgrade')
    .map((i) => ({
      id: i.id, name: i.name, slot: i.item_slot_type || null, tier: num(i.item_tier), cost: num(i.cost),
      img: i.shop_image_webp || i.shop_image || i.image_webp || i.image || '',
    }));
  const slimRanks = (arr) => (Array.isArray(arr) ? arr : []).map((r) => ({
    tier: r.tier, name: r.name, color: r.color,
    img: (r.images && (r.images.large_webp || r.images.large)) || '',
  }));

  async function cachedAsset(key, path, slim) {
    const hit = WR.store.get('asset:' + key, CFG.assetsTTL);
    if (hit) return hit;
    const data = slim(await api(path));
    WR.store.set('asset:' + key, data);
    return data;
  }

  let ASSETS = null;       // полный набор справочников (кэшируется в памяти)
  let ASSETS_CUR = null;   // последний загруженный набор, даже неполный
  async function loadAssets() {
    if (ASSETS) return ASSETS;
    const [heroes, items, ranks] = await Promise.all([
      cachedAsset('heroes', '/v1/assets/heroes', slimHeroes),
      cachedAsset('items', '/v1/assets/items', slimItems),
      cachedAsset('ranks', '/v1/assets/ranks', slimRanks),
    ].map((p) => p.catch((e) => { if (e && e.kind === 'rate') throw e; return null; })));
    const res = {
      heroes: new Map((heroes || []).map((h) => [h.id, h])),
      items: new Map((items || []).map((i) => [i.id, i])),
      itemsByName: new Map((items || []).map((i) => [i.name, i])),
      ranks: new Map((ranks || []).map((r) => [r.tier, r])),
      hasItems: !!(items && items.length),
    };
    if (heroes && items && ranks) ASSETS = res;
    ASSETS_CUR = res;
    return res;
  }

  // ---------- матч ----------
  function slimMatch(mi) {
    const st = (s) => ({
      t: num(s.time_stamp_s), nw: num(s.net_worth), k: num(s.kills), d: num(s.deaths), a: num(s.assists),
      dmg: num(s.player_damage), taken: num(s.player_damage_taken), mit: num(s.damage_mitigated),
      heal: num(s.player_healing), allyHeal: num(s.teammate_healing), allyBar: num(s.teammate_barriering),
      healPrev: num(s.heal_prevented), boss: num(s.boss_damage), loss: num(s.gold_death_loss),
    });
    return {
      v: 1,
      id: num(mi.match_id),
      duration: num(mi.duration_s),
      winner: mi.winning_team,
      start: num(mi.start_time),
      mode: num(mi.match_mode),
      objectives: (mi.objectives || []).map((o) => ({ team: o.team, id: num(o.team_objective_id), at: num(o.destroyed_time_s) })),
      midBoss: (mi.mid_boss || []).map((b) => ({ killed: b.team_killed, claimed: b.team_claimed, at: num(b.destroyed_time_s) })),
      players: (mi.players || []).map((p) => ({
        acc: num(p.account_id), slot: p.player_slot, team: p.team, hero: num(p.hero_id),
        k: num(p.kills), d: num(p.deaths), a: num(p.assists), nw: num(p.net_worth),
        lh: num(p.last_hits), dn: num(p.denies), lvl: num(p.level), abandon: num(p.abandon_match_time_s),
        badge: num(p.player_rank_data && p.player_rank_data.initial_display_rank),
        deaths: (p.death_details || []).map((x) => ({ t: num(x.game_time_s), killer: x.killer_player_slot })),
        items: (p.items || []).map((x) => ({ id: num(x.item_id), t: num(x.game_time_s), sold: num(x.sold_time_s) })),
        stats: (p.stats || []).map(st),
      })),
      profiles: {},
      ranks: {},
    };
  }

  // Новый матч, которого нет в базе deadlock-api.com, грузится из Steam с IP посетителя
  // (3 в час на IP): через прокси этот лимит делили бы все. После загрузки матч уже в базе,
  // и прокси сохраняет его у себя — следующие посетители получат его без лимита.
  async function matchMetadata(id) {
    const path = `/v1/matches/${id}/metadata`;
    try {
      return await api(path);
    } catch (e) {
      if (e.kind !== 'direct') throw e;
    }
    const raw = await api(path, CFG.direct);
    setTimeout(() => fetch(CFG.api + path).catch(() => {}), CFG.proxyStoreDelay);
    return raw;
  }

  async function loadMatchData(id, onStep) {
    const cached = WR.matchCache.get(id);
    if (cached && cached.v === 1) return Object.assign(cached, { fromCache: true });
    const raw = await matchMetadata(id);
    const mi = raw && (raw.match_info || raw);
    if (!mi || !Array.isArray(mi.players) || !mi.players.length) throw new ApiError('data');
    const S = slimMatch(mi);
    const ids = [...new Set(S.players.map((p) => p.acc).filter((x) => x > 0))];
    if (ids.length) {
      onStep && onStep();
      const needRank = S.players.filter((p) => p.acc > 0 && !p.badge).map((p) => p.acc);
      const [profiles, ranks] = await Promise.all([
        api(`/v1/players/steam?account_ids=${ids.join(',')}`).catch(() => []),
        needRank.length ? api(`/v1/players/rank?account_ids=${needRank.join(',')}`).catch(() => []) : [],
      ]);
      (Array.isArray(profiles) ? profiles : []).forEach((pr) => {
        S.profiles[pr.account_id] = { n: pr.personaname || '', av: pr.avatarmedium || pr.avatar || '', url: pr.profileurl || '' };
      });
      (Array.isArray(ranks) ? ranks : []).forEach((r) => { if (r && r.badge) S.ranks[r.account_id] = num(r.badge); });
    }
    WR.matchCache.put(id, S);
    return S;
  }

  // ======================================================================
  // Ранги
  // ======================================================================
  function rankInfo(badge) {
    const b = num(badge);
    const tier = Math.floor(b / 10);
    const sub = b % 10;
    const R = ASSETS_CUR && ASSETS_CUR.ranks;
    const r = R && R.get(tier);
    if (!b || tier < 1) {
      const r0 = R && R.get(0);
      return { tier: 0, sub: 0, name: t('Без ранга'), icon: (r0 && r0.img) || '', color: '#666' };
    }
    const base = (r && r.name) || CFG.rankNames[tier] || `Tier ${tier}`;
    const icon = tier <= 11 && sub >= 1 && sub <= 6
      ? `${CFG.direct}/v1/assets/ranks/${tier}/${sub}/image?format=webp`
      : (r && r.img) || '';
    return { tier, sub, name: sub ? `${base} ${sub}` : base, icon, color: (r && r.color) || '#999' };
  }
  function rankHtml(p) {
    const r = rankInfo(p.badge);
    const live = p.rankLive ? ` title="${esc(t('Текущий ранг игрока (в данных матча ранга нет)'))}"` : '';
    return `<span class="rank"${live}>${r.icon ? img(r.icon, r.name) : ''}<span>${esc(r.name)}${p.rankLive ? '*' : ''}</span></span>`;
  }

  // ======================================================================
  // Нормализация
  // ======================================================================
  function buildMatch(S, AS) {
    const players = S.players.map((p) => {
      const hero = AS.heroes.get(p.hero) || { id: p.hero, name: `Hero #${p.hero}`, card: '', small: '', type: null };
      const stats = p.stats.slice().sort((a, b) => a.t - b.t);
      const last = stats.length ? stats[stats.length - 1] : {};
      const prof = S.profiles[p.acc];
      const bought = p.items.map((x) => {
        const info = AS.items.get(x.id);
        return info ? Object.assign({}, info, { t: x.t, sold: x.sold }) : null;
      }).filter(Boolean);
      const build = bought.filter((x) => !x.sold)
        .sort((a, b) => (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9) || b.tier - a.tier);
      return {
        slot: p.slot, accountId: p.acc, team: p.team, hero,
        name: (prof && prof.n) || hero.name, anon: !(prof && prof.n),
        avatar: prof && prof.av, profileUrl: prof && prof.url,
        badge: p.badge || S.ranks[p.acc] || 0, rankLive: !p.badge && !!S.ranks[p.acc],
        k: p.k, d: p.d, a: p.a, nw: p.nw || num(last.nw), lh: p.lh, dn: p.dn, lvl: p.lvl,
        abandon: p.abandon,
        deaths: p.deaths.slice().sort((a, b) => a.t - b.t),
        stats,
        heroDmg: num(last.dmg), objDmg: num(last.boss), heal: num(last.heal),
        util: num(last.allyHeal) + num(last.allyBar) + num(last.healPrev),
        allyUtil: num(last.allyHeal) + num(last.allyBar),
        taken: num(last.taken) + num(last.mit), deathLoss: num(last.loss),
        bought, build,
      };
    });
    return {
      id: S.id, duration: Math.max(S.duration, 60), winner: S.winner, start: S.start, mode: S.mode,
      objectives: S.objectives, midBoss: S.midBoss, players,
      hasTimeline: players.some((p) => p.stats.length >= 3),
      hasDeaths: players.some((p) => p.deaths.length > 0),
      hasObjectives: S.objectives.some((o) => o.at > 0),
      hasItems: AS.hasItems,
      itemsByName: AS.itemsByName,
      fromCache: !!S.fromCache,
    };
  }

  // ======================================================================
  // Анализ
  // ======================================================================
  function analyze(M) {
    if (M.winner !== 0 && M.winner !== 1) throw new ApiError('nowinner');
    const dur = M.duration;
    const mins = dur / 60;
    const winner = M.winner;
    const loser = 1 - winner;
    const players = M.players;
    const byTeam = { 0: players.filter((p) => p.team === 0), 1: players.filter((p) => p.team === 1) };
    if (!byTeam[0].length || !byTeam[1].length) throw new ApiError('data');

    const team = {};
    [0, 1].forEach((tm) => {
      const L = byTeam[tm];
      team[tm] = {
        nw: sum(L, (p) => p.nw), kills: sum(L, (p) => p.k), deaths: sum(L, (p) => p.d),
        dmg: sum(L, (p) => p.heroDmg), obj: sum(L, (p) => p.objDmg), heal: sum(L, (p) => p.heal),
        util: sum(L, (p) => p.util), n: L.length,
      };
    });

    // Драки: кластеры смертей
    const fightsData = buildFights(players);

    // Базовые производные метрики
    players.forEach((p) => {
      const T = team[p.team];
      const n = T.n;
      p.spm = p.nw / mins;
      p.nwShare = T.nw ? p.nw / T.nw : 1 / n;
      p.dmgShare = T.dmg ? p.heroDmg / T.dmg : 1 / n;
      p.objShare = T.obj ? p.objDmg / T.obj : 1 / n;
      p.kp = T.kills ? (p.k + p.a) / T.kills : 0;
      p.dp10 = p.d / (mins / 10);
      p.utilPerMin = p.util / mins;
      p.leaver = p.abandon > 0;
      if (p.deaths.length) {
        p.wDeaths = sum(p.deaths, (d) => 1 + CFG.error.lateWeight * (d.t / 1800));
        p.lateDeaths = p.deaths.filter((d) => d.t >= CFG.error.lateFrom).length;
      } else {
        p.wDeaths = p.d * (1 + CFG.error.lateWeight * 0.5 * Math.min(1, dur / 1800));
        p.lateDeaths = null;
      }
      p.fightDeaths = p.deaths.filter((d) => d.cluster && d.cluster.size >= CFG.fightMinDeaths).length;
      p.soloDeaths = p.deaths.length - p.fightDeaths;
    });
    [0, 1].forEach((tm) => {
      const L = byTeam[tm];
      const avgSpm = mean(L, (p) => p.spm);
      L.forEach((p) => {
        p.afk = !p.leaver && mins >= CFG.afk.minMinutes &&
          (p.spm < CFG.afk.spmRatio * avgSpm || p.dmgShare < CFG.afk.minDmgShare);
        p.excluded = p.leaver || p.afk;
      });
      assignRoles(L);
    });

    // Калибровка ориентиров
    const tiers = players.map((p) => Math.floor(p.badge / 10)).filter((x) => x >= 1 && x <= 11);
    const lobbyTier = tiers.length ? mean(tiers) : null;
    const rankMul = lobbyTier == null ? 1 : clamp(1 + (lobbyTier - CFG.rankMul.center) * CFG.rankMul.step, CFG.rankMul.min, CFG.rankMul.max);
    const D = CFG.durationMul;
    const durMul = clamp(D.base + D.perRef * (mins / D.refMin), D.min, D.max);

    const enemyHealPerMin = { 0: team[1].heal / mins, 1: team[0].heal / mins };
    const ctx = { mins, dur, rankMul, durMul, enemyHealPerMin, M, byTeam, team };

    players.forEach((p) => scorePlayer(p, ctx));
    [0, 1].forEach((tm) => {
      const L = byTeam[tm];
      const avgW = mean(L, (p) => p.wDeaths) || 1;
      L.forEach((p) => { p.perf = perfIndex(p, avgW, L.length); });
    });

    const eligible = byTeam[loser].filter((p) => !p.excluded).sort((a, b) => b.score - a.score);
    const ruiner = eligible[0] || null;
    const near = eligible[1] || null;

    const winners = byTeam[winner].slice().sort((a, b) => b.perf - a.perf);
    const mvp = winners[0];
    const bestLoser = byTeam[loser].filter((p) => !p.excluded).sort((a, b) => b.perf - a.perf)[0] || null;
    const risky = players.filter((p) => !p.leaver).sort((a, b) => (b.wDeaths / mins) - (a.wDeaths / mins))[0];

    const curve = M.hasTimeline ? buildCurve(players) : null;

    const A = {
      M, id: M.id, dur, mins, winner, loser, players, byTeam, team, eligible, ruiner, near, mvp, bestLoser, risky,
      fights: fightsData.fights, curve, lobbyTier, rankMul, durMul, enemyHealPerMin, CFG, ROLE_LABEL,
    };
    A.phases = buildPhases(A);
    A.turning = buildTurning(A);
    A.episodes = buildEpisodes(A);
    A.lesson = buildLesson(A);
    A.fair = buildFair(A);
    A.confidence = buildConfidence(A);
    return A;
  }

  function buildFights(players) {
    const all = [];
    players.forEach((p) => p.deaths.forEach((d) => { d.team = p.team; d.player = p; all.push(d); }));
    all.sort((a, b) => a.t - b.t);
    const clusters = [];
    let cur = null;
    all.forEach((d) => {
      if (cur && d.t - cur.end <= CFG.fightGap) { cur.deaths.push(d); cur.end = d.t; }
      else { cur = { start: d.t, end: d.t, deaths: [d] }; clusters.push(cur); }
      d.cluster = cur;
    });
    clusters.forEach((c) => {
      c.size = c.deaths.length;
      c.dead = { 0: c.deaths.filter((d) => d.team === 0).length, 1: c.deaths.filter((d) => d.team === 1).length };
      c.winner = c.dead[0] === c.dead[1] ? null : (c.dead[0] < c.dead[1] ? 0 : 1);
    });
    return { clusters, fights: clusters.filter((c) => c.size >= CFG.fightMinDeaths) };
  }

  function assignRoles(L) {
    const n = L.length || 1;
    const avgTaken = mean(L, (p) => p.taken) || 1;
    const avgAlly = mean(L, (p) => p.allyUtil) || 1;
    const fallback = [];
    L.forEach((p) => {
      const spend = { weapon: 0, vitality: 0, spirit: 0 };
      p.bought.forEach((i) => { if (spend[i.slot] != null) spend[i.slot] += i.cost || 0; });
      const total = spend.weapon + spend.vitality + spend.spirit;
      p.slotMix = total ? { weapon: spend.weapon / total, vitality: spend.vitality / total, spirit: spend.spirit / total } : null;
      if (total < CFG.role.minSpend || p.bought.length < 3) { fallback.push(p); return; }
      const r = p.nwShare * n;
      const takenR = p.taken / avgTaken;
      const utilR = clamp(p.allyUtil / avgAlly, 0, 2.5);
      const assistR = (p.k + p.a) ? p.a / (p.k + p.a) : 0.5;
      const prior = CFG.role.heroPrior[p.hero.type] || {};
      const m = p.slotMix;
      const s = {
        carry: 2 * (r - 1) + 4 * (m.weapon - 1 / 3) + (prior.carry || 0),
        spirit: 2 * (r - 1) + 4 * (m.spirit - 1 / 3) + (prior.spirit || 0),
        tank: 4 * (m.vitality - 1 / 3) + 1.5 * (takenR - 1) + (prior.tank || 0),
        support: 3 * (1 - r) + 0.8 * (utilR - 1) + 2 * (assistR - 0.65) + CFG.role.supportBias,
      };
      const ranked = Object.entries(s).sort((a, b) => b[1] - a[1]);
      p.role = ranked[0][0];
      p.roleConf = clamp01((ranked[0][1] - ranked[1][1]) / CFG.role.confSpan);
      p.roleFallback = false;
    });
    if (fallback.length) {
      const order = L.slice().sort((a, b) => b.nw - a.nw);
      fallback.forEach((p) => {
        p.role = CFG.role.fallbackOrder[Math.min(order.indexOf(p), CFG.role.fallbackOrder.length - 1)] || 'carry';
        p.roleConf = 0.2;
        p.roleFallback = true;
      });
    }
  }

  function hasAny(p, names, M) {
    const ids = new Set(names.map((nm) => M.itemsByName.get(nm)).filter(Boolean).map((i) => i.id));
    // засчитываем любой купленный за матч предмет: проданный/улучшенный тоже был в сборке
    return p.bought.some((i) => ids.has(i.id));
  }
  const knownNames = (names, M) => names.filter((nm) => M.itemsByName.has(nm));

  function scorePlayer(p, ctx) {
    const { mins, M, byTeam } = ctx;
    const role = p.role;
    const W = CFG.weights[role];
    const L = byTeam[p.team];
    const reasons = [];
    const comps = {};
    const add = (key, pv, title, detail) => {
      const pts = pv * W[key] * CFG.scoreScale;
      comps[key] = { p: pv, w: W[key], pts };
      if (pv >= CFG.reasonMin && pts > 0.5) reasons.push({ key, title, detail, pts });
    };

    // farm
    p.expSpm = CFG.spm[role] * ctx.rankMul * ctx.durMul;
    p.farmR = p.spm / p.expSpm;
    add('farm', clamp01((CFG.farm.start - p.farmR) / CFG.farm.span), 'Фарм ниже ориентира',
      tf('{spm} souls/min — {pct}% от ориентира {exp} для роли «{role}»', { spm: fmt(p.spm), pct: pct(p.farmR), exp: fmt(p.expSpm), role: ROLE_LABEL[role] }));

    // fight
    const dmgR = p.dmgShare / CFG.dmgShare[role];
    const pDmg = clamp01((1 - dmgR) / CFG.fight.dmgSpan);
    const pKp = clamp01((CFG.kp[role] - p.kp) / CFG.fight.kpSpan);
    const fdAvg = mean(L, (x) => x.fightDeaths) || 1;
    const pFd = dmgR < 0.85 && p.fightDeaths > 0 ? clamp01((p.fightDeaths / fdAvg - CFG.fight.fdStart) / CFG.fight.fdSpan) : 0;
    const fm = CFG.fight.mix;
    add('fight', fm[0] * pDmg + fm[1] * pKp + fm[2] * pFd, 'Слабое участие в драках',
      M.hasDeaths
        ? tf('Доля урона по героям {share}% (ориентир {base}%), участие в убийствах {kp}%, смертей в драках: {fd}', { share: pct(p.dmgShare), base: pct(CFG.dmgShare[role]), kp: pct(p.kp), fd: p.fightDeaths })
        : tf('Доля урона по героям {share}% (ориентир {base}%), участие в убийствах {kp}%', { share: pct(p.dmgShare), base: pct(CFG.dmgShare[role]), kp: pct(p.kp) }));

    // error
    const avgW = mean(L, (x) => x.wDeaths) || 1;
    const pRel = clamp01((p.wDeaths / avgW - CFG.error.relStart) / CFG.error.relSpan);
    const pAbs = clamp01((p.dp10 - CFG.error.per10Start) / CFG.error.per10Span);
    const em = CFG.error.mix;
    add('error', em[0] * pRel + em[1] * pAbs, 'Дорогие смерти',
      p.lateDeaths != null
        ? tf('Смертей: {d} ({dp10} за 10 мин), из них {late} после 25-й минуты; потеряно {loss} souls', { d: p.d, dp10: p.dp10.toFixed(1), late: p.lateDeaths, loss: fmt(p.deathLoss) })
        : tf('Смертей: {d} ({dp10} за 10 мин) — больше, чем в среднем по команде', { d: p.d, dp10: p.dp10.toFixed(1) }));

    // obj
    const objR = p.objShare / CFG.objShare[role];
    add('obj', clamp01((1 - objR) / CFG.obj.span), 'Мало давления на объекты',
      tf('Урон по объектам {obj} — {share}% от командного (ориентир {base}%)', { obj: fmt(p.objDmg), share: pct(p.objShare), base: pct(CFG.objShare[role]) }));

    // utility (только support)
    const pUtil = role === 'support' ? clamp01(1 - p.utilPerMin / CFG.utilPerMin) : 0;
    add('utility', pUtil, 'Мало поддержки союзников',
      tf('Хил союзников и срезанный хил врагов: {util}/мин (ориентир {base}/мин)', { util: fmt(p.utilPerMin), base: fmt(CFG.utilPerMin) }));

    let extra = 0;
    // resource waste
    const nwR = p.nwShare * L.length;
    if (nwR >= CFG.waste.nwRatio && dmgR < CFG.waste.dmgRatio && objR < CFG.waste.objRatio) {
      extra += CFG.waste.penalty;
      reasons.push({ key: 'waste', title: 'Ресурсы не конвертированы в давление', pts: CFG.waste.penalty,
        detail: tf('{nw}% souls команды, но урон по героям — {dmg}%, по объектам — {obj}% от ориентира роли', { nw: pct(p.nwShare), dmg: pct(dmgR), obj: pct(objR) }) });
    }

    // сигналы по предметам
    let itemPts = 0;
    if (M.hasItems && p.bought.length) {
      const I = CFG.items;
      const core = role === 'carry' || role === 'spirit';
      const teamAvgD = mean(L, (x) => x.d);
      const list = (names) => knownNames(names, M).slice(0, 4).join(', ');
      if (core && mins >= I.defensive.minMinutes && p.d >= teamAvgD && knownNames(I.defensive.names, M).length && !hasAny(p, I.defensive.names, M)) {
        itemPts += I.defensive.penalty;
        reasons.push({ key: 'items', title: 'Нет защитных предметов в затяжной игре', pts: I.defensive.penalty,
          detail: tf('Игра шла {mins} мин, {d} смертей, но в сборке нет ничего из: {list}…', { mins: Math.round(mins), d: p.d, list: list(I.defensive.names) }) });
      }
      const enemyHeal = ctx.enemyHealPerMin[p.team];
      const teamHasAH = L.filter((x) => hasAny(x, I.antiHeal.names, M)).length;
      if (core && enemyHeal >= I.antiHeal.minEnemyHealPerMin && teamHasAH <= 1 && knownNames(I.antiHeal.names, M).length && !hasAny(p, I.antiHeal.names, M)) {
        itemPts += I.antiHeal.penalty;
        reasons.push({ key: 'items', title: 'Нет анти-хила против сильного лечения', pts: I.antiHeal.penalty,
          detail: tf('Соперники лечились на {heal}/мин, а в сборке нет {list}', { heal: fmt(enemyHeal), list: list(I.antiHeal.names) }) });
      }
      if (role !== 'support' && mins >= I.antiCC.minMinutes && p.dp10 >= I.antiCC.deathsPer10 && knownNames(I.antiCC.names, M).length && !hasAny(p, I.antiCC.names, M)) {
        itemPts += I.antiCC.penalty;
        reasons.push({ key: 'items', title: 'Нет защиты от контроля', pts: I.antiCC.penalty,
          detail: tf('{dp10} смертей за 10 мин, но нет {list}', { dp10: p.dp10.toFixed(1), list: list(I.antiCC.names) }) });
      }
      const maxTier = Math.max(0, ...p.build.map((i) => i.tier));
      if (mins >= I.lateTier.minMinutes && maxTier && maxTier < I.lateTier.minTier) {
        itemPts += I.lateTier.penalty;
        reasons.push({ key: 'items', title: 'Нет предметов T4+ к лейту', pts: I.lateTier.penalty,
          detail: tf('Игра длилась {mins} мин, а самый дорогой предмет в сборке — T{tier}', { mins: Math.round(mins), tier: maxTier }) });
      }
      itemPts = Math.min(itemPts, CFG.items.cap);
    }
    extra += itemPts;

    const base = sum(Object.values(comps), (c) => c.pts);
    p.comps = comps;
    p.extraPts = extra;
    p.score = Math.round(clamp(base + extra, 0, 100));
    p.level = levelOf(p.score);
    p.reasons = reasons.sort((a, b) => b.pts - a.pts);
    p.dmgR = dmgR;
    p.objR = objR;
  }

  function levelOf(score) {
    const L = CFG.levels.find((l) => score >= l[0]) || CFG.levels[CFG.levels.length - 1];
    return { label: L[1], idx: L[2] };
  }

  function perfIndex(p, avgW, n) {
    return Math.round(
      25 * clamp01((p.dmgShare * n) / 1.6) +
      20 * clamp01(p.kp / 0.8) +
      15 * clamp01((p.objShare * n) / 1.6) +
      15 * clamp01((p.nwShare * n) / 1.3) +
      15 * (1 - clamp01((p.wDeaths / avgW) / 1.8)) +
      10 * clamp01(p.utilPerMin / CFG.utilPerMin)
    );
  }

  // ---------- таймлайн ----------
  function nwAt(p, tt) {
    let v = 0;
    for (const s of p.stats) { if (s.t <= tt) v = s.nw; else break; }
    return v;
  }
  function buildCurve(players) {
    const ref = players.reduce((a, p) => (p.stats.length > (a ? a.stats.length : 0) ? p : a), null);
    if (!ref || ref.stats.length < 3) return null;
    const pts = [{ t: 0, diff: 0 }];
    ref.stats.forEach((s) => {
      let n0 = 0, n1 = 0;
      players.forEach((p) => { const v = nwAt(p, s.t); if (p.team === 0) n0 += v; else n1 += v; });
      pts.push({ t: s.t, diff: n0 - n1, n0, n1 });
    });
    return pts;
  }
  function diffAt(curve, tt) {
    if (!curve || !curve.length) return 0;
    if (tt <= curve[0].t) return curve[0].diff;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (tt <= b.t) return a.diff + (b.diff - a.diff) * ((tt - a.t) / ((b.t - a.t) || 1));
    }
    return curve[curve.length - 1].diff;
  }
  // разница souls с точки зрения команды tm
  const diffFor = (A, tm, tt) => (tm === 0 ? 1 : -1) * diffAt(A.curve, tt);

  function buildPhases(A) {
    const { dur, loser, winner, ruiner } = A;
    return CFG.phases.map((ph) => {
      const out = { key: ph.key, from: ph.from, to: Math.min(ph.to, dur) };
      if (ph.from >= dur) { out.none = true; return out; }
      const inPh = (d) => d.t >= ph.from && d.t < out.to;
      out.loserDeaths = sum(A.byTeam[loser], (p) => p.deaths.filter(inPh).length);
      out.winnerDeaths = sum(A.byTeam[winner], (p) => p.deaths.filter(inPh).length);
      out.ruinerDeaths = ruiner ? ruiner.deaths.filter(inPh).length : 0;
      if (A.curve) {
        out.swing = diffFor(A, loser, out.to) - diffFor(A, loser, ph.from);
        out.endDiff = diffFor(A, loser, out.to);
        out.state = out.swing > CFG.phaseSwing ? 'won' : out.swing < -CFG.phaseSwing ? 'lost' : 'even';
      } else if (A.M.hasDeaths) {
        const dd = out.winnerDeaths - out.loserDeaths;
        out.state = dd >= 3 ? 'won' : dd <= -3 ? 'lost' : 'even';
      } else {
        out.state = 'unknown';
      }
      return out;
    });
  }

  function objectivesLostAfter(A, tm, tt) {
    return A.M.objectives.filter((o) => o.team === tm && o.at > tt && o.at <= tt + CFG.objAfterFight);
  }

  function buildTurning(A) {
    const { loser, ruiner, dur } = A;
    let best = null;
    A.fights.forEach((f) => {
      const margin = f.dead[loser] - f.dead[1 - loser];
      if (margin <= 0) return;
      const rDied = !!ruiner && f.deaths.some((d) => d.player === ruiner);
      const lost = objectivesLostAfter(A, loser, f.end);
      const w = margin + (rDied ? 1.5 : 0) + lost.length * 0.8 + f.start / dur;
      if (!best || w > best.w) best = { f, w, rDied, lost, margin };
    });
    return best;
  }

  function buildEpisodes(A) {
    const { M, loser, winner, ruiner, dur } = A;
    const L = CFG.teams[loser], Wn = CFG.teams[winner];
    const ev = [];
    if (M.hasDeaths || M.hasObjectives) {
      A.fights.forEach((f) => {
        if (f.size < 3 || f.winner == null) return;
        const ld = f.dead[loser], wd = f.dead[winner];
        const rDied = !!ruiner && f.deaths.some((d) => d.player === ruiner);
        if (f.winner === winner) {
          const lost = objectivesLostAfter(A, loser, f.end);
          if (ld - wd < 2 && f.start < 300) return;
          ev.push({ kind: 'fight', t: f.start, neg: true, w: 1.5 + 0.6 * (ld - wd) + (rDied ? 1 : 0) + lost.length * 0.8 + f.start / dur,
            title: tf('Проигранная драка {a}–{b}', { a: wd, b: ld }),
            what: rDied
              ? tf('{team} потеряла {ld} героев, соперник — {wd}. Среди погибших — {name}.', { team: L, ld, wd, name: ruiner.name })
              : tf('{team} потеряла {ld} героев, соперник — {wd}.', { team: L, ld, wd }),
            why: lost.length
              ? tf('Сразу после драки пал {obj} — проигранная драка превратилась в потерю карты.', { obj: objType(lost[0].id) })
              : t('Каждая проигранная драка — это потерянные souls, время на респавне и окно для объектов соперника.') });
        } else {
          ev.push({ kind: 'fight', t: f.start, neg: false, w: 1.5 + 0.6 * (wd - ld) + f.start / dur,
            title: tf('Выигранная драка {a}–{b}', { a: wd, b: ld }),
            what: tf('{team} забрала {wd} героев, потеряв {ld}.', { team: L, wd, ld }),
            why: t('Показывает, что у команды были окна для камбэка.') });
        }
      });
      if (ruiner) {
        ruiner.deaths.forEach((d) => {
          if (d.cluster && d.cluster.size >= CFG.fightMinDeaths) return;
          if (d.t < 480) return;
          const killer = A.players.find((p) => p.slot === d.killer);
          ev.push({ kind: 'solo', t: d.t, neg: true, w: 1.6 + d.t / dur,
            title: tf('{name} пойман в одиночку', { name: ruiner.name }),
            what: killer
              ? tf('{hero} погиб вне командной драки — убийца {killer}.', { hero: ruiner.hero.name, killer: killer.hero.name })
              : tf('{hero} погиб вне командной драки.', { hero: ruiner.hero.name }),
            why: t('Одиночные смерти дают сопернику бесплатное численное преимущество и souls.') });
        });
      }
      M.objectives.forEach((o) => {
        if (!o.at || o.at > dur + 5) return;
        if (o.id === 0 && M.objectives.some((x) => x.id === 9 && x.team === o.team && x.at > 0)) return; // ядро Patron — дубль финала
        const type = objType(o.id);
        if (o.team === loser) {
          ev.push({ kind: 'obj', t: o.at, neg: true, w: OBJ_WEIGHT[type],
            title: tf('Потерян {obj}', { obj: type }),
            what: tf('{team} лишилась объекта «{obj}».', { team: L, obj: type }),
            why: t(OBJ_WHY[type]) });
        } else {
          ev.push({ kind: 'obj', t: o.at, neg: false, w: OBJ_WEIGHT[type] * 0.8,
            title: tf('Уничтожен вражеский {obj}', { obj: type }),
            what: tf('{team} снесла объект «{obj}» соперника.', { team: L, obj: type }),
            why: t('Объекты — главный способ давления; это был шанс развить преимущество.') });
        }
      });
      M.midBoss.forEach((b) => {
        if (!b.at) return;
        const tm = b.claimed != null ? b.claimed : b.killed;
        const neg = tm === winner;
        ev.push({ kind: 'boss', t: b.at, neg, w: 3,
          title: neg ? t('Мид-босс у соперника') : t('Мид-босс у команды'),
          what: tf('{team} забрала мид-босса.', { team: neg ? Wn : L }),
          why: t('Мид-босс даёт Rejuvenator — усиление команды и давление на объекты.') });
      });
      return pickEpisodes(ev).sort((a, b) => a.t - b.t);
    }
    // Нет таймлайна — производные сигналы по итогам матча
    if (!ruiner) return [];
    return ruiner.reasons.slice(0, CFG.maxEpisodes).map((r) => ({
      derived: true, neg: true, title: t(r.title), what: r.detail, why: t(COMP_WHY[r.key] || COMP_WHY.items),
    }));
  }

  // Отбор эпизодов: по весу, но с лимитом на каждый тип, чтобы драки не вытесняли объекты
  function pickEpisodes(ev) {
    const sorted = ev.slice().sort((a, b) => b.w - a.w);
    const used = {};
    const picked = [];
    sorted.forEach((e) => {
      if (picked.length >= CFG.maxEpisodes) return;
      if ((used[e.kind] || 0) >= (CFG.episodeCaps[e.kind] || CFG.maxEpisodes)) return;
      used[e.kind] = (used[e.kind] || 0) + 1;
      picked.push(e);
    });
    sorted.forEach((e) => { if (picked.length < CFG.maxEpisodes && !picked.includes(e)) picked.push(e); });
    return picked;
  }

  const COMP_WHY = {
    farm: 'Меньше souls — позже ключевые предметы и слабее каждая следующая драка.',
    fight: 'Командные драки решают объекты: без урона и участия команда воюет в меньшинстве.',
    error: 'Смерть — это потерянные souls, время на респавне и численное преимущество соперника.',
    obj: 'Объекты — главный путь к победе: без давления на них souls не превращаются в карту.',
    utility: 'Поддержка усиливает всю команду: без хила и контроля драки проигрываются раньше.',
    waste: 'Высокий фарм без отдачи — ресурсы команды, которые не сработали.',
    items: 'Сборка не отвечала на угрозы соперника.',
  };

  const LESSONS = {
    farm: {
      carry: 'Между драками добирайте волны и лагеря: Carry без souls — это просто ещё один герой.',
      spirit: 'Держите фарм между драками: Spirit-сборке нужны дорогие предметы к мидгейму.',
      tank: 'Даже фронтлайну нужны souls на защиту — забирайте волны, пока команда восстанавливается.',
      support: 'Не забывайте о минимальном фарме: без базовых предметов поддержка не переживает драки.',
    },
    fight: {
      carry: 'Держитесь ближе к команде в драках: ваш урон — главный ресурс, его нельзя тратить вне файтов.',
      spirit: 'Входите в драки со способностями наготове — Spirit Core решает файты бурстом.',
      tank: 'Фронтлайн должен начинать и держать драку: будьте первым, кто впитывает урон.',
      support: 'Участвуйте в драках: поддержка работает только рядом с командой.',
    },
    error: {
      carry: 'Меньше рискованных выходов в одиночку, особенно в лейте: одна смерть стоит объекта.',
      spirit: 'После прожатия способностей отходите: Spirit-герой без кулдаунов — лёгкая цель.',
      tank: 'Инициируйте, когда команда рядом: танк, умерший первым и в одиночку, открывает драку сопернику.',
      support: 'Держите позицию за фронтлайном: живая поддержка полезнее героической смерти.',
    },
    obj: {
      carry: 'Конвертируйте преимущество в объекты: после выигранной драки — сразу на Walker или Guardian.',
      spirit: 'После драки бейте объекты, а не гоняйтесь за киллами.',
      tank: 'Используйте живучесть, чтобы танковать объекты для команды.',
      support: 'Помогайте команде давить объекты — даже небольшой урон ускоряет снос.',
    },
    utility: {
      support: 'Покупайте и используйте предметы поддержки: хил, барьеры и анти-хил решают затяжные драки.',
    },
  };

  function buildLesson(A) {
    const r = A.ruiner;
    if (!r) return null;
    const top = Object.entries(r.comps).sort((a, b) => b[1].pts - a[1].pts)[0];
    const key = top ? top[0] : 'fight';
    const text = (LESSONS[key] && (LESSONS[key][r.role] || LESSONS[key].carry)) || LESSONS.fight[r.role];
    return { key, text };
  }

  function buildFair(A) {
    const { ruiner, loser, winner } = A;
    if (!ruiner) return [];
    const out = [];
    const L = A.byTeam[loser];
    if (A.curve && A.dur > 600) {
      const at10 = diffFor(A, loser, 600);
      const lanD = ruiner.deaths.filter((d) => d.t < 600).length;
      if (at10 < -1500 && lanD <= 1) out.push(tf('Команда отставала уже на лайнинге: {diff} souls к 10-й минуте, при этом у {name} смертей в этой фазе: {d}.', { diff: fmt(at10), name: ruiner.name, d: lanD }));
    }
    const gone = L.filter((p) => p.excluded);
    if (gone.length) out.push(tf('В команде был ливер или АФК: {names}.', { names: gone.map((p) => `${p.name} (${p.hero.name})`).join(', ') }));
    const moreDeaths = L.filter((p) => p !== ruiner && !p.excluded && p.d > ruiner.d).sort((a, b) => b.d - a.d)[0];
    if (moreDeaths) out.push(tf('{name} ({hero}) умирал чаще: {d} смертей против {rd}.', { name: moreDeaths.name, hero: moreDeaths.hero.name, d: moreDeaths.d, rd: ruiner.d }));
    const fed = A.byTeam[winner].slice().sort((a, b) => b.nw - a.nw)[0];
    if (fed && fed.nwShare * A.byTeam[winner].length >= 1.15) out.push(tf('У соперника был разогнанный {hero}: {kda}, {nw} souls.', { hero: fed.hero.name, kda: kda(fed), nw: fmt(fed.nw) }));
    if (ruiner.kp >= mean(L, (p) => p.kp) + 0.05) out.push(tf('Участие в убийствах {kp}% — выше среднего по команде.', { kp: pct(ruiner.kp) }));
    if (!out.length) out.push(t('Явных внешних факторов не найдено — статистика в основном отражает собственную игру.'));
    return out.slice(0, 4);
  }

  function buildConfidence(A) {
    const C = CFG.confidence;
    let c = C.base;
    if (A.M.hasTimeline) c += C.timeline;
    if (A.M.hasDeaths) c += C.deaths;
    if (A.M.hasObjectives) c += C.objectives;
    if (A.ruiner) c += Math.round(A.ruiner.roleConf * C.role);
    if (A.ruiner && A.near) c += Math.min(C.gap, Math.max(0, (A.ruiner.score - A.near.score) / 3));
    return Math.round(clamp(c, C.min, C.max));
  }

  // ======================================================================
  // Рендер
  // ======================================================================
  function roleBadge(p) {
    return `<span class="badge role">${esc(ROLE_LABEL[p.role])} · ${t('предположительно')}</span>`;
  }
  function exclBadges(p) {
    const b = [];
    if (p.leaver) b.push(`<span class="badge bad">${tf('Покинул матч на {t}', { t: time(p.abandon) })}</span>`);
    if (p.afk) b.push(`<span class="badge bad">${t('Возможно АФК')}</span>`);
    if (p.excluded) b.push(`<span class="badge">${t('Исключён из выбора')}</span>`);
    return b.join('');
  }
  const nameHtml = (p) => (p.profileUrl && safeUrl(p.profileUrl)
    ? `<a href="${esc(p.profileUrl)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name));

  function renderVerdict(A) {
    const el = $('verdict');
    const r = A.ruiner;
    if (!r) {
      el.innerHTML = `<div class="v-main" style="grid-column:1/-1"><p class="kicker">${t('Вердикт')}</p>
        <h2 class="sec-title">${t('Не из кого выбирать')}</h2>
        <p class="v-summary">${t('Все игроки проигравшей команды покинули матч или были АФК — честно выбрать руинера нельзя.')}</p></div>`;
      return;
    }
    const lv = r.level;
    const summary = tf('{name} ({hero}, предположительно {role}). Экономика: {spm} souls/min — {fpct}% от ориентира. Драки: {dmg}% урона команды по героям, участие в убийствах {kp}%. Объекты: {obj}% командного урона по объектам. Смертей: {d}.', {
      name: r.name, hero: r.hero.name, role: ROLE_LABEL[r.role], spm: fmt(r.spm), fpct: pct(r.farmR),
      dmg: pct(r.dmgShare), kp: pct(r.kp), obj: pct(r.objShare), d: r.d,
    });
    const top = r.reasons.slice(0, 3).map((x) => `<li><b>${t(x.title)}</b><span>${x.detail}</span></li>`).join('');
    el.innerHTML = `
      <div class="v-portrait">${img(r.hero.card || r.hero.small, r.hero.name)}<span class="stamp">RUINER</span></div>
      <div class="v-main">
        <p class="kicker">${t('Вердикт')} · ${tf('матч {id}', { id: A.id })}</p>
        <div class="v-top">${rankHtml(r)}<span>·</span>${teamSpan(r.team)}<span>·</span>${roleBadge(r)}</div>
        <div class="v-name">${nameHtml(r)}</div>
        <div class="v-hero">${esc(r.hero.name)} · K/D/A ${kda(r)} · ${fmt(r.nw)} souls</div>
        <div class="v-meters">
          <div class="meter"><small>${t('Влияние на поражение')}</small><b class="lvl-${lv.idx}">${t(lv.label)} · ${r.score}</b></div>
          <div class="meter"><small>${t('Уверенность оценки')}</small><b>${A.confidence}%</b></div>
        </div>
        <p class="v-summary">${summary}</p>
        ${top ? `<ul class="reasons">${top}</ul>` : `<p class="muted">${t('Явных провалов нет — он просто чуть слабее остальных по совокупности показателей.')}</p>`}
        <div class="v-actions">
          <button type="button" class="btn btn-amber" data-action="why">${t('ПОЧЕМУ ИМЕННО ОН?')}</button>
          <button type="button" class="btn btn-good" data-action="advocate" aria-expanded="false">${t('АДВОКАТ')}</button>
        </div>
        <div id="advocate" class="advocate" hidden></div>
      </div>`;
  }

  function renderAdvocate(A) {
    const box = $('advocate');
    if (!box) return;
    const args = WR.advocate(A);
    box.innerHTML = `<p class="kicker" style="color:var(--good)">${t('Слово защите')}</p>
      <ul class="reasons good">${args.map((a) => `<li><b>${a[0]}</b><span>${a[1]}</span></li>`).join('')}</ul>`;
  }

  function whyModal(A) {
    const r = A.ruiner;
    if (!r) return;
    const rows = Object.entries(r.comps).filter(([, c]) => c.w > 0)
      .map(([k, c]) => `<tr><td>${t(COMP_LABEL[k])}</td><td>${Math.round(c.pts)}</td></tr>`).join('') +
      (r.extraPts ? `<tr><td>${t('Ресурсы и предметы')}</td><td>${Math.round(r.extraPts)}</td></tr>` : '') +
      `<tr><td><b>${t('Итого')}</b></td><td>${r.score}</td></tr>`;
    const list = r.reasons.length
      ? `<ul class="reasons">${r.reasons.map((x) => `<li><b>${t(x.title)}</b><span>${x.detail}</span></li>`).join('')}</ul>`
      : `<p class="muted">${t('Явных провалов нет — он просто чуть слабее остальных по совокупности показателей.')}</p>`;
    const vs = A.near
      ? `<p class="note">${tf('Следующий по шкале — {name} ({hero}): {score}. Разница — {gap}.', { name: A.near.name, hero: A.near.hero.name, score: A.near.score, gap: r.score - A.near.score })}</p>` : '';
    const role = `<p class="note">${r.roleFallback
      ? t('Роль определена по net worth: данных о предметах недостаточно.')
      : tf('Роль определена по доле souls ({nw}%) и сборке: weapon {w}%, vitality {v}%, spirit {s}%.', { nw: pct(r.nwShare), w: pct(r.slotMix.weapon), v: pct(r.slotMix.vitality), s: pct(r.slotMix.spirit) })}</p>`;
    const calib = `<p class="note">${A.lobbyTier != null
      ? tf('Ориентиры souls/min скорректированы под средний ранг лобби ({rank}) и длительность игры: ×{mul}.', { rank: rankInfo(Math.round(A.lobbyTier) * 10).name, mul: (A.rankMul * A.durMul).toFixed(2) })
      : tf('Ранги игроков неизвестны — ориентиры скорректированы только под длительность игры: ×{mul}.', { mul: A.durMul.toFixed(2) })}</p>`;
    openModal(tf('Почему {name}?', { name: r.name }),
      `<table class="comp-table">${rows}</table>${list}${role}${calib}${vs}`);
  }

  function award(cls, kicker, p, why) {
    if (!p) return '';
    return `<div class="panel award ${cls}">${img(p.hero.small || p.hero.card, p.hero.name)}
      <div style="min-width:0"><p class="kicker">${kicker}</p><div class="who">${esc(p.name)}</div><div class="why">${why}</div></div></div>`;
  }
  function renderAwards(A) {
    $('awards').innerHTML =
      award('mvp', t('MVP матча'), A.mvp, A.mvp ? tf('{hero} · {kda} · вклад {perf}/100', { hero: A.mvp.hero.name, kda: kda(A.mvp), perf: A.mvp.perf }) : '') +
      award('best', t('Лучший в поражении'), A.bestLoser, A.bestLoser ? tf('{hero} · {kda} · вклад {perf}/100', { hero: A.bestLoser.hero.name, kda: kda(A.bestLoser), perf: A.bestLoser.perf }) : '') +
      award('risk', t('Самый рисковый игрок'), A.risky, A.risky ? tf('{hero} · {d} смертей · {loss} souls потеряно', { hero: A.risky.hero.name, d: A.risky.d, loss: fmt(A.risky.deathLoss) }) : '');
  }

  function renderNear(A) {
    const p = A.near;
    if (!p) { $('near').innerHTML = ''; return; }
    $('near').innerHTML = `<p class="kicker">${t('Близкий к руину')}</p>
      <div class="near">${img(p.hero.small || p.hero.card, p.hero.name)}
        <div style="min-width:0;flex:1"><div class="who">${esc(p.name)} <span class="muted">· ${esc(p.hero.name)}</span></div>
        <div class="facts">${tf('Влияние {score} ({level}) · K/D/A {kda} · {spm} souls/min · урон по героям {dmg}% · KP {kp}%', { score: p.score, level: t(p.level.label), kda: kda(p), spm: fmt(p.spm), dmg: pct(p.dmgShare), kp: pct(p.kp) })}</div>
        ${p.reasons[0] ? `<div class="facts">${t(p.reasons[0].title)}: ${p.reasons[0].detail}</div>` : ''}</div>
      </div>`;
  }

  function renderSummary(A) {
    const T = A.team;
    $('summary').innerHTML = `<div class="sec-head"><h2 class="sec-title">${t('Итоги матча')}</h2><span class="muted">#${A.id}</span></div>
      <div class="summary-row">
        <div>
          <div class="score-line"><span class="team-0">${T[0].kills}</span> : <span class="team-1">${T[1].kills}</span></div>
          <div class="muted">${tf('Победа: {team} · длительность {dur}', { team: CFG.teams[A.winner], dur: time(A.dur) })}</div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn" data-action="copy">${t('КОПИРОВАТЬ ИТОГ')}</button>
          <button type="button" class="btn" data-action="card"${A.ruiner ? '' : ' disabled'}>${t('СКАЧАТЬ КАРТОЧКУ')}</button>
        </div>
      </div>`;
  }

  function renderNumbers(A) {
    const T = A.team;
    const diff = T[A.winner].nw - T[A.loser].nw;
    const objs = (tm) => A.M.objectives.filter((o) => o.team !== tm && o.at > 0).length;
    const mb = (tm) => A.M.midBoss.filter((b) => (b.claimed != null ? b.claimed : b.killed) === tm).length;
    const stat = (label, value, sub) => `<div class="stat"><small>${label}</small><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
    $('numbers').innerHTML = `<h2 class="sec-title">${t('Матч в цифрах')}</h2><div class="stats">
      ${stat(t('Длительность'), time(A.dur))}
      ${stat(t('Победитель'), `<span class="team-${A.winner}">${esc(CFG.teams[A.winner])}</span>`)}
      ${stat(t('Разница по souls'), `+${fmt(diff)}`, tf('в пользу {team}', { team: CFG.teams[A.winner] }))}
      ${stat(t('Драк'), A.M.hasDeaths ? A.fights.length : '—', A.M.hasDeaths ? t('кластеры из 2+ смертей') : t('нет данных'))}
      ${stat(t('Объектов снесено'), `<span class="team-0">${objs(0)}</span> : <span class="team-1">${objs(1)}</span>`, 'Amber : Sapphire')}
      ${stat(t('Мид-босс'), `<span class="team-0">${mb(0)}</span> : <span class="team-1">${mb(1)}</span>`, 'Amber : Sapphire')}
    </div>`;
  }

  function renderChart(A) {
    const el = $('chart');
    const head = `<h2 class="sec-title">${t('Преимущество по souls')}</h2>`;
    if (!A.curve) {
      el.innerHTML = `${head}<p class="muted">${t('Покадровых данных по souls для этого матча нет — график построить нельзя.')}</p>`;
      return;
    }
    const W = 1000, H = 320, l = 62, r = 16, tp = 18, b = 34;
    const dur = A.dur;
    const raw = Math.max(1000, ...A.curve.map((p) => Math.abs(p.diff)));
    const max = Math.ceil(raw / 2000) * 2000;
    const x = (tt) => l + (tt / dur) * (W - l - r);
    const y = (v) => tp + ((max - v) / (2 * max)) * (H - tp - b);
    const y0 = y(0);
    const pts = A.curve.map((p) => `${x(p.t).toFixed(1)},${y(p.diff).toFixed(1)}`);
    const line = `M${pts.join(' L')}`;
    const area = `${line} L${x(A.curve[A.curve.length - 1].t).toFixed(1)},${y0.toFixed(1)} L${x(0).toFixed(1)},${y0.toFixed(1)} Z`;
    const zf = ((y0 - tp) / (H - tp - b)).toFixed(4);
    const kfmt = (v) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 100) / 10}k` : Math.abs(v)}`);
    let grid = '';
    [max, max / 2, 0, -max / 2, -max].forEach((v) => {
      grid += `<line x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,${v === 0 ? 0.25 : 0.07})"${v === 0 ? '' : ' stroke-dasharray="3 5"'}/>`;
      grid += `<text x="${l - 8}" y="${y(v) + 4}" text-anchor="end" fill="#8a857d" font-size="12">${kfmt(v)}</text>`;
    });
    const step = dur > 2400 ? 600 : 300;
    for (let s = 0; s <= dur; s += step) {
      grid += `<text x="${x(s)}" y="${H - 10}" text-anchor="middle" fill="#8a857d" font-size="12">${Math.round(s / 60)}′</text>`;
    }
    let marks = '';
    if (A.ruiner) {
      A.ruiner.deaths.forEach((d) => {
        const v = diffAt(A.curve, d.t);
        marks += `<circle cx="${x(d.t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="6" fill="#ff3b3b" stroke="#07080b" stroke-width="2"><title>${tf('{t} — смерть {name}', { t: time(d.t), name: A.ruiner.name })}</title></circle>`;
      });
    }
    el.innerHTML = `${head}<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('Преимущество по souls'))}">
      <defs>
        <linearGradient id="gArea" x1="0" y1="${tp}" x2="0" y2="${H - b}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#e8a33d" stop-opacity=".55"/><stop offset="${zf}" stop-color="#e8a33d" stop-opacity=".06"/>
          <stop offset="${zf}" stop-color="#3d7fe0" stop-opacity=".06"/><stop offset="1" stop-color="#3d7fe0" stop-opacity=".55"/>
        </linearGradient>
        <linearGradient id="gLine" x1="0" y1="${tp}" x2="0" y2="${H - b}" gradientUnits="userSpaceOnUse">
          <stop offset="${zf}" stop-color="#e8a33d"/><stop offset="${zf}" stop-color="#79b0ff"/>
        </linearGradient>
      </defs>
      ${grid}
      <text x="${l + 8}" y="${tp + 14}" fill="#e8a33d" font-size="13" font-weight="700">${tf('{team} впереди', { team: 'Amber Hand' })}</text>
      <text x="${l + 8}" y="${H - b - 8}" fill="#79b0ff" font-size="13" font-weight="700">${tf('{team} впереди', { team: 'Sapphire Flame' })}</text>
      <path d="${area}" fill="url(#gArea)"/>
      <path d="${line}" fill="none" stroke="url(#gLine)" stroke-width="3" stroke-linejoin="round"/>
      ${marks}
    </svg></div>
    <div class="chart-legend"><span><i style="background:var(--amber)"></i>Amber Hand</span><span><i style="background:var(--sapphire)"></i>Sapphire Flame</span>${A.ruiner ? `<span><i style="background:var(--ruin)"></i>${tf('смерти {name}', { name: A.ruiner.name })}</span>` : ''}</div>
    <p class="note">${tf('Точки — снимки статистики API ({n} шт.), между ними значения интерполированы.', { n: A.curve.length - 1 })}</p>`;
  }

  function renderExpect(A) {
    const rows = [A.loser, A.winner].map((tm) => A.byTeam[tm].slice().sort((a, b) => b.farmR - a.farmR).map((p) => {
      const ratio = p.farmR;
      const w = (Math.min(ratio, 1.5) / 1.5) * 100;
      const color = ratio >= 1 ? 'var(--good)' : ratio >= 0.85 ? 'var(--warn)' : 'var(--ruin)';
      const win = p.team === A.winner;
      return `<div class="bar-row">
        <div class="bar-who">${img(p.hero.small, p.hero.name)}<span class="wl ${win ? 'win' : 'loss'}">${win ? t('ПОБЕДА') : t('ПОРАЖЕНИЕ')}</span><span title="${esc(p.name)}">${esc(p.name)}</span></div>
        <div class="bar" title="${tf('{spm} из {exp} souls/min ({role})', { spm: fmt(p.spm), exp: fmt(p.expSpm), role: ROLE_LABEL[p.role] })}"><div class="bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></div><div class="bar-mark" style="left:66.67%"></div></div>
        <div class="bar-pct">${pct(ratio)}%</div>
      </div>`;
    }).join('')).join('');
    $('expect').innerHTML = `<h2 class="sec-title">${t('Сравнение с ожиданиями')}</h2>
      <p class="note" style="margin:-8px 0 14px">${t('Souls/min каждого игрока относительно ориентира его предполагаемой роли. Вертикальная черта — 100%.')}</p>
      <div class="bars">${rows}</div>`;
  }

  function playerCard(p, A, loserCard) {
    const items = p.build.map((i) => {
      const s = safeUrl(i.img);
      return s ? `<img src="${esc(s)}" alt="${esc(i.name)}" title="${esc(`${i.name} · T${i.tier}`)}" class="s-${esc(i.slot || '')}" loading="lazy">` : '';
    }).join('');
    const cell = (label, value) => `<div><small>${label}</small><b>${value}</b></div>`;
    const right = loserCard
      ? `<div class="pc-score"><b class="lvl-${p.level.idx}">${p.score}</b><small>${t(p.level.label)}</small></div>`
      : `<div class="pc-score"><b class="pos">${p.perf}</b><small>${t('вклад')}</small></div>`;
    return `<article class="pcard${A.ruiner === p ? ' is-ruiner' : ''}">
      <div class="pc-head">${img(p.hero.small || p.hero.card, p.hero.name, 'hero')}
        <div class="pc-id"><div class="pc-name" title="${esc(p.name)}">${nameHtml(p)}</div>
          <div class="pc-sub">${esc(p.hero.name)} · ${rankHtml(p)}</div></div>
        ${right}</div>
      <div class="pc-grid">
        ${cell('K/D/A', kda(p))}
        ${cell('Souls/min', fmt(p.spm))}
        ${cell('Last hits', fmt(p.lh))}
        ${cell(t('Урон по героям'), `${fmt(p.heroDmg)} <span class="muted">${pct(p.dmgShare)}%</span>`)}
        ${cell('KP', `${pct(p.kp)}%`)}
        ${cell(t('По объектам'), fmt(p.objDmg))}
        ${cell('Net worth', fmt(p.nw))}
        ${cell(t('Хил'), fmt(p.heal))}
        ${cell('Denies', fmt(p.dn))}
      </div>
      ${items ? `<div class="items">${items}</div>` : `<p class="note">${t('Нет данных о предметах')}</p>`}
      <div class="badges">${roleBadge(p)}${A.ruiner === p ? `<span class="badge bad">RUINER</span>` : ''}${exclBadges(p)}</div>
    </article>`;
  }

  function renderTeams(A) {
    $('winners').innerHTML = `<div class="sec-head"><h2 class="sec-title">${t('Победившая команда')}</h2>${teamSpan(A.winner)}</div>
      <div class="cards">${A.byTeam[A.winner].slice().sort((a, b) => b.perf - a.perf).map((p) => playerCard(p, A, false)).join('')}</div>`;
    $('losers').innerHTML = `<div class="sec-head"><h2 class="sec-title">${t('Игроки проигравшей команды')}</h2>${teamSpan(A.loser)}</div>
      <div class="cards">${A.byTeam[A.loser].slice().sort((a, b) => (a.excluded - b.excluded) || b.score - a.score).map((p) => playerCard(p, A, true)).join('')}</div>`;
  }

  const PHASE_NAME = { lane: 'Лайнинг', mid: 'Мидгейм', late: 'Лейт' };
  const PHASE_STATE = { won: ['Выиграна', 'pos'], lost: ['Проиграна', 'neg'], even: ['Примерно ровно', ''], unknown: ['Нет данных', 'muted'] };

  function renderStory(A) {
    const L = CFG.teams[A.loser];
    const phases = A.phases.map((ph) => {
      const when = ph.none ? '' : `${time(ph.from)}–${time(ph.to)}`;
      if (ph.none) {
        return `<div class="phase"><h4>${t(PHASE_NAME[ph.key])}</h4><div class="verdict-word muted">${t('Не наступила')}</div><p>${t('Матч закончился раньше.')}</p></div>`;
      }
      const st = PHASE_STATE[ph.state];
      const parts = [];
      if (ph.swing != null) parts.push(tf('Souls для {team}: {swing} за фазу (итог {end}).', { team: L, swing: `${ph.swing >= 0 ? '+' : ''}${fmt(ph.swing)}`, end: `${ph.endDiff >= 0 ? '+' : ''}${fmt(ph.endDiff)}` }));
      if (A.M.hasDeaths) parts.push(tf('Смерти {l}:{w}', { l: ph.loserDeaths, w: ph.winnerDeaths }) + (A.ruiner ? tf(', у {name} — {d}.', { name: A.ruiner.name, d: ph.ruinerDeaths }) : '.'));
      return `<div class="phase"><h4>${t(PHASE_NAME[ph.key])}</h4><div class="when">${when}</div>
        <div class="verdict-word ${st[1]}">${t(st[0])}</div><p>${parts.join(' ')}</p></div>`;
    }).join('');

    let turn;
    if (A.turning) {
      const f = A.turning.f;
      const dl = f.dead[A.loser], dw = f.dead[A.winner];
      turn = tf('{time}: драка {dw}–{dl} не в пользу {team} (убийства–потери).', { time: time(f.start), dl, dw, team: L }) + ' ' +
        (A.turning.rDied ? tf('В ней погиб {name}.', { name: A.ruiner.name }) + ' ' : '') +
        (A.turning.lost.length ? tf('В течение {s} с после неё пал {obj}.', { s: CFG.objAfterFight, obj: objType(A.turning.lost[0].id) }) : '');
    } else {
      turn = A.M.hasDeaths ? t('Явно проигранных драк не найдено — поражение копилось постепенно.') : t('Нет данных о смертях по времени — момент перелома определить нельзя.');
    }
    const lesson = A.lesson ? `${t(A.lesson.text)} <span class="muted">(${t(COMP_LABEL[A.lesson.key])})</span>` : '—';
    const fair = A.fair.length ? `<ul>${A.fair.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p>—</p>';
    $('story').innerHTML = `<h2 class="sec-title">${t('Как развивалась игра')}</h2>
      <div class="phases">${phases}</div>
      <div class="story-grid">
        <div class="story-card turn"><h4>${t('Момент перелома')}</h4><p>${turn}</p></div>
        <div class="story-card lesson"><h4>${t('Главный урок')}</h4><p>${lesson}</p></div>
        <div class="story-card fair"><h4>${t('Что не было твоей ошибкой')}</h4>${fair}</div>
      </div>`;
  }

  function renderEpisodes(A) {
    const ev = A.episodes;
    if (!ev.length) { $('episodes').innerHTML = `<h2 class="sec-title">${t('Ключевые эпизоды')}</h2><p class="muted">${t('Нет данных для эпизодов.')}</p>`; return; }
    $('episodes').innerHTML = `<h2 class="sec-title">${t('Ключевые эпизоды')}</h2><div class="episodes">${ev.map((e) => `
      <div class="ep">
        <div class="ep-time${e.derived ? ' derived' : ''}">${e.derived ? t('По итогам матча') : time(e.t)}</div>
        <div><span class="ep-tag ${e.neg ? 'neg' : 'pos'}">${e.neg ? t('негативный сигнал') : t('положительный сигнал')}</span>
          <h4>${e.title}</h4>
          <p><b>${t('Что произошло:')}</b> ${e.what}</p>
          <p><b>${t('Почему это важно:')}</b> ${e.why}</p></div>
      </div>`).join('')}</div>`;
  }

  function renderAll(A) {
    renderVerdict(A);
    renderAwards(A);
    renderNear(A);
    renderSummary(A);
    renderNumbers(A);
    renderChart(A);
    renderExpect(A);
    renderTeams(A);
    renderStory(A);
    renderEpisodes(A);
    $('result').hidden = false;
  }

  // ======================================================================
  // Модалка
  // ======================================================================
  let lastFocus = null;
  function openModal(title, html) {
    lastFocus = document.activeElement;
    $('modalTitle').innerHTML = title;
    $('modalBody').innerHTML = html;
    $('modal').hidden = false;
    document.body.style.overflow = 'hidden';
    document.querySelector('.modal-x').focus();
  }
  function closeModal() {
    if ($('modal').hidden) return;
    $('modal').hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ======================================================================
  // Управление
  // ======================================================================
  let busy = false;
  let current = null;
  let lastStatus = null;

  function setStatus(tpl, vars, kind) {
    lastStatus = tpl ? [tpl, vars, kind] : null;
    const el = $('status');
    el.className = 'status' + (kind === 'err' ? ' err' : kind === 'busy' ? ' busy' : '');
    el.innerHTML = tpl ? tf(tpl, vars || {}) : '';
  }

  function errorStatus(e) {
    const k = (e && e.kind) || 'data';
    const map = {
      rate: ['Слишком много запросов к API. Подождите {s} с и попробуйте снова.', { s: e.retryAfter || CFG.defaultCooldown }],
      notfound: ['Матч не найден ни в базе deadlock-api.com, ни в Steam. Проверьте Match ID: данные очень старых матчей и матчей из приватных лобби Valve не отдаёт.'],
      steamlimit: ['Этого матча ещё нет в базе, а лимит загрузки новых матчей из Steam исчерпан. Попробуйте через {m} мин. Уже загруженные матчи открываются как обычно.', { m: Math.max(1, Math.ceil((e.retryAfter || 3600) / 60)) }],
      steambusy: ['Steam сейчас не отдаёт этот матч — так бывает, если игра ещё идёт или только что закончилась. Попробуйте через {m} мин. Уже загруженные матчи открываются как обычно.', { m: Math.max(1, Math.ceil((e.retryAfter || 600) / 60)) }],
      unavailable: ['Матч не найден или ещё не обработан. Если игра закончилась недавно — попробуйте позже.'],
      bad: ['Некорректный Match ID.'],
      server: ['API вернул ошибку ({code}). Попробуйте позже.', { code: e.status }],
      timeout: ['API не отвечает. Попробуйте позже.'],
      offline: ['Нет подключения к интернету.'],
      network: ['Не удалось связаться с API: нет сети или сервис недоступен.'],
      down: ['Сервер deadlock-api.com сейчас недоступен — это сбой на их стороне. Уже разобранные ранее матчи могут открываться, новые — нет. Попробуйте позже.'],
      nowinner: ['В этом матче нет победителя — разбирать нечего.'],
      data: ['Не удалось разобрать данные матча.'],
    };
    const m = map[k] || map.data;
    setStatus(m[0], m[1], 'err');
  }

  async function start(raw) {
    const id = String(raw || '').replace(/\D/g, '');
    if (!id || id.length > 12 || Number(id) <= 0) { setStatus('Введите корректный Match ID — только цифры.', null, 'err'); return; }
    if (busy) return;
    busy = true;
    $('go').disabled = true;
    $('matchId').value = id;
    WR.track('analyze');
    try {
      setStatus('Загружаю матч {id}…', { id }, 'busy');
      const [assets, S] = await Promise.all([
        loadAssets(),
        loadMatchData(id, () => setStatus('Загружаю профили игроков…', null, 'busy')),
      ]);
      setStatus('Считаю…', null, 'busy');
      const M = buildMatch(S, assets);
      const A = analyze(M);
      current = A;
      renderAll(A);
      if (A.ruiner) WR.history.add({ id, nick: A.ruiner.name, hero: A.ruiner.hero.name, img: safeUrl(A.ruiner.hero.small) });
      else WR.history.add({ id, nick: '', hero: '', img: '' });
      WR.history.render($('history'), start);
      WR.deepLink.write(id);
      setStatus(M.fromCache ? 'Готово (из кэша): матч {id}.' : 'Готово: матч {id} разобран.', { id }, 'ok');
      $('verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      if (!(e instanceof ApiError)) console.error(e);
      errorStatus(e);
      WR.track('error-' + ((e && e.kind) || 'data'));
    } finally {
      busy = false;
      $('go').disabled = false;
    }
  }

  function init() {
    $('form').addEventListener('submit', (e) => { e.preventDefault(); start($('matchId').value); });
    $('result').addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b || !current) return;
      const act = b.dataset.action;
      WR.track('click-' + act);
      if (act === 'why') whyModal(current);
      else if (act === 'advocate') {
        const box = $('advocate');
        if (box.hidden) renderAdvocate(current);
        box.hidden = !box.hidden;
        b.setAttribute('aria-expanded', String(!box.hidden));
      } else if (act === 'copy') {
        WR.share.copy(current).then((ok) => setStatus(ok ? 'Итог скопирован в буфер обмена.' : 'Не удалось скопировать — браузер запретил доступ к буферу.', null, ok ? 'ok' : 'err'));
      } else if (act === 'card') {
        setStatus('Рисую карточку…', null, 'busy');
        WR.share.card(current, rankInfo).then((r) => (r === 'cancel' ? setStatus(null) : setStatus(r === 'shared' ? 'Карточка отправлена.' : 'Карточка сохранена.', null, 'ok')))
          .catch(() => setStatus('Не удалось создать карточку.', null, 'err'));
      }
    });
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal') || e.target.closest('.modal-x')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

    WR.onLang(() => {
      WR.history.render($('history'), start);
      if (current) {
        const advOpen = $('advocate') && !$('advocate').hidden;
        current = analyze(current.M); // тексты причин и эпизодов собираются на текущем языке
        renderAll(current);
        if (advOpen) { renderAdvocate(current); $('advocate').hidden = false; }
      }
      if (lastStatus) setStatus(lastStatus[0], lastStatus[1], lastStatus[2]);
      if (!$('modal').hidden) closeModal();
    });

    const author = window.WR_AUTHOR || {};
    const a = $('authorLink');
    if (author.url && safeUrl(author.url)) a.href = author.url;
    a.textContent = author.name || '—';

    WR.history.render($('history'), start);
    const deep = WR.deepLink.read();
    if (deep) start(deep);
  }

  // для отладки и для extras.js
  WR.app = { CFG, rankInfo, ROLE_LABEL, COMP_LABEL };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
