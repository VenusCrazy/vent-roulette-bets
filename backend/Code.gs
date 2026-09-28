/**
 * Catch Your Shooter: betting backend
 * Actions: getBets, getTeams, getScore, placeBet, declareResult, resetRound
 *
 * Where things live:
 *   - The team roster and the points are in a SEPARATE spreadsheet, opened by
 *     ID (CONFIG.SCORE_SPREADSHEET_ID). The script is bound to a different
 *     workbook entirely, so nothing here uses getActive() for team data.
 *   - The live round, the round counter and the archive are held in script
 *     properties, not in a spreadsheet. No Bets sheet, no Archive sheet, no
 *     Config sheet.
 *
 * The roster is read once per execution into an array, and every lookup is an
 * exact compare against that array.
 *
 * Points: THE SPREADSHEET IS NEVER WRITTEN. Its Score column is a formula
 * (=IF(COUNTA(D5:W5)=0,"",SUM(D5:W5))) owned by another script, and this one
 * only ever reads it. A team's spendable points are therefore computed here:
 *
 *   available = Score as the sheet evaluates it
 *            + what this script has settled for that team so far (state.p)
 *            - stakes that are still in flight this round
 *
 * A stake is HELD in the round rather than taken out of the sheet, so the
 * sheet's total is never disturbed. When the round is declared the hold is made
 * permanent: a winner is paid twice their stake, a loser forfeits theirs. That
 * is the whole of the bet — a winner's net is +stake, a loser's is −stake — and
 * it is why a game of fixed-multiplier bets mints and burns points rather than
 * conserving them.
 *
 * A refresh settles nothing, so it simply drops the round and hands every
 * un-settled stake straight back. The site's balance is the honest one; the
 * sheet's Score column stays exactly as its own script left it.
 */
const CONFIG = {
  // The spreadsheet that owns the teams and the points.
  SCORE_SPREADSHEET_ID: '165jVE7EteZQb4w4RoiHzXMHAVf4Akgt0xdSSzBi2lQM',
  SCORE_SHEET: 'Sheet1',

  FIRST_ROW: 2,

  // Sheet1 columns (1-based). The header row below ("Team Code", "Team Name",
  // "Score") is what the script actually reads — these are only the fallback
  // for a sheet whose headings are missing.
  SCORE_NAME: 2,  // B  Team Name
  SCORE_CODE: 1,  // A  Team Code
  SCORE_TOTAL: 3, // C  Score

  // How far across the first row to look for those header names.
  // Widen it if your headers sit further right than column 200.
  HEADER_SCAN_COLS: 200,

  VENTS: 9,
  WIN_MULTIPLIER: 2,
  REFUND_NEUTRAL: false,

  // Script properties, where the round and its archive live.
  PROPS_BETS: 'bets_v1',
  PROPS_HISTORY: 'history_v1',
  // PropertiesService caps a single value at 9KB, so the archive is trimmed to
  // fit rather than kept to a fixed number of rounds.
  HISTORY_MAX_BYTES: 8000,
};

/* ---------- entry points ---------- */

function doGet(e) {
  return json_(handleBettingAction_(e.parameter || {}));
}

function doPost(e) {
  let params;
  try {
    params = JSON.parse(e.postData.contents);
  } catch (err) {
    params = e.parameter || {};
  }
  return json_(handleBettingAction_(params));
}

