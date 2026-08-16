// Tutorial telemetry. Local only — a capped ring of events in localStorage so a play
// session can be inspected after the fact (which lesson armed, when it was shown, how long
// until it was learned). Nothing is uploaded; there is no backend.
//
// No wall clock anywhere: the determinism lint bans Date.now in src/, and the data is more
// useful in simulation seconds anyway, so every event carries the sim time the caller read
// from the game state. Storage failures (Safari private mode, headless runs) drop the event
// and return false — telemetry must never be able to break play.

const KEY = 'glv.tutorial.v1';
const CAP = 300;

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.setItem('glv.probe', '1');   // Safari private mode throws here
    localStorage.removeItem('glv.probe');
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * @param {'lesson_armed'|'lesson_shown'|'lesson_learned'|'lesson_skipped'} type
 * @param {object} data e.g. {lesson, simTime, sinceArmed}
 * @returns {boolean} true if the event was stored
 */
export function logTutorialEvent(type, data) {
  const s = storage();
  if (!s) return false;
  try {
    const arr = JSON.parse(s.getItem(KEY) || '[]');
    arr.push({ t: type, ...data });
    if (arr.length > CAP) arr.splice(0, arr.length - CAP);
    s.setItem(KEY, JSON.stringify(arr));
    return true;
  } catch {
    return false;
  }
}

/** @returns {object[]} all stored events, oldest first */
export function readTutorialEvents() {
  const s = storage();
  if (!s) return [];
  try { return JSON.parse(s.getItem(KEY) || '[]'); } catch { return []; }
}

export function clearTutorialEvents() {
  const s = storage();
  if (s) try { s.removeItem(KEY); } catch {}
}
