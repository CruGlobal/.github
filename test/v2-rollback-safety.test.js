import { describe, it, expect } from 'vitest'
import {
  splitStatements,
  classifySqlStatements,
  classifyRubyMigration,
  classifyMigrationFiles
} from '../src/v2/rollback-safety.js'

// Convenience: classify a single statement and return the first result.
const one = (sql) => classifySqlStatements(sql)[0]

describe('splitStatements', () => {
  it('splits on drizzle --> statement-breakpoint markers', () => {
    const sql = 'CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE TABLE b (id int);'
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE a (id int)',
      'CREATE TABLE b (id int)'
    ])
  })

  it('splits on terminating semicolons', () => {
    expect(splitStatements('CREATE TABLE a (id int); CREATE TABLE b (id int);')).toEqual([
      'CREATE TABLE a (id int)',
      'CREATE TABLE b (id int)'
    ])
  })

  it('does not let the -- comment strip eat the breakpoint marker', () => {
    // The marker is itself a `--` comment; it must end a statement, not vanish
    // with the other comments.
    const sql = 'CREATE TABLE a (id int);\n--> statement-breakpoint\nDROP TABLE b;'
    const parts = splitStatements(sql)
    expect(parts).toHaveLength(2)
    expect(parts[1]).toBe('DROP TABLE b')
  })

  it('strips -- line comments', () => {
    const sql = 'CREATE TABLE a (id int); -- add the a table\nCREATE TABLE b (id int);'
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE a (id int)',
      'CREATE TABLE b (id int)'
    ])
  })

  it('strips /* block */ comments across newlines', () => {
    const sql = '/* a\n   multi-line\n   note */ CREATE TABLE a (id int);'
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id int)'])
  })

  it('normalises whitespace and skips empty statements', () => {
    const sql = '\n\n  CREATE   TABLE\n a (id int) ;\n\n  ;\n'
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id int)'])
  })

  it('returns [] for empty / null input', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements(null)).toEqual([])
    expect(splitStatements(undefined)).toEqual([])
  })

  it('a drizzle breakpoint ends a statement that has no semicolon', () => {
    const sql = 'CREATE TABLE a (id int)\n--> statement-breakpoint\nCREATE TABLE b (id int)'
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE a (id int)',
      'CREATE TABLE b (id int)'
    ])
  })
})

// The splitter is a Postgres lexer, not a split on `;`: a `;`, `--` or `/*`
// inside a string, a quoted name or a dollar-quoted body is just text.
describe('splitStatements with quotes, dollar quotes and comments', () => {
  it.each([
    ['a single-quoted string', 'INSERT INTO notes (body) VALUES (\'a; b -- c /* d */\')'],
    ['a string with a doubled quote', 'COMMENT ON TABLE notes IS \'it\'\'s; -- fine\''],
    ['an E\'...\' string with a backslash-escaped quote', 'INSERT INTO notes (body) VALUES (E\'it\\\'s; -- still /* the string */\')'],
    ['a double-quoted name', 'CREATE TABLE "odd; -- name /* here */" (id int)'],
    ['a $$ body', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; -- one /* two */ $$ LANGUAGE sql'],
    ['a $fn$ body holding a $$ quote', 'CREATE FUNCTION g() RETURNS text AS $fn$ SELECT \'a;b\' || $$c; -- d$$; $fn$ LANGUAGE sql']
  ])('`;`, `--` and `/*` inside %s neither split nor strip', (_label, sql) => {
    expect(splitStatements(`${sql};\nCREATE TABLE b (id int);`)).toEqual([sql, 'CREATE TABLE b (id int)'])
  })

  it('a plpgsql function body is one statement', () => {
    const sql = [
      'CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$',
      'BEGIN',
      '  NEW.updated_at := now();',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;'
    ].join('\n')
    const results = classifySqlStatements(sql)
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('a DO block is one statement and stays unsafe', () => {
    const results = classifySqlStatements('DO $$\nBEGIN\n  DELETE FROM notes;\nEND\n$$;')
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
    expect(results[0].reason).toBe('unrecognized statement — classified unsafe conservatively')
  })

  // A naive `$...$` match would read `$1 + $` as a dollar-quote tag and swallow
  // everything after it.
  it('$1 is a parameter, not a dollar quote', () => {
    const sql = 'CREATE FUNCTION add_up(int, int) RETURNS int LANGUAGE sql RETURN $1 + $2;\nDROP TABLE notes;'
    expect(classifySqlStatements(sql).map((r) => r.phase)).toEqual(['expand', 'contract'])
  })

  it('block comments nest', () => {
    const sql = '/* outer /* inner */ still a comment; DROP TABLE notes; */ CREATE TABLE a (id int);'
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id int)'])
  })

  it('a comment between statements belongs to neither', () => {
    const sql = 'CREATE TABLE a (id int);\n/* between */\n-- and a line\nCREATE TABLE b (id int);'
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id int)', 'CREATE TABLE b (id int)'])
  })

  it('a breakpoint marker inside a string is not a boundary', () => {
    const sql = 'COMMENT ON TABLE a IS \'--> statement-breakpoint\';'
    expect(splitStatements(sql)).toEqual(['COMMENT ON TABLE a IS \'--> statement-breakpoint\''])
  })
})

describe('classifySqlStatements — EXPAND (safe) rules', () => {
  it.each([
    'CREATE TABLE users (id serial primary key)',
    'CREATE TYPE mood AS ENUM (\'happy\')',
    'CREATE INDEX idx_users_email ON users (email)',
    'CREATE UNIQUE INDEX uq_users_email ON users (email)',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON users (email)',
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
    'CREATE SEQUENCE users_seq',
    'CREATE VIEW active_users AS SELECT * FROM users',
    'CREATE MATERIALIZED VIEW mv AS SELECT * FROM users',
    'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
    'CREATE POLICY p ON users USING (true)',
    'CREATE SCHEMA billing'
  ])('CREATE ... is expand: %s', (sql) => {
    expect(one(sql).phase).toBe('expand')
  })

  it('ADD COLUMN nullable is expand', () => {
    expect(one('ALTER TABLE users ADD COLUMN nickname text').phase).toBe('expand')
  })

  it('ADD COLUMN NOT NULL WITH a DEFAULT is expand', () => {
    const r = one('ALTER TABLE users ADD COLUMN age integer NOT NULL DEFAULT 0')
    expect(r.phase).toBe('expand')
  })

  it.each([
    ['ALTER TYPE ... ADD VALUE', 'ALTER TYPE mood ADD VALUE \'sad\''],
    ['DROP INDEX', 'DROP INDEX idx_users_email'],
    ['ALTER TABLE ... DROP CONSTRAINT', 'ALTER TABLE users DROP CONSTRAINT users_email_key'],
    ['ALTER COLUMN ... SET DEFAULT', 'ALTER TABLE users ALTER COLUMN status SET DEFAULT \'active\''],
    ['ALTER COLUMN ... DROP DEFAULT', 'ALTER TABLE users ALTER COLUMN status DROP DEFAULT'],
    ['COMMENT ON', 'COMMENT ON TABLE users IS \'people\''],
    ['GRANT', 'GRANT SELECT ON users TO readonly'],
    ['REVOKE', 'REVOKE SELECT ON users FROM readonly'],
    ['INSERT INTO', 'INSERT INTO settings (k, v) VALUES (\'a\', \'b\')']
  ])('%s is expand', (_label, sql) => {
    expect(one(sql).phase).toBe('expand')
  })
})

describe('classifySqlStatements — CONTRACT (unsafe) rules', () => {
  it('ADD COLUMN NOT NULL without a DEFAULT is contract', () => {
    const r = one('ALTER TABLE users ADD COLUMN email text NOT NULL')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('adds a required column; a rollback would still enforce it')
  })

  it('DROP COLUMN is contract', () => {
    const r = one('ALTER TABLE users DROP COLUMN email')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('drops a column; a rollback would not restore it')
  })

  it.each([
    'DROP TABLE users',
    'DROP TYPE mood',
    'DROP VIEW active_users',
    'DROP MATERIALIZED VIEW mv',
    'DROP FUNCTION f',
    'DROP SEQUENCE users_seq',
    'DROP SCHEMA billing',
    'DROP POLICY p ON users',
    'DROP TRIGGER t ON users'
  ])('DROP object is contract: %s', (sql) => {
    expect(one(sql).phase).toBe('contract')
  })

  it.each([
    ['RENAME table', 'ALTER TABLE users RENAME TO people'],
    ['RENAME column', 'ALTER TABLE users RENAME COLUMN email TO email_address'],
    ['RENAME type', 'ALTER TYPE mood RENAME TO feeling'],
    ['RENAME enum value', 'ALTER TYPE mood RENAME VALUE \'happy\' TO \'glad\'']
  ])('%s is contract', (_label, sql) => {
    const r = one(sql)
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/renames/)
  })

  it('ALTER COLUMN ... TYPE is contract', () => {
    expect(one('ALTER TABLE users ALTER COLUMN age TYPE bigint').phase).toBe('contract')
    expect(one('ALTER TABLE users ALTER COLUMN age SET DATA TYPE bigint').phase).toBe('contract')
  })

  it('ALTER COLUMN ... SET NOT NULL is contract', () => {
    const r = one('ALTER TABLE users ALTER COLUMN email SET NOT NULL')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/NOT NULL/)
  })

  it('ADD CONSTRAINT is contract (tightening)', () => {
    const r = one('ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email)')
    expect(r.phase).toBe('contract')
  })

  // A trigger can enforce a rule the old image breaks (one that raises on a
  // NULL is a NOT NULL constraint in another form), and it outlives a rollback.
  it.each([
    ['CREATE TRIGGER', 'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()'],
    ['CREATE CONSTRAINT TRIGGER', 'CREATE CONSTRAINT TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()'],
    ['CREATE OR REPLACE TRIGGER', 'CREATE OR REPLACE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()']
  ])('%s is contract', (_label, sql) => {
    expect(one(sql)).toEqual({ statement: sql, phase: 'contract', reason: 'creates a trigger; it would still fire after a rollback' })
  })

  // OR REPLACE swaps out a definition that may already exist; the old one is gone.
  it.each([
    ['FUNCTION', 'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql'],
    ['PROCEDURE', 'CREATE OR REPLACE PROCEDURE p() LANGUAGE sql AS $$ SELECT 1 $$'],
    ['VIEW', 'CREATE OR REPLACE VIEW active_users AS SELECT * FROM users'],
    ['RULE', 'CREATE OR REPLACE RULE r AS ON INSERT TO users DO INSTEAD NOTHING']
  ])('CREATE OR REPLACE %s is contract', (_label, sql) => {
    expect(one(sql)).toEqual({ statement: sql, phase: 'contract', reason: 'replaces a definition (OR REPLACE); a rollback would not restore the old one' })
  })

  it('a trigger whose function raises on a NULL is unsafe end to end', () => {
    const path = 'migrations/0005_require_note_owner.sql'
    const content = [
      'CREATE FUNCTION notes_require_owner() RETURNS trigger AS $$',
      'BEGIN',
      '  IF NEW.owner_id IS NULL THEN',
      '    RAISE EXCEPTION \'owner_id is required; set it before saving\';',
      '  END IF;',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '',
      'CREATE TRIGGER notes_require_owner BEFORE INSERT OR UPDATE ON notes',
      '  FOR EACH ROW EXECUTE FUNCTION notes_require_owner();',
      ''
    ].join('\n')
    expect(classifyMigrationFiles([{ path, status: 'added', content }])).toEqual({
      verdict: 'unsafe',
      reasons: [`${path}: creates a trigger; it would still fire after a rollback`]
    })
  })

  it.each([
    ['TRUNCATE', 'TRUNCATE users'],
    ['UPDATE', 'UPDATE users SET status = \'active\''],
    ['DELETE', 'DELETE FROM users WHERE status = \'inactive\'']
  ])('%s is contract', (_label, sql) => {
    expect(one(sql).phase).toBe('contract')
  })

  it('unrecognised statement is contract (conservative default)', () => {
    const r = one('VACUUM FULL users')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('unrecognized statement — classified unsafe conservatively')
  })
})

