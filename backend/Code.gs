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
 * Points: a stake is DEBITED from the score column when the bet is placed, and
 * the payout is CREDITED when the round is declared. The winner takes the
 * multiplier; every other vent — the two declared losers and the six that
 * neither won nor lost — is paid nothing, because REFUND_NEUTRAL is false.
 * Because of that, addScore_ refuses to write to a score cell that holds a
 * formula: overwriting =SUM(...) with a plain number would destroy the
 * leaderboard. Run inspectScores() from the editor to see which case you are in.
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

// Shape: { r: <round number>, b: [ { c: code, n: name, a: amount, v: vent } ] }
function readRound_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.PROPS_BETS);
  if (!raw) return { r: 1, b: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      r: Number(parsed.r) > 0 ? Number(parsed.r) : 1,
      b: Array.isArray(parsed.b) ? parsed.b : [],
    };
  } catch (err) {
    // A corrupt blob must not take the site down; start a fresh round and say so.
    Logger.log('Could not read the stored round (' + err.message + '). Starting round 1 again.');
    return { r: 1, b: [] };
  }
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

/** Every team in the main spreadsheet: code, name, score and row, in sheet order. */
function roster_() {
  if (rosterCache_) return rosterCache_;

  const cols = scoreColumnMap_();
  const sheet = scoreSheet_();
  const last = sheet.getLastRow();
  const list = [];

  if (last >= CONFIG.FIRST_ROW) {
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
  return list;
}

/** Exact match against the roster array. Returns null when the team is unknown. */
function findTeam_(teamCode) {
  const target = String(teamCode).trim();
  const teams = roster_();
  for (let i = 0; i < teams.length; i++) {
    if (teams[i].teamCode === target) return teams[i];
  }
  return null;
}

/** Points are written here, and only here. Returns the team's new score. */
function addScore_(row, delta) {
  const cell = scoreSheet_().getRange(row, scoreColumnMap_().total);
  if (cell.getFormula()) {
    throw new Error(
      'The ' + CONFIG.SCORE_SHEET + ' score column holds a formula, so it cannot be ' +
      'adjusted directly without breaking the total. Run inspectScores() from the ' +
      'editor and read the log.'
    );
  }
  const after = Math.max(0, (Number(cell.getValue()) || 0) + delta);
  cell.setValue(after);
  return after;
}

/**
 * addScore_ plus the matching update to the cached roster entry, so a round
 * costs one read of the sheet rather than one read per team.
 */
function creditTeam_(team, delta) {
  team.totalScore = addScore_(team.row, delta);
  return team.totalScore;
}

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
  const teams = roster_().map((t) => ({
    teamCode: t.teamCode,
    teamName: t.teamName,
    totalScore: t.totalScore,
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

  return {
    ok: true,
    teamCode: team.teamCode,
    teamName: team.teamName,
    totalScore: team.totalScore,
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

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 1. The team must be on the roster
    const team = findTeam_(teamCode);
    if (!team) throw new Error('Unknown team ID');

    // 2. One bet per team per round
    const state = readRound_();
    for (let i = 0; i < state.b.length; i++) {
      if (String(state.b[i].c) === team.teamCode) {
        throw new Error('This team has already placed a bet this round');
      }
    }

    // 3. The stake cannot be more than the team has
    const total = team.totalScore;
    if (amount > total) {
      throw new Error('Bet exceeds your total score (' + total + ')');
    }

    // 4. Debit the stake, then record the bet. Both under the same lock, so a
    //    second bet cannot slip in between them.
    creditTeam_(team, -amount);
    state.b.push({ c: team.teamCode, n: team.teamName, a: amount, v: vent });
    writeRound_(state);

    return { ok: true, totalScore: total, pointsAfterBet: team.totalScore };
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

    // The stake was already debited, so this credits the payout only. With
    // REFUND_NEUTRAL off, a vent that neither won nor lost is paid nothing.
    const settled = state.b.map((b) => {
      const won = Number(b.v) === win;
      const payout = won ? Number(b.a) * CONFIG.WIN_MULTIPLIER : 0;
      if (won) {
        const team = findTeam_(b.c);
        if (team) creditTeam_(team, payout);
      }
      return {
        c: b.c,
        n: b.n,
        a: Number(b.a),
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
    writeRound_({ r: state.r + 1, b: [] });

    return { ok: true, settled: settled.length, winningVent: win };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Refresh: archive the round and start the next one. Nothing is settled and no
 * points move — declareResult does that.
 */
function resetRound_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = readRound_();
    if (!state.b.length) return { ok: true, archived: 0 };

    const archived = archiveRound_(state, { outcome: 'refreshed' });
    writeRound_({ r: state.r + 1, b: [] });
    return { ok: true, archived: archived };
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
    ? 'Archived ' + result.archived + ' bet(s) and started the next round. Points are untouched.'
    : 'Nothing to archive — no bets are live.';
  SpreadsheetApp.getUi().alert(message);
}

/**
 * Run this from the editor and read View > Logs. It prints the spreadsheet the
 * roster is read from, the columns it resolved, the first few teams, and —
 * the important one — whether the score column holds a plain number or a
 * formula. A formula means addScore_ will refuse to write, because a stake
 * cannot be debited from a cell that is already =SUM(something).
 */
function inspectScores() {
  const ss = scoreSpreadsheet_();
  const sheet = scoreSheet_();
  const cols = scoreColumnMap_();

  Logger.log('Spreadsheet: ' + ss.getName());
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('Tab: "' + sheet.getName() + '"  —  ' + sheet.getLastRow() + ' row(s) x ' + sheet.getLastColumn() + ' col(s)');
  Logger.log(
    'In use — name: column ' + cols.name + ' (' + columnLetter_(cols.name) +
    '), team code: column ' + cols.code + ' (' + columnLetter_(cols.code) +
    '), total score: column ' + cols.total + ' (' + columnLetter_(cols.total) + ')' +
    (cols.fromHeaders ? ' (detected from the header row)' : ' (CONFIG fallback — no matching headers)')
  );

  const teams = roster_();
  Logger.log('Usable teams: ' + teams.length);
  teams.slice(0, 5).forEach((t) => {
    const cell = sheet.getRange(t.row, cols.total);
    Logger.log(
      '  row ' + t.row + ': code="' + t.teamCode + '" name="' + t.teamName +
      '" score=' + t.totalScore + '  formula=' +
      (cell.getFormula() || '(none — a plain number, so stakes can be debited from it)')
    );
  });

  const state = readRound_();
  Logger.log('Round ' + state.r + ' — ' + state.b.length + ' live bet(s) in script properties');
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
