# WHO RUINED? — Deadlock Match Forensics

Статический сайт-анализатор матчей **Deadlock**. Вводишь Match ID — сайт загружает матч, разбирает проигравшую команду и выбирает «руинера»: игрока с наибольшим негативным вкладом в поражение. Каждый вывод сопровождается цифрами и причинами, а «адвокат» приводит аргументы в защиту.

> Разбор основан на статистике матча. Это оценка алгоритма по набору показателей, а не утверждение, что один игрок единолично проиграл игру.

## Возможности

- Вердикт: герой, ранг, ник, влияние на поражение (0–100), уверенность оценки (45–94%), топ-3 причины.
- «Почему именно он?» — все причины и разбивка очков по компонентам.
- «Адвокат» — аргументы в защиту руинера.
- Награды: MVP матча, лучший в поражении, самый рисковый игрок; «близкий к руину».
- График преимущества по souls (SVG) с точками смертей руинера.
- Сравнение souls/min с ориентиром роли для всех 12 игроков.
- Фазы игры, момент перелома, главный урок, «что не было твоей ошибкой».
- До 10 ключевых эпизодов с объяснением.
- PNG-карточка 1080×1080 и копирование итога в буфер.
- RU/EN, история последних 8 разборов, ссылки вида `?match=ID`.

## Структура

```
index.html
css/style.css
js/app.js        — загрузка данных, роли, скоринг, рендер
js/extras.js     — i18n RU/EN, кэш, история, share-карточка, «адвокат», deep links
assets/bg.webp   — фоновый арт (замените своим)
worker/          — необязательный API-прокси на Cloudflare Workers (см. ниже)
```

Без сборщиков и зависимостей: достаточно открыть `index.html` через любой статический сервер.

```bash
python -m http.server 8080
```

## Деплой на GitHub Pages

1. Settings → Pages → Source: *Deploy from a branch*.
2. Branch: `main`, папка `/ (root)`.
3. Сайт появится по адресу `https://<user>.github.io/<repo>/`.

## Данные