describe('classifySqlStatements — precedence & case-insensitivity', () => {
  it('classification is case-insensitive', () => {
    expect(one('create table users (id int)').phase).toBe('expand')
    expect(one('drop table users').phase).toBe('contract')
  })

  it('rename wins over other ALTER handling', () => {
    expect(one('ALTER TABLE users RENAME COLUMN a TO b').phase).toBe('contract')
  })

  it('SET DEFAULT (expand) is not misread as a TYPE change', () => {
    // A column literally named "type": SET DEFAULT must still be expand.
    expect(one('ALTER TABLE users ALTER COLUMN type SET DEFAULT 1').phase).toBe('expand')
  })

  it('classifies every statement in a multi-statement body', () => {
    const sql = 'CREATE TABLE a (id int);\n--> statement-breakpoint\nDROP TABLE b;'
    const results = classifySqlStatements(sql)
    expect(results.map((r) => r.phase)).toEqual(['expand', 'contract'])
  })
})

// The rules read a masked copy of each statement with every literal emptied, so
// words inside a string or a quoted name can neither trigger nor dodge a rule.
describe('classifySqlStatements reads the statement, not its literals', () => {
  it('a comment that mentions a destructive change is still a comment', () => {
    expect(one('COMMENT ON COLUMN notes.body IS \'DROP COLUMN body is planned, then TRUNCATE\'').phase).toBe('expand')
  })

  it('a string saying DEFAULT does not make a required column look defaulted', () => {
    const r = one('ALTER TABLE notes ADD COLUMN label text NOT NULL CHECK (label <> \'DEFAULT\')')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('adds a required column; a rollback would still enforce it')
  })

  it('neither does a quoted column named "default"', () => {
    const r = one('ALTER TABLE notes ADD COLUMN "default" int NOT NULL')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('adds a required column; a rollback would still enforce it')
  })

  it('a default value that reads like a second action is one action', () => {
    expect(one('ALTER TABLE notes ADD COLUMN body text DEFAULT \'x, DROP COLUMN y\'').phase).toBe('expand')
  })

  it('the reported statement keeps its literals', () => {
    expect(one('COMMENT ON TABLE notes IS \'a; b\'').statement).toBe('COMMENT ON TABLE notes IS \'a; b\'')
  })
})

describe('classifySqlStatements on session settings and transaction control', () => {
  it.each([
    'SET LOCAL lock_timeout = \'5s\'',
    'SET statement_timeout = 0',
    'SET search_path TO app, public',
    'SET SESSION lock_timeout TO \'1s\'',
    'RESET lock_timeout',
    'RESET ALL',
    'set local lock_timeout = \'5s\''
  ])('%s is expand', (sql) => {
    expect(one(sql)).toEqual({ statement: sql, phase: 'expand', reason: 'changes a session setting (no schema change)' })
  })

  it('ALTER TABLE ... SET is not a session setting', () => {
    expect(one('ALTER TABLE notes ALTER COLUMN body SET NOT NULL').reason)
      .toBe('tightens a column to NOT NULL; a rollback would still enforce it')
    expect(one('ALTER TABLE notes SET SCHEMA archive').reason)
      .toBe('unrecognized statement — classified unsafe conservatively')
  })

  it.each([
    'BEGIN',
    'BEGIN WORK',
    'BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED',
    'START TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    'START TRANSACTION READ WRITE, NOT DEFERRABLE',
    'COMMIT',
    'COMMIT WORK',
    'COMMIT AND NO CHAIN',
    'END',
    'END TRANSACTION',
    'commit'
  ])('%s is expand', (sql) => {
    expect(one(sql)).toEqual({ statement: sql, phase: 'expand', reason: 'transaction control (no schema change)' })
  })

  // Only a statement that is NOTHING but transaction control counts. ROLLBACK,
  // SAVEPOINT, SELECT and DO are left to the conservative default on purpose.
  it.each([
    ['a BEGIN that runs on into other SQL', 'BEGIN UPDATE notes SET body = \'x\''],
    ['END IF', 'END IF'],
    ['ROLLBACK', 'ROLLBACK'],
    ['SAVEPOINT', 'SAVEPOINT before_backfill'],
    ['SELECT', 'SELECT purge_old_notes()'],
    ['DO', 'DO $$ BEGIN PERFORM 1; END $$']
  ])('%s is not transaction control', (_label, sql) => {
    const r = one(sql)
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('unrecognized statement — classified unsafe conservatively')
  })

  it('a migration wrapped in BEGIN / COMMIT is judged on what it wraps', () => {
    const path = 'migrations/0003_wrapped.sql'
    const wrap = (body) => `BEGIN;\nSET LOCAL lock_timeout = '5s';\n${body}\nCOMMIT;\n`
    expect(classifyMigrationFiles([{ path, status: 'added', content: wrap('ALTER TABLE notes ADD COLUMN pinned boolean;') }]))
      .toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
    expect(classifyMigrationFiles([{ path, status: 'added', content: wrap('ALTER TABLE notes DROP COLUMN body;') }]))
      .toEqual({ verdict: 'unsafe', reasons: [`${path}: drops a column; a rollback would not restore it`] })
  })
})

