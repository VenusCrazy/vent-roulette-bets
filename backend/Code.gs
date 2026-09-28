/**
 * Catch Your Shooter: betting backend
 * Actions: getBets, placeBet, declareResult
 * Each declared result is archived to the "Archive" tab with its round number.
 */
const CONFIG = {
  BET_SHEET: 'CurrentRound',   // live bets for the current round
  HISTORY_SHEET: 'Archive',    // finished rounds
  MAIN_SHEET: 'Request 5.0',   // <-- change to the tab that holds team scores

  FIRST_ROW: 2,

  // CurrentRound columns (1-based)
  BET_NAME: 1,    // A
  BET_CODE: 2,    // B
  BET_AMOUNT: 4,  // D  Points BET
  BET_VENT: 5,    // E  VentChosen
  BET_AFTER: 6,   // F  Points After Bet
  BET_RESULT: 7,  // G  Result
  BET_PAYOUT: 8,  // H  Payout

  // Points balance lives here (matched by team code)
  MAIN_CODE: 2,   // B
  MAIN_SCORE: 19, // S

  VENTS: 9,
  WIN_MULTIPLIER: 2,      // total returned on a win (2x stake)
  REFUND_NEUTRAL: true,   // vents that neither won nor lost get their stake back
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
      case 'placeBet':      return placeBet_(p);
      case 'declareResult': return declareResult_(p);
      default:              return { ok: false, error: 'Unknown action' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- actions ---------- */

function getBets_() {
  const s = sheet_(CONFIG.BET_SHEET);
  const round = getRound_();
  const last = s.getLastRow();
  if (last < CONFIG.FIRST_ROW) {
    return { ok: true, round: round, bets: [], totalPoints: 0, activeBets: 0 };
  }
  const rows = s
    .getRange(CONFIG.FIRST_ROW, 1, last - CONFIG.FIRST_ROW + 1, CONFIG.BET_PAYOUT)
    .getValues();

  const bets = [];
  let total = 0;
  rows.forEach((r) => {
    const amount = Number(r[CONFIG.BET_AMOUNT - 1]);
    if (amount > 0) {
      bets.push({
        teamName: r[CONFIG.BET_NAME - 1],
        amount: amount,
        vent: Number(r[CONFIG.BET_VENT - 1]),
      });
      total += amount;
    }
  });
  return { ok: true, round: round, bets: bets, totalPoints: total, activeBets: bets.length };
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
    const bets = sheet_(CONFIG.BET_SHEET);
    const main = sheet_(CONFIG.MAIN_SHEET);

    const betRow = findRow_(bets, CONFIG.BET_CODE, teamCode);
    if (!betRow) throw new Error('Unknown team ID');

    if (Number(bets.getRange(betRow, CONFIG.BET_AMOUNT).getValue()) > 0) {
      throw new Error('This team has already placed a bet this round');
    }

    const mainRow = findRow_(main, CONFIG.MAIN_CODE, teamCode);
    if (!mainRow) throw new Error('Team not found on ' + CONFIG.MAIN_SHEET);

    const balance = getBalance_(main, mainRow);
    if (amount > balance) {
      throw new Error('Not enough points (balance: ' + balance + ')');
    }

    const after = balance - amount;
    setBalance_(main, mainRow, after);
    bets
      .getRange(betRow, CONFIG.BET_AMOUNT, 1, 5)
      .setValues([[amount, vent, after, 'Active', '']]);

    return { ok: true, pointsAfterBet: after, round: getRound_() };
  } finally {
    lock.releaseLock();
  }
}

function declareResult_(p) {
  const adminKey = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (adminKey && p.adminKey !== adminKey) throw new Error('Not authorised');

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
    const bets = sheet_(CONFIG.BET_SHEET);
    const main = sheet_(CONFIG.MAIN_SHEET);
    const round = getRound_();
    const last = bets.getLastRow();
    if (last < CONFIG.FIRST_ROW) return { ok: true, settled: 0, round: round };

    const rows = bets
      .getRange(CONFIG.FIRST_ROW, 1, last - CONFIG.FIRST_ROW + 1, CONFIG.BET_PAYOUT)
      .getValues();

    // Pass 1: work out every settlement, verify before writing anything
    const plan = [];
    rows.forEach((r) => {
      const amount = Number(r[CONFIG.BET_AMOUNT - 1]);
      if (!(amount > 0)) return;

      const vent = Number(r[CONFIG.BET_VENT - 1]);
      let result, payout;
      if (vent === win) {
        result = 'Won';
        payout = amount * CONFIG.WIN_MULTIPLIER;
      } else if (vent === l1 || vent === l2) {
        result = 'Lost';
        payout = 0;
      } else if (CONFIG.REFUND_NEUTRAL) {
        result = 'Refunded';
        payout = amount;
      } else {
        result = 'Lost';
        payout = 0;
      }

      let mainRow = 0;
      if (payout > 0) {
        mainRow = findRow_(main, CONFIG.MAIN_CODE, r[CONFIG.BET_CODE - 1]);
        if (!mainRow) {
          throw new Error('Team ' + r[CONFIG.BET_NAME - 1] + ' not found on ' + CONFIG.MAIN_SHEET);
        }
      }
      plan.push({ row: r, amount: amount, vent: vent, result: result, payout: payout, mainRow: mainRow });
    });

    if (!plan.length) return { ok: true, settled: 0, round: round };

    // Pass 2: apply payouts and build archive rows
    const now = new Date();
    const archive = [];
    plan.forEach((x) => {
      if (x.payout > 0) {
        setBalance_(main, x.mainRow, getBalance_(main, x.mainRow) + x.payout);
      }
      archive.push([
        round,
        now,
        x.row[CONFIG.BET_NAME - 1],
        x.row[CONFIG.BET_CODE - 1],
        x.amount,
        x.vent,
        x.result,
        x.payout,
        win,
        l1 + ', ' + l2,
      ]);
    });

    // Move the round into the archive, clear the live bets, advance the round
    const history = historySheet_();
    history
      .getRange(history.getLastRow() + 1, 1, archive.length, archive[0].length)
      .setValues(archive);
    bets.getRange(CONFIG.FIRST_ROW, CONFIG.BET_AMOUNT, rows.length, 5).clearContent();
    setRound_(round + 1);

    return { ok: true, settled: archive.length, winningVent: win, round: round, nextRound: round + 1 };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  const s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Sheet not found: ' + name);
  return s;
}

function historySheet_() {
  const ss = SpreadsheetApp.getActive();
  let s = ss.getSheetByName(CONFIG.HISTORY_SHEET);
  if (!s) s = ss.insertSheet(CONFIG.HISTORY_SHEET);
  if (s.getLastRow() === 0) {
    s.appendRow(['Round', 'Timestamp', 'Team Name', 'Team Code', 'Bet', 'Vent', 'Result', 'Payout', 'Winning Vent', 'Losing Vents']);
    s.setFrozenRows(1);
  }
  return s;
}

function findRow_(sheet, col, value) {
  const last = sheet.getLastRow();
  if (last < CONFIG.FIRST_ROW) return 0;
  const vals = sheet.getRange(CONFIG.FIRST_ROW, col, last - CONFIG.FIRST_ROW + 1, 1).getValues();
  const target = String(value).trim();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === target) return CONFIG.FIRST_ROW + i;
  }
  return 0;
}

function getBalance_(main, row) {
  return Number(main.getRange(row, CONFIG.MAIN_SCORE).getValue()) || 0;
}

function setBalance_(main, row, value) {
  const cell = main.getRange(row, CONFIG.MAIN_SCORE);
  if (cell.getFormula()) {
    throw new Error('Score cell is a formula; the script will not overwrite it.');
  }
  cell.setValue(value);
}

function getRound_() {
  const v = PropertiesService.getScriptProperties().getProperty('CURRENT_ROUND');
  return v ? Number(v) : 1;
}

function setRound_(n) {
  PropertiesService.getScriptProperties().setProperty('CURRENT_ROUND', String(n));
}

/** Editor helper: sets the round back to 1. Edit the number to set another. */
function resetRound() {
  setRound_(1);
}

/** Run once from the editor: adds the Result and Payout headers (G1, H1). */
function setupBettingSheet() {
  sheet_(CONFIG.BET_SHEET)
    .getRange(1, CONFIG.BET_RESULT, 1, 2)
    .setValues([['Result', 'Payout']]);
}
