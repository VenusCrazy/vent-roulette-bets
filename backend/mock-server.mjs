// Dev-only mock of the deployed Apps Script endpoint.
// Loads the REAL backend/Code.gs against an in-memory spreadsheet so the browser
// exercises the genuine code path. Not part of the app build.
//
//   node backend/mock-server.mjs          # serves on :8787
//
// Two workbooks are faked, like the real deployment: the script is bound to
// "Vent-Roulette" and reaches the teams through openById().
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'Code.gs'), 'utf8')

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
  getValue() { return this._read(this.row, this.col) }
  getFormula() { return this.sheet.formulas.get(this.row + ',' + this.col) || '' }
  setValue(v) {
    this.sheet.formulas.delete(this.row + ',' + this.col)
    this._write(this.row, this.col, v)
    return this
  }
}

class FakeSheet {
  constructor(name, data, sheetId = 0) {
    this.name = name; this.data = data; this.sheetId = sheetId; this.formulas = new Map()
  }
  getName() { return this.name }
  getSheetId() { return this.sheetId }
  getLastRow() { return this.data.length }
  getLastColumn() {
    let last = 0
    for (const row of this.data) {
      for (let c = 0; c < row.length; c++) {
        if (String(row[c] ?? '').trim()) last = Math.max(last, c + 1)
      }
    }
    return last
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols)
  }
  appendRow(row) { this.data.push(row.slice()); return this }
}

class FakeSpreadsheet {
  constructor(name, sheets) {
    this.name = name
    this.sheets = sheets
    this.byName = new Map(sheets.map((s) => [s.getName(), s]))
  }
  getName() { return this.name }
  getUrl() { return 'http://localhost:8787/' + encodeURIComponent(this.name) }
  getSheets() { return this.sheets }
  getSheetByName(name) { return this.byName.get(name) ?? null }
  insertSheet(name) {
    const sheet = new FakeSheet(name, [], this.sheets.length + 1)
    this.sheets.push(sheet)
    this.byName.set(name, sheet)
    return sheet
  }
}

// The main spreadsheet, reached by ID: row 1 headers, teams from row 2,
// A Team Code, B Team Name, C Score. C holds a SUM(D:W)-style formula owned by
// another script, exactly like the real sheet — this mock only ever reads it.
const scoreSheet = new FakeSheet('Sheet1', [
  ['Team Code', 'Team Name', 'Score'],
  ['1092', 'Alpha', 1000, 120, 80, 90],
  ['2424', 'Bravo', 1000, 140, 60, 75],
  ['2324', 'Charlie', 1000, 100, 95, 85],
  ['3232', 'Delta', 1000, 160, 70, 55],
  ['4141', 'Echo', 1000, 110, 90, 95],
])
scoreSheet.data.slice(1).forEach((_, i) => {
  const row = i + 2
  scoreSheet.formulas.set(`${row},3`, `=IF(COUNTA(D${row}:W${row})=0, "", SUM(D${row}:W${row}))`)
})
const scoreBook = new FakeSpreadsheet('Main Spreadsheet', [scoreSheet])

// The workbook the script is bound to. Deliberately has no team data.
const boundBook = new FakeSpreadsheet('Vent-Roulette', [
  new FakeSheet('Betting Sheet', [['Team Name', 'TeamCode', '', 'Points BET']]),
])

// Script properties, holding the live round.
const store = new Map()
const properties = {
  getProperty: (k) => (store.has(k) ? store.get(k) : null),
  setProperty: (k, v) => { store.set(k, String(v)) },
  deleteProperty: (k) => { store.delete(k) },
}

const load = new Function(
  'SpreadsheetApp',
  'ContentService',
  'LockService',
  'PropertiesService',
  'Logger',
  `${source}
  return { doGet, doPost, CONFIG };`
)
const api = load(
  {
    getActive: () => boundBook,
    openById: () => scoreBook,
  },
  {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this } }),
  },
  { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  { getScriptProperties: () => properties },
  { log: (...args) => console.log('[sheet]', ...args) }
)

// Seed a round through the real placeBet path, spread across the vent range so
// a declaration has a realistic mix of winner and loser.
for (const [code, amount, vent] of [['1092', 200, 1], ['2424', 150, 3], ['2324', 100, 5], ['4141', 75, 9]]) {
  const out = JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ action: 'placeBet', teamCode: code, amount, vent }) } }).text)
  if (!out.ok) console.log('[seed] skipped', code, out.error)
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