function handleBettingAction_(p) {
  try {
    switch (p.action) {
      case 'getBets':       return getBets_();
      case 'getTeams':      return getTeams_(p);
      case 'getScore':      return getScore_(p);
      case 'placeBet':      return placeBet_(p);
      case 'declareResult': return declareResult_(p);
      case 'resetRound':    return resetRound_();
      default:              return { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- the stored round ---------- */

// Shape: { r: <round>, p: { <teamCode>: <settled adjustment, ever> }, b: [ { c, n, a, v } ] }
function readRound_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROPS_BETS);
  if (!raw) return { r: 1, p: {}, b: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      r: Number(parsed.r) > 0 ? Number(parsed.r) : 1,
      // A single number here would mean one team's winnings banked for every
      // team, so anything that is not a per-team map is discarded rather than
      // silently shared out.
      p: parsed.p && typeof parsed.p === 'object' && !Array.isArray(parsed.p) ? parsed.p : {},
      b: Array.isArray(parsed.b) ? parsed.b : [],
    };
  } catch (err) {
    // A corrupt blob must not take the site down; start a fresh round and say so.
    Logger.log('Could not read the stored round (' + err.message + '). Starting round 1 again.');
    return { r: 1, p: {}, b: [] };
  }
}

/** What this script has settled in a team's favour, or against them. */
function settledFor_(state, teamCode) {
  return Number(state.p[String(teamCode)]) || 0;
}

/** The stake this team currently has riding on the live round, or 0. */
function inFlight_(state, teamCode) {
  const target = String(teamCode);
  for (let i = 0; i < state.b.length; i++) {
    if (String(state.b[i].c) === target) return Number(state.b[i].a) || 0;
  }
  return 0;
}

/**
 * What a team can actually spend right now: the sheet's own Score, plus every
 * stake this script has settled in their favour or against them, minus whatever
 * of their own stake is still riding on the open round. This is the only place
 * points are ever worked out — the spreadsheet is read, never written.
 */
function availableFor_(team, state) {
  return team.totalScore + settledFor_(state, team.teamCode) - inFlight_(state, team.teamCode);
}

function writeRound_(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROPS_BETS, JSON.stringify(state));
}

// Appends a finished round to the archive, dropping the oldest entries until
// the serialised history fits the property size limit.
function archiveRound_(state, meta) {
  if (!state.b.length) return 0;

  const props = PropertiesService.getScriptProperties();
  let history = [];
  const raw = props.getProperty(CONFIG.PROPS_HISTORY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    } catch (err) {
      Logger.log('Could not read the archive (' + err.message + '). Starting a new one.');
    }
  }

  history.push(Object.assign({ at: new Date().toISOString(), round: state.r }, meta, { bets: state.b }));
  let text = JSON.stringify(history);
  while (text.length > CONFIG.HISTORY_MAX_BYTES && history.length > 1) {
    history.shift();
    text = JSON.stringify(history);
  }
  props.setProperty(CONFIG.PROPS_HISTORY, text);
  return state.b.length;
}

/* ---------- the roster, read once into an array ---------- */

let scoreBook_ = null;
let rosterCache_ = null;
let scoreCols_ = null;

// Reading the roster costs several round trips to the Sheets API: open the
// workbook, find the tab, detect the columns from the header row, then read the
// block. The two module-level caches above only help inside a single execution,
// and Apps Script hands every request its own container — so a script that has
// been idle for a minute pays the whole cost again, on top of the cold start.
//
// CacheService is shared across containers, so a short-lived copy there turns
// getTeams and getScore into a single fast lookup. A placeBet deliberately
// bypasses it: the ceiling on a bet must be judged against the sheet's current
// numbers, not a snapshot up to ROSTER_CACHE_SECONDS old, and it is the one
// call where a moment's staleness could let a team overspend.
const ROSTER_CACHE_KEY = 'roster_v1';
const ROSTER_CACHE_SECONDS = 60;

function scoreSpreadsheet_() {
  if (!scoreBook_) scoreBook_ = SpreadsheetApp.openById(CONFIG.SCORE_SPREADSHEET_ID);
  return scoreBook_;
}

function scoreSheet_() {
  return findSheet_(scoreSpreadsheet_(), CONFIG.SCORE_SHEET);
}

const HEADER_PATTERNS = {
  name: [/^team\s*name$/i, /^crew\s*name$/i, /name/i],
  code: [/^team\s*code$/i, /code/i, /^id$/i],
  total: [/^total\s*score$/i, /totalscore/i, /^score$/i, /score/i, /total/i, /^points?$/i],
};

