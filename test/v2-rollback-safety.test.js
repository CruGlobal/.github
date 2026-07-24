import { describe, it, expect } from 'vitest'
import {
  splitStatements,
  classifySqlStatements,
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
    // The marker starts with `--`; splitting must happen before comment strip.
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
    'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
    'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()',
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
    expect(r.reason).toMatch(/omit the new required column/)
  })

  it('DROP COLUMN is contract', () => {
    const r = one('ALTER TABLE users DROP COLUMN email')
    expect(r.phase).toBe('contract')
    expect(r.reason).toMatch(/drops a column the previous image still selects/)
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

describe('classifyMigrationFiles', () => {
  const added = (path, content) => ({ path, status: 'added', content })

  it('no migration files → safe with no reasons', () => {
    expect(classifyMigrationFiles([])).toEqual({ verdict: 'safe', reasons: [] })
    expect(classifyMigrationFiles(null)).toEqual({ verdict: 'safe', reasons: [] })
  })

  it('added .sql with only additive statements → safe', () => {
    const files = [added('drizzle/0001_init.sql', 'CREATE TABLE users (id int);\n--> statement-breakpoint\nALTER TABLE users ADD COLUMN email text;')]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: [] })
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
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: [] })
  })

  it('ignores non-SQL dotfiles', () => {
    const files = [{ path: 'drizzle/.gitkeep', status: 'added', content: '' }]
    expect(classifyMigrationFiles(files)).toEqual({ verdict: 'safe', reasons: [] })
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
