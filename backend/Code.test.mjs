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

// The real Sheet1 layout: A Team Code, B Team Name, C Score, teams from row 2.
const SCORE_CODE = 1
const SCORE_NAME = 2
const SCORE_TOTAL = 3
const SCORE_COLS = 3
const SCORE_FIRST_ROW = 2
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
  // Every read is counted, so a test can prove a call was served from the cache
  // rather than by hitting the Sheets API again. `sheet.lockProbe` lets a test
  // see whether a read happened while the script lock was held.
  _countRead() {
    this.sheet.reads += 1
    if (this.sheet.lockProbe && this.sheet.lockProbe()) this.sheet.readsWhileLocked += 1
  }
  getValues() {
    this._countRead()
    const out = []
    for (let r = 0; r < this.numRows; r++) {
      const row = []
      for (let c = 0; c < this.numCols; c++) row.push(this._read(this.row + r, this.col + c))
      out.push(row)
    }
    return out
  }
  getValue() {
    this._countRead()
    return this._read(this.row, this.col)
  }
  // Real Sheets drops a formula when a plain value is written over it, and the
  // script relies on that check to avoid clobbering =SUM(...) cells.
  getFormula() {
    return this.sheet.formulas.get(this._key(this.row, this.col)) || ''
  }
  setValue(v) {
    this.sheet.writes.push(this._key(this.row, this.col))
    this.sheet.formulas.delete(this._key(this.row, this.col))
    this._write(this.row, this.col, v)
    return this
  }
  setValues(values) {
    values.forEach((row, ri) =>
      row.forEach((v, ci) => {
        this.sheet.writes.push(this._key(this.row + ri, this.col + ci))
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
    // Every cell this fake was written to. The main spreadsheet must stay empty.
    this.writes = []
    // Read counters, so caching can be asserted rather than assumed.
    this.reads = 0
    this.readsWhileLocked = 0
    this.lockProbe = null
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

// ---------- fake CacheService ----------

// Real CacheService is shared across containers, which is exactly why the script
// uses it: a fresh one per setup() keeps tests isolated while still exercising
// the cross-request path inside a single test.
class FakeCache {
  constructor() {
    this.store = new Map()
    this.hits = 0
    this.misses = 0
  }
  get(key) {
    if (!this.store.has(key)) {
      this.misses += 1
      return null
    }
    this.hits += 1
    return this.store.get(key)
  }
  put(key, value, _seconds) {
    if (String(value).length > 100000) throw new Error('Value is too large')
    this.store.set(key, String(value))
  }
  remove(key) {
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
  // Mirrors the real sheet: the score cells hold SUM(D:W)-style formulas owned
  // by another script, so nothing here may write to them.
  const scoreSheet = new FakeSheet(scoreName, [scoreHeader.slice(), ...scoreTeams], 1)
  scoreTeams.forEach((_, i) => {
    const row = SCORE_FIRST_ROW + i
    scoreSheet.formulas.set(
      `${row},${SCORE_TOTAL}`,
      `=IF(COUNTA(D${row}:W${row})=0, "", SUM(D${row}:W${row}))`
    )
  })
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
  const cache = new FakeCache()
  const logs = []
  const opened = []
  let lockDepth = 0
  let maxLockDepth = 0

  const load = new Function(
    'SpreadsheetApp',
    'ContentService',
    'LockService',
    'PropertiesService',
    'CacheService',
    'Logger',
    `${source}
    return { getBets_, getTeams_, getScore_, placeBet_, declareResult_, resetRound_,
             handleBettingAction_, inspectScores, clearStoredRounds, doGet, doPost, CONFIG };`
  )

  // Loading the source is what standing up a container is: the module-level
  // caches (scoreBook_, rosterCache_, scoreCols_) start empty every time, while
  // PropertiesService and CacheService are shared — exactly as they are across
  // real Apps Script requests. newContainer() lets a test model the next
  // request, which is the only way caching between requests can be observed.
  const newContainer = () =>
    load(
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
      { getScriptCache: () => cache },
      { log: (...args) => logs.push(args.map(String).join(' ')) }
    )

  const backend = newContainer()

  // Let the fake sheet report whether a read happened under the script lock.
  scoreSheet.lockProbe = () => lockDepth > 0

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

  return {
    backend,
    /** A fresh container sharing the same properties and cache: the next request. */
    newContainer,
    scoreSheet,
    scoreBook,
    boundBook,
    props,
    cache,
    logs,
    logged,
    history,
    storedRound,
    opened,
    maxLockDepth,
    /** Nothing may ever land here: the spreadsheet is read-only. */
    sheetWrites: () => scoreSheet.writes,
    available: (code) => backend.getScore_({ teamCode: code }).totalScore,
  }
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
    { teamCode: '1092', teamName: 'Alpha', totalScore: 500, sheetScore: 500 },
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
      { teamCode: '1092', teamName: 'Alpha Squad', totalScore: 500, sheetScore: 500 },
      { teamCode: '2424', teamName: 'Bravo', totalScore: 0, sheetScore: 0 },
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
  // '1092' is the code of Alpha, but it is also the NAME of Bravo and the raw
  // score value of Charlie. Only the code column may match it.
  assert.equal(backend.getScore_({ teamCode: '1092' }).teamName, 'Alpha')
  assert.equal(backend.getScore_({ teamCode: '1092' }).sheetScore, 500)
  assert.equal(backend.getScore_({ teamCode: '2324' }).teamName, 'Bravo')
  assert.equal(backend.getScore_({ teamCode: '2324' }).sheetScore, 1092, 'the number in its score cell')

  backend.placeBet_({ teamCode: '1092', amount: 100, vent: 1 })
  assert.deepEqual(
    backend.getTeams_({}).teams.map((t) => [t.teamCode, t.totalScore]),
    [['1092', 400], ['2424', 400], ['2324', 1092]],
    'only the team that bet has less to spend'
  )
  assert.deepEqual(scoreSheet.writes, [], 'and the spreadsheet was never touched')
})

test('getScore reports the spendable balance, the sheet value behind it, and the stake in flight', () => {
  const { backend, scoreSheet } = setup({
    scoreTeams: [scoreTeam('Alpha Squad', '1092', 500)],
    liveBets: [['1092', 200, 3]],
  })
  assert.deepEqual(backend.getScore_({ teamCode: ' 1092 ' }), {
    ok: true,
    teamCode: '1092',
    teamName: 'Alpha Squad',
    totalScore: 300, // 500 from the sheet, less the 200 already riding
    sheetScore: 500,
    inFlight: 200,
  })
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 500, 'the sheet still says 500')
  assert.deepEqual(scoreSheet.writes, [], 'reading it wrote nothing')
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
    { teamCode: '1092', teamName: 'Alpha Squad', totalScore: 500, sheetScore: 500 },
  ])
  backend.placeBet_({ teamCode: '1092', amount: 200, vent: 1 })
  assert.equal(cell(scoreSheet, 2, 8), 500, 'the detected score column is read, not written')
  assert.equal(backend.getScore_({ teamCode: '1092' }).totalScore, 300, 'the stake is held in the round')
  assert.ok(logged(/team code D \(4\), total score H \(8\)/), 'the resolution is logged')
})

test('a spreadsheet with no header row falls back to the CONFIG columns', () => {
  const header = new Array(SCORE_COLS).fill('')
  header[0] = 'Vault Roulette'
  const { backend, logged } = setup({ scoreHeader: header, scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.deepEqual(backend.getTeams_({}).teams, [
    { teamCode: '1092', teamName: 'Alpha', totalScore: 500, sheetScore: 500 },
  ])
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
      { teamCode: '1092', teamName: 'Alpha', totalScore: 500, sheetScore: 500 },
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

test('a bet holds the stake in the round instead of taking it out of the spreadsheet', () => {
  const { backend, scoreSheet, storedRound } = setup({ scoreTeams: [scoreTeam('Alpha Squad', '1092', 500)] })
  assert.deepEqual(backend.placeBet_({ teamCode: '1092', amount: 200, vent: 3 }), {
    ok: true,
    totalScore: 500,
    pointsAfterBet: 300,
  })
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 500, 'the sheet is untouched')
  assert.deepEqual(scoreSheet.writes, [], 'not one cell was written')
  assert.deepEqual(storedRound(), {
    r: 1,
    p: {},
    b: [{ c: '1092', n: 'Alpha Squad', a: 200, v: 3 }],
  })
  assert.equal(backend.getScore_({ teamCode: '1092' }).totalScore, 300, 'but the team has 300 to spend')
})

test('a bet equal to the balance is allowed; anything above it is rejected', () => {
  const { backend, storedRound } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.equal(backend.placeBet_({ teamCode: '1092', amount: 500, vent: 1 }).pointsAfterBet, 0)
  assert.equal(backend.getScore_({ teamCode: '1092' }).totalScore, 0)
  assert.equal(storedRound().b.length, 1)

  const second = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.throws(
    () => second.backend.placeBet_({ teamCode: '1092', amount: 501, vent: 1 }),
    /Bet exceeds your total score \(500\)/
  )
  assert.equal(second.storedRound(), null, 'a rejected bet is not recorded')
  assert.equal(second.available('1092'), 500, 'and moves no points')
})

test('a banked payout raises what a team can spend, and the sheet never sees it', () => {
  const { backend, scoreSheet, available } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  backend.placeBet_({ teamCode: '1092', amount: 200, vent: 1 })
  assert.equal(available('1092'), 300, 'the stake is held back while the round is open')

  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.equal(available('1092'), 900, '500 from the sheet plus the 400 payout')
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 500, 'the sheet still says 500')
  assert.deepEqual(scoreSheet.writes, [])
})

test('a second bet in the same round is rejected and does not double-hold the stake', () => {
  const { backend, storedRound } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  assert.throws(
    () => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 2 }),
    /already placed a bet this round/
  )
  assert.equal(backend.getScore_({ teamCode: '1092' }).totalScore, 300, 'still held once')
  assert.equal(storedRound().b.length, 1)
})

test('placeBet validates amount, vent and team code before touching anything', () => {
  const { backend, storedRound } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 0, vent: 1 }), /positive whole number/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 2.5, vent: 1 }), /positive whole number/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 0 }), /1 to 9/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 10 }), /1 to 9/)
  assert.throws(() => backend.placeBet_({ amount: 10, vent: 1 }), /Team ID is required/)
  assert.throws(() => backend.placeBet_({ teamCode: '9999', amount: 10, vent: 1 }), /Unknown team ID/)
  assert.equal(backend.getScore_({ teamCode: '1092' }).totalScore, 500, 'no points moved')
  assert.equal(storedRound(), null, 'nothing recorded')
})

