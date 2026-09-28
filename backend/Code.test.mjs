// Verification harness for backend/Code.gs — the deployed betting script.
// Loads the real Apps Script source in Node against an in-memory fake of the
// Sheets, Properties, Cache and Lock services, so the settlement rules, the
// balance arithmetic and the round bookkeeping can be exercised without
// touching the live workbook. node:test + node:assert only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'Code.gs'), 'utf8')

// ---------- fake Sheets API ----------

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols })
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
  getFormula() {
    return this._read(this.row, this.col).formula || ''
  }
  setValue(v) {
    const cell = { value: v }
    this._write(this.row, this.col, cell)
    this.sheet.formulas.delete(`${this.row}:${this.col}`)
    return this
  }
  setValues(values) {
    values.forEach((row, ri) =>
      row.forEach((v, ci) => {
        if (v && typeof v === 'object' && 'value' in v) this._write(this.row + ri, this.col + ci, v)
        else this._write(this.row + ri, this.col + ci, { value: v })
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
  appendRow(row) {
    this.sheet.data.push([...row])
    return this
  }
  setFrozenRows() {
    return this
  }
}

class FakeSheet {
  constructor(name, data) {
    this.name = name
    this.data = data
    this.formulas = new Map()
  }
  getName() {
    return this.name
  }
  getLastRow() {
    return this.data.length
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols)
  }
  appendRow(row) {
    return this.getRange(this.getLastRow() + 1, 1, 1, row.length).setValues([row])
  }
  setFrozenRows() {
    return this
  }
}

class FakeSpreadsheet {
  constructor(sheets) {
    this.byName = new Map(sheets.map((s) => [s.getName(), s]))
  }
  getSheetByName(name) {
    return this.byName.get(name) ?? null
  }
  insertSheet(name) {
    const sheet = new FakeSheet(name, [[]])
    this.byName.set(name, sheet)
    return sheet
  }
}

// Cell values are stored wrapped so a formula cell can be distinguished
// from a literal one. Helpers below unwrap.
const cell = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v)
const col = (sheet, row, index) => cell(sheet.data[row - 1]?.[index])

const BET_HEADER = ['Team Name', 'Team Code', '', 'Points BET', 'VentChosen', 'Points After Bet', 'Result', 'Payout']
const ARCHIVE_HEADER = ['Round', 'Timestamp', 'Team Name', 'Team Code', 'Bet', 'Vent', 'Result', 'Payout', 'Winning Vent', 'Losing Vents']

function setup({ bets, main, archive, props = {} } = {}) {
  const betSheet = new FakeSheet('CurrentRound', [BET_HEADER.slice(), ...(bets ?? [])])
  const mainSheet = new FakeSheet('Request 5.0', [new Array(19).fill(''), ...(main ?? [])])
  const archiveSheet = archive ? new FakeSheet('Archive', [ARCHIVE_HEADER.slice(), ...archive]) : null
  const sheets = [betSheet, mainSheet]
  if (archiveSheet) sheets.push(archiveSheet)
  const ss = new FakeSpreadsheet(sheets)
  const store = { ...props }

  const load = new Function(
    'SpreadsheetApp',
    'ContentService',
    'PropertiesService',
    'LockService',
    `${source}
    return { getBets_, placeBet_, declareResult_, handleBettingAction_, doGet, doPost, CONFIG };`
  )
  const backend = load(
    { getActive: () => ss },
    { MimeType: { JSON: 'application/json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this } }) },
    { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v) } }) },
    { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  )
  return { backend, betSheet, mainSheet, archiveSheet, ss, store }
}

// Convenience: main-sheet row with a code in B (index 1) and score in S (index 18)
const team = (code, score) => {
  const row = new Array(19).fill('')
  row[1] = code
  row[18] = score
  return row
}

const bet = (name, code, amount, vent, after = '', result = '', payout = '') => [
  name, code, '', amount, vent, after, result, payout,
]

// ---------- contract ----------