Все запросы идут из браузера к публичному API [deadlock-api.com](https://deadlock-api.com) — напрямую или через свой прокси из `worker/`, если он задан в `window.WR_API`.

| Эндпоинт | Что берём |
|---|---|
| `GET /v1/matches/{match_id}/metadata` | `match_info`: `duration_s`, `winning_team`, `match_mode`, `objectives[]` (`team`, `team_objective_id`, `destroyed_time_s`), `mid_boss[]` (`team_killed`, `team_claimed`, `destroyed_time_s`), `players[]` |
| ↳ `players[]` | `account_id`, `player_slot`, `team`, `hero_id`, `kills`, `deaths`, `assists`, `net_worth`, `last_hits`, `denies`, `abandon_match_time_s`, `player_rank_data.initial_display_rank`, `death_details[]` (`game_time_s`, `killer_player_slot`), `items[]` (`item_id`, `game_time_s`, `sold_time_s`) |
| ↳ `players[].stats[]` | покадрово: `time_stamp_s`, `net_worth`, `player_damage`, `player_damage_taken`, `damage_mitigated`, `player_healing`, `teammate_healing`, `teammate_barriering`, `heal_prevented`, `boss_damage`, `gold_death_loss` |
| `GET /v1/players/steam?account_ids=…` | `personaname`, `avatarmedium`, `profileurl` |
| `GET /v1/players/rank?account_ids=…` | `badge` — только если ранга нет в данных матча |
| `GET /v1/assets/heroes` | `id`, `name`, `hero_type`, `images.icon_hero_card_webp`, `images.icon_image_small_webp` |
| `GET /v1/assets/items` | предметы `type: "upgrade"`: `id`, `name`, `item_slot_type` (weapon / vitality / spirit), `item_tier`, `cost`, `shop_image_webp` |
| `GET /v1/assets/ranks` | `tier`, `name`, `color`, `images.large_webp` |
| `GET /v1/assets/ranks/{tier}/{subrank}/image?format=webp` | иконка ранга с подуровнем |

Ранг кодируется как `badge = tier × 10 + subrank`: tier 1–11 — Initiate, Seeker, Acolyte, Sentinel, Mystic, Ritualist, Emissary, Oracle, Phantom, Ascendant, Eternus; subrank 1–6; `0` — без ранга (Obscurus).

Объекты (`team_objective_id`): 1–4 Guardian, 5–8 Walker, 10–11 Shrine, 12–15 Base Guardian, 9 и 0 — Patron. `team` у объекта — команда-владелец.

Справочники кэшируются в `localStorage` на 24 часа, облегчённые данные последних 5 матчей — на 7 дней. При `429` или `503` с коротким `Retry-After` сайт выдерживает паузу и не повторяет запросы автоматически. `503` с `Retry-After` от 2 минут («Steam is busy») относится только к загрузке этого матча из Steam и остальные запросы не блокирует.

## Свой API-прокси (worker/)

Откуда deadlock-api.com берёт матчи: их Steam-боты запрашивают у Game Coordinator Deadlock «соль» матча, по ней скачивают с серверов Valve файл `.meta.bz2`, распаковывают и декодируют protobuf `CMsgMatchMetaData`. Valve сильно ограничивает такие запросы, поэтому матч, которого ещё нет в их базе, без ключа можно загрузить только 3 раза в час с одного IP. Уже загруженные матчи отдаются почти без ограничений.

Прокси в `worker/` (сейчас — `https://wrd-api.imkita339.workers.dev`) убирает эти ошибки, насколько возможно:

- навсегда хранит каждый открытый матч в Cloudflare KV (сжатым): повторно он открывается мгновенно, даже если deadlock-api.com лежит;
- держит справочники героев, предметов и рангов и отдаёт их, когда deadlock-api.com недоступен;
- при сбое deadlock-api.com отвечает `502` с CORS-заголовками — сайт сразу показывает, что лежит сервер, а не сеть;
- пропускает только нужные сайту эндпоинты и не больше 20 новых матчей в минуту с IP.

Без API-ключа прокси не грузит матчи из Steam: все воркеры выходят к deadlock-api.com с общего адреса, и лимит 3 матча в час делили бы все. Он берёт у deadlock-api.com только то, что уже есть в их базе (`disable_steam=true`), а на остальное отвечает `404` с заголовком `X-WR-Direct: 1`. Тогда сайт грузит матч напрямую — с лимитом на IP посетителя, как без прокси, — и через несколько секунд просит прокси сохранить его. Если прокси не отвечает, сайт сам переходит на прямые запросы.

С ключом (`wrangler secret put DEADLOCK_API_KEY`) прокси грузит новые матчи из Steam сам: 300 в час на ключ. Ключ выдают авторы deadlock-api.com; проект поддерживается через [Patreon](https://www.patreon.com/c/user?u=68961896) и [GitHub Sponsors](https://github.com/sponsors/raimannma).

Деплой (нужны Node.js и бесплатный аккаунт Cloudflare; в PowerShell пишите `npx.cmd`):

```bash
cd worker
npx wrangler login --device
npx wrangler kv namespace create MATCHES   # вставьте выданный id в wrangler.toml
npx wrangler secret put DEADLOCK_API_KEY   # необязательно: ключ deadlock-api.com
npx wrangler deploy
```

В `wrangler.toml` пропишите адрес сайта в `ALLOWED_ORIGINS` (например, `https://<user>.github.io`), а в `index.html` — адрес воркера: `window.WR_API = 'https://wrd-api.<subdomain>.workers.dev'`. Пустой `WR_API` возвращает прямые запросы к deadlock-api.com.

Бесплатного плана Cloudflare хватает: 100 000 запросов к воркеру в сутки, 1 ГБ в KV (около 10 000 матчей), 1 000 новых матчей в сутки на запись.

## Модель оценки

Для каждого игрока проигравшей команды считается **Score 0–100** — взвешенная сумма штрафов, веса зависят от предполагаемой роли:

| Компонент | Что меряет |
|---|---|
| farm | souls/min ниже ориентира роли (с поправкой на ранг лобби и длительность) |
| fight | доля урона по героям, kill participation, смерти в драках при малом уроне |
| error | цена смертей; поздние смерти весят больше |
| obj | доля урона по объектам относительно ориентира роли |
| utility | хил союзников и срезанный хил врагов — только для support |

Плюс штраф за «ресурсы без отдачи» и сигналы по предметам: нет защиты в затяжной игре, нет анти-хила против сильного лечения, нет защиты от контроля, нет T4+ к лейту. Ливеры и АФК исключаются из выбора.

Роль (Carry / Core, Spirit Core, Frontline / Tank, Support / Utility) определяется эвристикой по доле souls, тратам на weapon / vitality / spirit, полученному урону, хилу и ассистам — и всегда помечена как «предположительно».

Все коэффициенты собраны в объекте `CFG` в начале `js/app.js`.

## Настройка

В `index.html`:

```js
window.WR_GOATCOUNTER = '';   // код сайта GoatCounter — пусто, счётчик выключен
window.WR_AUTHOR = { name: 'Автор', url: 'https://github.com/…' };
```

Фон — `assets/bg.webp` (рекомендуется 1920×1080, тёмный арт).

## Правовое

Неофициальный фан-проект. Deadlock — товарный знак Valve Corporation; сайт не связан с Valve. Данные — [deadlock-api.com](https://deadlock-api.com).
