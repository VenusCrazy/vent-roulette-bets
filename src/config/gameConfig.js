export const TEAMS = ['Jack Sparrow', 'Will Turner', 'Hector Barbossa', 'Elizabeth Swan']

// The nine selectable vents. A bet's target is the vent NUMBER (1-9) —
// this is the value sent in the payload and written to the sheet.
// Mirrors MIN_VENT / MAX_VENT in backend/Code.gs; keep both in step.
export const VENT_MIN = 1
export const VENT_MAX = 9

export const VENTS = Array.from({ length: VENT_MAX - VENT_MIN + 1 }, (_, i) => VENT_MIN + i)

// Display form of a vent. The sheet and the payload both store the number;
// "Vent N" exists only for humans.
export const ventLabel = (vent) => (vent == null ? '' : `Vent ${vent}`)

export const APP_NAME = 'ReQuest — Guess who fired the shot!'

export const APP_TAGLINE = 'Self-report! Claim the Prize.'

export const MAX_GRID_COLUMNS = 2