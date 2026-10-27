// Rollback-safety classification (ported from flightdeck, the CTO's reference
// app). At PROMOTE time we ask a single question about the migrations added
// between the release currently in production and the promoted candidate:
//
//   Does this change remove or alter something such that a rollback might
//   not recover?
//
// A rollback swaps the image back; it does NOT run `down` migrations, so
// whatever a migration removed or tightened is still removed or tightened
// afterwards. A migration that only adds is an EXPAND and the rollback is
// clean. One that drops, renames, retypes, tightens a constraint or rewrites
// data is a CONTRACT: the rollback leaves the schema where the migration put
// it. This is ADVISORY ONLY; it never blocks a promote.
//
// The answer comes from the migration diff alone — the classifier never reads
// application code, so a reason says what the migration did and never what an
// image does with it.
//
// The classifier is deliberately conservative: anything it does not positively
// recognise as additive is treated as unsafe.

const EXPAND = 'expand'
const CONTRACT = 'contract'

// --- Statement splitting / normalisation ------------------------------------
//
// A migration is split into statements by a small Postgres lexer, not by a
// plain split on `;`. A `;`, `--` or `/*` inside a string is just text: a
// comment whose wording has a semicolon in it, a default of '--', a function
// body full of statements. Splitting on those left a piece of the string as a
// "statement" of its own, which no rule recognised, so an additive migration
// read as unsafe.
//
// Each statement comes in two forms. `text` is the statement as written, with
// comments blanked and whitespace collapsed; it is what a result reports.
// `masked` is the same with the inside of every string, quoted name and
// dollar-quoted body emptied ('a; b' becomes ''), and it is the only form the
// rules read. The rules look for words like DROP COLUMN, NOT NULL and DEFAULT,
// and those words inside a literal say nothing about what the statement does:
// a comment that mentions DROP COLUMN must not make a migration unsafe, and a
// CHECK that compares against 'DEFAULT' must not make a required column look
// defaulted.
//
// A quote-aware splitter can also go wrong in the dangerous direction. The old
// one could only split too often, which reads as unsafe. A lexer that misjudges
// where a string ends can swallow a real statement into the "string" and never
// classify it. So when the lexer cannot be sure, the file is reported as one
// that could not be split, instead of being classified on a guess.

const SPLIT_UNTERMINATED = 'could not split the SQL into statements (unterminated quote or comment)'
// Postgres reads a backslash in a plain '...' string as an ordinary character,
// but MySQL-style SQL reads `\'` as an escaped quote. On such SQL a Postgres
// lexer ends the string early, which can hide the statements that follow inside
// what it thinks is the next string. A quote right after a backslash is legal
// Postgres but rare, so it is reported rather than trusted.
const SPLIT_BACKSLASH = 'could not split the SQL into statements reliably (a quote follows a backslash, so it may use backslash escapes)'
// MySQL quotes names with backticks, starts a line comment with `#`, and runs
// the inside of a `/*! ... */` comment as code. A Postgres lexer reads none of
// these that way: the apostrophe in `user's` behind a backtick or a `#` opens a
// "string" that can swallow the statements after it. None of them is valid
// Postgres outside a literal, except the jsonb operators `#>`, `#>>` and `#-`
// and the rarely used `#` (XOR), which reads unsafe as the price of the guard.
const SPLIT_MYSQL = 'could not split the SQL into statements reliably (it uses MySQL-style syntax: a backtick, a # comment or a /*! comment)'

// drizzle-kit writes this line comment between the statements it generates,
// and a statement before it does not always end in `;`.
const DRIZZLE_BREAKPOINT = /^-->\s*statement-breakpoint/i

// Characters that start and continue a name. Postgres reads a `$` inside a
// name as part of it (`price$usd`), not as the start of a dollar quote, and
// the `e` that ends a name like `type` is not an E'...' string prefix. After a
// number it is different: `1$a$` is a number then a dollar quote. So `$` and
// `E` only continue a name when the run of name characters before them began
// with a letter, `_` or a non-ASCII character, never a digit.
const NAME_STARTS = /[A-Za-z_\u0080-\uffff]/
const NAME_CONTINUES = /[A-Za-z0-9_$\u0080-\uffff]/

// `$$` or `$tag$`. A tag cannot start with a digit, so `$1` stays a parameter.
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y