// Patterns are tried in order of confidence, and each is scanned left to right,
// so an exact "Team Name" beats a loose "Name" somewhere else on the row.
// Returns null when nothing on the row matches, so the caller can tell a
// detected column from a fallback one.
function findHeaderColumn_(header, patterns) {
  for (const pattern of patterns) {
    for (let i = 0; i < header.length; i++) {
      const cell = header[i] === null || header[i] === undefined ? '' : String(header[i]).trim();
      if (cell && pattern.test(cell)) return i + 1;
    }
  }
  return null;
}

function detectScoreColumns_() {
  const fallback = {
    name: CONFIG.SCORE_NAME,
    code: CONFIG.SCORE_CODE,
    total: CONFIG.SCORE_TOTAL,
    fromHeaders: false,
  };
  let header;
  try {
    header = scoreSheet_().getRange(1, 1, 1, CONFIG.HEADER_SCAN_COLS).getValues()[0];
  } catch (err) {
    Logger.log('Could not read the ' + CONFIG.SCORE_SHEET + ' header row: ' + err.message);
    return fallback;
  }

  const found = {
    name: findHeaderColumn_(header, HEADER_PATTERNS.name),
    code: findHeaderColumn_(header, HEADER_PATTERNS.code),
    total: findHeaderColumn_(header, HEADER_PATTERNS.total),
  };
  const cols = {
    name: found.name == null ? fallback.name : found.name,
    code: found.code == null ? fallback.code : found.code,
    total: found.total == null ? fallback.total : found.total,
    fromHeaders: found.name != null || found.code != null || found.total != null,
  };

  Logger.log(
    'Reading team data from ' + CONFIG.SCORE_SHEET + ': name ' + columnLetter_(cols.name) +
    ' (' + cols.name + '), team code ' + columnLetter_(cols.code) + ' (' + cols.code +
    '), total score ' + columnLetter_(cols.total) + ' (' + cols.total + ')' +
    (cols.fromHeaders
      ? ' — detected from the header row.'
      : ' — no matching headers on row 1, using the CONFIG columns.')
  );
  return cols;
}

function scoreColumnMap_() {
  if (!scoreCols_) scoreCols_ = detectScoreColumns_();
  return scoreCols_;
}

