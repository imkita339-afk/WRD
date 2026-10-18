// Вход в Steam и сессия с Game Coordinator Deadlock: запрос «солей» матча.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import SteamUser from 'steam-user';
import { APP_ID, MSG, CitadelClientHello, GetMatchMetaData, GetMatchMetaDataResponse } from './proto.js';
import { log } from './util.js';

const HELLO_EVERY = 5000;          // приветствие GC, пока он не ответит
const GC_TIMEOUT = 30000;          // ответ GC на запрос матча
const ELSEWHERE_RETRY = 10 * 60 * 1000;   // аккаунт заняли в игре — пробуем позже

export class DeadlockGC extends EventEmitter {
  constructor({ tokenFile }) {
    super();
    this.tokenFile = tokenFile;
    this.ready = false;
    this.helloTimer = null;
    this.client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true });

    this.client.on('refreshToken', (token) => {
      fs.writeFileSync(this.tokenFile, token, { mode: 0o600 });
      log('Сессия Steam сохранена — пароль больше не понадобится.');
    });
    this.client.on('loggedOn', () => {
      log(`Вошли в Steam как ${this.client.steamID.getSteamID64()}. Подключаемся к Deadlock…`);
      this.client.gamesPlayed([APP_ID]);
      this._startHello();
    });
    this.client.on('receivedFromGC', (appid, msgType) => {
      if (appid !== APP_ID || this.ready) return;
      if (msgType === MSG.clientWelcome || msgType === MSG.playtestStatus) {
        this.ready = true;
        clearInterval(this.helloTimer);
        log('Game Coordinator Deadlock на связи — бот готов.');
        this.emit('ready');
      }
    });
    this.client.on('disconnected', (eresult, msg) => {
      this._notReady();
      log(`Отключились от Steam (${msg || eresult}), steam-user переподключится сам.`);
    });
    this.client.on('error', (err) => this._onError(err));
  }

  // Первый вход — по логину и паролю (Steam Guard спросит код в консоли), потом — по сохранённой сессии
  start(credentials) {
    if (credentials) return this.client.logOn({ accountName: credentials.accountName, password: credentials.password });
    if (!fs.existsSync(this.tokenFile)) {
      log('Нет сохранённой сессии Steam. Запустите бота заново и войдите по логину и паролю.');
      process.exit(2);
    }
    this.client.logOn({ refreshToken: fs.readFileSync(this.tokenFile, 'utf8').trim() });
  }

  // Соли матча: номер кластера и metadata_salt, по ним файл качается с серверов Valve
  getSalts(matchId) {
    if (!this.ready) return Promise.reject(new Error('gc_not_ready'));
    const body = Buffer.from(GetMatchMetaData.encode({ match_id: matchId }).finish());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gc_timeout')), GC_TIMEOUT);
      this.client.sendToGC(APP_ID, MSG.getMatchMetaData, {}, body, (appid, msgType, payload) => {
        clearTimeout(timer);
        try {
          resolve(GetMatchMetaDataResponse.toObject(GetMatchMetaDataResponse.decode(payload), { enums: Number, defaults: true }));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  _startHello() {
    this._notReady();
    const hello = Buffer.from(CitadelClientHello.encode({}).finish());
    const send = () => this.client.sendToGC(APP_ID, MSG.clientHello, {}, hello);
    send();
    this.helloTimer = setInterval(send, HELLO_EVERY);
  }

  _notReady() {
    clearInterval(this.helloTimer);
    if (this.ready) this.emit('lost');
    this.ready = false;
  }

  _onError(err) {
    this._notReady();
    const E = SteamUser.EResult;
    if (err.eresult === E.LoggedInElsewhere || err.eresult === E.LogonSessionReplaced) {
      log('В этот аккаунт зашли с другого устройства (например, в игру). Повторим вход через 10 минут.');
      setTimeout(() => this.start(), ELSEWHERE_RETRY);
      return;
    }
    if ([E.InvalidPassword, E.AccessDenied, E.Expired, E.Revoked, E.InvalidSignature].includes(err.eresult)) {
      try { fs.unlinkSync(this.tokenFile); } catch (e) { /* уже нет */ }
      log('Сохранённая сессия Steam больше не действует. Запустите бота заново и войдите по логину и паролю.');
      process.exit(2);
    }
    log(`Ошибка Steam: ${err.message}. Повторим вход через минуту.`);
    setTimeout(() => this.start(), 60 * 1000);
  }
}
