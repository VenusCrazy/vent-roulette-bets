// Verification harness for backend/Code.gs — the deployed betting script.
// Loads the real Apps Script source in Node against in-memory fakes of the
// Sheets, Properties and Lock services.
//
// The architecture being tested:
//   - The roster and the points live in a SEPARATE spreadsheet, opened by ID.
//   - The live round, the round counter and the archive live in script
//     properties. No Bets sheet, no Archive sheet, no Config sheet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeSettlement } from '../src/lib/settlement.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'Code.gs'), 'utf8')

// The real Sheet1 layout: A Team Code, B Team Name, C Score.
const SCORE_CODE = 1
const SCORE_NAME = 2
const SCORE_TOTAL = 3
const SCORE_COLS = 3
const SCORE_HEADER = ['Team Code', 'Team Name', 'Score']

// ---------- fake Sheets API ----------

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols })
  }
  _key(r, c) {
    return r + ',' + c
  }
  _read(r, c) {
    const v = this.sheet.data[r - 1]?.[c - 1]
    return v === undefined ? '' : v
  }
  _write(r, c, v) {
    while (this.sheet.data.length <= r - 1) this.sheet.data.push([])
    while (this.sheet.data[r - 1].length <= c - 1) this.sheet.data[r - 1].push('')
    this.sheet.data[r - 1][c - 1] = v
  }
  getValues() {
    const out = []
    for (let r = 0; r < this.numRows; r++) {
      const row = []
      for (let c = 0; c < this.numCols; c++) row.push(this._read(this.row + r, this.col + c))
      out.push(row)
    }
    return out
  }
  getValue() {
    return this._read(this.row, this.col)
  }
  // Real Sheets drops a formula when a plain value is written over it, and the
  // script relies on that check to avoid clobbering =SUM(...) cells.
  getFormula() {
    return this.sheet.formulas.get(this._key(this.row, this.col)) || ''
  }
  setValue(v) {
    this.sheet.formulas.delete(this._key(this.row, this.col))
    this._write(this.row, this.col, v)
    return this
  }
  setValues(values) {
    values.forEach((row, ri) =>
      row.forEach((v, ci) => {
        this.sheet.formulas.delete(this._key(this.row + ri, this.col + ci))
        this._write(this.row + ri, this.col + ci, v)
      })
    )
    return this
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this._write(this.row + r, this.col + c, '')
    }
    return this
  }
}

class FakeSheet {
  constructor(name, data, sheetId = 0) {
    this.name = name
    this.data = data
    this.sheetId = sheetId
    this.formulas = new Map()
  }
  getName() {
    return this.name
  }
  getSheetId() {
    return this.sheetId
  }
  getLastRow() {
    return this.data.length
  }
  getLastColumn() {
    let last = 0
    for (const row of this.data) {
      for (let c = 0; c < row.length; c++) {
        const v = row[c]
        if (v !== null && v !== undefined && String(v).trim()) last = Math.max(last, c + 1)
      }
    }
    return last
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols)
  }
  appendRow(row) {
    this.data.push(row.slice())
    return this
  }
}

class FakeSpreadsheet {
  constructor(name, sheets) {
    this.name = name
    this.sheets = sheets
    this.byName = new Map(sheets.map((s) => [s.getName(), s]))
  }
  getName() {
    return this.name
  }
  getUrl() {
    return 'https://docs.google.com/spreadsheets/d/fake-' + this.name + '/edit'
  }
  getSheets() {
    return this.sheets
  }
  getSheetByName(name) {
    return this.byName.get(name) ?? null
  }
  insertSheet(name) {
    const sheet = new FakeSheet(name, [], this.sheets.length + 1)
    this.sheets.push(sheet)
    this.byName.set(name, sheet)
    return sheet
  }
}

// ---------- fake PropertiesService ----------

class FakeProperties {
  constructor() {
    this.store = new Map()
  }
  getProperty(key) {
    return this.store.has(key) ? this.store.get(key) : null
  }
  setProperty(key, value) {
    this.store.set(key, String(value))
  }
  deleteProperty(key) {
    this.store.delete(key)
  }
}

// ---------- fixtures ----------

const cell = (sheet, row, col) => sheet.data[row - 1]?.[col - 1]