test('a score cell holding a formula is read as its value and never overwritten', () => {
  const { backend, scoreSheet } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 2090)] })
  assert.equal(scoreSheet.formulas.get('2,3'), '=IF(COUNTA(D2:W2)=0, "", SUM(D2:W2))')
  assert.equal(backend.getScore_({ teamCode: '1092' }).totalScore, 2090, 'the formula evaluates to a balance')

  backend.placeBet_({ teamCode: '1092', amount: 200, vent: 1 })
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  backend.resetRound_()

  assert.equal(scoreSheet.formulas.get('2,3'), '=IF(COUNTA(D2:W2)=0, "", SUM(D2:W2))', 'the formula is intact')
  assert.deepEqual(scoreSheet.writes, [], 'and no cell was written at any point')
})

test('a whole round of bets, declarations and refreshes never writes to the spreadsheet', () => {
  const { backend, scoreSheet } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 1000), scoreTeam('Bravo', '2424', 800)],
  })
  for (let round = 0; round < 5; round++) {
    const vent = (round % 9) + 1
    // The two declared losers have to be different from the winning vent.
    const losing = [((vent + 1) % 9) + 1, ((vent + 2) % 9) + 1]
    backend.placeBet_({ teamCode: '1092', amount: 100, vent })
    backend.placeBet_({ teamCode: '2424', amount: 50, vent })
    backend.getTeams_({})
    backend.getBets_()
    if (round % 2 === 0) {
      backend.declareResult_({ winningVent: vent, losingVent1: losing[0], losingVent2: losing[1] })
    } else {
      backend.resetRound_()
    }
  }
  assert.deepEqual(scoreSheet.writes, [], 'Sheet1 is read-only, always')
  assert.deepEqual(
    scoreSheet.data,
    [['Team Code', 'Team Name', 'Score'], ['1092', 'Alpha', 1000], ['2424', 'Bravo', 800]],
    'and its contents are byte-for-byte what they started as'
  )
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