function normalizeWhitespace (sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

// The index just past the quote that closes the run opened at `open`, or -1
// when it never closes. A doubled quote is an escaped quote. With `escapes`
// (an E'...' string) a backslash escapes the next character too.
function quoteEnd (sql, open, quote, escapes) {
  for (let j = open + 1; j < sql.length; j++) {
    if (escapes && sql[j] === '\\') { j++; continue }
    if (sql[j] !== quote) continue
    if (sql[j + 1] === quote) { j++; continue }
    return j + 1
  }
  return -1
}

// The index just past the `*/` that closes the comment opened at `open`, or -1.
// Postgres block comments nest, so `/* a /* b */ c */` is a single comment.
function blockCommentEnd (sql, open) {
  let depth = 0
  for (let j = open; j < sql.length - 1; j++) {
    if (sql[j] === '/' && sql[j + 1] === '*') {
      depth++
      j++
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      depth--
      j++
      if (depth === 0) return j + 1
    }
  }
  return -1
}

// Walk the SQL once, splitting statements on `;` and on drizzle's breakpoint
// only outside strings, quoted names, dollar-quoted bodies and comments.
// Returns { statements: [{ text, masked }], problem }, where `problem` is null
// or { reason, at } naming the first reason the split cannot be trusted and
// the index of the statement it was found in.
function lexSql (sql) {
  const statements = []
  let problem = null
  let text = ''
  let masked = ''
  // Where the run of name characters that ends just before the current
  // position began, or -1. Anything other than a plain character ends a run.
  let nameStart = -1

  const emit = (raw, mask = raw) => {
    text += raw
    masked += mask
    nameStart = -1
  }
  const flush = () => {
    const statement = normalizeWhitespace(text)
    if (statement !== '') statements.push({ text: statement, masked: normalizeWhitespace(masked) })
    text = ''
    masked = ''
    nameStart = -1
  }
  const flag = (reason) => {
    if (problem === null) problem = { reason, at: statements.length }
  }

  if (!sql) return { statements, problem }

  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    const afterName = nameStart !== -1 && NAME_STARTS.test(sql[nameStart])

    if (ch === ';') {
      flush()
      i++
      continue
    }

    if (ch === '-' && next === '-') {
      let end = i + 2
      while (end < sql.length && sql[end] !== '\n' && sql[end] !== '\r') end++
      if (DRIZZLE_BREAKPOINT.test(sql.slice(i, end))) flush()
      else emit(' ')
      i = end
      continue
    }

    if (ch === '/' && next === '*') {
      if (sql[i + 2] === '!') flag(SPLIT_MYSQL)
      const end = blockCommentEnd(sql, i)
      if (end === -1) {
        flag(SPLIT_UNTERMINATED)
        emit(sql.slice(i))
        break
      }
      emit(' ')
      i = end
      continue
    }

    if (ch === '\'' || ch === '"') {
      const end = quoteEnd(sql, i, ch, false)
      if (end === -1) {
        flag(SPLIT_UNTERMINATED)
        emit(sql.slice(i))
        break
      }
      // Any backslash right before a quote counts, not only before the closing
      // one: MySQL reads `'a\''` as a closed string, Postgres as an open one.
      if (sql.slice(i + 1, end).includes('\\' + ch)) flag(SPLIT_BACKSLASH)
      emit(sql.slice(i, end), ch + ch)
      i = end
      continue
    }

    if ((ch === 'E' || ch === 'e') && next === '\'' && !afterName) {
      const end = quoteEnd(sql, i + 1, '\'', true)
      if (end === -1) {
        flag(SPLIT_UNTERMINATED)
        emit(sql.slice(i))
        break
      }
      emit(sql.slice(i, end), ch + '\'\'')
      i = end
      continue
    }

    if (ch === '$' && !afterName) {
      DOLLAR_QUOTE.lastIndex = i
      const open = DOLLAR_QUOTE.exec(sql)
      if (open) {
        const tag = open[0]
        const close = sql.indexOf(tag, i + tag.length)
        if (close === -1) {
          flag(SPLIT_UNTERMINATED)
          emit(sql.slice(i))
          break
        }
        const end = close + tag.length
        emit(sql.slice(i, end), tag + tag)
        i = end
        continue
      }
    }

    if (ch === '`' || (ch === '#' && next !== '>' && next !== '-')) flag(SPLIT_MYSQL)

    const start = NAME_CONTINUES.test(ch) ? (nameStart === -1 ? i : nameStart) : -1
    emit(ch)
    nameStart = start
    i++
  }
  flush()
  return { statements, problem }
}

// Split a migration file body into individual normalised statements.
export function splitStatements (sql) {
  return lexSql(sql).statements.map((s) => s.text)
}

// --- Ordered rule table ------------------------------------------------------

// A rename is judged on the whole statement and wins over every other rule,
// including the per-action ALTER TABLE split below: the old name is gone and a
// rollback does not bring it back. Postgres does not combine RENAME with other
// ALTER TABLE actions, so there is nothing for a split to find.
const RENAMES = /^ALTER\b[\s\S]*\bRENAME\b/i

// A statement that is nothing but transaction control. Anchored at both ends,
// so a statement that only starts with BEGIN (a stray `BEGIN UPDATE ...` from
// a function body) is not mistaken for one.
const TRANSACTION_MODE = String.raw`(?:ISOLATION\s+LEVEL\s+(?:SERIALIZABLE|REPEATABLE\s+READ|READ\s+COMMITTED|READ\s+UNCOMMITTED)|READ\s+WRITE|READ\s+ONLY|(?:NOT\s+)?DEFERRABLE)`
const TRANSACTION_START = new RegExp(
  String.raw`^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)(?:\s+${TRANSACTION_MODE}(?:(?:\s*,\s*|\s+)${TRANSACTION_MODE})*)?$`,
  'i'
)
const TRANSACTION_END = /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?$/i

const UNRECOGNIZED = { phase: CONTRACT, reason: 'unrecognized statement — classified unsafe conservatively' }