/** A Sheet1 team row: code in A, name in B, score in C. */
function scoreTeam(name, code, total) {
  const row = new Array(SCORE_COLS).fill('')
  row[SCORE_CODE - 1] = code
  row[SCORE_NAME - 1] = name
  row[SCORE_TOTAL - 1] = total
  return row
}

function setup({
  scoreTeams = [],
  scoreHeader = SCORE_HEADER,
  scoreName = 'Sheet1',
  scoreFormulas = {},
  extraSheets = [],
  liveBets = [],
  boundSheets = [['Betting Sheet', [['Team Name', 'TeamCode']]]],
} = {}) {
  const scoreSheet = new FakeSheet(scoreName, [scoreHeader.slice(), ...scoreTeams], 1)
  for (const [key, formula] of Object.entries(scoreFormulas)) scoreSheet.formulas.set(key, formula)
  const scoreBook = new FakeSpreadsheet('Main Spreadsheet', [
    scoreSheet,
    ...extraSheets.map(([name, data], i) => new FakeSheet(name, data, i + 2)),
  ])

  // The workbook this script is actually bound to. It is not the one that owns
  // the teams — the test asserts that.
  const boundBook = new FakeSpreadsheet(
    'Vent-Roulette',
    boundSheets.map(([name, data], i) => new FakeSheet(name, data, i))
  )

  const props = new FakeProperties()
  const logs = []
  const opened = []
  let lockDepth = 0
  let maxLockDepth = 0

  const load = new Function(
    'SpreadsheetApp',
    'ContentService',
    'LockService',
    'PropertiesService',
    'Logger',
    `${source}
    return { getBets_, getTeams_, getScore_, placeBet_, declareResult_, resetRound_,
             handleBettingAction_, inspectScores, clearStoredRounds, doGet, doPost, CONFIG };`
  )

  const backend = load(
    {
      getActive: () => boundBook,
      openById: (id) => {
        opened.push(id)
        return scoreBook
      },
    },
    {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this } }),
    },
    {
      getScriptLock: () => ({
        waitLock() {
          lockDepth += 1
          maxLockDepth = Math.max(maxLockDepth, lockDepth)
        },
        releaseLock() {
          lockDepth -= 1
        },
      }),
    },
    { getScriptProperties: () => props },
    { log: (...args) => logs.push(args.map(String).join(' ')) }
  )

  // Seed the round through the real placeBet path, so the debit is genuine.
  for (const [code, amount, vent] of liveBets) {
    const out = backend.placeBet_({ teamCode: code, amount, vent })
    if (!out || out.ok !== true) throw new Error('could not seed a bet: ' + JSON.stringify(out))
  }

  const logged = (re) => logs.some((line) => re.test(line))
  const history = () => {
    const raw = props.getProperty(backend.CONFIG.PROPS_HISTORY)
    return raw ? JSON.parse(raw) : null
  }
  const storedRound = () => {
    const raw = props.getProperty(backend.CONFIG.PROPS_BETS)
    return raw ? JSON.parse(raw) : null
  }

  return { backend, scoreSheet, scoreBook, boundBook, props, logs, logged, history, storedRound, opened, maxLockDepth }
}

// ---------- contract ----------

test('every action returns ok:true on success and ok:false with a message on failure', () => {
  const { backend } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.equal(backend.getBets_().ok, true)
  const failed = backend.handleBettingAction_({ action: 'placeBet', teamCode: '9999', amount: 10, vent: 1 })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /Unknown team ID/)
  assert.equal(backend.handleBettingAction_({ action: 'nope' }).error, 'Unknown action')
})

test('CONFIG points at the other spreadsheet, and the real Sheet1 layout', () => {
  const c = setup().backend.CONFIG
  assert.equal(c.SCORE_SPREADSHEET_ID, '165jVE7EteZQb4w4RoiHzXMHAVf4Akgt0xdSSzBi2lQM')
  assert.equal(c.SCORE_SHEET, 'Sheet1')
  assert.equal(c.FIRST_ROW, 2, 'team data starts on row 2, under the header')
  assert.equal(c.SCORE_CODE, 1, 'team code is column A on Sheet1')
  assert.equal(c.SCORE_NAME, 2, 'team name is column B on Sheet1')
  assert.equal(c.SCORE_TOTAL, 3, 'the score is column C on Sheet1')
  assert.equal(c.VENTS, 9)
  assert.equal(c.WIN_MULTIPLIER, 2)
  assert.equal(c.REFUND_NEUTRAL, false, 'losing vents are deducted, not refunded')
})