test('declaring pays the winner into the bank, pays nobody else, and starts the next round', () => {
  const { backend, history, storedRound, available } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500), scoreTeam('Charlie', '2324', 500)],
    liveBets: [['1092', 200, 1], ['2424', 100, 2], ['2324', 50, 7]],
  })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.deepEqual(out, { ok: true, settled: 3, winningVent: 1, paidOut: 400 })

  // Alpha staked 200 and won: 500 from the sheet, plus the 400 payout.
  assert.equal(available('1092'), 900, 'winner is paid twice the stake')
  assert.equal(available('2424'), 400, 'a declared loser gets nothing')
  assert.equal(available('2324'), 450, 'a neutral vent loses its stake, not refunded')

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

  assert.deepEqual(
    storedRound(),
    { r: 2, p: { '1092': 400, '2424': -100, '2324': -50 }, b: [] },
    'the round advanced and each team was settled on its own line'
  )
  assert.equal(backend.getBets_().activeBets, 0)
})

test('one team winnings are never banked for another', () => {
  const { backend, available } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500)],
    liveBets: [['1092', 200, 1], ['2424', 100, 1]],
  })
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.equal(available('1092'), 900, 'winner up by their stake')
  assert.equal(available('2424'), 700, 'the other winner up by theirs, not both up by 400')
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

  const { backend, history, available } = setup({ scoreTeams, liveBets })
  // setup() has already placed the bets, so each stake is held back.
  for (let v = 1; v <= 9; v++) assert.equal(available(`code${v}`), 900, `vent ${v} stake held`)

  assert.equal(backend.declareResult_({ winningVent: win, losingVent1: losers[0], losingVent2: losers[1] }).settled, 9)

  const [round] = history()
  for (let v = 1; v <= 9; v++) {
    const predicted = computeSettlement(100, v, win, losers)
    const archived = round.settled[v - 1]
    assert.equal(archived.outcome, predicted.outcome, `vent ${v} outcome`)
    assert.equal(archived.payout, predicted.payout, `vent ${v} payout`)
    // The sheet said 1000 throughout. Settling makes the held stake permanent:
    // a winner is paid 200 and lands on 1200, a loser forfeits 100 and lands on 900.
    const expected = predicted.outcome === 'won' ? 1000 + predicted.payout : 1000 - 100
    assert.equal(available(`code${v}`), expected, `vent ${v} balance`)
  }
})