// Each rule inspects the masked, normalised statement and returns
// { phase, reason } on a match, or null to fall through. FIRST match wins, so
// order matters: specific / destructive forms are checked before broader
// additive ones.
const RULES = [
  // Renames of ANY object are destructive. Checked first so it wins over other
  // ALTER rules.
  rule(RENAMES, CONTRACT, 'renames an object; a rollback would not restore the old name'),

  // ALTER TABLE ... ADD COLUMN — additive UNLESS it is NOT NULL without a
  // DEFAULT, which makes the column required from here on.
  addColumn,

  // ALTER TABLE ... destructive / tightening column & constraint changes.
  rule(/^ALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i, CONTRACT, 'drops a column; a rollback would not restore it'),
  rule(/^ALTER\s+TABLE\b[\s\S]*\bADD\s+CONSTRAINT\b/i, CONTRACT, 'adds a constraint; a rollback would still enforce it'),
  // Column-level ALTERs: NOT NULL (tighten) and DEFAULT (loosen) are checked
  // before the TYPE rule so a column literally named "type" can't be misread.
  rule(/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/i, CONTRACT, 'tightens a column to NOT NULL; a rollback would still enforce it'),
  rule(/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\b(SET|DROP)\s+DEFAULT\b/i, EXPAND, 'changes a column default (the column\'s shape is unchanged)'),
  rule(/^ALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\b(SET\s+DATA\s+TYPE|TYPE)\b/i, CONTRACT, 'changes a column type; a rollback would not restore the old type'),
  // ALTER TABLE ... DROP CONSTRAINT is a loosening — nothing new is rejected.
  rule(/^ALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i, EXPAND, 'drops a constraint (loosening; nothing new is rejected)'),

  // ALTER TYPE ... ADD VALUE grows an enum — additive (rename handled above).
  rule(/^ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i, EXPAND, 'adds a new enum value (additive)'),

  // A trigger is a rule the database applies to every write, written as code:
  // one that raises when a column is NULL is a NOT NULL constraint in another
  // form, and it keeps firing after a rollback. Checked before the OR REPLACE
  // rule so `CREATE OR REPLACE TRIGGER` gets this reason.
  rule(/^CREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i, CONTRACT, 'creates a trigger; it would still fire after a rollback'),
  // OR REPLACE swaps out a function, view or other definition that may already
  // exist, and a rollback does not put the old one back.
  rule(/^CREATE\s+OR\s+REPLACE\b/i, CONTRACT, 'replaces a definition (OR REPLACE); a rollback would not restore the old one'),

  // CREATE of any other supported object is additive.
  rule(/^CREATE\s+(UNIQUE\s+)?(MATERIALIZED\s+)?(TABLE|TYPE|INDEX|EXTENSION|SEQUENCE|VIEW|FUNCTION|POLICY|SCHEMA)\b/i, EXPAND, 'creates a new database object (additive)'),

  // DROP INDEX is safe (an index is a performance structure, not a correctness
  // one); dropping any OTHER object is destructive.
  rule(/^DROP\s+INDEX\b/i, EXPAND, 'drops an index (correctness does not depend on one)'),
  dropObject,

  // Metadata / privilege / additive-data statements are safe.
  rule(/^COMMENT\s+ON\b/i, EXPAND, 'sets a comment (metadata only)'),
  rule(/^(GRANT|REVOKE)\b/i, EXPAND, 'grant/revoke (privileges only; no schema shape change)'),
  rule(/^INSERT\s+INTO\b/i, EXPAND, 'inserts data (additive)'),

  // Session settings and transaction control change nothing in the schema.
  // Migrations open with `SET LOCAL lock_timeout` so they give up rather than
  // queue behind a lock and stall the running service, and raw SQL files wrap
  // their work in BEGIN / COMMIT. `ALTER TABLE ... SET ...` starts with ALTER,
  // so it never reaches the SET rule. ROLLBACK and SAVEPOINT are left to the
  // conservative default: they mean a migration undoes part of its own work,
  // which these rules cannot follow. So are SELECT and DO, on purpose: a SELECT
  // can call a function that changes anything, and a DO block runs code the
  // rules cannot read.
  rule(/^(SET|RESET)\b/i, EXPAND, 'changes a session setting (no schema change)'),
  rule(TRANSACTION_START, EXPAND, 'transaction control (no schema change)'),
  rule(TRANSACTION_END, EXPAND, 'transaction control (no schema change)'),

  // Data migrations & bulk deletes are conservatively unsafe.
  rule(/^TRUNCATE\b/i, CONTRACT, 'truncates a table; a rollback would not restore the rows'),
  rule(/^UPDATE\b/i, CONTRACT, 'runs a data migration (UPDATE) that cannot be assumed backward-compatible'),
  rule(/^DELETE\b/i, CONTRACT, 'runs a data migration (DELETE); a rollback would not restore the rows')
]

function rule (regex, phase, reason) {
  return (s) => (regex.test(s) ? { phase, reason } : null)
}

function addColumn (s) {
  if (!/^ALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b/i.test(s)) return null
  if (/\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s)) {
    return { phase: CONTRACT, reason: 'adds a required column; a rollback would still enforce it' }
  }
  return { phase: EXPAND, reason: 'adds a column (additive; nullable or defaulted)' }
}

function dropObject (s) {
  const m = /^DROP\s+(MATERIALIZED\s+VIEW|TABLE|TYPE|VIEW|FUNCTION|SEQUENCE|SCHEMA|POLICY|TRIGGER)\b/i.exec(s)
  if (!m) return null
  const obj = m[1].toLowerCase()
  return { phase: CONTRACT, reason: `drops a ${obj}; a rollback would not restore it` }
}

// The first rule that matches a masked statement, or the conservative default.
function matchRules (masked) {
  for (const test of RULES) {
    const hit = test(masked)
    if (hit) return hit
  }
  // Unrecognised → unsafe by default (conservative).
  return UNRECOGNIZED
}

// --- Multi-action ALTER TABLE --------------------------------------------------
//
// One ALTER TABLE can carry several comma-separated actions, and the rules
// above each read the whole statement, so whichever matched first spoke for
// every action: `ADD COLUMN a int, DROP COLUMN b` read as "adds a column" and
// came out safe. So each action is classified on its own, as
// `ALTER TABLE <name> <action>`, and an unsafe action makes the statement
// unsafe with that action's reason. A single action reads exactly as before.