test('no sheet names for bets, history or config survive anywhere in the script', () => {
  for (const gone of ['BET_SHEET', 'HISTORY_SHEET', 'insertSheet', 'appendRow']) {
    assert.ok(!source.includes(gone), `${gone} was removed from the script`)
  }
})

test('the roster is read from the other spreadsheet, never the bound workbook', () => {
  const { backend, scoreSheet, boundBook, opened } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    // A decoy tab with the same name, holding different teams, in the workbook
    // the script is bound to. If getActive() were used, this is what it would find.
    boundSheets: [['Sheet1', [['Team Code', 'Team Name', 'Score'], ['decoy', 'Decoy', 9999]]]],
  })

  assert.deepEqual(backend.getTeams_({}).teams, [
    { teamCode: '1092', teamName: 'Alpha', totalScore: 500 },
  ])
  assert.deepEqual(opened, ['165jVE7EteZQb4w4RoiHzXMHAVf4Akgt0xdSSzBi2lQM'], 'opened by ID')
  assert.ok(!boundBook.byName.get('Sheet1').data.some((r) => r.includes('1092')), 'the decoy was ignored')
  assert.equal(scoreSheet.data.length, 2)
})

// ---------- the stored round ----------

test('getBets on a fresh install is an empty round 1, and touches no spreadsheet', () => {
  const { backend, opened } = setup()
  assert.deepEqual(backend.getBets_(), {
    ok: true,
    bets: [],
    totalPoints: 0,
    activeBets: 0,
    round: 1,
  })
  assert.deepEqual(opened, [], 'the 15s poll costs no Sheets read')
})

test('getBets reports the live bets, the total and the round number', () => {
  const { backend } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500)],
    liveBets: [['1092', 200, 1], ['2424', 150, 3]],
  })
  assert.deepEqual(backend.getBets_(), {
    ok: true,
    bets: [
      { teamName: 'Alpha', amount: 200, vent: 1 },
      { teamName: 'Bravo', amount: 150, vent: 3 },
    ],
    totalPoints: 350,
    activeBets: 2,
    round: 1,
  })
})

test('a corrupt stored round starts round 1 again instead of failing the request', () => {
  const { backend, props, logged } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  props.setProperty('bets_v1', '{not json')
  assert.deepEqual(backend.getBets_().bets, [])
  assert.equal(backend.getBets_().round, 1)
  assert.ok(logged(/Could not read the stored round/))
})

// ---------- reading the roster ----------

test('getTeams returns the whole roster in sheet order', () => {
  const { backend } = setup({
    scoreTeams: [scoreTeam('Alpha Squad', '1092', 500), scoreTeam('Bravo', '2424', 0)],
  })
  assert.deepEqual(backend.getTeams_({}), {
    ok: true,
    teams: [
      { teamCode: '1092', teamName: 'Alpha Squad', totalScore: 500 },
      { teamCode: '2424', teamName: 'Bravo', totalScore: 0 },
    ],
  })
})

test('getTeams skips rows with no team code, and ?q= searches name or code', () => {
  const { backend } = setup({
    scoreTeams: [
      scoreTeam('Alpha Squad', '1092', 500),
      scoreTeam('No code yet', '', 300),
      scoreTeam('Bravo', '2424', 100),
    ],
  })
  assert.deepEqual(backend.getTeams_({}).teams.map((t) => t.teamCode), ['1092', '2424'])
  assert.deepEqual(backend.getTeams_({ q: 'squad' }).teams.map((t) => t.teamName), ['Alpha Squad'])
  assert.deepEqual(backend.getTeams_({ q: '24' }).teams.map((t) => t.teamCode), ['2424'])
  assert.deepEqual(backend.getTeams_({ q: 'nothing' }).teams, [])
})