test('every action returns ok:true on success and ok:false with a message on failure', () => {
  const { backend } = setup({ bets: [bet('Alpha', '1092', 200, 1)] })
  assert.equal(backend.getBets_().ok, true)
  const failed = backend.handleBettingAction_({ action: 'placeBet', teamCode: '9999', amount: 10, vent: 1 })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /Unknown team ID/)
  assert.equal(backend.handleBettingAction_({ action: 'nope' }).error, 'Unknown action')
})

// ---------- getBets ----------

test('getBets returns only rows with a positive bet, plus totals and the round', () => {
  const { backend } = setup({
    bets: [bet('Alpha', '1092', 200, 1), bet('Nobody', '0000'), bet('Bravo', '2424', 150, 3, 850, 'Active', '')],
    props: { CURRENT_ROUND: '4' },
  })
  const out = backend.getBets_()
  assert.equal(out.ok, true)
  assert.equal(out.round, 4)
  assert.equal(out.activeBets, 2)
  assert.equal(out.totalPoints, 350)
  assert.deepEqual(out.bets, [
    { teamName: 'Alpha', amount: 200, vent: 1 },
    { teamName: 'Bravo', amount: 150, vent: 3 },
  ])
})

test('getBets on an empty sheet returns an empty list, not an error', () => {
  const { backend } = setup({ bets: [] })
  const out = backend.getBets_()
  assert.deepEqual(out, { ok: true, round: 1, bets: [], totalPoints: 0, activeBets: 0 })
})

// ---------- placeBet ----------

test('placeBet debits the balance, records the bet, and returns pointsAfterBet', () => {
  const { backend, betSheet, mainSheet } = setup({
    bets: [bet('Alpha', '1092')],
    main: [team('1092', 1000)],
  })
  const out = backend.placeBet_({ teamCode: '1092', amount: 200, vent: 3 })
  assert.equal(out.ok, true)
  assert.equal(out.pointsAfterBet, 800)
  assert.equal(col(mainSheet, 2, 18), 800, 'balance debited in Request 5.0 column S')
  assert.equal(col(betSheet, 2, 3), 200, 'Points BET')
  assert.equal(col(betSheet, 2, 4), 3, 'VentChosen')
  assert.equal(col(betSheet, 2, 5), 800, 'Points After Bet is the post-bet balance')
  assert.equal(col(betSheet, 2, 6), 'Active')
  assert.equal(col(betSheet, 2, 7), '', 'Payout stays empty until declared')
})

test('placeBet rejects an unknown team ID and an over-balance bet with the server message', () => {
  const { backend } = setup({ bets: [bet('Alpha', '1092')], main: [team('1092', 100)] })
  assert.throws(() => backend.placeBet_({ teamCode: '9999', amount: 10, vent: 1 }), /Unknown team ID/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 500, vent: 1 }), /Not enough points \(balance: 100\)/)
})

test('placeBet rejects a second bet in the same round', () => {
  const { backend } = setup({
    bets: [bet('Alpha', '1092', 200, 1, 800, 'Active', '')],
    main: [team('1092', 800)],
  })
  assert.throws(
    () => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 2 }),
    /already placed a bet this round/
  )
})

test('placeBet validates amount and vent before touching the sheet', () => {
  const { backend } = setup({ bets: [bet('Alpha', '1092')], main: [team('1092', 1000)] })
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 0, vent: 1 }), /positive whole number/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 2.5, vent: 1 }), /positive whole number/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 0 }), /1 to 9/)
  assert.throws(() => backend.placeBet_({ teamCode: '1092', amount: 10, vent: 10 }), /1 to 9/)
  assert.throws(() => backend.placeBet_({ amount: 10, vent: 1 }), /Team ID is required/)
})

// ---------- declareResult: settlement rules ----------

