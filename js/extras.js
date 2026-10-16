'use strict';

/*
 * WHO RUINED? — вспомогательные модули:
 * i18n RU/EN, localStorage-кэш, история разборов, deep links,
 * «адвокат», копирование итога, PNG-карточка, счётчик GoatCounter.
 */
window.WR = (function () {
  // ======================================================================
  // Хранилище (localStorage с TTL, все обращения в try/catch)
  // ======================================================================
  const PREFIX = 'wr:';
  const store = {
    get(key, ttl) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (ttl && (!o.ts || Date.now() - o.ts > ttl)) return null;
        return o.v;
      } catch (e) { return null; }
    },
    set(key, v) {
      try { localStorage.setItem(PREFIX + key, JSON.stringify({ ts: Date.now(), v })); return true; } catch (e) { return false; }
    },
    del(key) { try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ } },
  };

  // ======================================================================
  // Экранирование и форматирование
  // ======================================================================
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const locale = () => (lang === 'ru' ? 'ru-RU' : 'en-US');
  const num = (n) => Math.round(Number(n) || 0).toLocaleString(locale());
  const time = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // ======================================================================
  // i18n: словарь RU → EN + regex для строк с числами
  // ======================================================================
  const DICT = {
    ", у {name} — {d}.": ", {name}: {d}.",
    "API вернул ошибку ({code}). Попробуйте позже.": "The API returned an error ({code}). Please try again later.",
    "API не отвечает. Попробуйте позже.": "The API is not responding. Please try again later.",
    "Base Guardian защищает вход на базу — дальше путь к Shrines и Patron.": "Base Guardians protect the base entrance — next come the Shrines and the Patron.",
    "KP {kp}% при среднем по команде {avg}%": "KP {kp}% vs. a team average of {avg}%",
    "MVP матча": "Match MVP",
    "Match ID": "Match ID",
    "Match ID, например 117895792": "Match ID, e.g. 117895792",
    "Shrines защищают Patron: без них поражение уже близко.": "Shrines protect the Patron: without them, defeat is close.",
    "Souls для {team}: {swing} за фазу (итог {end}).": "Souls for {team}: {swing} in this phase (ending at {end}).",
    "Souls/min каждого игрока относительно ориентира его предполагаемой роли. Вертикальная черта — 100%.": "Each player's souls/min relative to the benchmark for their estimated role. The vertical line is 100%.",
    "WHO RUINED? — матч {id}": "WHO RUINED? — match {id}",
    "Walker — ключевой объект линии: без него база становится уязвимой.": "The Walker is a lane's key objective: without it the base becomes vulnerable.",
    "{dmg} урона по героям — больше всех в команде": "{dmg} hero damage — the most on the team",
    "{dmg} урона по героям — второй результат в команде": "{dmg} hero damage — second best on the team",
    "{dp10} смертей за 10 мин, но нет {list}": "{dp10} deaths per 10 min, but no {list}",
    "{d} смертей при среднем по команде {avg}": "{d} deaths vs. a team average of {avg}",
    "{hero} · {d} смертей · {loss} souls потеряно": "{hero} · {d} deaths · {loss} souls lost",
    "{hero} · {kda} · вклад {perf}/100": "{hero} · {kda} · impact {perf}/100",
    "{hero} погиб вне командной драки — убийца {killer}.": "{hero} died outside a team fight — killed by {killer}.",
    "{hero} погиб вне командной драки.": "{hero} died outside a team fight.",
    "{names} — команда играла в меньшинстве": "{names} — the team played a player down",
    "{name} ({hero}) умирал чаще: {d} смертей против {rd}.": "{name} ({hero}) died more often: {d} deaths vs. {rd}.",
    "{name} ({hero}, предположительно {role}). Экономика: {spm} souls/min — {fpct}% от ориентира. Драки: {dmg}% урона команды по героям, участие в убийствах {kp}%. Объекты: {obj}% командного урона по объектам. Смертей: {d}.": "{name} ({hero}, likely {role}). Economy: {spm} souls/min — {fpct}% of the benchmark. Fights: {dmg}% of the team's hero damage, kill participation {kp}%. Objectives: {obj}% of the team's objective damage. Deaths: {d}.",
    "{name} отстаёт по шкале всего на {gap}": "{name} is only {gap} points behind",
    "{name} пойман в одиночку": "{name} caught alone",
    "{nw}% souls команды, но урон по героям — {dmg}%, по объектам — {obj}% от ориентира роли": "{nw}% of the team's souls, but hero damage at {dmg}% and objective damage at {obj}% of the role benchmark",
    "{share}% командного урона по объектам": "{share}% of the team's objective damage",
    "{spm} souls/min — {pct}% от ориентира {exp} для роли «{role}»": "{spm} souls/min — {pct}% of the {exp} benchmark for “{role}”",
    "{spm} souls/min — {pct}% от ориентира роли": "{spm} souls/min — {pct}% of the role benchmark",
    "{spm} из {exp} souls/min ({role})": "{spm} of {exp} souls/min ({role})",
    "{team} впереди": "{team} ahead",
    "{team} забрала {wd} героев, потеряв {ld}.": "{team} took down {wd} heroes and lost {ld}.",
    "{team} забрала мид-босса.": "{team} took the Mid Boss.",
    "{team} лишилась объекта «{obj}».": "{team} lost its {obj}.",
    "{team} потеряла {ld} героев, соперник — {wd}.": "{team} lost {ld} heroes, the enemy lost {wd}.",
    "{team} потеряла {ld} героев, соперник — {wd}. Среди погибших — {name}.": "{team} lost {ld} heroes, the enemy lost {wd}. {name} was among the dead.",
    "{team} снесла объект «{obj}» соперника.": "{team} destroyed the enemy {obj}.",
    "{time}: драка {dw}–{dl} не в пользу {team} (убийства–потери).": "{time}: a {dw}–{dl} fight went against {team} (kills–losses).",
    "{t} — смерть {name}": "{t} — {name} died",
    "{util}/мин хила союзникам и срезанного хила врагов": "{util}/min of ally healing and prevented enemy healing",
    "АДВОКАТ": "DEFENSE",
    "АНАЛИЗИРОВАТЬ": "ANALYZE",
    "Автор:": "Author:",
    "Без ранга": "Unranked",
    "Близкий к руину": "Runner-up ruiner",
    "В команде был ливер или АФК": "The team had a leaver or AFK",
    "В команде был ливер или АФК: {names}.": "The team had a leaver or AFK: {names}.",
    "В ней погиб {name}.": "{name} died in it.",
    "В течение {s} с после неё пал {obj}.": "Within {s} s the {obj} fell.",
    "В этом матче нет победителя — разбирать нечего.": "This match has no winner — nothing to analyze.",
    "Введите Match ID — разберём проигравшую команду и покажем, чей вклад в поражение был самым большим. Честно, с цифрами и аргументами.": "Enter a Match ID — we'll break down the losing team and show whose contribution to the loss was the biggest. Honestly, with numbers and arguments.",
    "Введите корректный Match ID — только цифры.": "Enter a valid Match ID — digits only.",
    "Вердикт": "Verdict",
    "Влияние {score} ({level}) · K/D/A {kda} · {spm} souls/min · урон по героям {dmg}% · KP {kp}%": "Impact {score} ({level}) · K/D/A {kda} · {spm} souls/min · hero damage {dmg}% · KP {kp}%",
    "Влияние на поражение": "Impact on the loss",
    "Возможно АФК": "Possibly AFK",
    "Все игроки проигравшей команды покинули матч или были АФК — честно выбрать руинера нельзя.": "Every player on the losing team left or was AFK — there's no fair way to pick a ruiner.",
    "Входите в драки со способностями наготове — Spirit Core решает файты бурстом.": "Enter fights with your abilities ready — a Spirit Core wins fights with burst.",
    "Выиграна": "Won",
    "Выигранная драка {a}–{b}": "Fight won {a}–{b}",
    "Высокий фарм без отдачи — ресурсы команды, которые не сработали.": "High farm with no payoff — team resources that never paid off.",
    "Высокое": "High",
    "Высокое участие в убийствах": "High kill participation",
    "Главный урок": "Main lesson",
    "Готово (из кэша): матч {id}.": "Done (from cache): match {id}.",
    "Готово: матч {id} разобран.": "Done: match {id} analyzed.",
    "Давил объекты": "Pressured objectives",
    "Даже фронтлайну нужны souls на защиту — забирайте волны, пока команда восстанавливается.": "Even a frontliner needs souls for defense — take waves while the team recovers.",
    "Данные:": "Data:",
    "Держите позицию за фронтлайном: живая поддержка полезнее героической смерти.": "Stay behind your frontline: a living support is worth more than a heroic death.",
    "Держите фарм между драками: Spirit-сборке нужны дорогие предметы к мидгейму.": "Keep farming between fights: a Spirit build needs expensive items by midgame.",
    "Держитесь ближе к команде в драках: ваш урон — главный ресурс, его нельзя тратить вне файтов.": "Stay close to your team in fights: your damage is the main resource, don't waste it outside fights.",
    "Длительность": "Duration",
    "Доля урона по героям {share}% (ориентир {base}%), участие в убийствах {kp}%": "Hero damage share {share}% (benchmark {base}%), kill participation {kp}%",
    "Доля урона по героям {share}% (ориентир {base}%), участие в убийствах {kp}%, смертей в драках: {fd}": "Hero damage share {share}% (benchmark {base}%), kill participation {kp}%, deaths in fights: {fd}",
    "Дорогие смерти": "Costly deaths",
    "Драк": "Fights",
    "Драки": "Fights",
    "Загружаю матч {id}…": "Loading match {id}…",
    "Загружаю профили игроков…": "Loading player profiles…",
    "Закрыть": "Close",
    "Игра длилась {mins} мин, а самый дорогой предмет в сборке — T{tier}": "The game lasted {mins} min, yet the best item in the build was T{tier}",
    "Игра шла {mins} мин, {d} смертей, но в сборке нет ничего из: {list}…": "The game lasted {mins} min with {d} deaths, but the build had none of: {list}…",
    "Игроки проигравшей команды": "Losing team players",
    "Инициируйте, когда команда рядом: танк, умерший первым и в одиночку, открывает драку сопернику.": "Initiate when your team is close: a tank who dies first and alone hands the fight to the enemy.",
    "Исключён из выбора": "Excluded from the pick",
    "Используйте живучесть, чтобы танковать объекты для команды.": "Use your durability to tank objectives for the team.",
    "Итог скопирован в буфер обмена.": "Summary copied to the clipboard.",
    "Итоги матча": "Match summary",
    "Итого": "Total",
    "Итоговая разница — {diff} souls ({pct}%): проигрывала вся команда, а не один игрок": "Final gap — {diff} souls ({pct}%): the whole team was losing, not one player",
    "КОПИРОВАТЬ ИТОГ": "COPY SUMMARY",
    "Каждая проигранная драка — это потерянные souls, время на респавне и окно для объектов соперника.": "Every lost fight means lost souls, time on respawn and a window for enemy objectives.",
    "Как развивалась игра": "How the game unfolded",
    "Карточка отправлена.": "Card shared.",
    "Карточка сохранена.": "Card saved.",
    "Ключевые эпизоды": "Key moments",
    "Команда в целом сильно отставала по souls": "The team as a whole was far behind on souls",
    "Команда отставала уже на лайнинге: {diff} souls к 10-й минуте, при этом у {name} смертей в этой фазе: {d}.": "The team was already behind in the laning phase: {diff} souls by minute 10, while {name} died {d} time(s) in that phase.",
    "Командные драки решают объекты: без урона и участия команда воюет в меньшинстве.": "Team fights decide objectives: without damage and presence the team fights a player down.",
    "Конвертируйте преимущество в объекты: после выигранной драки — сразу на Walker или Guardian.": "Turn advantages into objectives: after a won fight go straight for a Walker or Guardian.",
    "Лайнинг": "Laning",
    "Лейт": "Late game",
    "Лучший в поражении": "Best on the losing side",
    "Мало давления на объекты": "Little objective pressure",
    "Мало поддержки союзников": "Little ally support",
    "Матч {id} · победа {team} · {dur}": "Match {id} · {team} won · {dur}",
    "Матч в цифрах": "Match in numbers",
    "Матч закончился раньше.": "The match ended earlier.",
    "Матч не найден или ещё не обработан. Если игра закончилась недавно — попробуйте позже.": "Match not found or not processed yet. If the game ended recently, try again later.",
    "Матч не найден ни в базе deadlock-api.com, ни в Steam. Проверьте Match ID: данные очень старых матчей и матчей из приватных лобби Valve не отдаёт.": "Match not found in the deadlock-api.com database or on Steam. Check the Match ID: Valve doesn't provide data for very old matches or private lobbies.",
    "Этого матча ещё нет в базе, а лимит загрузки новых матчей из Steam исчерпан (3 в час на IP). Попробуйте через {m} мин. Уже загруженные матчи открываются как обычно.": "This match isn't in the database yet, and the limit for fetching new matches from Steam is used up (3 per hour per IP). Try again in {m} min. Already loaded matches open as usual.",
    "Между драками добирайте волны и лагеря: Carry без souls — это просто ещё один герой.": "Clear waves and camps between fights: a Carry without souls is just another hero.",
    "Меньше souls — позже ключевые предметы и слабее каждая следующая драка.": "Fewer souls means later key items and weaker fights every time.",
    "Меньше рискованных выходов в одиночку, особенно в лейте: одна смерть стоит объекта.": "Fewer risky solo plays, especially late: one death can cost an objective.",
    "Мид-босс": "Mid Boss",
    "Мид-босс даёт Rejuvenator — усиление команды и давление на объекты.": "The Mid Boss drops the Rejuvenator — a team buff and objective pressure.",
    "Мид-босс у команды": "Mid Boss taken by the team",
    "Мид-босс у соперника": "Mid Boss taken by the enemy",
    "Мидгейм": "Midgame",
    "Момент перелома": "Turning point",
    "Не забывайте о минимальном фарме: без базовых предметов поддержка не переживает драки.": "Don't skip basic farm: without core items a support won't survive fights.",
    "Не из кого выбирать": "No one to pick",
    "Не наступила": "Not reached",
    "Не удалось разобрать данные матча.": "Couldn't parse the match data.",
    "Не удалось связаться с API: нет сети или сервис недоступен.": "Couldn't reach the API: no network or the service is down.",
    "Сервер deadlock-api.com сейчас недоступен — это сбой на их стороне. Уже разобранные ранее матчи могут открываться, новые — нет. Попробуйте позже.": "The deadlock-api.com server is down right now — the problem is on their side. Previously analyzed matches may still open, new ones won't. Please try again later.",
    "Не удалось скопировать — браузер запретил доступ к буферу.": "Couldn't copy — the browser blocked clipboard access.",
    "Не удалось создать карточку.": "Couldn't create the card.",
    "Небольшое": "Minor",
    "Некорректный Match ID.": "Invalid Match ID.",
    "Неофициальный фан-проект. Deadlock — товарный знак Valve Corporation. Сайт не связан с Valve.": "Unofficial fan project. Deadlock is a trademark of Valve Corporation. This site is not affiliated with Valve.",
    "Нет анти-хила против сильного лечения": "No anti-heal against heavy healing",
    "Нет данных": "No data",
    "Нет данных для эпизодов.": "No data for key moments.",
    "Нет данных о предметах": "No item data",
    "Нет данных о смертях по времени — момент перелома определить нельзя.": "No timed death data — the turning point can't be determined.",
    "Нет защитных предметов в затяжной игре": "No defensive items in a long game",
    "Нет защиты от контроля": "No protection from crowd control",
    "Нет подключения к интернету.": "No internet connection.",
    "Нет предметов T4+ к лейту": "No T4+ items by late game",
    "Низкое": "Low",
    "Объектов снесено": "Objectives destroyed",
    "Объекты": "Objectives",
    "Объекты — главный путь к победе: без давления на них souls не превращаются в карту.": "Objectives are the path to victory: without pressure on them, souls never turn into map control.",
    "Объекты — главный способ давления; это был шанс развить преимущество.": "Objectives are the main way to apply pressure; this was a chance to build an advantage.",
    "Одиночные смерти дают сопернику бесплатное численное преимущество и souls.": "Solo deaths give the enemy a free numbers advantage and souls.",
    "Ориентиры souls/min скорректированы под средний ранг лобби ({rank}) и длительность игры: ×{mul}.": "Souls/min benchmarks are adjusted for the lobby's average rank ({rank}) and game length: ×{mul}.",
    "Ориентиры могли не совпасть с тем, что он реально делал в матче.": "The benchmarks may not match what this player actually did in the match.",
    "Открывает линию: сопернику — souls и контроль карты.": "Opens the lane: the enemy gets souls and map control.",
    "Открыть разбор": "Open analysis",
    "Очень высокое": "Very high",
    "ПОБЕДА": "WIN",
    "ПОРАЖЕНИЕ": "LOSS",
    "ПОЧЕМУ ИМЕННО ОН?": "WHY THIS PLAYER?",
    "По итогам матча": "Match totals",
    "По объектам": "Objective dmg",
    "Победа: {team} · {dur} · счёт {k0}:{k1}": "Winner: {team} · {dur} · score {k0}:{k1}",
    "Победа: {team} · длительность {dur}": "Winner: {team} · duration {dur}",
    "Победившая команда": "Winning team",
    "Победитель": "Winner",
    "Поддерживал команду": "Supported the team",
    "Поддержка": "Support",
    "Поддержка усиливает всю команду: без хила и контроля драки проигрываются раньше.": "Support strengthens the whole team: without healing and control, fights are lost sooner.",
    "Покадровых данных по souls для этого матча нет — график построить нельзя.": "This match has no souls timeline data, so the chart can't be drawn.",
    "Показывает, что у команды были окна для камбэка.": "Shows the team had windows for a comeback.",
    "Покинул матч на {t}": "Left the match at {t}",
    "Покупайте и используйте предметы поддержки: хил, барьеры и анти-хил решают затяжные драки.": "Buy and use support items: healing, barriers and anti-heal decide long fights.",
    "Помогайте команде давить объекты — даже небольшой урон ускоряет снос.": "Help the team hit objectives — even a little damage speeds things up.",
    "После драки бейте объекты, а не гоняйтесь за киллами.": "After a fight, hit objectives instead of chasing kills.",
    "После прожатия способностей отходите: Spirit-герой без кулдаунов — лёгкая цель.": "Back off after using your abilities: a Spirit hero on cooldown is an easy target.",
    "Потеря объекта сдвигает карту в пользу соперника.": "Losing an objective shifts the map in the enemy's favor.",
    "Потерян {obj}": "{obj} lost",
    "Почему {name}?": "Why {name}?",
    "Почему это важно:": "Why it matters:",
    "Почти ничья": "Nearly a tie",
    "Преимущество по souls": "Souls advantage",
    "Примерно ровно": "Roughly even",
    "Причины:": "Reasons:",
    "Проиграна": "Lost",
    "Проигранная драка {a}–{b}": "Fight lost {a}–{b}",
    "Разбор основан на статистике матча. Это оценка алгоритма по набору показателей, а не утверждение, что один игрок единолично проиграл игру.": "This breakdown is based on match statistics. It's an algorithmic assessment across a set of metrics, not a claim that one player lost the game alone.",
    "Разница по souls": "Souls gap",
    "Ранги игроков неизвестны — ориентиры скорректированы только под длительность игры: ×{mul}.": "Player ranks are unknown — benchmarks are adjusted for game length only: ×{mul}.",
    "Ресурсы и предметы": "Resources and items",
    "Ресурсы не конвертированы в давление": "Resources not converted into pressure",
    "Рисую карточку…": "Drawing the card…",
    "Роль определена неуверенно": "Role detection is uncertain",
    "Роль определена по net worth: данных о предметах недостаточно.": "Role estimated from net worth: not enough item data.",
    "Роль определена по доле souls ({nw}%) и сборке: weapon {w}%, vitality {v}%, spirit {s}%.": "Role estimated from souls share ({nw}%) and build: weapon {w}%, vitality {v}%, spirit {s}%.",
    "Руинер: {name} ({hero}) — влияние на поражение: {level} ({score}), уверенность {conf}%": "Ruiner: {name} ({hero}) — impact on the loss: {level} ({score}), confidence {conf}%",
    "СКАЧАТЬ КАРТОЧКУ": "DOWNLOAD CARD",
    "Самый рисковый игрок": "Riskiest player",
    "Сборка не отвечала на угрозы соперника.": "The build didn't answer the enemy's threats.",
    "Сильных аргументов в защиту нет": "No strong arguments for the defense",
    "Слабое участие в драках": "Weak fight presence",
    "Следующий по шкале — {name} ({hero}): {score}. Разница — {gap}.": "Next on the scale: {name} ({hero}) with {score}. Gap: {gap}.",
    "Слишком много запросов к API. Подождите {s} с и попробуйте снова.": "Too many API requests. Wait {s} s and try again.",
    "Слово защите": "The defense speaks",
    "Смертей: {d} ({dp10} за 10 мин) — больше, чем в среднем по команде": "Deaths: {d} ({dp10} per 10 min) — more than the team average",
    "Смертей: {d} ({dp10} за 10 мин), из них {late} после 25-й минуты; потеряно {loss} souls": "Deaths: {d} ({dp10} per 10 min), {late} of them after minute 25; {loss} souls lost",
    "Смерти {l}:{w}": "Deaths {l}:{w}",
    "Смерть — это потерянные souls, время на респавне и численное преимущество соперника.": "A death means lost souls, time on respawn and a numbers advantage for the enemy.",
    "Соперники лечились на {heal}/мин, а в сборке нет {list}": "The enemy healed {heal}/min, yet the build has no {list}",
    "Сравнение с ожиданиями": "Expectations vs. reality",
    "Сразу после драки пал {obj} — проигранная драка превратилась в потерю карты.": "The {obj} fell right after the fight — a lost fight turned into lost map.",
    "Статистика почти по всем пунктам против него. Но это всё ещё только цифры, а не весь матч.": "The stats are against this player on almost every point. But it's still just numbers, not the whole match.",
    "Считаю…": "Crunching numbers…",
    "Текущий ранг игрока (в данных матча ранга нет)": "Player's current rank (the match data has no rank)",
    "Топ-1 по урону в команде": "Top-1 damage on the team",
    "Топ-2 по урону в команде": "Top-2 damage on the team",
    "Точки — снимки статистики API ({n} шт.), между ними значения интерполированы.": "Points are API stat snapshots ({n} total); values between them are interpolated.",
    "У соперника был разогнанный {hero}: {kda}, {nw} souls.": "The enemy had a fed {hero}: {kda}, {nw} souls.",
    "Уверенность оценки": "Confidence",
    "Уверенность оценки {conf}% · по статистике матча": "Confidence {conf}% · based on match statistics",
    "Умеренное": "Moderate",
    "Умирал реже среднего": "Died less than average",
    "Уничтожен вражеский {obj}": "Enemy {obj} destroyed",
    "Урон по героям": "Hero damage",
    "Урон по объектам {obj} — {share}% от командного (ориентир {base}%)": "Objective damage {obj} — {share}% of the team's (benchmark {base}%)",
    "Участвуйте в драках: поддержка работает только рядом с командой.": "Join the fights: support only works next to the team.",
    "Участие в убийствах {kp}% — выше среднего по команде.": "Kill participation {kp}% — above the team average.",
    "Фарм в норме": "Farm on target",
    "Фарм ниже ориентира": "Farm below benchmark",
    "Финальный объект — матч решён.": "The final objective — the match is decided.",
    "Фронтлайн должен начинать и держать драку: будьте первым, кто впитывает урон.": "A frontliner should start and hold the fight: be the first to soak damage.",
    "Хил": "Healing",
    "Хил союзников и срезанный хил врагов: {util}/мин (ориентир {base}/мин)": "Ally healing and prevented enemy healing: {util}/min (benchmark {base}/min)",
    "Цена смертей": "Cost of deaths",
    "Что не было твоей ошибкой": "What wasn't your fault",
    "Что произошло:": "What happened:",
    "Экономика": "Economy",
    "Явно проигранных драк не найдено — поражение копилось постепенно.": "No clearly lost fights found — the loss built up gradually.",
    "Явных внешних факторов не найдено — статистика в основном отражает собственную игру.": "No clear external factors found — the stats mostly reflect this player's own game.",
    "Явных провалов нет — он просто чуть слабее остальных по совокупности показателей.": "No glaring failures — just slightly weaker than the rest across the metrics.",
    "в пользу {team}": "in favor of {team}",
    "вклад": "impact",
    "кластеры из 2+ смертей": "clusters of 2+ deaths",
    "матч {id}": "match {id}",
    "негативный сигнал": "negative signal",
    "нет данных": "no data",
    "положительный сигнал": "positive signal",
    "предположительно": "estimated",
    "смерти {name}": "{name}'s deaths",
  };

  // Строки с числами, которые не проходят через шаблоны
  const REGEX = [
    [/^(\d+) мин$/, '$1 min'],
    [/^(\d+) с$/, '$1 s'],
    [/^(\d+) смертей$/, '$1 deaths'],
    [/^Tier (\d+)$/, 'Tier $1'],
  ];

  let lang = (function () {
    const saved = store.get('lang');
    if (saved === 'ru' || saved === 'en') return saved;
    const nav = (navigator.language || 'ru').toLowerCase();
    return nav.startsWith('ru') || nav.startsWith('uk') || nav.startsWith('be') || nav.startsWith('kk') ? 'ru' : 'en';
  })();
  const listeners = [];

  function t(s) {
    if (lang === 'ru' || s == null) return s;
    if (Object.prototype.hasOwnProperty.call(DICT, s)) return DICT[s];
    for (const [re, rep] of REGEX) if (re.test(s)) return s.replace(re, rep);
    return s;
  }
  // Шаблон с подстановкой; значения экранируются (результат безопасен для HTML)
  function tf(tpl, vars) {
    vars = vars || {};
    return t(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
  }
  // То же без экранирования — для буфера обмена и canvas
  function tfr(tpl, vars) {
    vars = vars || {};
    return t(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      if (el.dataset.ru == null) el.dataset.ru = el.textContent.trim();
      el.textContent = t(el.dataset.ru);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      if (el.dataset.ruPh == null) el.dataset.ruPh = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', t(el.dataset.ruPh));
    });
    const x = document.querySelector('.modal-x');
    if (x) x.setAttribute('aria-label', t('Закрыть'));
    document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  }
  function setLang(l) {
    if (l !== 'ru' && l !== 'en') return;
    if (l === lang) return;
    lang = l;
    store.set('lang', l);
    applyStatic();
    listeners.forEach((cb) => { try { cb(l); } catch (e) { console.error(e); } });
    track('lang-' + l);
  }

  // ======================================================================
  // Пауза при лимите запросов
  // ======================================================================
  const cooldown = {
    get() { return Number(store.get('cooldown')) || 0; },
    set(until) { store.set('cooldown', until); },
  };

  // ======================================================================
  // Кэш разобранных матчей (облегчённые данные, до 5 штук)
  // ======================================================================
  const MATCH_MAX = 5;
  const matchCache = {
    get(id) { return store.get('m:' + id, 7 * 24 * 3600 * 1000); },
    put(id, data) {
      let index = (store.get('m:index') || []).filter((x) => x !== String(id));
      index.unshift(String(id));
      while (index.length > MATCH_MAX) store.del('m:' + index.pop());
      for (let i = 0; i < MATCH_MAX && !store.set('m:' + id, data); i++) {
        const old = index.pop();
        if (!old || old === String(id)) break;
        store.del('m:' + old);
      }
      store.set('m:index', index);
    },
  };

  // ======================================================================
  // История последних разборов
  // ======================================================================
  const history = {
    list() { const h = store.get('history'); return Array.isArray(h) ? h : []; },
    add(entry) {
      const h = this.list().filter((x) => String(x.id) !== String(entry.id));
      h.unshift(Object.assign({ ts: Date.now() }, entry));
      store.set('history', h.slice(0, 8));
    },
    render(el, onPick) {
      if (!el) return;
      const h = this.list();
      el.innerHTML = h.map((x) => {
        const im = typeof x.img === 'string' && /^https:\/\//.test(x.img) ? `<img src="${esc(x.img)}" alt="">` : '';
        const label = [x.hero, x.nick].filter(Boolean).join(' · ');
        return `<button type="button" class="chip" data-id="${esc(x.id)}" title="${esc(t('Открыть разбор'))}">${im}<b>#${esc(x.id)}</b>${label ? `<span>${esc(label)}</span>` : ''}</button>`;
      }).join('');
      el.onclick = (e) => {
        const b = e.target.closest('.chip');
        if (b) { track('click-history'); onPick(b.dataset.id); }
      };
    },
  };

  // ======================================================================
  // Deep links: ?match=ID
  // ======================================================================
  const deepLink = {
    read() {
      try {
        const v = new URLSearchParams(location.search).get('match');
        return v && /^\d{1,12}$/.test(v) ? v : null;
      } catch (e) { return null; }
    },
    write(id) {
      try {
        const u = new URL(location.href);
        u.searchParams.set('match', id);
        window.history.replaceState(null, '', u);
      } catch (e) { /* ignore */ }
    },
    url(id) {
      try { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('match', id); return u.toString(); } catch (e) { return ''; }
    },
  };

  // ======================================================================
  // GoatCounter (без cookies), события: анализ, клики, ошибки
  // ======================================================================
  const gcQueue = [];
  function track(name) {
    if (!window.WR_GOATCOUNTER) return;
    const ev = { path: String(name), title: String(name), event: true };
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count(ev);
    else gcQueue.push(ev);
  }
  function initCounter() {
    const code = window.WR_GOATCOUNTER;
    if (!code || !/^[a-z0-9-]+$/i.test(code)) return;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://gc.zgo.at/count.js';
    s.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
    s.onload = () => {
      const flush = () => {
        if (!window.goatcounter || !window.goatcounter.count) return setTimeout(flush, 300);
        while (gcQueue.length) window.goatcounter.count(gcQueue.shift());
      };
      flush();
    };
    document.head.appendChild(s);
  }

  // ======================================================================
  // «Адвокат»: аргументы в защиту руинера
  // ======================================================================
  function advocate(A) {
    const r = A.ruiner;
    if (!r) return [];
    const L = A.byTeam[A.loser].filter((p) => !p.excluded);
    const mean = (f) => (L.length ? L.reduce((s, p) => s + f(p), 0) / L.length : 0);
    const pct = (x) => Math.round((x || 0) * 100);
    const CFG = A.CFG;
    const out = [];

    const avgKp = mean((p) => p.kp);
    if (r.kp >= avgKp + 0.05) out.push([t('Высокое участие в убийствах'), tf('KP {kp}% при среднем по команде {avg}%', { kp: pct(r.kp), avg: pct(avgKp) })]);

    const dmgRank = A.byTeam[A.loser].slice().sort((a, b) => b.heroDmg - a.heroDmg).indexOf(r);
    if (dmgRank === 0) out.push([t('Топ-1 по урону в команде'), tf('{dmg} урона по героям — больше всех в команде', { dmg: num(r.heroDmg) })]);
    else if (dmgRank === 1) out.push([t('Топ-2 по урону в команде'), tf('{dmg} урона по героям — второй результат в команде', { dmg: num(r.heroDmg) })]);

    const avgD = mean((p) => p.d);
    if (r.d < avgD - 0.5) out.push([t('Умирал реже среднего'), tf('{d} смертей при среднем по команде {avg}', { d: r.d, avg: avgD.toFixed(1) })]);

    const T = A.team;
    const deficit = T[A.winner].nw - T[A.loser].nw;
    if (T[A.winner].nw && deficit / T[A.winner].nw >= 0.08) {
      out.push([t('Команда в целом сильно отставала по souls'), tf('Итоговая разница — {diff} souls ({pct}%): проигрывала вся команда, а не один игрок', { diff: num(deficit), pct: pct(deficit / T[A.winner].nw) })]);
    }

    const gone = A.byTeam[A.loser].filter((p) => p.excluded);
    if (gone.length) out.push([t('В команде был ливер или АФК'), tf('{names} — команда играла в меньшинстве', { names: gone.map((p) => `${p.name} (${p.hero.name})`).join(', ') })]);

    if (r.objShare >= CFG.objShare[r.role]) out.push([t('Давил объекты'), tf('{share}% командного урона по объектам', { share: pct(r.objShare) })]);
    if (r.utilPerMin >= CFG.utilPerMin * 1.2) out.push([t('Поддерживал команду'), tf('{util}/мин хила союзникам и срезанного хила врагов', { util: num(r.utilPerMin) })]);
    if (r.farmR >= 1) out.push([t('Фарм в норме'), tf('{spm} souls/min — {pct}% от ориентира роли', { spm: num(r.spm), pct: pct(r.farmR) })]);
    if (r.roleFallback || r.roleConf < 0.3) out.push([t('Роль определена неуверенно'), t('Ориентиры могли не совпасть с тем, что он реально делал в матче.')]);
    if (A.near && r.score - A.near.score <= 5) out.push([t('Почти ничья'), tf('{name} отстаёт по шкале всего на {gap}', { name: A.near.name, gap: r.score - A.near.score })]);

    if (!out.length) out.push([t('Сильных аргументов в защиту нет'), t('Статистика почти по всем пунктам против него. Но это всё ещё только цифры, а не весь матч.')]);
    return out;
  }

  // ======================================================================
  // Копирование итога и PNG-карточка
  // ======================================================================
  function summaryText(A) {
    const r = A.ruiner;
    const lines = [
      tfr('WHO RUINED? — матч {id}', { id: A.id }),
      tfr('Победа: {team} · {dur} · счёт {k0}:{k1}', { team: A.CFG.teams[A.winner], dur: time(A.dur), k0: A.team[0].kills, k1: A.team[1].kills }),
    ];
    if (r) {
      lines.push(tfr('Руинер: {name} ({hero}) — влияние на поражение: {level} ({score}), уверенность {conf}%', {
        name: r.name, hero: r.hero.name, level: t(r.level.label), score: r.score, conf: A.confidence,
      }));
      lines.push(tfr('K/D/A {kda} · {spm} souls/min · KP {kp}%', { kda: `${r.k}/${r.d}/${r.a}`, spm: num(r.spm), kp: Math.round(r.kp * 100) }));
      if (r.reasons.length) lines.push(t('Причины:') + ' ' + r.reasons.slice(0, 3).map((x, i) => `${i + 1}) ${t(x.title)}`).join('; '));
    }
    if (A.mvp) lines.push(tfr('MVP: {name} ({hero})', { name: A.mvp.name, hero: A.mvp.hero.name }));
    lines.push(deepLink.url(A.id));
    return lines.filter(Boolean).join('\n');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fallback */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src || !/^https:\/\//.test(src)) return resolve(null);
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  function fitText(ctx, text, maxW, size, weight) {
    let s = size;
    ctx.font = `${weight} ${s}px "Inter Tight", system-ui, sans-serif`;
    while (ctx.measureText(text).width > maxW && s > 34) {
      s -= 4;
      ctx.font = `${weight} ${s}px "Inter Tight", system-ui, sans-serif`;
    }
    let out = text;
    while (ctx.measureText(out).width > maxW && out.length > 2) out = out.slice(0, -2) + '…';
    return out;
  }

  const LEVEL_COLOR = ['#3ddc84', '#c9d36a', '#f2c14e', '#ff6a4d', '#ff3b3b'];

  async function card(A, rankInfo) {
    const r = A.ruiner;
    if (!r) throw new Error('no ruiner');
    try { await document.fonts.load('900 64px "Inter Tight"'); await document.fonts.load('600 28px "Inter Tight"'); } catch (e) { /* ignore */ }
    const S = 1080;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d');

    g.fillStyle = '#07080b';
    g.fillRect(0, 0, S, S);
    let rg = g.createRadialGradient(120, 80, 0, 120, 80, 700);
    rg.addColorStop(0, 'rgba(232,163,61,0.28)'); rg.addColorStop(1, 'rgba(232,163,61,0)');
    g.fillStyle = rg; g.fillRect(0, 0, S, S);
    rg = g.createRadialGradient(980, 980, 0, 980, 980, 760);
    rg.addColorStop(0, 'rgba(61,127,224,0.26)'); rg.addColorStop(1, 'rgba(61,127,224,0)');
    g.fillStyle = rg; g.fillRect(0, 0, S, S);

    // портрет героя справа
    const hero = await loadImage(r.hero.card || r.hero.small);
    if (hero) {
      const bx = 560, by = 90, bw = 460, bh = 640;
      const sc = Math.max(bw / hero.width, bh / hero.height);
      const sw = bw / sc, sh = bh / sc;
      g.save();
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, bw, bh, 28); else g.rect(bx, by, bw, bh);
      g.clip();
      g.drawImage(hero, (hero.width - sw) / 2, (hero.height - sh) / 2, sw, sh, bx, by, bw, bh);
      const fade = g.createLinearGradient(0, by + bh * 0.55, 0, by + bh);
      fade.addColorStop(0, 'rgba(7,8,11,0)'); fade.addColorStop(1, 'rgba(7,8,11,0.85)');
      g.fillStyle = fade; g.fillRect(bx, by, bw, bh);
      g.restore();
      g.strokeStyle = 'rgba(255,59,59,0.6)'; g.lineWidth = 3;
      g.beginPath(); if (g.roundRect) g.roundRect(bx, by, bw, bh, 28); else g.rect(bx, by, bw, bh); g.stroke();
      g.fillStyle = '#ff3b3b';
      g.beginPath(); if (g.roundRect) g.roundRect(bx + 24, by + bh - 70, 170, 46, 10); else g.rect(bx + 24, by + bh - 70, 170, 46); g.fill();
      g.fillStyle = '#fff'; g.font = '900 24px "Inter Tight", system-ui, sans-serif'; g.textBaseline = 'middle';
      g.fillText('RUINER', bx + 50, by + bh - 47);
    }

    g.textBaseline = 'alphabetic';
    g.fillStyle = '#e8a33d';
    g.font = '700 22px "Inter Tight", system-ui, sans-serif';
    g.fillText('DEADLOCK / MATCH FORENSICS', 64, 112);
    g.font = '900 92px "Inter Tight", system-ui, sans-serif';
    g.fillStyle = '#ece7df'; g.fillText('WHO', 60, 210);
    g.fillStyle = '#ff3b3b'; g.fillText('RUINED?', 60, 300);

    g.fillStyle = '#ece7df';
    g.fillText(fitText(g, r.name, 470, 64, 900), 64, 420);
    g.fillStyle = '#9a958d';
    g.font = '600 28px "Inter Tight", system-ui, sans-serif';
    const ri = rankInfo ? rankInfo(r.badge) : null;
    g.fillText(fitText(g, `${r.hero.name}${ri ? ' · ' + ri.name : ''}`, 470, 28, 600), 64, 466);

    g.font = '700 20px "Inter Tight", system-ui, sans-serif';
    g.fillStyle = '#9a958d';
    g.fillText(t('Влияние на поражение').toUpperCase(), 64, 540);
    g.fillStyle = LEVEL_COLOR[r.level.idx] || '#ff3b3b';
    g.font = '900 56px "Inter Tight", system-ui, sans-serif';
    g.fillText(fitText(g, `${t(r.level.label)} · ${r.score}`, 470, 56, 900), 64, 602);

    const stats = [['K/D/A', `${r.k}/${r.d}/${r.a}`], ['SOULS/MIN', num(r.spm)], ['KP', `${Math.round(r.kp * 100)}%`]];
    stats.forEach((s, i) => {
      const x = 64 + i * 160;
      g.fillStyle = '#6b675f'; g.font = '700 18px "Inter Tight", system-ui, sans-serif'; g.fillText(s[0], x, 680);
      g.fillStyle = '#ece7df'; g.font = '800 38px "Inter Tight", system-ui, sans-serif'; g.fillText(s[1], x, 726);
    });

    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(64, 800, S - 128, 2);
    g.fillStyle = '#ece7df';
    g.font = '700 26px "Inter Tight", system-ui, sans-serif';
    g.fillText(tfr('Матч {id} · победа {team} · {dur}', { id: A.id, team: A.CFG.teams[A.winner], dur: time(A.dur) }), 64, 860);
    g.fillStyle = '#9a958d';
    g.font = '500 22px "Inter Tight", system-ui, sans-serif';
    g.fillText(fitText(g, tfr('Уверенность оценки {conf}% · по статистике матча', { conf: A.confidence }), S - 128, 22, 500), 64, 902);
    g.fillStyle = '#e8a33d';
    g.font = '600 22px "Inter Tight", system-ui, sans-serif';
    g.fillText(fitText(g, deepLink.url(A.id).replace(/^https?:\/\//, ''), S - 128, 22, 600), 64, 1000);

    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
    const fileName = `who-ruined-${A.id}.png`;
    const mobile = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (mobile && navigator.canShare && typeof File === 'function') {
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'WHO RUINED?', text: summaryText(A) });
          return 'shared';
        } catch (e) {
          if (e && e.name === 'AbortError') return 'cancel';
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'saved';
  }

  const share = {
    text: summaryText,
    copy: (A) => copyText(summaryText(A)),
    card,
  };

  // ======================================================================
  // Инициализация
  // ======================================================================
  function init() {
    applyStatic();
    document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
    initCounter();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    t, tf, tfr, esc, num, time, store, cooldown, matchCache, history, deepLink, track, advocate, share,
    get lang() { return lang; },
    setLang,
    onLang(cb) { listeners.push(cb); },
  };
})();