test('declareResult rejects out-of-range vents and duplicates', () => {
  const { backend, available } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  assert.throws(() => backend.declareResult_({ winningVent: 10, losingVent1: 2, losingVent2: 3 }), /valid vents/)
  assert.throws(() => backend.declareResult_({ winningVent: 0, losingVent1: 2, losingVent2: 3 }), /valid vents/)
  assert.throws(() => backend.declareResult_({ winningVent: 1, losingVent1: 1, losingVent2: 3 }), /all be different/)
  assert.throws(() => backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 2 }), /all be different/)
  assert.equal(available('1092'), 300, 'the round is untouched')
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

test('a refresh hands back every un-settled stake and banks nothing', () => {
  const { backend, scoreSheet, history, storedRound, available } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 500)],
    liveBets: [['1092', 200, 1], ['2424', 150, 3]],
  })
  assert.equal(available('1092'), 300, 'the stakes are held while the round is open')

  const out = backend.resetRound_()
  assert.deepEqual(out, { ok: true, archived: 2, returned: 2 })

  const [round] = history()
  assert.equal(round.outcome, 'refreshed', 'a refresh decides nothing')
  assert.equal(round.winningVent, undefined)
  assert.deepEqual(round.bets.map((b) => [b.c, b.a, b.v]), [['1092', 200, 1], ['2424', 150, 3]])

  assert.equal(available('1092'), 500, 'the stake came straight back')
  assert.equal(available('2424'), 500, 'for everyone')
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 500)
  assert.deepEqual(scoreSheet.writes, [])
  assert.deepEqual(storedRound(), { r: 2, p: {}, b: [] }, 'nothing was banked')
  assert.deepEqual(backend.getBets_().bets, [])
})