// The rules each read a whole statement, so in a multi-action ALTER TABLE the
// first rule to match used to speak for every action. Each action is now
// classified on its own and the unsafe one gives the reason.
describe('classifySqlStatements on a multi-action ALTER TABLE', () => {
  it.each([
    ['ADD COLUMN then DROP COLUMN', 'ALTER TABLE t ADD COLUMN a int, DROP COLUMN b', 'drops a column; a rollback would not restore it'],
    ['a defaulted then a required ADD COLUMN', 'ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0, ADD COLUMN b int NOT NULL', 'adds a required column; a rollback would still enforce it'],
    ['ADD COLUMN then ADD CONSTRAINT', 'ALTER TABLE t ADD COLUMN a jsonb, ADD CONSTRAINT c CHECK (a IS NULL)', 'adds a constraint; a rollback would still enforce it'],
    ['ADD COLUMN then SET NOT NULL', 'ALTER TABLE t ADD COLUMN a int, ALTER COLUMN b SET NOT NULL', 'tightens a column to NOT NULL; a rollback would still enforce it'],
    ['ADD COLUMN then an action no rule knows', 'ALTER TABLE t ADD COLUMN a int, ENABLE ROW LEVEL SECURITY', 'unrecognized statement — classified unsafe conservatively'],
    ['IF EXISTS ONLY with a quoted, qualified name', 'ALTER TABLE IF EXISTS ONLY "app"."orders" ADD COLUMN a int, DROP COLUMN b', 'drops a column; a rollback would not restore it'],
    ['ONLY (name)', 'ALTER TABLE ONLY (orders) ADD COLUMN a int, DROP COLUMN b', 'drops a column; a rollback would not restore it'],
    ['name *', 'ALTER TABLE orders * ADD COLUMN a int, DROP COLUMN b', 'drops a column; a rollback would not restore it']
  ])('%s is unsafe, for the action that is', (_label, sql, reason) => {
    expect(one(sql)).toEqual({ statement: sql, phase: 'contract', reason })
  })

  it('only additive actions stay safe', () => {
    const r = one('ALTER TABLE t ADD COLUMN a int, ADD COLUMN b text NOT NULL DEFAULT \'\', ALTER COLUMN c SET DEFAULT 0, DROP CONSTRAINT d')
    expect(r.phase).toBe('expand')
    expect(r.reason).toBe('adds a column (additive; nullable or defaulted)')
  })

  it('commas inside parentheses and brackets do not split actions', () => {
    const sql = 'ALTER TABLE orders ADD COLUMN total numeric(10, 2), ' +
      'ADD COLUMN size text CHECK (size IN (\'s\', \'m\')), ' +
      'ADD COLUMN tags text[] DEFAULT ARRAY[\'a\', \'b\']'
    expect(one(sql).phase).toBe('expand')
  })

  it('a rename still wins over the per-action split', () => {
    expect(one('ALTER TABLE t ADD COLUMN c int, RENAME COLUMN a TO b').reason)
      .toBe('renames an object; a rollback would not restore the old name')
  })

  it('ADD CONSTRAINT on its own stays unsafe', () => {
    expect(one('ALTER TABLE t ADD CONSTRAINT c CHECK (a IS NULL)')).toEqual({
      statement: 'ALTER TABLE t ADD CONSTRAINT c CHECK (a IS NULL)',
      phase: 'contract',
      reason: 'adds a constraint; a rollback would still enforce it'
    })
  })
})