function cellText_(row, col) {
  const v = row[col - 1];
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Every team in the main spreadsheet: code, name, score and row, in sheet order.
 * Pass { fresh: true } to skip the cross-container cache and read the sheet.
 */
function roster_(options) {
  const fresh = !!(options && options.fresh);
  if (!fresh && rosterCache_) return rosterCache_;

  const cache = fresh ? null : CacheService.getScriptCache();
  if (cache) {
    const hit = cache.get(ROSTER_CACHE_KEY);
    if (hit) {
      try {
        const parsed = JSON.parse(hit);
        if (Array.isArray(parsed)) {
          rosterCache_ = parsed;
          return parsed;
        }
      } catch (err) {
        // A corrupt entry is not worth failing a request over — re-read instead.
      }
    }
  }

  const cols = scoreColumnMap_();
  const sheet = scoreSheet_();
  const last = sheet.getLastRow();
  const list = [];

  if (last >= CONFIG.FIRST_ROW) {
    // Only the three columns that matter, not the whole row. The activity
    // columns to the right are hundreds of cells this script never looks at.
    const width = Math.max(cols.name, cols.code, cols.total);
    sheet.getRange(CONFIG.FIRST_ROW, 1, last - CONFIG.FIRST_ROW + 1, width).getValues()
      .forEach((r, i) => {
        const teamCode = cellText_(r, cols.code).trim();
        if (!teamCode) return;
        list.push({
          row: CONFIG.FIRST_ROW + i,
          teamCode: teamCode,
          teamName: cellText_(r, cols.name),
          totalScore: Number(r[cols.total - 1]) || 0,
        });
      });
  }

  rosterCache_ = list;
  if (cache) {
    try {
      cache.put(ROSTER_CACHE_KEY, JSON.stringify(list), ROSTER_CACHE_SECONDS);
    } catch (err) {
      // The 100KB per-value limit, on a roster far larger than that. Caching is
      // an optimisation; a refusal to cache must never fail the request.
      Logger.log('Could not cache the roster: ' + err.message);
    }
  }
  return list;
}

/** Exact match against the roster array. Returns null when the team is unknown. */
function findTeam_(teamCode, options) {
  const target = String(teamCode).trim();
  const teams = roster_(options);
  for (let i = 0; i < teams.length; i++) {
    if (teams[i].teamCode === target) return teams[i];
  }
  return null;
}

/**
 * Deliberately no write path exists. The Score column belongs to the other
 * script that owns this spreadsheet, so this script computes spendable points
 * for itself and leaves every cell alone. If you ever need to point this at a
 * sheet you are allowed to write to, that is a deliberate decision to revisit,
 * not something to bolt on here.
 */

/* ---------- actions ---------- */

function getBets_() {
  const state = readRound_();
  const bets = state.b.map((b) => ({
    teamName: b.n,
    amount: Number(b.a),
    vent: Number(b.v),
  }));
  const totalPoints = bets.reduce((sum, b) => sum + b.amount, 0);
  return {
    ok: true,
    bets: bets,
    totalPoints: totalPoints,
    activeBets: bets.length,
    round: state.r,
  };
}

function getTeams_(p) {
  const state = readRound_();
  const teams = roster_().map((t) => ({
    teamCode: t.teamCode,
    teamName: t.teamName,
    totalScore: availableFor_(t, state),
    sheetScore: t.totalScore,
  }));

  // Optional ?q= search, so a team can be found by name or code.
  const q = String((p && p.q) || '').trim().toLowerCase();
  if (!q) return { ok: true, teams: teams };
  return {
    ok: true,
    teams: teams.filter(
      (t) => t.teamCode.toLowerCase().indexOf(q) !== -1 || t.teamName.toLowerCase().indexOf(q) !== -1
    ),
  };
}

function getScore_(p) {
  const teamCode = String(p.teamCode || '').trim();
  if (!teamCode) throw new Error('Team ID is required');

  const team = findTeam_(teamCode);
  if (!team) throw new Error('Unknown team ID');
  const state = readRound_();

  return {
    ok: true,
    teamCode: team.teamCode,
    teamName: team.teamName,
    // What the team can spend, which is what the form needs for its ceiling.
    totalScore: availableFor_(team, state),
    sheetScore: team.totalScore,
    inFlight: inFlight_(state, team.teamCode),
  };
}

function placeBet_(p) {
  const teamCode = String(p.teamCode || '').trim();
  const amount = Number(p.amount);
  const vent = Number(p.vent);

  if (!teamCode) throw new Error('Team ID is required');
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Bet amount must be a positive whole number');
  }
  if (!Number.isInteger(vent) || vent < 1 || vent > CONFIG.VENTS) {
    throw new Error('Pick a vent from 1 to ' + CONFIG.VENTS);
  }

  // Read the sheet BEFORE taking the lock. It is the slow part — a second or
  // more — and holding the script lock across it would make every bet in a
  // queue wait its turn behind a Sheets API round trip. Nothing here is shared
  // between teams, so a stale-by-a-few-hundred-milliseconds read is harmless;
  // the fresh flag is what guarantees the ceiling is judged against current
  // numbers rather than a cached roster.
  const team = findTeam_(teamCode, { fresh: true });
  if (!team) throw new Error('Unknown team ID');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 1. One bet per team per round
    const state = readRound_();
    for (let i = 0; i < state.b.length; i++) {
      if (String(state.b[i].c) === team.teamCode) {
        throw new Error('This team has already placed a bet this round');
      }
    }

    // 2. The stake cannot be more than the team can spend — the sheet's own
    //    score, plus settled payouts, minus anything already riding this round.
    const available = availableFor_(team, state);
    if (amount > available) {
      throw new Error('Bet exceeds your total score (' + available + ')');
    }

    // 3. Record the bet. The stake is held in the round, not taken out of the
    //    spreadsheet, so this team's spendable points drop by `amount` from the
    //    moment the bet lands. What is left under the lock is a properties
    //    read and write — milliseconds, not seconds.
    state.b.push({ c: team.teamCode, n: team.teamName, a: amount, v: vent });
    writeRound_(state);

    return { ok: true, totalScore: team.totalScore, pointsAfterBet: available - amount };
  } finally {
    lock.releaseLock();
  }
}

