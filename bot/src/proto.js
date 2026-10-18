// Протоколы Deadlock (SteamDatabase/Protobufs, папка protos/) и разбор файла матча
// в тот же JSON, что отдаёт deadlock-api.com: snake_case, enum'ы числами, значения по умолчанию.
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const PROTOS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'protos');

const root = new protobuf.Root();
root.resolvePath = (origin, target) => path.join(PROTOS, target);
root.loadSync(['citadel_gcmessages_client.proto', 'citadel_gcmessages_common.proto', 'gcsystemmsgs.proto'], { keepCase: true });

const clientMsgs = root.lookupEnum('EGCCitadelClientMessages').values;

export const APP_ID = 1422450;
export const MSG = {
  clientHello: 4006,                                     // k_EMsgGCClientHello
  clientWelcome: 4004,                                   // k_EMsgGCClientWelcome
  playtestStatus: clientMsgs.k_EMsgGCToClientDevPlaytestStatus,
  getMatchMetaData: clientMsgs.k_EMsgClientToGCGetMatchMetaData,
};

export const CitadelClientHello = root.lookupType('CMsgCitadelClientHello');
export const GetMatchMetaData = root.lookupType('CMsgClientToGCGetMatchMetaData');
export const GetMatchMetaDataResponse = root.lookupType('CMsgClientToGCGetMatchMetaDataResponse');
export const MetaResult = GetMatchMetaDataResponse.lookupEnum('EResult').values;

const MatchMetaData = root.lookupType('CMsgMatchMetaData');
const MatchMetaDataContents = root.lookupType('CMsgMatchMetaDataContents');

const TO_JSON = { longs: Number, enums: Number, bytes: String, defaults: true, arrays: true };

// Файл .meta.bz2 с серверов Valve; несмотря на расширение, внутри Zstandard
export function decodeMetaFile(buf) {
  const zstd = buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
  if (!zstd) throw new Error('unknown_compression');
  const meta = MatchMetaData.decode(zlib.zstdDecompressSync(buf));
  return MatchMetaDataContents.toObject(MatchMetaDataContents.decode(meta.match_details), TO_JSON);
}