test('winning vent is paid the multiplier, declared losers are paid nothing', () => {
  const { backend, mainSheet } = setup({
    bets: [bet('Alpha', '1092', 200, 1, 800), bet('Bravo', '2424', 100, 2, 900), bet('Charlie', '2324', 50, 3, 950)],
    main: [team('1092', 800), team('2424', 900), team('2324', 950)],
  })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'k' })
  assert.equal(out.ok, true)
  assert.equal(out.settled, 3)
  assert.equal(out.winningVent, 1)
  assert.equal(col(mainSheet, 2, 18), 800 + 400, 'winner credited stake x 2')
  assert.equal(col(mainSheet, 3, 18), 900, 'declared loser unchanged')
  assert.equal(col(mainSheet, 4, 18), 950, 'declared loser unchanged')
})

test('a vent that neither won nor lost is refunded its full stake', () => {
  const { backend, mainSheet } = setup({
    bets: [bet('Alpha', '1092', 200, 1, 800), bet('Echo', '4141', 75, 7, 925)],
    main: [team('1092', 800), team('4141', 925)],
  })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'k' })
  assert.equal(out.settled, 2)
  assert.equal(col(mainSheet, 3, 18), 1000, 'neutral vent refunded: 925 + 75')
})

test('settlement across all nine vents pays the winner and refunds the six neutrals', () => {
  const bets = [bet('Alpha', '1092', 200, 1, 800), bet('Bravo', '2424', 100, 2, 900)]
  const main = [team('1092', 800), team('2424', 900)]
  for (let v = 3; v <= 9; v++) {
    bets.push(bet(`T${v}`, `T${v}`, 10, v, 990))
    main.push(team(`T${v}`, 990))
  }
  const { backend, mainSheet } = setup({ bets, main })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'k' })
  assert.equal(out.settled, 9)
  assert.equal(col(mainSheet, 2, 18), 800 + 400, 'winner')
  assert.equal(col(mainSheet, 3, 18), 900, 'loser pays nothing more')
  assert.equal(col(mainSheet, 4, 18), 990, 'declared loser vent 3 pays nothing more')
  for (let row = 5; row <= 10; row++) {
    assert.equal(col(mainSheet, row, 18), 1000, `neutral vent ${row - 1} refunded its stake`)
  }
})

test('declaring archives the round, clears live bets, and advances the round number', () => {
  const { backend, betSheet, archiveSheet, store } = setup({
    bets: [bet('Alpha', '1092', 200, 1, 800)],
    main: [team('1092', 800)],
    archive: [],
    props: { CURRENT_ROUND: '3' },
  })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'k' })
  assert.equal(out.round, 3)
  assert.equal(out.nextRound, 4)
  assert.equal(store.CURRENT_ROUND, '4')
  assert.equal(col(archiveSheet, 2, 0), 3, 'archive row carries the round number')
  assert.equal(col(archiveSheet, 2, 2), 'Alpha')
  assert.equal(col(archiveSheet, 2, 6), 'Won')
  assert.equal(col(archiveSheet, 2, 7), 400, 'archived payout')
  assert.equal(col(archiveSheet, 2, 8), 1)
  assert.equal(col(archiveSheet, 2, 9), '2, 3')
  assert.equal(col(betSheet, 2, 3), '', 'live bet cleared')
  assert.equal(col(betSheet, 2, 5), '', 'balance column cleared')
})

test('declaring with no bets settles nothing and does not advance the round', () => {
  const { backend, store } = setup({ bets: [bet('Alpha', '1092')], main: [team('1092', 1000)] })
  const out = backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'k' })
  assert.deepEqual(out, { ok: true, settled: 0, round: 1 })
  assert.equal(store.CURRENT_ROUND, undefined, 'round untouched')
})

// ---------- declareResult: guards ----------

test('declareResult rejects a wrong admin key when one is configured', () => {
  const { backend } = setup({
    bets: [bet('Alpha', '1092', 200, 1, 800)],
    main: [team('1092', 800)],
    props: { ADMIN_KEY: 'secret' },
  })
  assert.throws(
    () => backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'wrong' }),
    /Not authorised/
  )
  assert.equal(backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'secret' }).ok, true)
})

