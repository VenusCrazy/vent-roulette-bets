# Catch Your Shooter

A betting page for the round-based game. The frontend is React + Vite; the backend is a
Google Apps Script web app that reads and writes a Google Sheet. There is no application
server in between — the deployed Apps Script URL is the only thing the browser talks to.

## Setup

```bash
npm install
cp .env.example .env
```

Add your deployed web app URL to `.env`:

```
VITE_APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycb.../exec
```

Then start the dev server:

```bash
npm run dev
```

Vite reads `.env` **at startup only**. If you edit `.env` while the server is running,
stop it and start it again or the change is ignored.

`.env` is gitignored; `.env.example` is committed.

## Deployment notes (Apps Script)

These are the three things that most often break an otherwise correct setup.

**1. Deploy as a Web App with the right access.** In the Apps Script editor:

- **Deploy → New deployment → Web app**
- **Execute as:** *Me*
- **Who has access:** *Anyone*

If "Who has access" is restricted to your own Google account, the browser receives an HTML
login page instead of JSON and every request fails with a "did not return valid JSON"
error. This is the single most common cause of that message.

**2. Create a new deployment version after every backend change.** The `/exec` URL stays
the same, but a new edit is not served until you redeploy. **Deploy → Manage deployments →
edit (pencil icon) → Version: New version → Deploy.** Without this, the URL looks right and
still runs your previous code.

**3. Use the `/exec` URL, not `/dev`.** `/dev` is the editor's development sandbox and
requires your Google login. `/exec` is the deployed public endpoint. Copy the URL ending in
`/exec` into `.env`.

## The data

Two workbooks are involved, and they are not the same one.

| | Role |
| --- | --- |
| **The main spreadsheet** (`CONFIG.SCORE_SPREADSHEET_ID`) | Owns the teams and the points. `Sheet1`, row 1 headers, teams from row 2: **A `Team Code` · B `Team Name` · C `Score`**, with the activity columns to the right. This is the only spreadsheet the script reads *or* writes. |
| **The bound workbook** | Whatever the Apps Script project was created from. The script uses it for nothing except the `Vault Roulette` menu. The old `Betting Sheet` tab there is now unused. |

The script is reached by ID, not through `getActive()`, so the roster comes from the right
file regardless of which spreadsheet the project is bound to. Change
`CONFIG.SCORE_SPREADSHEET_ID` if your teams live somewhere else.

### Where the round is kept

**In script properties, not in a spreadsheet.** There is no `Bets` sheet, no `Archive_Bets`
and no `Config` sheet any more:

- `bets_v1` — `{ r: <round number>, b: [ { c, n, a, v } ] }`, the live round.
- `history_v1` — finished rounds, trimmed to fit the 9KB limit PropertiesService puts on a
  single value, oldest dropped first.

Both are only ever touched under the script lock, so a second bet cannot slip in between the
debit and the write.

### How points move

The stake is **debited from the score column when the bet is placed**, and the payout is
**credited when the round is declared**:

- Bet 200 with 1000 points → the team is on 800 and the bet is recorded.
- That vent wins → the team is credited 400, landing on 1200. Net **+200**: the stake doubled.
- That vent loses → nothing is credited, the team stays on 800.

`CONFIG.REFUND_NEUTRAL` is `false`, so a vent that neither won nor lost is paid nothing
either. Of the nine vents that leaves **1 paid and 8 losing**: the winning vent, the two you
declared as losers, and the six that did nothing at all. `src/lib/settlement.js` mirrors that,
and a drift guard in the test suite fails if the two ever disagree.

Because the debit happens up front, a team's points **dip while a round is open** and rise
again when you declare. That is deliberate, and it is what your original main-sheet script
did.

> **Before the first bet: run `inspectScores()` from the editor and read the log.** It prints
> the resolved columns and, for the first few teams, whether the score cell holds a plain
> number or a formula. If column C is `=SUM(D2:W2)` or similar, the script **refuses to
> write** rather than destroy the formula, and bets will fail with *"the score column holds
> a formula"*. Nothing can be written until that is resolved.

### Reading the team data