test('getTeams on a spreadsheet with no team rows returns an empty roster', () => {
  assert.deepEqual(setup().backend.getTeams_({}), { ok: true, teams: [] })
})

test('a team is matched only by the team-code column, not by any cell in the row', () => {
  // '1092' also appears in a name and a score cell on other rows. A whole-sheet
  // text search would match those; comparing the code column does not.
  const { backend, scoreSheet } = setup({
    scoreTeams: [
      scoreTeam('Alpha', '1092', 500),
      scoreTeam('1092', '2424', 400),
      scoreTeam('Bravo', '2324', '1092'),
    ],
  })
  assert.equal(backend.getScore_({ teamCode: '1092' }).teamName, 'Alpha')
  backend.placeBet_({ teamCode: '1092', amount: 100, vent: 1 })
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 400, 'Alpha was debited')
  assert.equal(cell(scoreSheet, 3, SCORE_TOTAL), 400, 'the row whose name is the code was not')
  assert.equal(cell(scoreSheet, 4, SCORE_TOTAL), '1092', 'the row whose score is the code was not')
})

test('getScore reads the team name and total score, and never writes', () => {
  const { backend, scoreSheet } = setup({ scoreTeams: [scoreTeam('Alpha Squad', '1092', 500)] })
  assert.deepEqual(backend.getScore_({ teamCode: ' 1092 ' }), {
    ok: true,
    teamCode: '1092',
    teamName: 'Alpha Squad',
    totalScore: 500,
  })
  const before = JSON.stringify(scoreSheet.data)
  backend.getScore_({ teamCode: '1092' })
  assert.equal(JSON.stringify(scoreSheet.data), before)
})

test('getScore rejects an unknown team and a missing team code', () => {
  const { backend } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.throws(() => backend.getScore_({ teamCode: '9999' }), /Unknown team ID/)
  assert.throws(() => backend.getScore_({}), /Team ID is required/)
})

// ---------- column detection ----------

test('the team data is read from whichever columns the header row names', () => {
  // A spreadsheet somewhere else entirely — name in B, code in D, score in H.
  const header = new Array(8).fill('')
  header[1] = 'Team Name'
  header[3] = 'TeamCode'
  header[7] = 'Total Score'
  const row = (name, code, total) => {
    const r = new Array(8).fill('')
    r[1] = name
    r[3] = code
    r[7] = total
    return r
  }

  const { backend, scoreSheet, logged } = setup({
    scoreHeader: header,
    scoreTeams: [row('Alpha Squad', '1092', 500)],
  })

  assert.deepEqual(backend.getTeams_({}).teams, [
    { teamCode: '1092', teamName: 'Alpha Squad', totalScore: 500 },
  ])
  backend.placeBet_({ teamCode: '1092', amount: 200, vent: 1 })
  assert.equal(cell(scoreSheet, 2, 8), 300, 'the detected score column was debited')
  assert.ok(logged(/team code D \(4\), total score H \(8\)/), 'the resolution is logged')
})