test('declareResult rejects out-of-range vents and duplicates', () => {
  const { backend } = setup({ bets: [bet('Alpha', '1092', 200, 1, 800)], main: [team('1092', 800)] })
  assert.throws(() => backend.declareResult_({ winningVent: 10, losingVent1: 2, losingVent2: 3 }), /valid vents/)
  assert.throws(() => backend.declareResult_({ winningVent: 0, losingVent1: 2, losingVent2: 3 }), /valid vents/)
  assert.throws(() => backend.declareResult_({ winningVent: 1, losingVent1: 1, losingVent2: 3 }), /all be different/)
  assert.throws(() => backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 2 }), /all be different/)
})

test('setBalance_ refuses to overwrite a formula cell', () => {
  const { backend, mainSheet } = setup({ bets: [bet('Alpha', '1092', 200, 1, 800)], main: [team('1092', 800)] })
  mainSheet.formulas.set('2:19', '=SUM(A1:A9)')
  mainSheet.data[1][18] = { value: 800, formula: '=SUM(A1:A9)' }
  assert.throws(
    () => backend.declareResult_({ winningVent: 1, losingVent1: 2, losingVent2: 3, adminKey: 'k' }),
    /Score cell is a formula/
  )
})

// ---------- transports ----------

test('doGet and doPost both route through the same action dispatcher', () => {
  const { backend } = setup({ bets: [bet('Alpha', '1092', 200, 1)] })
  const viaGet = JSON.parse(backend.doGet({ parameter: { action: 'getBets' } }).text)
  assert.equal(viaGet.ok, true)
  assert.equal(viaGet.activeBets, 1)
  const viaPost = JSON.parse(backend.doPost({ postData: { contents: '{"action":"getBets"}' } }).text)
  assert.equal(viaPost.ok, true)
  const bad = JSON.parse(backend.doPost({ postData: { contents: 'not json' } }).text)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'Unknown action')
})

// ---------- drift guard: the frontend preview must match the sheet ----------
// AdminDeclareWinner shows a predicted Payout before anyone commits. If that
// prediction disagrees with what declareResult_ actually writes, the admin
// approves numbers the sheet will not honour — so run the same nine-vent round
// through both and require identical outcomes.
import { computeSettlement } from '../src/lib/settlement.js'

test('the frontend preview predicts exactly what the sheet writes, for all nine vents', () => {
  const win = 4
  const losers = [2, 7]
  // Fresh rows per setup: settling mutates the sheet in place, so a shared
  // array would arrive at the second run already cleared.
  const scenario = () => {
    const bets = []
    const main = []
    for (let v = 1; v <= 9; v++) {
      bets.push(bet(`Team ${v}`, `code${v}`, 100, v, 900))
      main.push(team(`code${v}`, 900))
    }
    return { bets, main }
  }

  const first = setup(scenario())
  const out = first.backend.declareResult_({
    winningVent: win, losingVent1: losers[0], losingVent2: losers[1], adminKey: 'k',
  })
  assert.equal(out.settled, 9)

  for (let v = 1; v <= 9; v++) {
    const predicted = computeSettlement(100, v, win, losers)
    // The script credits balance + payout on top of the post-bet balance.
    assert.equal(
      col(first.mainSheet, v + 1, 18),
      900 + predicted.payout,
      `vent ${v}: preview said ${predicted.outcome}/${predicted.payout}, sheet wrote a different balance`
    )
  }

  // The sheet's own Result and Payout columns must carry what the preview shows.
  const second = setup({ ...scenario(), archive: [] })
  second.backend.declareResult_({
    winningVent: win, losingVent1: losers[0], losingVent2: losers[1], adminKey: 'k',
  })
  const resultLabels = { won: 'Won', lost: 'Lost', refunded: 'Refunded' }
  for (let v = 1; v <= 9; v++) {
    const predicted = computeSettlement(100, v, win, losers)
    assert.equal(
      col(second.archiveSheet, v + 1, 6),
      resultLabels[predicted.outcome],
      `vent ${v}: preview label disagreed with the archived Result`
    )
    assert.equal(
      col(second.archiveSheet, v + 1, 7),
      predicted.payout,
      `vent ${v}: preview payout disagreed with the archived Payout`
    )
  }
})