The script reads row 1 of `Sheet1` and uses the columns headed **Team Name**, **Team Code**
and **Score** (also accepted: `Total Score`, `Points`, `ID`, `Crew Name`), then loads the
whole roster into an array once per execution. Every team lookup is an exact compare against
that array — never a whole-sheet text search, which would match a team code that happened to
be typed into an activity cell.

If the header row is renamed or removed it falls back to `CONFIG.SCORE_NAME` (2),
`CONFIG.SCORE_CODE` (1) and `CONFIG.SCORE_TOTAL` (3). Widen `CONFIG.HEADER_SCAN_COLS` (200)
if the headings sit further right than column 200.

- **To see everything the script can see**, run `inspectScores()` and open
  **View → Execution log**.
- **To fetch the roster as JSON**, hit the endpoint in a browser: `…/exec?action=getTeams`,
  or add `&q=alpha` to search by name or code. `?action=getScore&teamCode=1092` reads one team.
- **"Sheet not found"** means `CONFIG.SCORE_SHEET` does not match a tab in the main
  spreadsheet. Spaces and capitalisation don't matter (`Sheet 1` and `sheet1` both match
  `Sheet1`), but a differently named tab does not — and the error lists the tabs that do exist.

### Refreshing a round

Two ways to archive the current round and start the next one. Nothing is settled and **no
points move** — `declareResult` does that:

- **In the spreadsheet:** the **Vault Roulette → Refresh round (archive & clear)** menu, which
  appears next to Help once the sheet has been opened (the `onOpen` trigger adds it).
- **From the website:** the **Refresh Round** card on `/admin` (click twice to confirm).

If the stored round ever gets into a bad state, run `clearStoredRounds()` from the editor. It
throws the round and the archive away and does not touch points.

There is no access control on the web actions: anyone with the deployed URL (or the `/admin`
route) can declare results, refresh a round, or read the roster and everyone's bet. Keep the
URL and the route to yourselves.

After editing `Code.gs` (including the first time you paste it), redeploy a new version — see
note 2 above — or the changes never go live.

## How the frontend talks to Apps Script

Apps Script web apps do not answer CORS preflight (`OPTIONS`) requests, so the request has
to stay within the CORS-safelisted set or it fails before reaching the script. The API layer
in `src/api/betting.js` handles this:

- `POST` sends `Content-Type: text/plain` — a CORS-safelisted value, byte for byte, with no
  charset parameter. The body is still JSON; `doPost` parses `e.postData.contents`
  regardless of the declared type. `application/json` would trigger a preflight and fail.
- No custom headers are sent, and `mode` is left at its default so the response stays
  readable. (`no-cors` would make the response opaque.)
- `GET` appends a timestamp, since Apps Script caches aggressively behind a CDN.
- Every request has a 20s `AbortController` timeout, so a hung call cannot leave the UI
  spinning forever.
- Apps Script replies with **HTTP 200 even when something failed**, so success is decided by
  `data.ok`, never by `response.ok`. Failures carry `{ ok: false, error: "..." }` and that
  message is shown to the user verbatim.

In the network tab, placing a bet should show a single `POST` with **no `OPTIONS` request
above it**.

## Layout

| Path | Purpose |
| --- | --- |
| `/` | Place bets (the entered Team ID's score is looked up and shown), see total and active bets, current round's bets (polls every 15s) |
| `/admin` | Declare the round result and settle payouts; refresh (archive & clear) the round |

## Commands

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # ESLint
npm test         # API contract, settlement rules, and Code.gs harness tests
npm run mock     # local stand-in for the deployed web app on :8787
```

`npm test` runs the Apps Script source in `backend/Code.gs` against an in-memory fake of the
Sheets API, so the settlement rules and round bookkeeping are verified without a live
workbook. `npm run mock` serves that same code over HTTP for local UI testing — it is a
development aid only and is not part of the app or its build.

To point the app at the mock instead of the real deployment, set
`VITE_APPS_SCRIPT_URL=http://localhost:8787` in `.env`. It seeds five teams
(`1092`, `2424`, `2324`, `3232`, `4141`) with 1000 points each.