test('a spreadsheet with no header row falls back to the CONFIG columns', () => {
  const header = new Array(SCORE_COLS).fill('')
  header[0] = 'Vault Roulette'
  const { backend, logged } = setup({ scoreHeader: header, scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.deepEqual(backend.getTeams_({}).teams, [{ teamCode: '1092', teamName: 'Alpha', totalScore: 500 }])
  assert.ok(logged(/no matching headers on row 1, using the CONFIG columns/))
})

test('headers that agree with CONFIG are still reported as detected', () => {
  const { backend, logged } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  backend.getTeams_({})
  assert.ok(logged(/detected from the header row/))
  assert.ok(logged(/name B \(2\), team code A \(1\), total score C \(3\)/))
})

test('a tab named differently is still found, ignoring case and spaces', () => {
  for (const name of ['Sheet 1', 'sheet1', 'SHEET1 ']) {
    const { backend } = setup({ scoreName: name, scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
    assert.deepEqual(backend.getTeams_({}).teams, [
      { teamCode: '1092', teamName: 'Alpha', totalScore: 500 },
    ], `matched a tab called "${name}"`)
  }
})

test('a genuinely different tab is an error that names the tabs that do exist', () => {
  const { backend } = setup({
    scoreName: 'Roulette Standings',
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    extraSheets: [['Notes', [['hi']]]],
  })
  assert.throws(
    () => backend.getTeams_({}),
    (err) => {
      assert.match(err.message, /Sheet not found: "Sheet1"/)
      assert.match(err.message, /Its tabs are: Roulette Standings \| Notes/)
      return true
    }
  )
})

// ---------- placeBet ----------

test('a bet debits the score column and records amount, vent and points after', () => {
  const { backend, scoreSheet, storedRound } = setup({ scoreTeams: [scoreTeam('Alpha Squad', '1092', 500)] })
  assert.deepEqual(backend.placeBet_({ teamCode: '1092', amount: 200, vent: 3 }), {
    ok: true,
    totalScore: 500,
    pointsAfterBet: 300,
  })
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 300, 'the stake left the team balance')
  assert.deepEqual(storedRound(), {
    r: 1,
    b: [{ c: '1092', n: 'Alpha Squad', a: 200, v: 3 }],
  })
})

test('a bet equal to the total score is allowed; anything above it is rejected', () => {
  const { backend, scoreSheet, storedRound } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.equal(backend.placeBet_({ teamCode: '1092', amount: 500, vent: 1 }).pointsAfterBet, 0)
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 0)
  assert.equal(storedRound().b.length, 1)

  const second = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.throws(
    () => second.backend.placeBet_({ teamCode: '1092', amount: 501, vent: 1 }),
    /Bet exceeds your total score \(500\)/
  )
  assert.equal(cell(second.scoreSheet, 2, SCORE_TOTAL), 500, 'a rejected bet moves no points')
  assert.equal(second.storedRound(), null, 'and is not recorded')
})

test('a second bet in the same round is rejected and does not debit again', () => {
  const { backend, scoreSheet, storedRound } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  assert.throws(
    () => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 2 }),
    /already placed a bet this round/
  )
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 300, 'still debited once')
  assert.equal(storedRound().b.length, 1)
})

test('placeBet validates amount, vent and team code before touching anything', () => {
  const { backend, scoreSheet, storedRound } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 0, vent: 1 }), /positive whole number/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 2.5, vent: 1 }), /positive whole number/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 0 }), /1 to 9/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 10 }), /1 to 9/)
  assert.throws(() => backend.placeBet_({ amount: 10, vent: 1 }), /Team ID is required/)
  assert.throws(() => backend.placeBet_({ teamCode: '9999', amount: 10, vent: 1 }), /Unknown team ID/)
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 500, 'no points moved')
  assert.equal(storedRound(), null, 'nothing recorded')
})

test('a score cell holding a formula is refused, so the total cannot be destroyed', () => {
  const { backend, scoreSheet, storedRound } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    // C2 is =SUM(D2:W2), exactly the shape a per-activity game sheet has.
    scoreFormulas: { '2,3': '=SUM(D2:W2)' },
  })
  assert.throws(
    () => backend.placeBet_({ teamCode: '1092', amount: 200, vent: 1 }),
    /score column holds a formula/
  )
  assert.equal(scoreSheet.formulas.get('2,3'), '=SUM(D2:W2)', 'the formula is intact')
  assert.equal(storedRound(), null, 'the bet is not recorded either')
})

test('every write path takes the script lock, and releases it', () => {
  const { backend, maxLockDepth } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500)],
    liveBets: [['1092', 100, 1]],
  })
  assert.equal(maxLockDepth, 1, 'one lock at a time, never nested')
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  backend.placeBet_({ teamCode: '2424', amount: 50, vent: 4 })
  backend.resetRound_()
  assert.equal(maxLockDepth, 1)
})

// ---------- declareResult ----------

