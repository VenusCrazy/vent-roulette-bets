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

The roster is cached separately in `CacheService` for 60 seconds, because it is the one
thing that costs a spreadsheet round trip. See
[Why the site sometimes feels slow](#why-the-site-sometimes-feels-slow).

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
- Apps Script replies with **HTTP 200 even when something failed**, so success is decided by
  `data.ok`, never by `response.ok`. Failures carry `{ ok: false, error: "..." }` and that
  message is shown to the user verbatim.

In the network tab, placing a bet should show a single `POST` with **no `OPTIONS` request
above it**.

### Why the site sometimes feels slow

An Apps Script web app runs on a container that is **shut down when it sits idle**, so the
first request after a pause pays a cold start on top of the work. Measured against the live
deployment:

| Call | Warm | Cold |
| --- | --- | --- |
| `getBets` (no spreadsheet access) | ~2.2s | **12.5s** |
| `getTeams` | ~2.9s | — |
| `getScore` | ~3.2s | — |

Three things follow from that, and all three are in the code:

- **The timeout is 25s, and a request is retried once.** A cold start that overruns the
  ceiling is retried after a second, because a sleeping container is the most predictable
  failure there is. The old 20s ceiling failed exactly when the service was slowest.
  A retry after a timeout on `placeBet` that comes back *"already placed a bet this round"*
  is reported as the success it is: the script refuses a second bet per team per round, so
  that answer is proof the first attempt got through.
- **A failed background poll does not raise an alarm.** `useBets` keeps the last good board
  on screen and reports `loaded`, so a timed-out refresh on top of a correct board shows a
  muted one-liner instead of a red banner. A red alert is reserved for having nothing to show.
- **The roster is cached across containers, but a bet never is.** Reading it costs several
  Sheets round trips, and the module-level cache dies with the container, so `roster_()` also
  uses `CacheService` for 60 seconds. `getTeams` and `getScore` are therefore served from
  cache. **`placeBet` deliberately bypasses it** (`roster_({ fresh: true })`) so the ceiling
  is judged against the sheet's current numbers and a team cannot overspend against a
  snapshot. It also reads the sheet *before* taking the script lock, so a queue of teams is
  not serialised behind the Sheets API — the lock is held only for a properties read and
  write, milliseconds rather than seconds.
- **The poll interval is 2–4s.** A bet should show up on everyone's board while the round is
  still being argued about. It also keeps the container awake, which is the other half of why
  the site used to feel slow after a pause. Each client adds up to 2s of jitter so tabs do not
  land on the same instant.
- **Failures back the poll off.** Consecutive failures double the period — 2s, 8s, 16s, 30s,
  where it stops — and a single success puts it straight back to 2–4s. Polling hard into a
  throttle is a spiral, since every refusal is another request that invites the next one.
  Switching back to the tab polls at once rather than waiting out a backed-off period.

> **On quotas:** the current published Apps Script quotas do *not* include a
> executions-per-minute cap for web app calls; the documented ceilings are 6 minutes of runtime
> per execution and 30 simultaneous executions per user. What is real is throttling in
> practice — hammering the endpoint does get refused, which is what the backoff above is
> there for. At 2–4s a single open tab is roughly 20 requests a minute, well inside 30
> concurrent. If the board starts refusing while several tabs are open, close the extras; the
> backoff will recover on its own.

> If the site stays slow even when warm, the account is on Apps Script's free tier, where
> containers are aggressively recycled. A Workspace account removes the cold starts; nothing
> in this codebase can.

### Troubleshooting timeouts

| Symptom | Cause |
| --- | --- |
| *"took too long to respond"* after ~25s, on a first load | A cold start that outlived one retry. Try again — the second attempt finds the container awake. |
| *"did not return valid JSON"* | The request hit Google's rate limiter or a login page. This endpoint is public; it fails if it is deployed **Execute as: Me** with access **Only myself**. |
| The board is correct but shows *"Couldn't reach the service just now"* | One background poll timed out. Nothing is wrong; the next one replaces it. |
| Betting works, the roster is empty | `CONFIG.SCORE_SPREADSHEET_ID` or `CONFIG.SCORE_SHEET` no longer match. Run `inspectScores()` and read the log. |

## Layout

| Path | Purpose |
| --- | --- |
| `/` | Place bets (the entered Team ID's score is looked up and shown), see total and active bets, current round's bets (polls every 2–4s) |
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
