// Rollback-safety classification (ported from flightdeck, the CTO's reference
// app). At PROMOTE time we ask a single question about the SQL migrations added
// between the release currently in production and the promoted candidate:
//
//   Can the PREVIOUS image still run against the NEW schema?
//
// If every added migration is additive / backward-compatible the schema change
// is an EXPAND and a rollback (image swap back) stays safe. If any migration is
// destructive — drops, renames, tightening constraints, data migrations — it is
// a CONTRACT: the old image would break against the new schema, so a rollback
// would NOT revert cleanly. This is ADVISORY ONLY; it never blocks a promote.
//
// The classifier is deliberately conservative: anything it does not positively
// recognise as additive is treated as unsafe.

const EXPAND = 'expand'
const CONTRACT = 'contract'

// --- Statement splitting / normalisation ------------------------------------

// Strip SQL comments: /* block */ (across newlines) and -- line comments.
// NOTE: callers must split on drizzle's `--> statement-breakpoint` marker
// BEFORE this runs — otherwise the `--` line-comment strip eats the marker.
function stripComments (sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

function normalizeWhitespace (sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

// Split a migration file body into individual normalised statements.
export function splitStatements (sql) {
  if (!sql) return []
  return sql
    // Drizzle separates statements with a "--> statement-breakpoint" marker.
    // Split on it FIRST, before stripping `--` line comments.
    .split(/-->\s*statement-breakpoint/i)
    // ...then strip comments and split each chunk on terminating semicolons.
    .flatMap((chunk) => stripComments(chunk).split(';'))
    .map(normalizeWhitespace)
    .filter((s) => s.length > 0)
}

// --- Ordered rule table ------------------------------------------------------

// Each rule inspects the normalised statement head and returns { phase, reason }
// on a match, or null to fall through. FIRST match wins, so order matters:
// specific / destructive forms are checked before broader additive ones.
const RULES = [
  // Renames of ANY object are destructive — the previous image still refers to
  // the object by its old name. Checked first so it wins over other ALTER rules.
  rule(/^ALTER\b[\s\S]*\bRENAME\b/i, CONTRACT, 'renames an object the previous image still references by its old name'),

  // ALTER TABLE ... ADD COLUMN — additive UNLESS it is NOT NULL without a
  // DEFAULT, which the previous image's INSERTs cannot satisfy.
  addColumn,

  // ALTER TABLE ... destructive / tightening column & constraint changes.
  rule(/^ALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i, CONTRACT, 'drops a column the previous image still selects'),
  rule(/^ALTER\s+TABLE\b[\s\S]*\bADD\s+CONSTRAINT\b/i, CONTRACT, 'adds a constraint that can reject the previous image\'s writes'),
  // Column-level ALTERs: NOT NULL (tighten) and DEFAULT (loosen) are checked
  // before the TYPE rule so a column literally named "type" can't be misread.
  rule(/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i, CONTRACT, 'tightens a column to NOT NULL; the previous image may still write nulls'),
  rule(/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\b(SET|DROP)\s+DEFAULT\b/i, EXPAND, 'changes a column default (the previous image is unaffected)'),
  rule(/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\b(SET\s+DATA\s+TYPE|TYPE)\b/i, CONTRACT, 'changes a column type; the previous image reads/writes it with the old type'),
  // ALTER TABLE ... DROP CONSTRAINT is a loosening — old writes still pass.
  rule(/^ALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i, EXPAND, 'drops a constraint (loosening; the previous image\'s writes still pass)'),

  // ALTER TYPE ... ADD VALUE grows an enum — additive (rename handled above).
  rule(/^ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i, EXPAND, 'adds a new enum value (additive)'),

  // CREATE of any supported object is additive.
  rule(/^CREATE\s+(OR\s+REPLACE\s+)?(UNIQUE\s+)?(MATERIALIZED\s+)?(TABLE|TYPE|INDEX|EXTENSION|SEQUENCE|VIEW|FUNCTION|TRIGGER|POLICY|SCHEMA)\b/i, EXPAND, 'creates a new database object (additive)'),

  // DROP INDEX is safe (the previous image does not require the index to exist);
  // dropping any OTHER object the previous image depends on is destructive.
  rule(/^DROP\s+INDEX\b/i, EXPAND, 'drops an index (the previous image does not require it)'),
  dropObject,

  // Metadata / privilege / additive-data statements are safe.
  rule(/^COMMENT\s+ON\b/i, EXPAND, 'sets a comment (metadata only)'),
  rule(/^(GRANT|REVOKE)\b/i, EXPAND, 'grant/revoke (privileges only; no schema shape change)'),
  rule(/^INSERT\s+INTO\b/i, EXPAND, 'inserts data (additive)'),

  // Data migrations & bulk deletes are conservatively unsafe.
  rule(/^TRUNCATE\b/i, CONTRACT, 'truncates a table the previous image expects to be populated'),
  rule(/^UPDATE\b/i, CONTRACT, 'runs a data migration (UPDATE) that cannot be assumed backward-compatible'),
  rule(/^DELETE\b/i, CONTRACT, 'runs a data migration (DELETE) that removes rows the previous image may read')
]

function rule (regex, phase, reason) {
  return (s) => (regex.test(s) ? { phase, reason } : null)
}

function addColumn (s) {
  if (!/^ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i.test(s)) return null
  if (/\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s)) {
    return { phase: CONTRACT, reason: 'previous image INSERTs omit the new required column' }
  }
  return { phase: EXPAND, reason: 'adds a column (additive; nullable or defaulted)' }
}

function dropObject (s) {
  const m = /^DROP\s+(MATERIALIZED\s+VIEW|TABLE|TYPE|VIEW|FUNCTION|SEQUENCE|SCHEMA|POLICY|TRIGGER)\b/i.exec(s)
  if (!m) return null
  const obj = m[1].toLowerCase()
  return { phase: CONTRACT, reason: `drops a ${obj} the previous image still depends on` }
}

// Classify a single normalised statement against the rule table.
function classifyStatement (statement) {
  for (const test of RULES) {
    const hit = test(statement)
    if (hit) return { statement, phase: hit.phase, reason: hit.reason }
  }
  // Unrecognised → unsafe by default (conservative).
  return { statement, phase: CONTRACT, reason: 'unrecognized statement — classified unsafe conservatively' }
}

// Classify every statement in a migration file body.
export function classifySqlStatements (sql) {
  return splitStatements(sql).map(classifyStatement)
}

// --- File-level classification ----------------------------------------------

// Drizzle keeps journal/snapshot bookkeeping under a meta/ subdirectory; those
// are never real migrations.
function isMetaPath (path) {
  return /(^|\/)meta\//.test(path)
}

function isDotfile (path) {
  return /(^|\/)\.[^/]*$/.test(path)
}

function isSql (path) {
  return /\.sql$/i.test(path)
}

// Classify a set of changed migration files into a single advisory verdict.
// files: [{ path, status, content }] where status is a GitHub compare status
// (added | modified | removed | renamed | ...). Returns { verdict, reasons }.
export function classifyMigrationFiles (files) {
  const reasons = []

  for (const file of files ?? []) {
    const path = file.path
    // drizzle bookkeeping under meta/ is ignored entirely.
    if (isMetaPath(path)) continue
    const sql = isSql(path)
    // Non-SQL dotfiles (.gitkeep, .DS_Store, ...) are ignored.
    if (isDotfile(path) && !sql) continue

    const status = (file.status ?? '').toLowerCase()

    if (!sql) {
      // A non-.sql migration artifact we cannot classify (only plain .sql is
      // classified today; frameworks land later).
      if (status === 'added') {
        reasons.push(`${path}: unsupported migration format (only .sql is classified)`)
      }
      continue
    }

    if (status !== 'added') {
      // A .sql file that already existed being edited/removed/renamed rewrites
      // applied history — always unsafe.
      reasons.push(`${path}: migration history modified (${status || 'changed'})`)
      continue
    }

    // A freshly added .sql migration — classify its statements; every CONTRACT
    // statement contributes a path-prefixed reason.
    for (const st of classifySqlStatements(file.content ?? '')) {
      if (st.phase === CONTRACT) reasons.push(`${path}: ${st.reason}`)
    }
  }

  return { verdict: reasons.length === 0 ? 'safe' : 'unsafe', reasons }
}