// A table name in the masked form: a plain name or an emptied quoted one
// (`""`), optionally schema-qualified.
const SQL_NAME = String.raw`(?:""|[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)`
const SQL_QUALIFIED_NAME = String.raw`${SQL_NAME}(?:\s*\.\s*${SQL_NAME})*`
const ALTER_TABLE_HEAD = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s*\(\s*${SQL_QUALIFIED_NAME}\s*\)|(?:ONLY\s+)?${SQL_QUALIFIED_NAME}(?:\s*\*)?)`,
  'i'
)

// Split on commas that are not inside parentheses or brackets, so
// `numeric(10, 2)`, `CHECK (a IN ('x', 'y'))` and `ARRAY['a', 'b']` stay in one
// action. The masked form has no string contents left, so a comma or bracket
// inside a literal cannot get in the way.
function splitTopLevel (s) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '(' || ch === '[') {
      depth++
    } else if ((ch === ')' || ch === ']') && depth > 0) {
      depth--
    } else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(s.slice(start).trim())
  return parts
}

// The verdict for an ALTER TABLE with more than one action, or null when it
// has only one and the whole-statement rules apply as they always have.
function classifyAlterTableActions (masked) {
  const head = ALTER_TABLE_HEAD.exec(masked)
  const actions = splitTopLevel(head ? masked.slice(head[0].length) : masked)
  if (actions.length < 2) return null
  // Several actions but no table name we can read: falling back to the
  // whole-statement rules would let the first action speak for the rest.
  if (!head) return UNRECOGNIZED
  const verdicts = actions.map((action) => matchRules(`${head[0]} ${action}`))
  return verdicts.find((v) => v.phase === CONTRACT) ?? verdicts[0]
}

// Classify a masked statement: per action for a multi-action ALTER TABLE,
// otherwise against the rule table.
function classifyMasked (masked) {
  if (/^ALTER\s+TABLE\b/i.test(masked) && !RENAMES.test(masked)) {
    const verdict = classifyAlterTableActions(masked)
    if (verdict) return verdict
  }
  return matchRules(masked)
}

// Classify every statement in a migration file body. When the split itself
// cannot be trusted, the file gets that one reason and nothing else: a
// statement read from a mis-split file may be a piece of a string, and its
// reason would describe something the migration never did.
export function classifySqlStatements (sql) {
  const { statements, problem } = lexSql(sql)
  if (problem) {
    return [{ statement: statements[problem.at]?.text ?? '', phase: CONTRACT, reason: problem.reason }]
  }
  return statements.map(({ text, masked }) => {
    const { phase, reason } = classifyMasked(masked)
    return { statement: text, phase, reason }
  })
}

// --- Rails / ActiveRecord migration classification ---------------------------
//
// Node has no Ruby parser, so this is a deliberately line-oriented heuristic:
// strip comments, swallow heredoc bodies, join continuation lines into logical
// statements, take the LEADING method call of each and look it up in an
// EXPAND/CONTRACT table that mirrors the SQL rule table above. The conservative
// default is the same — a call the table does not positively recognise as
// additive is CONTRACT.
//
// The axis is ROLLBACK safety, not lock safety, so this is NOT a port of
// strong_migrations' rules; the two tools are complementary. In particular
// `safety_assured { ... }` — strong_migrations' escape hatch for a *different*
// question — does not silence anything here: the wrapper is transparent and its
// contents are classified like any other call.

// Additive calls: the new schema is a superset of the old one, so a rollback
// leaves nothing missing. Wording mirrors the SQL table.
const RUBY_EXPAND = {
  create_table: 'creates a new table (additive)',
  create_join_table: 'creates a new join table (additive)',
  add_column: 'adds a column (additive; nullable or defaulted)',
  add_index: 'adds an index (additive)',
  add_reference: 'adds a reference column (additive; nullable or defaulted)',
  add_belongs_to: 'adds a reference column (additive; nullable or defaulted)',
  add_timestamps: 'adds timestamp columns (additive; nullable or defaulted)',
  enable_extension: 'enables an extension (additive)',
  // Removing an index takes nothing away that correctness depends on: the same
  // queries still return the same rows, only slower. Mirrors the SQL table's
  // `DROP INDEX` → EXPAND.
  remove_index: 'removes an index (correctness does not depend on one)',
  // Dropping a constraint only widens what the database accepts. These two are
  // the Rails spelling of the SQL table's `ALTER TABLE ... DROP CONSTRAINT`,
  // which is already EXPAND.
  remove_foreign_key: 'removes a foreign key (loosening; nothing new is rejected)',
  remove_check_constraint: 'removes a check constraint (loosening; nothing new is rejected)'
}

// The three shapes a model data migration takes. Named once so the many method
// names that share one cannot drift apart, and so which methods share a shape
// is visible at a glance.
const WRITES_ROWS = 'writes rows in a data migration; a rollback would not restore them'
const ADDS_ROWS = 'adds rows in a data migration; a rollback would leave them in place'
const DELETES_ROWS = 'deletes rows in a data migration; a rollback would not restore them'

// Destructive / tightening calls: the rollback leaves the schema where the
// migration put it, so what was removed stays removed and what was tightened
// stays tightened.
const RUBY_CONTRACT = {
  remove_column: 'drops a column; a rollback would not restore it',
  remove_columns: 'drops columns; a rollback would not restore them',
  remove_reference: 'drops a reference column; a rollback would not restore it',
  remove_belongs_to: 'drops a reference column; a rollback would not restore it',
  drop_table: 'drops a table; a rollback would not restore it',
  drop_join_table: 'drops a join table; a rollback would not restore it',
  rename_column: 'renames a column; a rollback would not restore the old name',
  rename_table: 'renames a table; a rollback would not restore the old name',
  change_column: 'changes a column type; a rollback would not restore the old type',
  // Always unsafe, in both directions: the new nullability outlives the
  // rollback, and the SQL table already treats a loosening `DROP NOT NULL` as
  // unsafe (it falls through to the conservative default). Same answer here.
  change_column_null: 'changes a column NOT NULL constraint; a rollback would still enforce it',
  // Leaning unsafe: the new default is what the database supplies from here on,
  // rollback or not.
  change_column_default: 'changes a column default; a rollback would still apply the new default',
  add_check_constraint: 'adds a constraint; a rollback would still enforce it',
  add_foreign_key: 'adds a constraint; a rollback would still enforce it',
  // A `reversible do |dir|` block hides which half runs on the way up; the
  // contents cannot be attributed to a direction by line scanning.
  reversible: 'wraps changes in a direction-aware block whose contents cannot be classified',
  // Data migrations through a model. The rows are the change, and a rollback
  // reverts code, not rows — so these are unsafe wherever they appear, most of
  // all inside a loop, where the receiver is a block variable (see
  // classifyRubyStatement). The SQL table treats ANY `UPDATE` / `DELETE` /
  // `TRUNCATE` as CONTRACT, so the singular mutators have to be here next to
  // the collection-level ones: `destroy_all` unsafe and `destroy` safe would
  // be the same two-halves disagreement the constraint rows above fix, in the
  // spelling — iterate, then mutate one record — that is by far the commonest.
  save: WRITES_ROWS,
  'save!': WRITES_ROWS,
  update: WRITES_ROWS,
  'update!': WRITES_ROWS,
  update_all: WRITES_ROWS,
  update_column: WRITES_ROWS,
  update_columns: WRITES_ROWS,
  update_counters: WRITES_ROWS,
  update_attribute: WRITES_ROWS,
  // Long gone from Rails, but still live in apps old enough to predate its
  // removal, and free to catch.
  update_attributes: WRITES_ROWS,
  touch: WRITES_ROWS,
  // Only the bang forms: `increment` / `decrement` change the in-memory
  // attribute and never reach the database, so they are not writes.
  'increment!': WRITES_ROWS,
  'decrement!': WRITES_ROWS,
  'toggle!': WRITES_ROWS,
  // An upsert can overwrite values that were already there, and a rollback
  // does not bring those back — so it keeps the removal wording that a plain
  // insert does not deserve.
  upsert: WRITES_ROWS,
  upsert_all: WRITES_ROWS,
  // An insert only adds. Still CONTRACT — the new rows outlive the image swap
  // and the old code has to cope with them — but a rollback has nothing to
  // restore, so the removal wording would simply be false.
  insert: ADDS_ROWS,
  'insert!': ADDS_ROWS,
  insert_all: ADDS_ROWS,
  'insert_all!': ADDS_ROWS,
  delete: DELETES_ROWS,
  delete_all: DELETES_ROWS,
  destroy: DELETES_ROWS,
  'destroy!': DELETES_ROWS,
  destroy_all: DELETES_ROWS
}

// `null: false` with no `default:` makes the column required from here on — the
// same rule as SQL's ADD COLUMN NOT NULL.
const RUBY_NULL_CAVEAT = new Set(['add_column', 'add_reference', 'add_belongs_to'])

// Statements that never touch schema — skipped whole, including their arguments.
const RUBY_IGNORED = new Set([
  'def', 'class', 'module', 'require', 'require_relative',
  'private', 'public', 'protected', 'include', 'extend',
  'attr_accessor', 'attr_reader', 'attr_writer',
  // A migration-runner flag, not a schema change.
  'disable_ddl_transaction!',
  // Narration / logging.
  'puts', 'print', 'p', 'say', 'say_with_time', 'announce', 'write',
  'info', 'debug', 'warn', 'error', 'raise', 'return'
])

// Tokens that merely wrap or introduce the real call: strip them and keep
// looking at the rest of the statement so `safety_assured { remove_column ... }`
// is still classified on its contents.
const RUBY_TRANSPARENT = new Set([
  'safety_assured', 'suppress_messages',
  'do', 'then', 'else', 'elsif', 'begin', 'ensure', 'rescue', 'end',
  'if', 'unless', 'while', 'until', 'case', 'when', 'in',
  'and', 'or', 'not', 'yield', 'true', 'false', 'nil', 'self'
])

// Iteration helpers: the loop header itself touches no schema, and the body is
// classified on its own lines. Keyed on the METHOD segment of the call, so
// `TABLES.each do |t|` is covered as well as a bare `each`. The EXPAND /
// CONTRACT tables are consulted BEFORE this set, so a name that somehow lands
// in both is classified rather than skipped.
const RUBY_ITERATION = new Set([
  'each', 'each_with_index', 'each_with_object', 'each_pair', 'each_key',
  'each_value', 'reverse_each', 'map', 'flat_map', 'times'
])

// An assignment PREFIX is transparent, not a skip: `TABLES = %i[a b c]` is a
// constant, not a call to `TABLES`, but `x = remove_column :a, :b` still drops
// a column. Strip `IDENT =` / `IDENT ||=` / `IDENT +=` and keep looking at what
// is being assigned. `==`, `=~` and `=>` are comparisons / hash syntax.
const RUBY_ASSIGN = /^\s*(?:\*\*|\|\||&&|<<|>>|[+\-*/%|&^])?=(?![=~>])/

// A leading method call with an optional receiver chain: `add_column`,
// `connection.execute`, `t.string`, `ActiveRecord::Base.connection.execute`.
const RUBY_LEADING_CALL = /^([A-Za-z_][A-Za-z0-9_:]*[!?]?(?:\.[A-Za-z_][A-Za-z0-9_]*[!?]?)*)/

// `<<~SQL`, `<<-SQL`, `<<SQL`, `<<~'SQL'` — the body is never Ruby, and it is
// never classifiable SQL either (see classifyRubyStatement).
const RUBY_HEREDOC = /<<[-~]?(['"]?)([A-Z_]+)\1/g

// A line whose code ends in one of these is mid-expression; the next line is a
// continuation of the SAME logical statement (Rails/rubocop wraps long
// `add_column ... , null: false` calls exactly this way).
const RUBY_CONTINUES = /(,|\\|\(|\[|\+|=|&&|\|\||\.|::)$/

// Walk `text`, calling `at(ch, i)` for every character that is NOT inside a
// string literal. `at` returns true to stop the walk.
function outsideStrings (text, at) {
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === '\'') { quote = ch; continue }
    if (at(ch, i)) return
  }
}

// Strip a `#` line comment, honouring quotes so `execute "... #{x} ..."` keeps
// its interpolation marker (which is what makes it unclassifiable).
function stripRubyComment (line) {
  let cut = -1
  outsideStrings(line, (ch, i) => {
    // `#{` outside a string is not a comment in valid Ruby; leave it alone.
    if (ch !== '#' || line[i + 1] === '{') return false
    cut = i
    return true
  })
  return cut === -1 ? line : line.slice(0, cut)
}