test('a refresh keeps payouts already banked from earlier rounds', () => {
  const { backend, available } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.equal(available('1092'), 900)

  backend.placeBet_({ teamCode: '1092', amount: 400, vent: 5 })
  assert.equal(available('1092'), 500, '400 held out of 900')
  backend.resetRound_()
  assert.equal(available('1092'), 900, 'the stake came back; the earlier payout stayed')
})

test('a team can bet again straight after a refresh, against its full balance', () => {
  const { backend } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  backend.resetRound_()
  const out = backend.placeBet_({ teamCode: '1092', amount: 100, vent: 5 })
  assert.equal(out.ok, true)
  assert.equal(out.pointsAfterBet, 400, 'the returned stake is spendable again')
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
  assert.deepEqual(backend.handleBettingAction_({ action: 'resetRound' }), { ok: true, archived: 1, returned: 1 })
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

test('clearStoredRounds throws the round, the archive and the banked payouts away', () => {
  const { backend, scoreSheet, history, storedRound, props, available } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500)],
    liveBets: [['1092', 200, 1]],
  })
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  assert.equal(available('1092'), 900)

  backend.clearStoredRounds()
  assert.equal(storedRound(), null)
  assert.equal(history(), null)
  assert.equal(props.store.size, 0)
  assert.equal(available('1092'), 500, 'the banked payout went with it, back to the sheet value')
  assert.equal(cell(scoreSheet, 2, SCORE_TOTAL), 500, 'the spreadsheet never moved')
  assert.deepEqual(scoreSheet.writes, [])
})

// ---------- editor helpers ----------

test('inspectScores reports the columns, the read-only promise and the balance it works out', () => {
  const { backend, logged } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 2090), scoreTeam('Bravo', '2424', 250)],
    liveBets: [['2424', 100, 4]],
  })
  backend.inspectScores()
  assert.ok(logged(/Spreadsheet: Main Spreadsheet/))
  assert.ok(logged(/Tab: "Sheet1"/))
  assert.ok(logged(/Read-only: this script never writes to this spreadsheet\./))
  assert.ok(logged(/name: column 2 \(B\), team code: column 1 \(A\), total score: column 3 \(C\)/))
  assert.ok(logged(/Usable teams: 2/))
  // Alpha: sheet 2090, nothing riding, so available is the same.
  assert.ok(logged(/row 2: code="1092" name="Alpha" sheet=2090 {2}available=2090 {2}formula==IF\(COUNTA\(D2:W2\)/))
  // Bravo: 250 from the sheet less the 100 it is holding.
  assert.ok(logged(/row 3: code="2424" name="Bravo" sheet=250 {2}available=150 {2}\(stake of 100 riding this round\)/))
  assert.ok(logged(/Round 1 — 1 live bet\(s\) in script properties/))
  assert.ok(logged(/Settled by this script so far: nothing yet\./))
})