test('declaring credits the winner, pays nobody else, and starts the next round', () => {
  const { backend, scoreSheet, history, storedRound } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500), scoreTeam('Charlie', '2324', 500)],
    liveBets: [['1092', 200, 1], ['2424', 100, 2], ['2324', 50, 7]],
  })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.deepEqual(out, { ok: true, settled: 3, winningVent: 1 })

  // Alpha staked 200: 500 -> 300 on the bet, then +400 for winning it.
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 700, 'winner is made whole and then 200 up')
  assert.equal(cell(scoreSheet, 3, SCORE_TOTAL), 400, 'a declared loser keeps nothing')
  assert.equal(cell(scoreSheet, 4, SCORE_TOTAL), 450, 'a neutral vent loses the stake, not refunded')

  const [round] = history()
  assert.equal(round.round, 1)
  assert.equal(round.outcome, 'declared')
  assert.equal(round.winningVent, 1)
  assert.deepEqual(round.losingVents, [2, 3])
  assert.deepEqual(round.settled.map((b) => [b.c, b.outcome, b.payout]), [
    ['1092', 'won', 400],
    ['2424', 'lost', 0],
    ['2324', 'lost', 0],
  ])

  assert.deepEqual(storedRound(), { r: 2, b: [] }, 'the round advanced and the bets cleared')
  assert.equal(backend.getBets_().activeBets, 0)
})

test('the frontend preview predicts exactly what the script credits, across all nine vents', () => {
  const win = 4
  const losers = [2, 7]
  const scoreTeams = []
  const liveBets = []
  for (let v = 1; v <= 9; v++) {
    scoreTeams.push(scoreTeam(`Team ${v}`, `code${v}`, 1000))
    liveBets.push([`code${v}`, 100, v])
  }

  const { backend, scoreSheet, history } = setup({ scoreTeams, liveBets })
  // setup() has already debited each stake, so this is the post-bet balance.
  const afterBet = scoreTeams.map((_, i) => cell(scoreSheet, i + 2, SCORE_TOTAL))
  assert.ok(afterBet.every((v) => v === 900), 'every stake came off first')

  assert.equal(backend.declareResult_({ winningVent: win, losingVent1: losers[0], losingVent2: losers[1] }).settled, 9)

  const [round] = history()
  for (let v = 1; v <= 9; v++) {
    const predicted = computeSettlement(100, v, win, losers)
    const archived = round.settled[v - 1]
    assert.equal(archived.outcome, predicted.outcome, `vent ${v} outcome`)
    assert.equal(archived.payout, predicted.payout, `vent ${v} payout`)
    assert.equal(cell(scoreSheet, v + 1, SCORE_TOTAL), afterBet[v - 1] + predicted.payout, `vent ${v} balance`)
  }
})

test('declareResult rejects out-of-range vents and duplicates', () => {
  const { backend, scoreSheet } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  assert.throws(() => backend.declareResult_({ winningVent: 10, losingVent1: 2, losingVent2: 3 }), /valid vents/)
  assert.throws(() => backend.declareResult_({ winningVent: 0, losingVent1: 2, losingVent2: 3 }), /valid vents/)
  assert.throws(() => backend.declareResult_({ winningVent: 1, losingVent1: 1, losingVent2: 3 }), /all be different/)
  assert.throws(() => backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 2 }), /all be different/)
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 300, 'the round is untouched')
})

test('declaring with no bets settles nothing and writes no archive', () => {
  const { backend, history } = setup()
  assert.deepEqual(backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 }), {
    ok: true,
    settled: 0,
    winningVent: 1,
  })
  assert.equal(history(), null)
})

// ---------- resetRound ----------

test('resetRound archives the round, advances it and moves no points', () => {
  const { backend, scoreSheet, history, storedRound } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500)],
    liveBets: [['1092', 200, 1], ['2424', 150, 3]],
  })
  const out = backend.resetRound_()
  assert.deepEqual(out, { ok: true, archived: 2 })

  const [round] = history()
  assert.equal(round.outcome, 'refreshed', 'a refresh decides nothing')
  assert.equal(round.winningVent, undefined)
  assert.deepEqual(round.bets.map((b) => [b.c, b.a, b.v]), [['1092', 200, 1], ['2424', 150, 3]])

  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 300, 'the stake stays debited until a round is declared')
  assert.equal(cell(scoreSheet, 3, SCORE_TOTAL), 350)
  assert.deepEqual(storedRound(), { r: 2, b: [] })
  assert.deepEqual(backend.getBets_().bets, [])
})

test('a team can bet again straight after a refresh', () => {
  const { backend } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  backend.resetRound_()
  const out = backend.placeBet_({ teamCode: '1092', amount: 100, vent: 5 })
  assert.equal(out.ok, true)
  assert.equal(out.pointsAfterBet, 200, 'bets against the post-bet balance')
})

