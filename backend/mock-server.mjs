// Dev-only mock of the deployed Apps Script endpoint.
// Loads the REAL backend/Code.gs against an in-memory workbook so the browser
// exercises the genuine code path. Not part of the app build.
//
//   node backend/mock-server.mjs          # serves on :8787
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'Code.gs'), 'utf8')

// Every cell is stored wrapped ({ value }) so a formula cell stays
// distinguishable from a literal one, which setBalance_ relies on.
const wrap = (v) => ({ value: v })
const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v)

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    Object.assign(this, { sheet, row, col, numRows, numCols })
  }
  _read(r, c) { return unwrap(this.sheet.data[r - 1]?.[c - 1]) }
  _write(r, c, v) {
    while (this.sheet.data.length <= r - 1) this.sheet.data.push([])
    while (this.sheet.data[r - 1].length <= c - 1) this.sheet.data[r - 1].push(wrap(''))
    this.sheet.data[r - 1][c - 1] = wrap(v)
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
  getValue() { return this._read(this.row, this.col) }
  getFormula() {
    const cell = this.sheet.data[this.row - 1]?.[this.col - 1]
    return cell && typeof cell === 'object' ? cell.formula || '' : ''
  }
  setValue(v) { this._write(this.row, this.col, v); return this }
  setValues(values) {
    values.forEach((row, ri) => row.forEach((v, ci) => this._write(this.row + ri, this.col + ci, v)))
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
  constructor(name, data) { this.name = name; this.data = data.map((r) => r.map(wrap)) }
  getName() { return this.name }
  getLastRow() { return this.data.length }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols)
  }
  appendRow(row) { this.data.push(row.map(wrap)); return this }
  setFrozenRows() { return this }
}

class FakeSpreadsheet {
  constructor(sheets) { this.byName = new Map(sheets.map((s) => [s.getName(), s])) }
  getSheetByName(name) { return this.byName.get(name) ?? null }
  insertSheet(name) {
    const sheet = new FakeSheet(name, [[]])
    this.byName.set(name, sheet)
    return sheet
  }
}

const BET_HEADER = [
  'Team Name', 'Team Code', '', 'Points BET',
  'VentChosen', 'Points After Bet', 'Result', 'Payout',
]

// CurrentRound holds the team roster; column D stays empty until a bet lands.
const ROSTER = [
  ['Alpha', '1092'], ['Bravo', '2424'], ['Charlie', '2324'],
  ['Delta', '3232'], ['Echo', '4141'],
]
const betSheet = new FakeSheet('CurrentRound', [
  BET_HEADER,
  ...ROSTER.map(([name, code]) => [name, code, '', '', '', '', '', '']),
])

// Request 5.0: code in B, score in S.
const mainRow = (code, score) => {
  const row = new Array(19).fill('')
  row[1] = code
  row[18] = score
  return row
}
const mainSheet = new FakeSheet('Request 5.0', [
  new Array(19).fill(''),
  mainRow('1092', 1000), mainRow('2424', 1000), mainRow('2324', 1000),
  mainRow('3232', 1000), mainRow('4141', 1000),
])

const ss = new FakeSpreadsheet([betSheet, mainSheet])
const store = { ADMIN_KEY: 'devkey' }

const load = new Function(
  'SpreadsheetApp',
  'ContentService',
  'PropertiesService',
  'LockService',
  `${source}
  return { doGet, doPost, CONFIG };`
)
const api = load(
  { getActive: () => ss },
  {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this } }),
  },
  {
    getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v) },
    }),
  },
  { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
)

// Seed a round through the real placeBet path, spread across the vent range
// so a declaration has a realistic mix of winner, loser and refunded bets.
for (const [code, amount, vent] of [['1092', 200, 1], ['2424', 150, 3], ['2324', 100, 5], ['4141', 75, 9]]) {
  api.doPost({ postData: { contents: JSON.stringify({ action: 'placeBet', teamCode: code, amount, vent }) } })
}

const server = http.createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    const out = api.doGet({ parameter: Object.fromEntries(url.searchParams) })
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' })
    res.end(out.text)
    return
  }

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const out = api.doPost({ postData: { contents: body } })
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' })
    res.end(out.text)
  })
})

server.listen(8787, () => console.log('mock Apps Script on http://localhost:8787'))