// Split on `;` outside string literals, so `execute "a; b"` stays intact.
function splitOnSemicolons (text) {
  const cuts = []
  outsideStrings(text, (ch, i) => {
    if (ch === ';') cuts.push(i)
    return false
  })
  const parts = []
  let start = 0
  for (const cut of cuts) {
    parts.push(text.slice(start, cut))
    start = cut + 1
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function indentWidth (line) {
  return /^[ \t]*/.exec(line)[0].length
}

// Comment-stripped code lines, with heredoc BODIES removed and the flag hoisted
// onto the line that opened them.
function rubyCodeLines (source) {
  const raw = source.split(/\r?\n/)
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const code = stripRubyComment(raw[i])
    const tags = Array.from(code.matchAll(RUBY_HEREDOC), (m) => m[2])
    out.push({ code, indent: indentWidth(code), heredoc: tags.length > 0 })
    // Consume every open heredoc body so its contents are never read as Ruby.
    while (tags.length > 0 && i + 1 < raw.length) {
      i++
      const at = tags.indexOf(raw[i].trim())
      if (at !== -1) tags.splice(at, 1)
    }
  }
  return out
}

// Locate each `def NAME ... end` span by indentation: the terminator is the
// first following line at the same indent whose whole body is `end`. Returns
// null when ANY def cannot be resolved — the caller then classifies the entire
// file, which is the conservative fallback.
function rubyDefSpans (lines) {
  const spans = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*def\s+(?:self\.)?([a-z_][A-Za-z0-9_]*[!?]?)/.exec(lines[i].code)
    if (!m) continue
    // `def change; ...; end` — the whole span is this one line.
    if (splitOnSemicolons(lines[i].code).includes('end')) {
      spans.push({ name: m[1], start: i, end: i })
      continue
    }
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].indent === lines[i].indent && lines[j].code.trim() === 'end') { end = j; break }
    }
    if (end === -1) return null
    spans.push({ name: m[1], start: i, end })
  }
  return spans
}