function declareResult_(p) {
  const win = Number(p.winningVent);
  const l1 = Number(p.losingVent1);
  const l2 = Number(p.losingVent2);
  const vents = [win, l1, l2];

  if (vents.some((v) => !Number.isInteger(v) || v < 1 || v > CONFIG.VENTS)) {
    throw new Error('Choose valid vents (1-' + CONFIG.VENTS + ')');
  }
  if (new Set(vents).size !== 3) {
    throw new Error('Winning and losing vents must all be different');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = readRound_();
    if (!state.b.length) return { ok: true, settled: 0, winningVent: win };

    // Settling makes each held stake permanent, in opposite directions: a
    // winner is paid twice their stake, a loser forfeits theirs. Net, a winner
    // is up by their stake and a loser is down by theirs. With REFUND_NEUTRAL
    // off, a vent that neither won nor lost forfeits too — one vent pays out,
    // eight lose their stake.
    let paidOut = 0;
    const settledFor = Object.assign({}, state.p);
    const settled = state.b.map((b) => {
      const stake = Number(b.a) || 0;
      const won = Number(b.v) === win;
      const payout = won ? stake * CONFIG.WIN_MULTIPLIER : 0;
      paidOut += payout;
      // Credited against this team alone. A winner is paid twice their stake;
      // a loser forfeits the stake that was being held for them.
      settledFor[b.c] = settledFor_(state, b.c) + (won ? payout : -stake);
      return {
        c: b.c,
        n: b.n,
        a: stake,
        v: Number(b.v),
        outcome: won ? 'won' : 'lost',
        payout: payout,
      };
    });

    archiveRound_(state, {
      outcome: 'declared',
      winningVent: win,
      losingVents: [l1, l2],
      settled: settled,
    });
    writeRound_({ r: state.r + 1, p: settledFor, b: [] });

    return { ok: true, settled: settled.length, winningVent: win, paidOut: paidOut };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Refresh: archive the round and start the next one. Nothing is settled — only
 * declareResult pays out.
 *
 * Because a stake is held in the round rather than taken out of the spreadsheet,
 * discarding the round hands every un-settled stake straight back. Nothing is
 * lost and nothing is paid, so a refresh is always safe to run.
 */
function resetRound_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = readRound_();
    if (!state.b.length) return { ok: true, archived: 0 };

    const archived = archiveRound_(state, { outcome: 'refreshed' });
    writeRound_({ r: state.r + 1, p: state.p, b: [] });
    return { ok: true, archived: archived, returned: archived };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Tab names drift in practice — "Sheet1" vs "Sheet 1" vs "sheet1" — so the
// configured name is matched exactly first and then loosely, on whitespace and
// capitalisation. Anything beyond that is a genuinely different tab, so the
// error lists what is actually there rather than guessing.
function findSheet_(ss, name) {
  const exact = ss.getSheetByName(name);
  if (exact) return exact;
  const target = normalizeSheetName_(name);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (normalizeSheetName_(sheets[i].getName()) === target) return sheets[i];
  }
  throw new Error(
    'Sheet not found: "' + name + '" in ' + ss.getName() +
    '. Its tabs are: ' + sheets.map((s) => s.getName()).join(' | ')
  );
}

function normalizeSheetName_(name) {
  return String(name).toLowerCase().replace(/\s+/g, '');
}

/** 1 -> "A", 27 -> "AA". */
function columnLetter_(col) {
  let out = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

/* ---------- editor helpers (never called by the site) ---------- */

/** Adds the "Vault Roulette" menu every time the spreadsheet is opened. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Vault Roulette')
    .addItem('Refresh round (archive & clear)', 'refreshFromMenu')
    .addToUi();
}

/** Menu handler: refresh and say what happened. Runs as the sheet owner. */
function refreshFromMenu() {
  const result = resetRound_();
  const message = result.archived
    ? 'Archived ' + result.archived + ' bet(s), started the next round and returned ' +
      result.returned + ' held stake(s). Nothing was settled.'
    : 'Nothing to archive — no bets are live.';
  SpreadsheetApp.getUi().alert(message);
}

/**
 * Run this from the editor and read View > Logs. It prints the spreadsheet the
 * roster is read from, the columns it resolved, the first few teams with what
 * the Score cell actually holds, and how the script's own balance compares to
 * the sheet's. This script never writes to the spreadsheet, so a formula in
 * that column is fine — it is simply read as the value it evaluates to.
 */
function inspectScores() {
  const ss = scoreSpreadsheet_();
  const sheet = scoreSheet_();
  const cols = scoreColumnMap_();
  const state = readRound_();

  Logger.log('Spreadsheet: ' + ss.getName());
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('Tab: "' + sheet.getName() + '"  —  ' + sheet.getLastRow() + ' row(s) x ' + sheet.getLastColumn() + ' col(s)');
  Logger.log('Read-only: this script never writes to this spreadsheet.');
  Logger.log(
    'In use — name: column ' + cols.name + ' (' + columnLetter_(cols.name) +
    '), team code: column ' + cols.code + ' (' + columnLetter_(cols.code) +
    '), total score: column ' + cols.total + ' (' + columnLetter_(cols.total) + ')' +
    (cols.fromHeaders ? ' (detected from the header row)' : ' (CONFIG fallback — no matching headers)')
  );

  const teams = roster_({ fresh: true });
  Logger.log('Usable teams: ' + teams.length);
  teams.slice(0, 8).forEach((t) => {
    const cell = sheet.getRange(t.row, cols.total);
    const riding = inFlight_(state, t.teamCode);
    Logger.log(
      '  row ' + t.row + ': code="' + t.teamCode + '" name="' + t.teamName +
      '" sheet=' + t.totalScore + '  available=' + availableFor_(t, state) +
      (riding ? '  (stake of ' + riding + ' riding this round)' : '') +
      '  formula=' + (cell.getFormula() || '(a plain number)')
    );
  });

  Logger.log('Round ' + state.r + ' — ' + state.b.length + ' live bet(s) in script properties');
  const settledCodes = Object.keys(state.p);
  Logger.log(
    settledCodes.length
      ? 'Settled by this script so far: ' +
          settledCodes.map((c) => c + ' ' + (state.p[c] > 0 ? '+' : '') + state.p[c]).join(', ')
      : 'Settled by this script so far: nothing yet.'
  );
  Logger.log(
    state.b.length
      ? 'A team\'s available points already exclude its own stake this round.'
      : 'No stakes are in flight, so every available figure equals the sheet plus what is settled.'
  );
}

/**
 * Escape hatch for when the stored round gets into a bad state: throws away the
 * live round and the archive. Points are not touched. Editor only.
 */
function clearStoredRounds() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(CONFIG.PROPS_BETS);
  props.deleteProperty(CONFIG.PROPS_HISTORY);
  Logger.log('Cleared the stored round and archive. The next read starts round 1.');
}
