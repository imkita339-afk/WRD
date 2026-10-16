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

Все запросы идут из браузера к публичному API [deadlock-api.com](https://deadlock-api.com), без ключей и без бэкенда.

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

Справочники кэшируются в `localStorage` на 24 часа, облегчённые данные последних 5 матчей — на 7 дней. При `429` или `503` с `Retry-After` сайт выдерживает паузу и не повторяет запросы автоматически.

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
