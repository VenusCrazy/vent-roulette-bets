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
| **The main spreadsheet** (`CONFIG.SCORE_SPREADSHEET_ID`) | Owns the teams and the points. `Sheet1`, row 1 headers, teams from row 2: **A `Team Code` · B `Team Name` · C `Score`**, with the activity columns to the right. **Read-only** — see below. |
| **The bound workbook** | Whatever the Apps Script project was created from. The script uses it for nothing except the `Vault Roulette` menu. The old `Betting Sheet` tab there is now unused. |

The script is reached by ID, not through `getActive()`, so the roster comes from the right
file regardless of which spreadsheet the project is bound to. Change
`CONFIG.SCORE_SPREADSHEET_ID` if your teams live somewhere else.

### The main spreadsheet is never written

Column C is not a number — it is a formula owned by the other script on that workbook:

```
=IF(COUNTA(D5:W5)=0, "", SUM(D5:W5))
```

So this script **only ever reads it**. It never calls `setValue` on that workbook, never
touches the formula, and a test asserts that a full run of bets, declarations and refreshes
leaves the sheet byte-for-byte identical. The website is where points move; the sheet's own
total stays as its own script left it.

The consequence, worth knowing: **your in-sheet `Score` column will not reflect a team's
betting position during a round.** Someone opening the spreadsheet mid-round sees the
un-bet total. The site's balance is the honest one.

### Where the round is kept

**In script properties, not in a spreadsheet.** There is no `Bets` sheet, no `Archive_Bets`
and no `Config` sheet any more:

- `bets_v1` — `{ r: <round>, p: { <teamCode>: <settled, ever> }, b: [ { c, n, a, v } ] }`:
  the round counter, what each team has settled, and the live round.
- `history_v1` — finished rounds, trimmed to fit the 9KB limit PropertiesService puts on a
  single value, oldest dropped first.

Both are only ever touched under the script lock.

### How points move

Since the sheet is read-only, spendable points are worked out here:

```
available = Score as the sheet evaluates it
         + what this script has settled for that team so far
         - stakes still in flight this round
```

A stake is **held in the round**, not taken out of the sheet, so a team's points dip while
the round is open and the sheet never moves. Declaring makes each hold permanent:

- Bet 200 with the sheet at 1000 → the team can spend **800**, sheet still says 1000.
- That vent **wins** → settled **+400**, so it can spend **1400**. Net **+200**: the stake doubled.
- That vent **loses** → settled **−200**, so it can spend **800**. The stake is gone.
- **Refresh** instead of declaring → the hold is dropped and the 200 comes straight back. A
  refresh settles nothing, so it is always safe.

`CONFIG.REFUND_NEUTRAL` is `false`, so a vent that neither won nor lost forfeits its stake
too. Of the nine vents that leaves **1 paid and 8 forfeiting**: the winning vent, the two you
declared as losers, and the six that did nothing at all. `src/lib/settlement.js` mirrors
that, and a drift guard in the test suite fails if the two ever disagree.

> Because each bet mints or burns points rather than conserving them, this is a game of
> chance, not a pot. Points can leave the table over a long run.

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
  **View → Execution log**. It prints the spreadsheet, the columns it resolved, each team's
  sheet score next to what it can actually spend, and what this script has settled.
- **To fetch the roster as JSON**, hit the endpoint in a browser: `…/exec?action=getTeams`,
  or add `&q=alpha` to search by name or code. `?action=getScore&teamCode=1005` reads one
  team and returns `totalScore` (spendable), `sheetScore` and `inFlight`.
- **"Sheet not found"** means `CONFIG.SCORE_SHEET` does not match a tab in the main
  spreadsheet. Spaces and capitalisation don't matter (`Sheet 1` and `sheet1` both match
  `Sheet1`), but a differently named tab does not — and the error lists the tabs that do exist.

### Refreshing a round

Two ways to archive the current round and start the next one. **Nothing is settled and no
points move — every held stake is handed straight back:**

- **In the spreadsheet:** the **Vault Roulette → Refresh round (archive & clear)** menu, which
  appears next to Help once the sheet has been opened (the `onOpen` trigger adds it).
- **From the website:** the **Refresh Round** card on `/admin` (click twice to confirm).

If the stored round ever gets into a bad state, run `clearStoredRounds()` from the editor. It
throws the round, the archive **and the settled totals** away, which resets every team to
their sheet score. It never touches the spreadsheet.

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