// Join continuation lines into logical statements, dropping `def down` bodies:
// a rollback never reverts migrations, so only the forward direction (`change` /
// `up`, plus anything outside a def) can affect the new schema.
function rubyStatements (source) {
  const lines = rubyCodeLines(source)
  const spans = rubyDefSpans(lines)
  const isDown = (i) =>
    spans !== null && spans.some((s) => s.name === 'down' && i >= s.start && i <= s.end)

  const joined = []
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].code.trim()
    if (text === '') { current = null; continue }
    if (current) {
      current.text += ' ' + text
      current.heredoc = current.heredoc || lines[i].heredoc
    } else {
      current = { text, heredoc: lines[i].heredoc, down: isDown(i) }
      joined.push(current)
    }
    const next = lines[i + 1]
    const chained = next !== undefined && next.code.trim().startsWith('.')
    if (!RUBY_CONTINUES.test(text) && !chained) current = null
  }

  return joined
    .filter((s) => !s.down)
    // `a; b` on one line is two statements — rare, but a `def change; ...; end`
    // one-liner must not be able to hide its body behind the `def`.
    .flatMap((s) => splitOnSemicolons(s.text).map((text) => ({ text, heredoc: s.heredoc })))
}

// A receiver like `t` / `tbl` / `dir` is a block variable: the call belongs to
// the enclosing create_table / change_table / reversible call, which is what
// carries the verdict. `connection` is NOT such a receiver. The test is only
// lexical, so a model in a loop (`m.save`) is indistinguishable from a table
// definition (`t.string`) — the caller compensates by checking the unsafe
// table first.
function isBlockReceiver (receiver) {
  if (receiver === '') return false
  if (receiver === 'connection' || /(^|\.)connection$/.test(receiver)) return false
  return /^[a-z_][A-Za-z0-9_]*$/.test(receiver)
}

