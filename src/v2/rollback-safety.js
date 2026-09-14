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
  // Renames of ANY object are destructive — the old name is gone and a rollback
  // does not bring it back. Checked first so it wins over other ALTER rules.
  rule(/^ALTER\b[\s\S]*\bRENAME\b/i, CONTRACT, 'renames an object; a rollback would not restore the old name'),

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

  // CREATE of any supported object is additive.
  rule(/^CREATE\s+(OR\s+REPLACE\s+)?(UNIQUE\s+)?(MATERIALIZED\s+)?(TABLE|TYPE|INDEX|EXTENSION|SEQUENCE|VIEW|FUNCTION|TRIGGER|POLICY|SCHEMA)\b/i, EXPAND, 'creates a new database object (additive)'),

  // DROP INDEX is safe (an index is a performance structure, not a correctness
  // one); dropping any OTHER object is destructive.
  rule(/^DROP\s+INDEX\b/i, EXPAND, 'drops an index (correctness does not depend on one)'),
  dropObject,

  // Metadata / privilege / additive-data statements are safe.
  rule(/^COMMENT\s+ON\b/i, EXPAND, 'sets a comment (metadata only)'),
  rule(/^(GRANT|REVOKE)\b/i, EXPAND, 'grant/revoke (privileges only; no schema shape change)'),
  rule(/^INSERT\s+INTO\b/i, EXPAND, 'inserts data (additive)'),

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

// `execute` / `connection.execute`: pull the raw SQL out of a SIMPLE string
// literal and hand it to the SQL rule table. Anything less tractable —
// interpolation, concatenation, a variable, a heredoc — is unknown → unsafe.
function classifyRubyExecute (args) {
  const m = /^\s*\(?\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1/.exec(args)
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
  const sql = literal.replace(/\\(['"])/g, '$1')
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
