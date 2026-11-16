import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { DatabaseColumn, DatabaseSchema, schemaHash } from './schema'

export interface SchemaChange { kind: string; table: string; column?: string; review: boolean }
export interface MigrationPlan { changes: SchemaChange[]; statements: string[] }
export interface SchemaSnapshot { format: 1; version: number; hash: string; schema: DatabaseSchema }

export function diffSchemas(previous: DatabaseSchema | undefined, next: DatabaseSchema): MigrationPlan {
    if (previous && (previous.format !== next.format || previous.provider !== next.provider)) throw new Error('Cannot change the database provider or snapshot format of an existing backend')
    const quote = (s: string) => next.provider === 'mysql' ? `\`${s.replace(/`/g, '``')}\`` : `"${s.replace(/"/g, '""')}"`
    const literal = (v: string | number | boolean) => typeof v === 'string' ? `${next.provider === 'postgresql' ? 'E' : ''}'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : String(v)
    const type = (c: DatabaseColumn) => ({ id: 'varchar(36)', string: 'varchar(255)', text: 'text', integer: 'integer', float: next.provider === 'mysql' ? 'double' : 'double precision', boolean: 'boolean', datetime: next.provider === 'mysql' ? 'datetime(3)' : 'timestamptz', json: next.provider === 'mysql' ? 'json' : 'jsonb' })[c.type]
    const definition = (c: DatabaseColumn) => `${quote(c.name)} ${type(c)}${c.required ? ' NOT NULL' : ''}${c.name === '_id' ? ' PRIMARY KEY' : ''}${c.default !== undefined ? ` DEFAULT ${literal(c.default)}` : ''}`
    const indexName = (table: string, fields: string[]) => `gmb_u_${createHash('sha256').update(JSON.stringify([table, fields])).digest('hex').slice(0, 20)}`
    const changes: SchemaChange[] = []
    const statements: string[] = []
    const change = (kind: string, table: string, review = false, column?: string) => changes.push({ kind, table, ...(column ? { column } : {}), review })
    const oldTables = new Map((previous?.tables || []).map(t => [t.name, t]))
    const newTables = new Map(next.tables.map(t => [t.name, t]))
    for (const table of next.tables) {
        const old = oldTables.get(table.name)
        if (!old) {
            change('createTable', table.name)
            statements.push(`CREATE TABLE ${quote(table.name)} (${table.columns.map(definition).join(', ')})`)
        } else {
            // Drop obsolete indexes before changing/dropping their columns.
            for (const fields of old.unique.filter(f => !table.unique.some(n => JSON.stringify(n) === JSON.stringify(f)))) {
                change('dropUnique', table.name, true)
                statements.push(next.provider === 'mysql' ? `DROP INDEX ${quote(indexName(table.name, fields))} ON ${quote(table.name)}` : `DROP INDEX ${quote(indexName(table.name, fields))}`)
            }
            for (const column of table.columns) {
                const before = old.columns.find(c => c.name === column.name)
                if (!before) {
                    change('addColumn', table.name, column.required && column.default === undefined, column.name)
                    statements.push(`ALTER TABLE ${quote(table.name)} ADD COLUMN ${definition(column)}`)
                } else if (JSON.stringify(before) !== JSON.stringify(column)) {
                    change('alterColumn', table.name, true, column.name)
                    if (next.provider === 'mysql') statements.push(`ALTER TABLE ${quote(table.name)} MODIFY COLUMN ${definition(column)}`)
                    else {
                        if (before.type !== column.type) {
                            statements.push(`ALTER TABLE ${quote(table.name)} ALTER COLUMN ${quote(column.name)} DROP DEFAULT`)
                            statements.push(`ALTER TABLE ${quote(table.name)} ALTER COLUMN ${quote(column.name)} TYPE ${type(column)} USING ${quote(column.name)}::${type(column)}`)
                        }
                        statements.push(`ALTER TABLE ${quote(table.name)} ALTER COLUMN ${quote(column.name)} ${column.required ? 'SET' : 'DROP'} NOT NULL`)
                        statements.push(`ALTER TABLE ${quote(table.name)} ALTER COLUMN ${quote(column.name)} ${column.default !== undefined ? `SET DEFAULT ${literal(column.default)}` : 'DROP DEFAULT'}`)
                    }
                }
            }
            for (const column of old.columns.filter(c => !table.columns.some(n => n.name === c.name))) {
                change('dropColumn', table.name, true, column.name)
                statements.push(`ALTER TABLE ${quote(table.name)} DROP COLUMN ${quote(column.name)}`)
            }
        }
        for (const fields of table.unique.filter(f => !old?.unique.some(n => JSON.stringify(n) === JSON.stringify(f)))) {
            change('addUnique', table.name, !!old)
            statements.push(`CREATE UNIQUE INDEX ${quote(indexName(table.name, fields))} ON ${quote(table.name)} (${fields.map(quote).join(', ')})`)
        }
    }
    for (const table of oldTables.values()) if (!newTables.has(table.name)) {
        change('dropTable', table.name, true)
        statements.push(`DROP TABLE ${quote(table.name)}`)
    }
    return { changes, statements }
}

export function prepareMigration(outDir: string, schema: DatabaseSchema) {
    const directory = path.join(outDir, 'database')
    const snapshotPath = path.join(directory, 'schema.snapshot.json')
    let previous: SchemaSnapshot | undefined
    if (fs.existsSync(snapshotPath)) {
        previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
        if (previous.format !== 1 || previous.schema?.format !== 1 || previous.hash !== schemaHash(previous.schema) || !Number.isInteger(previous.version) || previous.version < 1) throw new Error('Invalid database schema snapshot')
        if (previous.schema.provider !== schema.provider) throw new Error('Cannot change the database provider of an existing backend')
        const migrationDirectory = path.join(directory, 'migrations')
        const history = fs.existsSync(migrationDirectory) ? fs.readdirSync(migrationDirectory).filter(f => /^\d{6}_[a-f0-9]{12}\.cjs$/.test(f)).sort() : []
        const expectedLast = `${String(previous.version).padStart(6, '0')}_${previous.hash.slice(0, 12)}.cjs`
        if (history.length !== previous.version || history.some((f, i) => !f.startsWith(String(i + 1).padStart(6, '0') + '_')) || history[history.length - 1] !== expectedLast) {
            throw new Error('Incomplete database migration history. Restore the migrations matching the schema snapshot.')
        }
    }
    const hash = schemaHash(schema)
    if (previous?.hash === hash) return { snapshot: previous, commit: () => {} }
    const version = (previous?.version || 0) + 1
    if (version > 999999) throw new Error('Database migration version limit exceeded')
    const snapshot: SchemaSnapshot = { format: 1, version, hash, schema }
    const plan = diffSchemas(previous?.schema, schema)
    const id = `${String(version).padStart(6, '0')}_${hash.slice(0, 12)}`
    const migration = `// Generated database schema version ${version}. Review before applying.\n// Renames are represented as drop/add; edit this migration to preserve existing data.\nexports.schemaHash = ${JSON.stringify(hash)};\nexports.requiresReview = ${plan.changes.some(c => c.review)};\nexports.changes = ${JSON.stringify(plan.changes, null, 2)};\nexports.up = async (knex) => {\n    if (exports.requiresReview && process.env.GMB_ALLOW_DESTRUCTIVE_MIGRATIONS !== '1') {\n        throw new Error('Migration ${id} requires review. Review/edit it and set GMB_ALLOW_DESTRUCTIVE_MIGRATIONS=1 to apply.');\n    }\n    for (const sql of ${JSON.stringify(plan.statements, null, 2)}) await knex.raw(sql);\n};\nexports.down = async () => { throw new Error('Automatic rollback is not supported. Write and review a forward migration.'); };\nexports.config = { transaction: ${schema.provider === 'postgresql'} };\n`
    return { snapshot, commit: () => {
        fs.mkdirSync(path.join(directory, 'migrations'), { recursive: true })
        fs.mkdirSync(path.join(directory, 'snapshots'), { recursive: true })
        const migrationPath = path.join(directory, 'migrations', `${id}.cjs`)
        const historyPath = path.join(directory, 'snapshots', `${id}.json`)
        // Never overwrite history, including after a partially failed generation.
        for (const [file, contents] of [[migrationPath, migration], [historyPath, JSON.stringify(snapshot, null, 2) + '\n']]) {
            if (fs.existsSync(file)) {
                if (fs.readFileSync(file, 'utf8') !== contents) throw new Error(`Database history already exists with different contents: ${file}`)
            } else fs.writeFileSync(file, contents, { flag: 'wx' })
        }
        const temporary = `${snapshotPath}.${process.pid}.tmp`
        fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n')
        fs.renameSync(temporary, snapshotPath)
    } }
}