// Find the leading call of a logical statement, stepping over wrappers.
function scanRubyCall (statement) {
  let rest = statement
  for (let guard = 0; guard < 64; guard++) {
    rest = rest.replace(/^[\s{}();,]+/, '')
    // A block parameter list (`|t|`, `|dir|`) is not a call.
    rest = rest.replace(/^\|[^|]*\|\s*/, '')
    // Once a transparent iteration header has been stepped over, a
    // symbol-to-proc argument IS the call: `each(&:destroy)` deletes rows just
    // as `each { |m| m.destroy }` does. Resolve `&:name` to `name` and look it
    // up like any other leading call. A `&` residue that is NOT a symbol
    // (`&block`, `&method(:x)`) keeps its token, so it reaches the
    // conservative default instead of vanishing.
    rest = rest.replace(/^&\s*:?/, '')
    if (rest === '') return null
    const m = RUBY_LEADING_CALL.exec(rest)
    if (!m) return null
    const chain = m[1]
    const after = rest.slice(chain.length)
    // `null: false` — a hash key, not a call. The chain pattern has to allow
    // `Foo::Bar`, so it absorbs a label's trailing colon; check both spellings
    // or a bare hash (`OPTS = { null: false }`) reads as a call to `null:`.
    if (/^:(?!:)/.test(after) || /[^:]:$/.test(chain)) return null
    const parts = chain.split('.')
    const method = parts[parts.length - 1]
    const receiver = parts.slice(0, -1).join('.')
    // `TABLES = %i[a b c]` / `x ||= 1`: step over the assignment and classify
    // the right-hand side. A literal has no leading call, so the statement then
    // contributes nothing; a call is classified exactly as it would be alone.
    const assign = receiver === '' ? RUBY_ASSIGN.exec(after) : null
    if (assign) { rest = after.slice(assign[0].length); continue }
    if (RUBY_IGNORED.has(method)) return null
    if (receiver === '' && RUBY_TRANSPARENT.has(method)) { rest = after; continue }
    // Table lookups first: an iteration name is only stepped over when neither
    // table claims it.
    if (RUBY_ITERATION.has(method) && !RUBY_EXPAND[method] && !RUBY_CONTRACT[method]) {
      rest = after
      continue
    }
    return { chain, method, receiver, after }
  }
  return null
}

