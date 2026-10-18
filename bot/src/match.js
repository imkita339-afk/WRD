// Матч целиком: соли у GC → файл с серверов Valve → JSON в формате deadlock-api.com
import { APP_ID, MetaResult, decodeMetaFile } from './proto.js';

const DOWNLOAD_TIMEOUT = 30000;

// status: ok | not_found | in_flight | limit | offline | error
export async function fetchMatch(gc, quota, id) {
  if (!gc.ready) return { status: 'offline' };
  if (!quota.take()) return { status: 'limit', retryAfter: Math.ceil(quota.waitMs() / 1000) };

  const r = await gc.getSalts(id);
  switch (r.result) {
    case MetaResult.k_eResult_Success: break;
    case MetaResult.k_eResult_InvalidMatch: return { status: 'not_found' };
    case MetaResult.k_eResult_MatchInFlight: return { status: 'in_flight' };
    case MetaResult.k_eResult_RateLimited:
    case MetaResult.k_eResult_TooBusy:
    case MetaResult.k_eResult_TemporarilyDisabled:
      quota.pause();
      return { status: 'limit', retryAfter: Math.ceil(quota.waitMs() / 1000) };
    default: return { status: 'error', detail: `gc_result_${r.result}` };
  }
  if (!r.metadata_salt || !r.replay_group_id) return { status: 'in_flight' };

  const url = `http://replay${r.replay_group_id}.valve.net/${APP_ID}/${id}_${r.metadata_salt}.meta.bz2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
  if (res.status === 404) return { status: 'in_flight' };   // файл ещё не выложен
  if (!res.ok) return { status: 'error', detail: `download_${res.status}` };

  const contents = decodeMetaFile(Buffer.from(await res.arrayBuffer()));
  const mi = contents.match_info;
  if (!mi || !Array.isArray(mi.players) || !mi.players.length) return { status: 'error', detail: 'empty_match' };
  return { status: 'ok', match: { match_info: mi } };
}