test('inspectScores reports a banked payout as the gap between the sheet and what a team can spend', () => {
  const { backend, logged } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 2090)],
    liveBets: [['1092', 200, 1]],
  })
  backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3 })
  backend.placeBet_({ teamCode: '1092', amount: 500, vent: 2 })
  backend.inspectScores()
  // 2090 + 400 banked - 500 riding = 1990
  assert.ok(logged(/row 2: code="1092" name="Alpha" sheet=2090 {2}available=1990 {2}\(stake of 500 riding this round\)/))
  assert.ok(logged(/Settled by this script so far: 1092 \+400/))
})

// ---------- latency: the reads people actually wait on ----------

test('getTeams and getScore are served from the cross-container cache, not the sheet', () => {
  const { newContainer, scoreSheet, cache } = setup({
    scoreTeams: [scoreTeam('Alpha', '1092', 500), scoreTeam('Bravo', '2424', 400)],
  })

  // Request 1 pays for the sheet.
  const first = newContainer().getTeams_({})
  const readsAfterFirst = scoreSheet.reads
  assert.ok(readsAfterFirst > 0, 'the first request does read the sheet')

  // Requests 2-4 are each a brand new container, and none of them touch it.
  for (let i = 0; i < 3; i++) {
    const backend = newContainer()
    backend.getTeams_({})
    backend.getScore_({ teamCode: '1092' })
    backend.getTeams_({ q: 'bra' })
  }
  assert.equal(scoreSheet.reads, readsAfterFirst, 'later requests cost no Sheets calls at all')
  assert.equal(cache.hits, 3, 'all three came from CacheService')
  assert.deepEqual(
    newContainer().getTeams_({}).teams.map((t) => t.totalScore),
    first.teams.map((t) => t.totalScore)
  )
})

test('a cached roster is used until it expires, then the sheet is read again', () => {
  const { newContainer, scoreSheet, cache } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.equal(newContainer().getScore_({ teamCode: '1092' }).totalScore, 500)

  // Another script records an activity result, so the sheet's formula moves.
  scoreSheet.data[1][SCORE_TOTAL - 1] = 750
  assert.equal(newContainer().getScore_({ teamCode: '1092' }).totalScore, 500, 'served from the cache')

  // What the 60s TTL does when it runs out.
  cache.store.clear()
  assert.equal(newContainer().getScore_({ teamCode: '1092' }).totalScore, 750, 'and fresh once it expires')
})

test('a bet is judged against the current sheet, never a cached roster', () => {
  const { newContainer, scoreSheet } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  assert.equal(newContainer().getScore_({ teamCode: '1092' }).totalScore, 500)

  // The other script records a result between the lookup and the bet.
  scoreSheet.data[1][SCORE_TOTAL - 1] = 100

  // A cached roster would still say 500 and wave a 400 bet through.
  assert.throws(() => newContainer().placeBet_({ teamCode: '1092', amount: 400, vent: 1 }), /exceeds/)
  assert.equal(newContainer().getScore_({ teamCode: '1092' }).totalScore, 500, 'the cache was not consulted')

  assert.equal(newContainer().placeBet_({ teamCode: '1092', amount: 100, vent: 1 }).ok, true)
})

test('a bet never holds the script lock while it waits on the spreadsheet', () => {
  const { backend, scoreSheet } = setup({ scoreTeams: [scoreTeam('Alpha', '1092', 500)] })
  scoreSheet.readsWhileLocked = 0
  backend.placeBet_({ teamCode: '1092', amount: 100, vent: 1 })
  assert.equal(
    scoreSheet.readsWhileLocked,
    0,
    'the sheet is read before the lock, so a queue of teams is not serialised behind Sheets'
  )
})

test('an oversized roster is still served when the cache refuses to hold it', () => {
  // CacheService caps a single value at 100KB. A roster that big must not fail
  // the request just because it could not be cached.
  const many = Array.from({ length: 6000 }, (_, i) => scoreTeam(`Team ${i}`, `code${i}`, 100))
  const { backend, cache } = setup({ scoreTeams: many })
  const teams = backend.getTeams_({})
  assert.equal(teams.teams.length, 6000)
  assert.equal(cache.store.size, 0, 'nothing was cached')
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