// A string literal at the start of `execute`'s arguments. The two branches of
// the body must not overlap: if a backslash could be read either as an escape
// or as a plain character, a run of backslashes with no closing quote makes the
// regex try every way of pairing them up, which takes exponential time. The
// optional `(` carries its own whitespace for the same reason, on a smaller
// scale: two `\s*` in a row would split a run of spaces every possible way.
const RUBY_STRING_ARG = /^\s*(?:\(\s*)?(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1/

// The escapes a double-quoted Ruby literal can carry into SQL that this file
// reproduces. The others (`\0`, octal, `\x`, `\u`, `\e`, `\a`, `\b`, `\f`, `\v`,
// `\M-`, `\C-`, a backslash before a line break or any other character) are
// rare in SQL and not worth getting exactly right, so a literal that uses one
// is not classified at all.
const RUBY_DOUBLE_QUOTED_ESCAPES = new Map([
  ['\\', '\\'], ['"', '"'], ['\'', '\''], ['n', '\n'], ['t', '\t'], ['r', '\r'], ['s', ' ']
])

// The string Ruby hands to the database for a literal's body, or null when it
// uses an escape we do not reproduce. This has to be Ruby's reading, not the
// source text: `\n` in the source is a line break to Postgres, which ends a
// `--` comment, and `\\\\` is two backslashes, which can close an E'...'
// string. Read any other way, a comment or a string can hide a statement.
function rubyStringValue (quote, body) {
  // In a single-quoted literal only `\\` and `\'` are escapes; any other
  // backslash is a plain character.
  if (quote === '\'') return body.replace(/\\([\\'])/g, '$1')
  let value = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      value += body[i]
      continue
    }
    const escaped = RUBY_DOUBLE_QUOTED_ESCAPES.get(body[i + 1])
    if (escaped === undefined) return null
    value += escaped
    i++
  }
  return value
}

// `execute` / `connection.execute`: pull the raw SQL out of a SIMPLE string
// literal and hand it to the SQL rule table. Anything less tractable —
// interpolation, concatenation, a variable, a heredoc — is unknown → unsafe.
function classifyRubyExecute (args) {
  const m = RUBY_STRING_ARG.exec(args)
  if (!m) return { phase: CONTRACT, reason: '`execute` runs raw SQL that cannot be classified' }
  const literal = m[2]
  if (literal.includes('#{')) {
    return { phase: CONTRACT, reason: '`execute` interpolates values into raw SQL that cannot be classified' }
  }
  // Anything after the literal (`+ x`, `% [..]`, `.squish`, a trailing `if`)
  // means the SQL we hold is not the SQL that runs.
  if (!/^[)\s]*$/.test(args.slice(m[0].length))) {
    return { phase: CONTRACT, reason: '`execute` builds raw SQL that cannot be classified' }
  }
  const sql = rubyStringValue(m[1], literal)
  if (sql === null) {
    return { phase: CONTRACT, reason: '`execute` raw SQL uses a string escape that cannot be classified' }
  }
  const classified = classifySqlStatements(sql)
  if (classified.length === 0) {
    return { phase: CONTRACT, reason: '`execute` runs raw SQL that cannot be classified' }
  }
  const bad = classified.find((s) => s.phase === CONTRACT)
  if (bad) return { phase: CONTRACT, reason: `\`execute\` raw SQL — ${bad.reason}` }
  return { phase: EXPAND, reason: `\`execute\` raw SQL — ${classified[0].reason}` }
}

function classifyRubyStatement (statement) {
  const call = scanRubyCall(statement.text)

  // Heredoc content is opaque: it is not Ruby, and it is not a string literal we
  // can hand to the SQL rules either.
  if (statement.heredoc) {
    return call === null
      ? { phase: CONTRACT, reason: 'heredoc content that cannot be classified' }
      : { phase: CONTRACT, reason: `\`${call.method}\` uses heredoc SQL that cannot be classified` }
  }

  if (call === null) return null
  const method = call.method
  if (method === 'execute') return classifyRubyExecute(call.after)

  // A destructive call is destructive whatever it is called on, and
  // isBlockReceiver is purely lexical — every lowercase receiver looks like a
  // create_table block variable. So consult the unsafe table BEFORE discarding
  // the statement, or `models.each { |m| m.save }` is invisible: the loop
  // header touches no schema and the body would be attributed to a block that
  // never existed.
  if (isBlockReceiver(call.receiver)) {
    if (RUBY_CONTRACT[method]) return { phase: CONTRACT, reason: `\`${method}\` ${RUBY_CONTRACT[method]}` }
    return null
  }

  // add_timestamps adds NOT NULL created_at/updated_at, so without defaults (or
  // an explicit `null: true`) the columns are required from here on.
  if (method === 'add_timestamps') {
    if (!hasDefaultOption(statement.text) && !/\bnull:\s*true\b|:null\s*=>\s*true\b/.test(statement.text)) {
      return { phase: CONTRACT, reason: '`add_timestamps` adds required timestamp columns; a rollback would still enforce them' }
    }
  }

  if (RUBY_NULL_CAVEAT.has(method) && isNotNullWithoutDefault(statement.text)) {
    return { phase: CONTRACT, reason: `\`${method}\` adds a required column; a rollback would still enforce it` }
  }

  if (RUBY_EXPAND[method]) return { phase: EXPAND, reason: `\`${method}\` ${RUBY_EXPAND[method]}` }
  if (RUBY_CONTRACT[method]) return { phase: CONTRACT, reason: `\`${method}\` ${RUBY_CONTRACT[method]}` }
  return { phase: CONTRACT, reason: `unrecognized migration call \`${method}\` — classified unsafe conservatively` }
}

function hasDefaultOption (text) {
  return /\bdefault:\s*|:default\s*=>/.test(text)
}

function isNotNullWithoutDefault (text) {
  return /\bnull:\s*false\b|:null\s*=>\s*false\b/.test(text) && !hasDefaultOption(text)
}

// Classify every schema-touching call in a Rails migration file body.
export function classifyRubyMigration (source) {
  if (!source) return []
  const results = []
  for (const statement of rubyStatements(source)) {
    const hit = classifyRubyStatement(statement)
    if (hit) results.push({ statement: statement.text, phase: hit.phase, reason: hit.reason })
  }
  return results
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

// Rails / ActiveRecord migrations (db/migrate/*.rb).
function isRuby (path) {
  return /\.rb$/i.test(path)
}

// Classify a set of changed migration files into a single advisory verdict.
// files: [{ path, status, content }] where status is a GitHub compare status
// (added | modified | removed | renamed | ...). Returns { verdict, reasons }.
export function classifyMigrationFiles (files) {
  const reasons = []
  let classifiedFiles = 0

  for (const file of files ?? []) {
    const path = file.path
    // drizzle bookkeeping under meta/ is ignored entirely.
    if (isMetaPath(path)) continue
    const sql = isSql(path)
    const ruby = isRuby(path)
    // Dotfiles in no classifiable format (.gitkeep, .DS_Store, ...) are ignored.
    if (isDotfile(path) && !sql && !ruby) continue

    const status = (file.status ?? '').toLowerCase()

    if (!sql && !ruby) {
      // A migration artifact in a format we cannot classify (plain .sql and Rails
      // .rb migrations today; other frameworks land later).
      if (status === 'added') {
        reasons.push(`${path}: unsupported migration format (only .sql and Rails .rb are classified)`)
      }
      continue
    }

    if (status !== 'added') {
      // A migration file that already existed being edited/removed/renamed
      // rewrites applied history — always unsafe.
      reasons.push(`${path}: migration history modified (${status || 'changed'})`)
      continue
    }

    // A freshly added migration — classify it; every CONTRACT statement / call
    // contributes a path-prefixed reason.
    classifiedFiles++
    const statements = sql
      ? classifySqlStatements(file.content ?? '')
      : classifyRubyMigration(file.content ?? '')
    for (const st of statements) {
      if (st.phase === CONTRACT) reasons.push(`${path}: ${st.reason}`)
    }
  }

  if (reasons.length > 0) return { verdict: 'unsafe', reasons }
  // A safe verdict must say WHY: the notifier renders reasons[0], and "ran
  // only additive migrations" vs "ran no migrations at all" are different
  // operator situations when deciding whether a rollback is clean.
  if (classifiedFiles === 0) return { verdict: 'safe', reasons: ['no migration changes in this release'] }
  return { verdict: 'safe', reasons: [`${classifiedFiles} additive migration${classifiedFiles === 1 ? '' : 's'}`] }
}