test('resetRound on a clear round archives nothing and writes no archive', () => {
  const { backend, history } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.equal(history().length, 1)
  assert.deepEqual(backend.resetRound_(), { ok: true, archived: 0 }, 'no double-archiving')
  assert.equal(history().length, 1)
})

test('the resetRound web action archives and clears with no credentials', () => {
  const { backend } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)], liveBets: [['1092', 200, 1]] })
  assert.deepEqual(backend.handleBettingAction_({ action: 'resetRound' }), { ok: true, archived: 1 })
  assert.deepEqual(backend.getBets_().bets, [])
})

// ---------- the archive ----------

test('the archive is trimmed to the property size limit instead of a fixed count', () => {
  const teams = []
  for (let i = 0; i < 10; i++) teams.push(scoreTeam(`Team with a fairly long name ${i}`, `code${i}`, 1000))
  const { backend, history, logged } = setup({ scoreTeams: teams })

  for (let round = 0; round < 40; round++) {
    const vent = (round % 9) + 1
    // The two declared losers have to be different from the winning vent.
    const losing = [((vent + 1) % 9) + 1, ((vent + 2) % 9) + 1]
    backend.placeBet_({ teamCode: 'code0', amount: 100, vent })
    backend.declareResult_({ winningVent: vent, losingVent1: losing[0], losingVent2: losing[1] })
  }

  const raw = JSON.stringify(history())
  assert.ok(raw.length <= backend.CONFIG.HISTORY_MAX_BYTES, `archive stayed under the cap (${raw.length})`)
  assert.ok(history().length < 40, 'older rounds were dropped, not the whole thing')
  assert.ok(history().length >= 1, 'the most recent round always survives')
  const rounds = history().map((r) => r.round)
  assert.deepEqual(rounds, rounds.slice().sort((a, b) => a - b), 'kept in order')
  assert.equal(Math.max(...rounds), 40, 'the newest round is the one kept')
})

test('a corrupt archive is replaced rather than blocking the round', () => {
  const { backend, props, history, logged } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  props.setProperty('history_v1', 'not json at all')
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.equal(history().length, 1)
  assert.ok(logged(/Could not read the archive/))
})

test('clearStoredRounds throws the round and archive away but leaves points alone', () => {
  const { backend, scoreSheet, history, storedRound, props } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  backend.clearStoredRounds()
  assert.equal(storedRound(), null)
  assert.equal(history(), null)
  assert.equal(props.store.size, 0)
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 300, 'the debited stake is not refunded by this')
})

// ---------- editor helpers ----------

test('inspectScores reports the columns, the teams and whether the score is a formula', () => {
  const { backend, logged } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 250)],
    scoreFormulas: { '2,3': '=SUM(D2:W2)' },
    liveBets: [['2424', 100, 4]],
  })
  backend.inspectScores()
  assert.ok(logged(/Spreadsheet: Main Spreadsheet/))
  assert.ok(logged(/Tab: "Sheet1"/))
  assert.ok(logged(/name: column 2 \(B\), team code: column 1 \(A\), total score: column 3 \(C\)/))
  assert.ok(logged(/Usable teams: 2/))
  assert.ok(logged(/row 2: code="1092" name="Alpha" score=500 {2}formula==SUM\(D2:W2\)/))
  assert.ok(logged(/row 3: code="2424" name="Bravo" score=150 {2}formula=\(none — a plain number/))
  assert.ok(logged(/Round 1 — 1 live bet\(s\) in script properties/))
})

// ---------- transports ----------

test('doGet and doPost both route through the same action dispatcher', () => {
  const { backend } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)], liveBets: [['1092', 200, 1]] })
  const viaGet = JSON.parse(backend.doGet({ parameter: { action: 'getBets' } }).text)
  assert.equal(viaGet.ok, true)
  assert.equal(viaGet.activeBets, 1)
  const viaPost = JSON.parse(backend.doPost({ postData: { contents: '{"action":"getBets"}' } }).text)
  assert.equal(viaPost.ok, true)
  const bad = JSON.parse(backend.doPost({ postData: { contents: 'not json' } }).text)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'Unknown action')
})
