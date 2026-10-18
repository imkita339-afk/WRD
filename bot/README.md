# Steam-бот WHO RUINED?

Свой источник матчей Deadlock — тот же путь, что у deadlock-api.com, только в маленьком масштабе:

1. бот входит в Steam и подключается к Game Coordinator Deadlock;
2. по запросу `GetMatchMetaData` получает «соли» матча (кластер и `metadata_salt`);
3. скачивает `http://replay{кластер}.valve.net/1422450/{match_id}_{salt}.meta.bz2` (внутри Zstandard);
4. разбирает protobuf `CMsgMatchMetaDataContents` в тот же JSON, что отдаёт deadlock-api.com.

Бот сам держит WebSocket к прокси (`worker/`), поэтому белый IP и открытые порты не нужны. Прокси спрашивает бота, только когда матча нет ни в своём хранилище, ни в базе deadlock-api.com (или когда она лежит). Если бот выключен или лимит исчерпан, сайт загружает матч напрямую, как раньше.

## Лимит

40 запросов к GC за 24 часа (как у deadlock-api на один аккаунт), после ответа «Rate Limited» — пауза на час. Меняется в `config.json` (`dailyLimit`). Учёт — в `data/quota.json`.

## Запуск

Нужен Node.js 22.15+ и **отдельный** Steam-аккаунт с доступом к Deadlock — не основной: автоматический вход противоречит правилам Steam, аккаунт бота рискует блокировкой. Не заходите в этот аккаунт в игре, пока бот работает: Steam выкинет бота (он вернётся сам через 10 минут).

```bash
start.cmd
```

Первый запуск спросит логин, пароль и код Steam Guard. Пароль нигде не сохраняется — бот запоминает только сессию Steam в `data/refresh-token.txt`. Дальше `start.cmd` запускается без вопросов.

Проверка одного матча без прокси (тратит 1 запрос из лимита):

```bash
start.cmd --match 117323415
```

## Файлы

```
config.json          адрес прокси и суточный лимит
src/main.js          запуск, первый вход
src/steam.js         Steam и Game Coordinator
src/match.js         соли → файл Valve → JSON
src/proto.js         протоколы и разбор файла матча
src/hub.js           WebSocket к прокси
src/quota.js         суточный лимит
protos/              SteamDatabase/Protobufs, папка deadlock
data/                сессия Steam, токен прокси, учёт лимита — не коммитится
```

`data/bot-token.txt` должен совпадать с секретом воркера `BOT_TOKEN` (`npx.cmd wrangler secret put BOT_TOKEN` в папке `worker`).

Память: около 200–250 МБ, диск — около 50 МБ без Node.js.