// A quote-aware splitter that misjudges where a string ends could swallow a
// real statement into a "string". When it cannot be sure, the file is reported
// once, with why, and nothing in it is classified.
describe('classifySqlStatements on SQL that cannot be split reliably', () => {
  const UNTERMINATED = 'could not split the SQL into statements (unterminated quote or comment)'
  const BACKSLASH = 'could not split the SQL into statements reliably (a quote follows a backslash, so it may use backslash escapes)'
  const path = 'migrations/0004_x.sql'
  const verdict = (content) => classifyMigrationFiles([{ path, status: 'added', content }])

  it.each([
    ['string', 'CREATE TABLE a (id int);\nCOMMENT ON TABLE a IS \'never closed;\nDROP TABLE b;'],
    ['E\'...\' string', 'INSERT INTO a (body) VALUES (E\'never closed\\\');'],
    ['quoted name', 'CREATE TABLE "never closed (id int);'],
    ['$$ body', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1;'],
    ['$tag$ body', 'CREATE FUNCTION f() RETURNS int AS $fn$ SELECT 1 $$;'],
    ['block comment', 'CREATE TABLE a (id int); /* never closed /* nested */ DROP TABLE b;']
  ])('an unterminated %s makes the file unsafe', (_label, sql) => {
    expect(verdict(sql)).toEqual({ verdict: 'unsafe', reasons: [`${path}: ${UNTERMINATED}`] })
  })

  it('the could-not-split result is the only one for the file', () => {
    const results = classifySqlStatements('CREATE TABLE a (id int);\nCOMMENT ON TABLE a IS \'never closed;')
    expect(results).toEqual([{ statement: 'COMMENT ON TABLE a IS \'never closed;', phase: 'contract', reason: UNTERMINATED }])
  })

  it('a quote right after a backslash makes the file unsafe', () => {
    expect(verdict('INSERT INTO notes (body) VALUES (\'C:\\\');')).toEqual({ verdict: 'unsafe', reasons: [`${path}: ${BACKSLASH}`] })
  })

  // In MySQL-style SQL `\'` is an escaped quote. Read as Postgres, the string
  // ends early and the DROP below lands inside the next "string".
  it.each([
    ['before the closing quote', 'INSERT INTO notes (body) VALUES (\'it\\\'s\'); DROP TABLE notes; INSERT INTO notes (body) VALUES (\'ok\');'],
    ['before a doubled quote', 'INSERT INTO notes (body) VALUES (\'a\\\'\'\'); DROP TABLE notes; INSERT INTO notes (body) VALUES (\'b\\\'\'\');'],
    ['in a quoted name', 'INSERT INTO notes (body) VALUES ("it\\"s"); DROP TABLE notes; INSERT INTO notes (body) VALUES ("ok");']
  ])('a backslash %s cannot hide a statement', (_label, sql) => {
    expect(verdict(sql)).toEqual({ verdict: 'unsafe', reasons: [`${path}: ${BACKSLASH}`] })
  })

  it('an E\'...\' string may escape a quote with a backslash', () => {
    expect(verdict('INSERT INTO notes (body) VALUES (E\'it\\\'s\');')).toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('a backslash anywhere else in a string is fine', () => {
    const sql = 'ALTER TABLE notes ADD COLUMN code text CHECK (code ~ \'^\\d+$\');\n' +
      'COMMENT ON COLUMN notes.code IS \'Stored under C:\\notes\\codes\';'
    expect(verdict(sql)).toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  // A Postgres lexer reads the apostrophe after a backtick or a MySQL `#`
  // comment as the start of a string, and the DROP between two of them would
  // vanish into it.
  const MYSQL = 'could not split the SQL into statements reliably (it uses MySQL-style syntax: a backtick, a # comment or a /*! comment)'
  it.each([
    ['a # comment', [
      'CREATE TABLE people (',
      '  name text # the user\'s name',
      ');',
      'DROP TABLE sessions;',
      'CREATE TABLE bios (',
      '  bio text # the user\'s bio',
      ');'
    ].join('\n')],
    ['backtick-quoted names', 'CREATE TABLE `user\'s` (id int); DROP TABLE sessions; CREATE TABLE `owner\'s` (id int);'],
    ['a /*! comment', '/*!40101 SET NAMES utf8 */;\nCREATE TABLE a (id int);']
  ])('SQL with %s makes the file unsafe', (_label, sql) => {
    expect(verdict(sql)).toEqual({ verdict: 'unsafe', reasons: [`${path}: ${MYSQL}`] })
  })

  it('the jsonb operators #>, #>> and #- are not MySQL comments', () => {
    const sql = 'CREATE INDEX events_city_idx ON example_events ((payload #>> \'{address,city}\'));\n' +
      'CREATE INDEX events_geo_idx ON example_events ((payload #> \'{geo}\'));\n' +
      'CREATE VIEW events_public AS SELECT payload #- \'{secret}\' AS payload FROM example_events;'
    expect(verdict(sql)).toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  // After a number, `$` starts a dollar quote as it does in Postgres. Read as
  // part of a name, it would leave the `'` inside the quote to open a "string"
  // that swallows the DROP.
  it('a dollar quote right after a number is still a dollar quote', () => {
    const results = classifySqlStatements('SET x = 1$a$ \' $a$; DROP TABLE users; --\'')
    expect(results.map((r) => r.reason)).toEqual([
      'changes a session setting (no schema change)',
      'drops a table; a rollback would not restore it'
    ])
  })

  it('a $ inside a name is part of the name', () => {
    expect(splitStatements('ALTER TABLE notes ADD COLUMN price$usd numeric; ALTER TABLE notes ADD COLUMN a$b$c int;')).toEqual([
      'ALTER TABLE notes ADD COLUMN price$usd numeric',
      'ALTER TABLE notes ADD COLUMN a$b$c int'
    ])
  })
})

describe('classifyMigrationFiles on plain CREATE versus OR REPLACE and triggers', () => {
  const path = 'migrations/0006_x.sql'
  const verdict = (content) => classifyMigrationFiles([{ path, status: 'added', content }])

  it('a new plpgsql function is safe, semicolons and all', () => {
    const sql = [
      'CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$',
      'BEGIN',
      '  NEW.updated_at := now();',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;'
    ].join('\n')
    expect(verdict(sql)).toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('a new view is safe', () => {
    expect(verdict('CREATE VIEW open_orders AS SELECT * FROM orders WHERE closed_at IS NULL;'))
      .toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('replacing a view is unsafe', () => {
    expect(verdict('CREATE OR REPLACE VIEW open_orders AS SELECT * FROM orders WHERE closed_at IS NULL;')).toEqual({
      verdict: 'unsafe',
      reasons: [`${path}: replaces a definition (OR REPLACE); a rollback would not restore the old one`]
    })
  })

  it('a trigger on its own is unsafe', () => {
    expect(verdict('CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();')).toEqual({
      verdict: 'unsafe',
      reasons: [`${path}: creates a trigger; it would still fire after a rollback`]
    })
  })
})

// --- Rails / ActiveRecord ----------------------------------------------------

// Wrap a body in a realistic Rails migration class. `body` lines keep their
// relative indentation.
const migration = (body, method = 'change') => [
  'class DoAThing < ActiveRecord::Migration[7.1]',
  `  def ${method}`,
  ...body.split('\n').map((l) => (l === '' ? '' : '    ' + l)),
  '  end',
  'end',
  ''
].join('\n')

// Classify a single-call `def change` body and return the first result.
const rb = (body) => classifyRubyMigration(migration(body))[0]

describe('classifyRubyMigration — EXPAND (safe) calls', () => {
  it.each([
    ['create_table', 'create_table :users do |t|\n  t.string :name\nend', /creates a new table/],
    ['create_join_table', 'create_join_table :users, :roles', /creates a new join table/],
    ['add_column', 'add_column :users, :nickname, :string', /adds a column/],
    ['add_index', 'add_index :users, :email', /adds an index/],
    ['add_reference', 'add_reference :comments, :post', /adds a reference column/],
    ['add_belongs_to', 'add_belongs_to :comments, :author', /adds a reference column/],
    ['enable_extension', 'enable_extension "pgcrypto"', /enables an extension/],
    ['add_timestamps', 'add_timestamps :users, default: -> { "now()" }', /adds timestamp columns/],
    ['remove_index', 'remove_index :users, :email', /removes an index/],
    ['remove_foreign_key', 'remove_foreign_key :comments, :posts', /removes a foreign key/],
    ['remove_check_constraint', 'remove_check_constraint :users, name: "age_check"', /removes a check constraint/]
  ])('%s is expand', (call, body, reason) => {
    const r = rb(body)
    expect(r.phase).toBe('expand')
    expect(r.reason).toMatch(reason)
    expect(r.reason).toContain(`\`${call}\``)
  })

  it('a create_table block\'s interior belongs to the new table (not classified separately)', () => {
    // `t.string ... null: false` inside a brand-new table is fine: the previous
    // image never writes to a table it does not know about.
    const results = classifyRubyMigration(migration([
      'create_table :users do |t|',
      '  t.string :email, null: false',
      '  t.references :account, null: false, foreign_key: true',
      '  t.timestamps',
      'end'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
    expect(results[0].reason).toContain('`create_table`')
  })

  it('a migration with an empty body is safe', () => {
    expect(classifyRubyMigration(migration(''))).toEqual([])
  })

  it('returns [] for empty / null input', () => {
    expect(classifyRubyMigration('')).toEqual([])
    expect(classifyRubyMigration(null)).toEqual([])
    expect(classifyRubyMigration(undefined)).toEqual([])
  })

  it('class / def / disable_ddl_transaction! scaffolding is not a call', () => {
    const results = classifyRubyMigration([
      'class DoAThing < ActiveRecord::Migration[7.1]',
      '  disable_ddl_transaction!',
      '',
      '  def change',
      '    add_index :users, :email, algorithm: :concurrently',
      '  end',
      'end',
      ''
    ].join('\n'))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('# comments cannot smuggle in a destructive call', () => {
    const results = classifyRubyMigration(migration([
      '# remove_column :users, :email comes next release',
      'add_column :users, :email, :string # not drop_table :users'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })
})

describe('classifyRubyMigration — CONTRACT (unsafe) calls', () => {
  it.each([
    ['remove_column', 'remove_column :users, :email', /drops a column; a rollback would not restore it/],
    ['remove_columns', 'remove_columns :users, :a, :b', /drops columns; a rollback would not restore them/],
    ['remove_reference', 'remove_reference :comments, :post', /drops a reference column/],
    ['remove_belongs_to', 'remove_belongs_to :comments, :author', /drops a reference column/],
    ['drop_table', 'drop_table :users', /drops a table; a rollback would not restore it/],
    ['drop_join_table', 'drop_join_table :users, :roles', /drops a join table/],
    ['rename_column', 'rename_column :users, :email, :email_address', /renames a column/],
    ['rename_table', 'rename_table :users, :people', /renames a table/],
    ['change_column', 'change_column :users, :age, :bigint', /changes a column type/],
    ['change_column_null', 'change_column_null :users, :email, false', /NOT NULL/],
    ['change_column_default', 'change_column_default :users, :status, from: nil, to: "a"', /changes a column default/],
    ['add_check_constraint', 'add_check_constraint :users, "age >= 0"', /adds a constraint; a rollback would still enforce it/],
    ['add_foreign_key', 'add_foreign_key :comments, :posts', /adds a constraint; a rollback would still enforce it/],
    ['reversible', 'reversible do |dir|\n  dir.up { add_column :users, :x, :string }\nend', /direction-aware block/]
  ])('%s is contract', (call, body, reason) => {
    const r = rb(body)
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(reason)
    expect(r.reason).toContain(`\`${call}\``)
  })

  // The two sentence shapes, pinned verbatim: a removal says the thing is not
  // coming back, a tightening says the restriction outlives the rollback.
  // Neither makes a claim about what any application image does.
  it('a removal reads as "a rollback would not restore it"', () => {
    expect(rb('drop_table :legacy').reason)
      .toBe('`drop_table` drops a table; a rollback would not restore it')
  })

  it('a tightening reads as "a rollback would still enforce it"', () => {
    expect(rb('add_foreign_key :comments, :posts').reason)
      .toBe('`add_foreign_key` adds a constraint; a rollback would still enforce it')
  })

  // Loosening to NULL is unsafe too — the SQL table already treats
  // `ALTER COLUMN ... DROP NOT NULL` as unsafe via its conservative default.
  it('change_column_null is contract in both directions', () => {
    expect(rb('change_column_null :users, :email, true').phase).toBe('contract')
  })

  it('an unrecognized call is contract, naming the call', () => {
    const r = rb('change_table :users, bulk: true do |t|\n  t.remove :email\nend')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('unrecognized migration call `change_table` — classified unsafe conservatively')
  })

  it('an ActiveRecord model data migration is contract', () => {
    const r = rb('User.update_all(status: "active")')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`update_all` writes rows in a data migration; a rollback would not restore them')
  })

  it('a heredoc is contract, naming the call that opened it', () => {
    const r = rb('execute <<~SQL\n  DROP TABLE users;\nSQL')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` uses heredoc SQL that cannot be classified')
  })

  it('a heredoc body is never read as Ruby', () => {
    // `add_column` inside the heredoc text must not be mistaken for a safe call.
    const results = classifyRubyMigration(migration([
      'execute <<-SQL',
      '  add_column',
      'SQL'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
  })
})

describe('classifyRubyMigration — null: false / default: interplay', () => {
  it.each(['add_column :users, :email, :string', 'add_reference :comments, :post', 'add_belongs_to :comments, :author'])(
    'null: false without a default is contract: %s', (call) => {
      const r = rb(`${call}, null: false`)
      expect(r.phase).toBe('contract')
      // The SQL table's ADD COLUMN NOT NULL reason, prefixed with the call.
      expect(r.reason).toMatch(/adds a required column; a rollback would still enforce it/)
    })

  it.each(['add_column :users, :email, :string', 'add_reference :comments, :post', 'add_belongs_to :comments, :author'])(
    'null: false WITH a default is expand: %s', (call) => {
      expect(rb(`${call}, null: false, default: ""`).phase).toBe('expand')
    })

  it('nullable (no null: option) is expand', () => {
    expect(rb('add_column :users, :email, :string').phase).toBe('expand')
  })

  it('null: true is expand even though a default is absent', () => {
    expect(rb('add_column :users, :email, :string, null: true').phase).toBe('expand')
  })

  it('the options may wrap onto continuation lines', () => {
    const results = classifyRubyMigration(migration([
      'add_column :users, :email, :string,',
      '           null: false,',
      '           default: ""'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('a wrapped null: false with no default is still contract', () => {
    const results = classifyRubyMigration(migration([
      'add_column :users, :email, :string,',
      '           null: false'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
  })

  it('add_timestamps without defaults is contract (it adds NOT NULL columns)', () => {
    const r = rb('add_timestamps :users')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/required timestamp columns/)
  })

  it('add_timestamps null: true is expand', () => {
    expect(rb('add_timestamps :users, null: true').phase).toBe('expand')
  })
})

// `RUBY_LEADING_CALL` cannot tell `TABLES = ...` from a call to a method named
// `TABLES`, so a constant assignment used to fall through to the conservative
// default and stamp an otherwise additive migration unsafe. The assignment
// PREFIX is transparent, which is not the same as skipping the statement.
describe('classifyRubyMigration — assignment is a transparent prefix', () => {
  it('a constant assigned a literal contributes nothing', () => {
    const results = classifyRubyMigration([
      'class BackfillFlags < ActiveRecord::Migration[7.1]',
      '  TABLES = %i[alpha beta gamma]',
      '',
      '  def change',
      '    add_column :alpha, :flag, :boolean',
      '  end',
      'end',
      ''
    ].join('\n'))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
    expect(results[0].reason).toContain('`add_column`')
  })

  it.each([
    ['string', 'NAME = "index_users_on_email"'],
    ['number', 'BATCH_SIZE = 1000'],
    ['array', 'TABLES = %i[alpha beta]'],
    ['bracketed array', 'TABLES = ["alpha", "beta"]'],
    ['hash', 'OPTS = { null: false }'],
    ['local variable', 'batch = 1000'],
    ['or-assignment', 'batch ||= 1000']
  ])('an assigned %s contributes nothing', (_label, assignment) => {
    const results = classifyRubyMigration(migration(`${assignment}\nadd_column :users, :x, :string`))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  // The whole point of a transparent PREFIX rather than a skipped statement:
  // the right-hand side is still classified, so a destructive call cannot be
  // hidden behind an assignment.
  it('an assigned destructive call is still contract', () => {
    const r = rb('x = remove_column :a, :b')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`remove_column` drops a column; a rollback would not restore it')
  })

  it('an assignment does not make a whole migration safe', () => {
    const path = 'db/migrate/20260103000000_drop_it.rb'
    const { verdict } = classifyMigrationFiles([
      { path, status: 'added', content: migration('removed = remove_column :users, :email') }
    ])
    expect(verdict).toBe('unsafe')
  })
})

// A loop header touches no schema; the body is classified on its own lines.
describe('classifyRubyMigration — iteration headers are transparent', () => {
  it('a constant loop over additive calls is safe end to end', () => {
    const source = [
      'class BackfillFlags < ActiveRecord::Migration[7.1]',
      '  TABLES = %i[alpha beta gamma]',
      '',
      '  def change',
      '    TABLES.each do |t|',
      '      add_column t, :flag, :boolean',
      '    end',
      '  end',
      'end',
      ''
    ].join('\n')

    const results = classifyRubyMigration(source)
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
    // Neither the constant nor the loop header may contribute a reason.
    expect(results.some((r) => /TABLES|each/.test(r.reason))).toBe(false)

    const path = 'db/migrate/20260104000000_backfill_flags.rb'
    expect(classifyMigrationFiles([{ path, status: 'added', content: source }]))
      .toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('a constant index name is not a call either', () => {
    const source = [
      'class SwapIndex < ActiveRecord::Migration[7.1]',
      '  INDEX = "index_users_on_email"',
      '',
      '  def change',
      '    remove_index :users, name: INDEX',
      '    add_index :users, :email, name: INDEX, unique: true',
      '  end',
      'end',
      ''
    ].join('\n')

    const results = classifyRubyMigration(source)
    expect(results.map((r) => r.phase)).toEqual(['expand', 'expand'])

    const path = 'db/migrate/20260105000000_swap_index.rb'
    expect(classifyMigrationFiles([{ path, status: 'added', content: source }]))
      .toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it.each([
    ['each', 'TABLES.each do |t|'],
    ['each_with_index', 'TABLES.each_with_index do |t, i|'],
    ['each_with_object', 'TABLES.each_with_object({}) do |t, acc|'],
    ['reverse_each', 'TABLES.reverse_each do |t|'],
    ['map', 'TABLES.map do |t|'],
    ['flat_map', 'TABLES.flat_map do |t|']
  ])('%s steps over the header and classifies the body', (_label, header) => {
    const results = classifyRubyMigration(migration([
      header,
      '  add_column t, :flag, :boolean',
      'end'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('a brace-block iteration is classified on its body', () => {
    expect(rb('COLUMNS.map { |c| add_column :users, c, :string }').phase).toBe('expand')
  })

  // Transparency means "keep looking", never "discard": a destructive body is
  // still reported.
  it('a destructive loop body is still contract', () => {
    const results = classifyRubyMigration(migration([
      'TABLES.each do |t|',
      '  remove_column t, :legacy',
      'end'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
    expect(results[0].reason).toContain('`remove_column`')
  })
})

// A block-variable receiver means "this call belongs to the enclosing
// create_table / change_table", and the statement is discarded on that basis.
// The test is only lexical, so `m.save` inside a loop looked exactly like
// `t.string` inside a create_table and a data migration went unreported —
// including on a loop whose header was already transparent.
describe('classifyRubyMigration — data mutation on a block variable', () => {
  const added = (path, content) => ({ path, status: 'added', content })

  it.each([
    ['save', 'm.save', /writes rows/],
    ['save!', 'm.save!', /writes rows/],
    ['update', 'm.update(active: true)', /writes rows/],
    ['update!', 'm.update!(active: true)', /writes rows/],
    ['update_all', 'm.update_all(active: true)', /writes rows/],
    ['update_column', 'm.update_column(:active, true)', /writes rows/],
    ['update_columns', 'm.update_columns(active: true)', /writes rows/],
    ['update_counters', 'm.update_counters(:id, hits: 1)', /writes rows/],
    ['touch', 'm.touch', /writes rows/],
    ['increment!', 'm.increment!(:hits)', /writes rows/],
    ['decrement!', 'm.decrement!(:hits)', /writes rows/],
    ['update_attribute', 'm.update_attribute(:active, true)', /writes rows/],
    ['update_attributes', 'm.update_attributes(active: true)', /writes rows/],
    ['toggle!', 'm.toggle!(:active)', /writes rows/],
    ['upsert', 'm.upsert({ name: "x" })', /writes rows/],
    ['upsert_all', 'm.upsert_all([{ name: "x" }])', /writes rows/],
    ['insert', 'm.insert({ name: "x" })', /adds rows/],
    ['insert!', 'm.insert!({ name: "x" })', /adds rows/],
    ['insert_all', 'm.insert_all([{ name: "x" }])', /adds rows/],
    ['insert_all!', 'm.insert_all!([{ name: "x" }])', /adds rows/],
    ['delete', 'm.delete', /deletes rows/],
    ['delete_all', 'm.delete_all', /deletes rows/],
    ['destroy', 'm.destroy', /deletes rows/],
    ['destroy!', 'm.destroy!', /deletes rows/],
    ['destroy_all', 'm.destroy_all', /deletes rows/]
  ])('%s on a block variable is contract', (call, body, reason) => {
    const r = rb(body)
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(reason)
    expect(r.reason).toContain(`\`${call}\``)
  })

  // An insert takes nothing away, so the removal wording would be false. The
  // VERDICT is deliberately unchanged: the rows outlive the image swap and the
  // old code still meets them.
  it.each(['m.insert({ name: "x" })', 'm.insert_all([{ name: "x" }])'])(
    'an insert is contract but does not claim a rollback lost anything: %s', (body) => {
      const r = rb(body)
      expect(r.phase).toBe('contract')
      expect(r.reason).toMatch(/adds rows in a data migration; a rollback would leave them in place$/)
    })

  it('an upsert keeps the removal wording (it can overwrite prior values)', () => {
    expect(rb('m.upsert({ name: "x" })').reason)
      .toBe('`upsert` writes rows in a data migration; a rollback would not restore them')
  })

  it('a constant loop that writes rows is unsafe', () => {
    const source = [
      'class ActivateAll < ActiveRecord::Migration[7.1]',
      '  MODELS = [User, Account]',
      '',
      '  def change',
      '    MODELS.each { |m| m.update_all(active: true) }',
      '  end',
      'end',
      ''
    ].join('\n')
    const results = classifyRubyMigration(source)
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
    expect(results[0].reason).toContain('`update_all`')

    const path = 'db/migrate/20260107000000_activate_all.rb'
    expect(classifyMigrationFiles([added(path, source)]).verdict).toBe('unsafe')
  })

  it('a lowercase-receiver loop that writes rows is unsafe', () => {
    // The loop header was discarded as a block-variable call long before the
    // iteration allowlist existed, so this one read safe on its own.
    const results = classifyRubyMigration(migration([
      'models.each do |m|',
      '  m.save',
      'end'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
    expect(results[0].reason).toContain('`save`')
  })

  // Iterate, then mutate one record: the commonest spelling of a data
  // migration, and the one the collection-level rows alone would miss.
  it('a loop that destroys records is unsafe', () => {
    const source = migration('models.each { |m| m.destroy }')
    const results = classifyRubyMigration(source)
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
    expect(results[0].reason)
      .toBe('`destroy` deletes rows in a data migration; a rollback would not restore them')

    const path = 'db/migrate/20260109000000_purge.rb'
    expect(classifyMigrationFiles([added(path, source)]).verdict).toBe('unsafe')
  })

  // `increment` / `decrement` without the bang change the in-memory attribute
  // and never reach the database, so they are deliberately NOT writes.
  it.each(['m.increment(:hits)', 'm.decrement(:hits)'])(
    'a non-persisting %s contributes nothing', (body) => {
      expect(classifyRubyMigration(migration(body))).toEqual([])
    })

  // `each(&:destroy)` and `each { |m| m.destroy }` are the same deletion, and
  // the symbol-to-proc spelling is the commoner of the two. Stepping over the
  // iteration header leaves `(&:destroy)` as the residue, so the symbol has to
  // resolve or the statement disappears.
  it.each([
    ['each(&:destroy)', 'User.all.each(&:destroy)', '`destroy` deletes rows in a data migration; a rollback would not restore them'],
    ['each(&:save!)', 'Account.all.each(&:save!)', '`save!` writes rows in a data migration; a rollback would not restore them'],
    ['map(&:destroy)', 'User.all.map(&:destroy)', '`destroy` deletes rows in a data migration; a rollback would not restore them'],
    ['each(&:delete_all)', 'MODELS.each(&:delete_all)', '`delete_all` deletes rows in a data migration; a rollback would not restore them']
  ])('%s resolves the symbol and reports the real call', (_label, body, reason) => {
    const r = rb(body)
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe(reason)
  })

  it('the symbol-to-proc and block spellings of one deletion agree', () => {
    expect(rb('User.all.each(&:destroy)').phase).toBe(rb('User.all.each { |u| u.destroy }').phase)
  })

  // An unresolvable block argument must reach the conservative default, not
  // vanish the way it would if the scan simply gave up.
  it.each([
    ['&block', 'User.all.each(&block)'],
    ['&method(:x)', 'User.all.each(&method(:purge))']
  ])('an unresolvable %s argument is contract by the conservative default', (_label, body) => {
    const r = rb(body)
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/classified unsafe conservatively$/)
  })

  it('an unknown symbol still reaches the conservative default', () => {
    const r = rb('User.all.map(&:to_s)')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('unrecognized migration call `to_s` — classified unsafe conservatively')
  })

  it('a relation loop that writes rows is unsafe', () => {
    const r = rb('User.all.each { |u| u.save }')
    expect(r.phase).toBe('contract')
    expect(r.reason).toContain('`save`')
  })

  // The guard on checking the table before discarding the statement: a
  // create_table body must STILL belong to the new table.
  it('a create_table body is still not classified separately', () => {
    const source = migration([
      'create_table :things do |t|',
      '  t.string :name',
      '  t.timestamps',
      'end'
    ].join('\n'))
    const results = classifyRubyMigration(source)
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
    expect(results[0].reason).toContain('`create_table`')

    const path = 'db/migrate/20260108000000_create_things.rb'
    expect(classifyMigrationFiles([added(path, source)]))
      .toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('a one-line create_table body is still not classified separately', () => {
    const results = classifyRubyMigration(migration(
      'create_table :things do |t|\n  t.string :name; t.timestamps\nend'
    ))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })
})

// The Ruby table mirrors the SQL one; dropping a constraint is a loosening in
// both spellings. These two used to fall through to the conservative default,
// so the two halves of the classifier disagreed about the same operation.
describe('classifyRubyMigration — constraint removal agrees with the SQL table', () => {
  const added = (path, content) => ({ path, status: 'added', content })

  it.each([
    ['remove_foreign_key', 'remove_foreign_key :comments, :posts'],
    ['remove_check_constraint', 'remove_check_constraint :users, name: "age_check"']
  ])('%s is expand', (_label, body) => {
    expect(rb(body).phase).toBe('expand')
  })

  it('the Ruby verdict matches the SQL DROP CONSTRAINT verdict', () => {
    const sqlVerdict = classifyMigrationFiles([
      added('drizzle/0003_drop_constraint.sql', 'ALTER TABLE comments DROP CONSTRAINT fk_comments_posts;')
    ])
    const rubyVerdict = classifyMigrationFiles([
      added('db/migrate/20260106000000_drop_constraint.rb', migration('remove_foreign_key :comments, :posts'))
    ])
    expect(sqlVerdict.verdict).toBe('safe')
    expect(rubyVerdict).toEqual(sqlVerdict)
  })
})

// Guard clauses around a call are common in migrations that must tolerate a
// partially-applied schema. This is EXISTING behaviour — pinned so the
// tokenizer changes cannot move it.
describe('classifyRubyMigration — table_exists? guards', () => {
  it('a trailing `if table_exists?` guard classifies the guarded call', () => {
    expect(rb('add_column :users, :x, :string if table_exists?(:users)').phase).toBe('expand')
  })

  it('a `return unless table_exists?` guard contributes nothing', () => {
    const results = classifyRubyMigration(migration([
      'return unless table_exists?(:users)',
      'add_column :users, :x, :string'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('a bare `if table_exists?` block opener is contract (unrecognized call)', () => {
    const results = classifyRubyMigration(migration([
      'if table_exists?(:users)',
      '  add_column :users, :x, :string',
      'end'
    ].join('\n')))
    expect(results.map((r) => r.phase)).toEqual(['contract', 'expand'])
    expect(results[0].reason).toContain('`table_exists?`')
  })
})

describe('classifyRubyMigration — def up / def down isolation', () => {
  it('classifies def up and ignores def down', () => {
    const results = classifyRubyMigration([
      'class DoAThing < ActiveRecord::Migration[7.1]',
      '  def up',
      '    add_column :users, :nickname, :string',
      '  end',
      '',
      '  def down',
      '    remove_column :users, :nickname',
      '  end',
      'end',
      ''
    ].join('\n'))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('ignores def down even when it comes first', () => {
    const results = classifyRubyMigration([
      'class DoAThing < ActiveRecord::Migration[7.1]',
      '  def down',
      '    drop_table :users',
      '  end',
      '',
      '  def up',
      '    create_table :users do |t|',
      '      t.string :name',
      '    end',
      '  end',
      'end',
      ''
    ].join('\n'))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('isolates a one-line def down', () => {
    const results = classifyRubyMigration([
      'class DoAThing < ActiveRecord::Migration[7.1]',
      '  def up; add_column :users, :x, :string; end',
      '  def down; remove_column :users, :x; end',
      'end',
      ''
    ].join('\n'))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('expand')
  })

  it('a one-line def cannot hide its body behind the def keyword', () => {
    const results = classifyRubyMigration([
      'class DoAThing < ActiveRecord::Migration[7.1]',
      '  def change; drop_table :legacy; end',
      'end',
      ''
    ].join('\n'))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
  })

  it('classifies bare DSL calls when there is no def to isolate', () => {
    const results = classifyRubyMigration('add_column :users, :x, :string\ndrop_table :legacy\n')
    expect(results.map((r) => r.phase)).toEqual(['expand', 'contract'])
  })
})

describe('classifyRubyMigration — execute() raw SQL', () => {
  it('a double-quoted literal is classified with the SQL rules (safe)', () => {
    const r = rb('execute "CREATE INDEX idx_users_email ON users (email)"')
    expect(r.phase).toBe('expand')
    expect(r.reason).toBe('`execute` raw SQL — creates a new database object (additive)')
  })

  it('a single-quoted literal is classified with the SQL rules (unsafe)', () => {
    const r = rb('execute \'DROP TABLE users\'')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` raw SQL — drops a table; a rollback would not restore it')
  })

  it('parenthesised form is classified', () => {
    const r = rb('execute("UPDATE users SET status = \'active\'")')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/runs a data migration \(UPDATE\)/)
  })

  it('connection.execute is classified like execute', () => {
    const r = rb('connection.execute "DROP TABLE users"')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/drops a table/)
  })

  it('a multi-statement literal reports the destructive half', () => {
    const r = rb('execute "CREATE TABLE a (id int); DROP TABLE b"')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/drops a table/)
  })

  it('interpolation is contract (the SQL that runs is not the SQL we hold)', () => {
    const r = rb('execute "UPDATE users SET status = \'#{status}\'"')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` interpolates values into raw SQL that cannot be classified')
  })

  it('a non-literal argument is contract', () => {
    const r = rb('execute backfill_sql')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` runs raw SQL that cannot be classified')
  })

  it('concatenation onto a literal is contract', () => {
    const r = rb('execute "UPDATE users " + suffix')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` builds raw SQL that cannot be classified')
  })

  it('a `;` inside a SQL string in the literal does not split the SQL', () => {
    const r = rb('execute "COMMENT ON TABLE notes IS \'drafts; and finals\'"')
    expect(r.phase).toBe('expand')
    expect(r.reason).toBe('`execute` raw SQL — sets a comment (metadata only)')
  })

  it('a destructive statement after such a string is still reported', () => {
    const r = rb('execute "COMMENT ON TABLE notes IS \'a; b\'; DROP TABLE drafts"')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` raw SQL — drops a table; a rollback would not restore it')
  })

  it('SQL that cannot be split is contract, with why', () => {
    const r = rb('execute "COMMENT ON TABLE notes IS \'never closed"')
    expect(r.phase).toBe('contract')
    expect(r.reason).toBe('`execute` raw SQL — could not split the SQL into statements (unterminated quote or comment)')
  })

  // The SQL is classified as Ruby hands it to the database, not as written in
  // the source. Read from the source, each of these hides the DROP.
  it.each([
    // `\\\\` is two backslashes, which close the E'...' string.
    ['an escaped backslash', String.raw`execute "COMMENT ON COLUMN notes.body IS E'ends in \\\\'; ALTER TABLE notes DROP COLUMN legacy -- don't"`],
    // `\n` is a line break, which ends the `--` comment.
    ['a \\n line break', String.raw`execute "SET LOCAL lock_timeout = '5s'; -- wait\nALTER TABLE notes DROP COLUMN legacy"`]
  ])('%s in a double-quoted literal is read as Ruby reads it', (_label, body) => {
    expect(rb(body)).toMatchObject({ phase: 'contract', reason: '`execute` raw SQL — drops a column; a rollback would not restore it' })
  })

  it('an unescaped literal can still be safe', () => {
    const r = rb(String.raw`execute "CREATE INDEX notes_body_idx ON notes (body);\nCOMMENT ON COLUMN notes.body IS 'x; y'"`)
    expect(r).toMatchObject({ phase: 'expand', reason: '`execute` raw SQL — creates a new database object (additive)' })
  })

  it.each([
    ['\\0', String.raw`execute "COMMENT ON TABLE notes IS 'a\0b'"`],
    ['octal', String.raw`execute "COMMENT ON TABLE notes IS 'a\101b'"`],
    ['\\x', String.raw`execute "COMMENT ON TABLE notes IS 'a\x41b'"`],
    ['\\u', String.raw`execute "COMMENT ON TABLE notes IS 'a\u0041b'"`],
    ['\\e', String.raw`execute "COMMENT ON TABLE notes IS 'a\eb'"`],
    ['\\M-', String.raw`execute "COMMENT ON TABLE notes IS 'a\M-ab'"`],
    ['\\C-', String.raw`execute "COMMENT ON TABLE notes IS 'a\C-ab'"`],
    ['an unknown escape', String.raw`execute "CREATE INDEX notes_code_idx ON notes (code) WHERE code ~ '^\d+$'"`]
  ])('a double-quoted literal with a %s escape is contract', (_label, body) => {
    expect(rb(body)).toMatchObject({ phase: 'contract', reason: '`execute` raw SQL uses a string escape that cannot be classified' })
  })

  // In a single-quoted Ruby literal only `\\` and `\'` are escapes; every other
  // backslash reaches the database as written.
  it('a single-quoted literal keeps other backslashes as they are', () => {
    const r = rb(String.raw`execute 'CREATE INDEX notes_code_idx ON notes (code) WHERE code ~ \'^\d+$\''`)
    expect(r).toMatchObject({ phase: 'expand', reason: '`execute` raw SQL — creates a new database object (additive)' })
  })

  // So `\n` there is two characters, and the `--` comment runs on to the end of
  // the string: Postgres never sees the DROP as a statement.
  it('a \\n in a single-quoted literal is not a line break', () => {
    const r = rb(String.raw`execute 'SET LOCAL lock_timeout = \'5s\'; -- wait\nALTER TABLE notes DROP COLUMN legacy'`)
    expect(r).toMatchObject({ phase: 'expand', reason: '`execute` raw SQL — changes a session setting (no schema change)' })
  })

  it('a long run of backslashes with no closing quote finishes quickly', () => {
    const start = Date.now()
    const r = rb(`execute "${'\\\\'.repeat(40)}`)
    expect(Date.now() - start).toBeLessThan(1000)
    expect(r).toMatchObject({ phase: 'contract', reason: '`execute` runs raw SQL that cannot be classified' })
  })
})

// strong_migrations answers a DIFFERENT question (lock safety while the
// migration runs). Its escape hatch must not silence THIS classifier.
describe('classifyRubyMigration — safety_assured does not bypass the classifier', () => {
  it('classifies the contents of a safety_assured { } brace block', () => {
    const r = rb('safety_assured { remove_column :users, :email }')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/drops a column/)
  })

  it('classifies the contents of a safety_assured do ... end block', () => {
    const results = classifyRubyMigration(migration([
      'safety_assured do',
      '  remove_column :users, :email',
      'end'
    ].join('\n')))
    expect(results).toHaveLength(1)
    expect(results[0].phase).toBe('contract')
  })

  it('a safety_assured wrapper around an additive call stays safe', () => {
    expect(rb('safety_assured { add_index :users, :email }').phase).toBe('expand')
  })
})

describe('classifyMigrationFiles', () => {
  const added = (path, content) => ({ path, status: 'added', content })

  it('no migration files → safe, with an explicit no-changes reason', () => {
    expect(classifyMigrationFiles([])).toEqual({ verdict: 'safe', reasons: ['no migration changes in this release'] })
    expect(classifyMigrationFiles(null)).toEqual({ verdict: 'safe', reasons: ['no migration changes in this release'] })
  })

  it('added .sql with only additive statements → safe, counted', () => {
    const files = [added('drizzle/0001_init.sql', 'CREATE TABLE users (id int);\n--> statement-breakpoint\nALTER TABLE users ADD COLUMN email text;')]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('added .sql with a destructive statement → unsafe, reason prefixed with path', () => {
    const files = [added('drizzle/0002_drop.sql', 'DROP TABLE users;')]
    const { verdict, reasons } = classifyMigrationFiles(files)
    expect(verdict).toBe('unsafe')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/^drizzle\/0002_drop\.sql: /)
  })

  it.each(['modified', 'removed', 'renamed'])('%s .sql → unsafe (history modified)', (status) => {
    const files = [{ path: 'drizzle/0001_init.sql', status, content: 'CREATE TABLE users (id int);' }]
    const { verdict, reasons } = classifyMigrationFiles(files)
    expect(verdict).toBe('unsafe')
    expect(reasons[0]).toMatch(/migration history modified/)
  })

  it('added non-.sql file → unsafe (unsupported format)', () => {
    const files = [added('drizzle/0001_init.js', 'module.exports = {}')]
    const { verdict, reasons } = classifyMigrationFiles(files)
    expect(verdict).toBe('unsafe')
    expect(reasons[0]).toMatch(/unsupported migration format/)
  })

  it('ignores drizzle meta/ bookkeeping', () => {
    const files = [
      { path: 'drizzle/meta/_journal.json', status: 'added', content: '{}' },
      { path: 'drizzle/meta/0001_snapshot.json', status: 'modified', content: '{}' }
    ]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: ['no migration changes in this release'] })
  })

  it('ignores non-SQL dotfiles', () => {
    const files = [{ path: 'drizzle/.gitkeep', status: 'added', content: '' }]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: ['no migration changes in this release'] })
  })

  it('accumulates reasons across files and statements', () => {
    const files = [
      added('drizzle/0001_ok.sql', 'CREATE TABLE a (id int);'),
      added('drizzle/0002_bad.sql', 'DROP TABLE a;\n--> statement-breakpoint\nTRUNCATE b;'),
      { path: 'drizzle/0000_init.sql', status: 'modified', content: '' }
    ]
    const { verdict, reasons } = classifyMigrationFiles(files)
    expect(verdict).toBe('unsafe')
    expect(reasons).toHaveLength(3)
    expect(reasons.filter((r) => r.startsWith('drizzle/0002_bad.sql:'))).toHaveLength(2)
    expect(reasons.some((r) => r.startsWith('drizzle/0000_init.sql:'))).toBe(true)
  })
})

// Two hand-written Postgres migrations in the shape that used to be misread:
// they open with SET LOCAL lock_timeout, add columns in one multi-line ALTER
// TABLE, and document them with COMMENT ON COLUMN text full of quotes.
describe('classifyMigrationFiles on hand-written Postgres migrations', () => {
  const added = (path, content) => ({ path, status: 'added', content })

  const WIDGET_SYNC = [
    '-- Track when each widget last synced, so the sync job can pick up where it',
    '-- left off. Every new column is nullable or has a default.',
    '',
    'SET LOCAL lock_timeout = \'5s\';',
    '',
    'ALTER TABLE widgets',
    '  ADD COLUMN last_synced_at timestamptz,',
    '  ADD COLUMN sync_cursor bigint,',
    '  ADD COLUMN sync_started_at timestamptz,',
    '  ADD COLUMN sync_failures smallint NOT NULL DEFAULT 0,',
    '  ADD COLUMN sync_paused_until timestamptz;',
    '',
    'COMMENT ON COLUMN widgets.last_synced_at IS \'When the widget\'\'s last sync finished.\';',
    'COMMENT ON COLUMN widgets.sync_cursor IS \'The widget\'\'s position in the upstream feed.\';',
    'COMMENT ON COLUMN widgets.sync_started_at IS \'When the current sync began, or null if one isn\'\'t running.\';',
    'COMMENT ON COLUMN widgets.sync_failures IS \'Failed syncs in a row, reset after one that doesn\'\'t fail.\';',
    'COMMENT ON COLUMN widgets.sync_paused_until IS \'Don\'\'t sync this widget again before this time.\';',
    '',
    'CREATE INDEX widgets_sync_due_idx',
    '  ON widgets (sync_paused_until)',
    '  WHERE sync_started_at IS NULL',
    '    AND (last_synced_at IS NULL OR sync_failures > 0);',
    '',
    'CREATE TABLE widget_sync_runs (',
    '  widget_id bigint NOT NULL,',
    '  outcome text NOT NULL CHECK (outcome IN (\'finished\', \'failed\')),',
    '  started_at timestamptz NOT NULL DEFAULT now(),',
    '  PRIMARY KEY (widget_id, started_at)',
    ');',
    '',
    'CREATE INDEX widget_sync_runs_outcome_idx ON widget_sync_runs (outcome, started_at);',
    '',
    'COMMENT ON COLUMN widget_sync_runs.outcome IS \'Either \'\'finished\'\' or \'\'failed\'\'.\';',
    'COMMENT ON COLUMN widget_sync_runs.started_at IS \'When the run began, by the widget\'\'s clock.\';',
    ''
  ].join('\n')

  const ORDER_DELIVERY_PREFS = [
    '-- Let an order carry optional delivery preferences as a JSON object.',
    '',
    'SET LOCAL lock_timeout = \'5s\';',
    '',
    'ALTER TABLE orders ADD COLUMN delivery_prefs jsonb, ADD CONSTRAINT orders_delivery_prefs_is_object CHECK (delivery_prefs IS NULL OR jsonb_typeof(delivery_prefs) = \'object\');',
    '',
    'COMMENT ON COLUMN orders.delivery_prefs IS \'The customer\'\'s delivery preferences. Carrier names are stored in lowercase; or, for a carrier we don\'\'t list, exactly as typed.\';',
    'COMMENT ON COLUMN orders.delivery_window IS \'Allowed keys: {"start", "end"} (both optional, both local times).\';',
    'COMMENT ON COLUMN orders.placed_at IS \'When the order was placed.\';',
    ''
  ].join('\n')

  it('an additive migration with quoted comments is safe', () => {
    const results = classifySqlStatements(WIDGET_SYNC)
    // SET, ALTER, 5 comments, index, table, index, 2 comments: no fragments.
    expect(results).toHaveLength(12)
    expect(results.every((r) => r.phase === 'expand')).toBe(true)
    expect(classifyMigrationFiles([added('migrations/0007_widget_sync.sql', WIDGET_SYNC)]))
      .toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('a column added alongside a constraint is unsafe for the constraint alone', () => {
    const path = 'migrations/0008_order_delivery_prefs.sql'
    expect(classifyMigrationFiles([added(path, ORDER_DELIVERY_PREFS)])).toEqual({
      verdict: 'unsafe',
      reasons: [`${path}: adds a constraint; a rollback would still enforce it`]
    })
  })
})

describe('classifyMigrationFiles — Rails .rb migrations', () => {
  const added = (path, content) => ({ path, status: 'added', content })

  it('added .rb with only additive calls → safe, counted', () => {
    const files = [added('db/migrate/20260101000000_add_email.rb', migration('add_column :users, :email, :string'))]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: ['1 additive migration'] })
  })

  it('added .rb with a destructive call → unsafe, reason names the file and the call', () => {
    const path = 'db/migrate/20260102000000_drop_legacy.rb'
    const { verdict, reasons } = classifyMigrationFiles([added(path, migration('drop_table :legacy'))])
    expect(verdict).toBe('unsafe')
    expect(reasons).toEqual([`${path}: \`drop_table\` drops a table; a rollback would not restore it`])
  })

  it.each(['modified', 'removed', 'renamed'])('%s .rb → unsafe (history modified)', (status) => {
    const files = [{ path: 'db/migrate/20260101000000_add_email.rb', status, content: '' }]
    const { verdict, reasons } = classifyMigrationFiles(files)
    expect(verdict).toBe('unsafe')
    expect(reasons[0]).toMatch(/migration history modified/)
  })

  it('a still-unsupported format is reported as such', () => {
    const { verdict, reasons } = classifyMigrationFiles([added('db/migrate/0001_init.py', 'pass')])
    expect(verdict).toBe('unsafe')
    expect(reasons[0]).toBe('db/migrate/0001_init.py: unsupported migration format (only .sql and Rails .rb are classified)')
  })

  it('ignores non-classifiable dotfiles under the migrations path', () => {
    expect(classifyMigrationFiles([added('db/migrate/.keep', '')])).toEqual({ verdict: 'safe', reasons: ['no migration changes in this release'] })
  })

  it('a mixed .sql + .rb diff classifies both and collects every reason', () => {
    const files = [
      added('db/migrate/20260101000000_ok.rb', migration('add_column :users, :x, :string')),
      added('db/migrate/20260102000000_bad.rb', migration('drop_table :legacy\nrename_column :users, :a, :b')),
      added('drizzle/0001_ok.sql', 'CREATE TABLE t (id int);'),
      added('drizzle/0002_bad.sql', 'TRUNCATE t;'),
      { path: 'db/migrate/20251231000000_old.rb', status: 'modified', content: '' }
    ]
    const { verdict, reasons } = classifyMigrationFiles(files)
    expect(verdict).toBe('unsafe')
    expect(reasons).toHaveLength(4)
    expect(reasons.filter((r) => r.startsWith('db/migrate/20260102000000_bad.rb:'))).toHaveLength(2)
    expect(reasons.filter((r) => r.startsWith('drizzle/0002_bad.sql:'))).toHaveLength(1)
    expect(reasons.filter((r) => r.startsWith('db/migrate/20251231000000_old.rb:'))).toHaveLength(1)
    expect(reasons.some((r) => r.startsWith('db/migrate/20260101000000_ok.rb'))).toBe(false)
  })

  it('an all-additive mixed diff is safe, with a plural count', () => {
    const files = [
      added('db/migrate/20260101000000_ok.rb', migration('add_index :users, :email')),
      added('drizzle/0001_ok.sql', 'CREATE TABLE t (id int);')
    ]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: ['2 additive migrations'] })
  })
})
