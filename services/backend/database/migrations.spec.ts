import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { exportAsFromString } from '../build'
import { getModelsFromSchema } from '../../parser/scan'
import { diffSchemas, prepareMigration as prepareDatabaseMigration, MigrationFormat } from './migrations'
import { prepareMigration } from '../targets/typescript/database/migrations'
import { databaseProvider, DatabaseSchema, schemaFromModels } from './schema'

describe('database snapshots and migrations', () => {
    let directory: string
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-database-')) })
    afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })
    const schema = async (source: string, provider: 'postgresql' | 'mysql' = 'postgresql') => schemaFromModels(await getModelsFromSchema(source), provider)
    const migrations = () => fs.readdirSync(path.join(directory, 'database/migrations')).sort()

    it('reuses SQL planning and snapshot history with a non-JavaScript migration format', async () => {
        const format: MigrationFormat = {
            extension: 'sql',
            render: ({ plan }) => plan.statements.map(sql => sql + ';').join('\n') + '\n',
        }
        const initial = await schema('model Todo {\n title: String\n}')
        const updated = await schema('model Todo {\n title: String\n done: Boolean\n}')
        prepareDatabaseMigration(directory, initial, format).commit()
        const originalFile = migrations()[0]
        const original = fs.readFileSync(path.join(directory, 'database/migrations', originalFile), 'utf8')
        expect(originalFile).toMatch(/\.sql$/)
        expect(original).toBe(format.render({ id: '', version: 1, hash: '', schema: initial, plan: diffSchemas(undefined, initial) }))
        const next = prepareDatabaseMigration(directory, updated, format)
        next.commit()
        expect(next.snapshot.version).toBe(2)
        expect(migrations()).toHaveLength(2)
        expect(fs.readFileSync(path.join(directory, 'database/migrations', originalFile), 'utf8')).toBe(original)
        prepareDatabaseMigration(directory, updated, format).commit()
        expect(migrations()).toHaveLength(2)
    })

    it('ignores source order, whitespace and API protection changes in the database diff', async () => {
        const a = await schema('model Todo {\n title: String\n done: Boolean\n}')
        const b = await schema('model Todo {\n done: Boolean\n title: String\n }')
        expect(a).toEqual(b)
        expect(diffSchemas(a, b)).toEqual({ changes: [], statements: [] })
        prepareMigration(directory, a).commit()
        const plan = prepareMigration(directory, b)
        plan.commit()
        expect(plan.snapshot.version).toBe(1)
        expect(migrations()).toHaveLength(1)
    })

    it.each(['postgresql', 'mysql'] as const)('preserves migration history across %s backend regenerations', async provider => {
        await exportAsFromString('sql', 'model Todo {\n title: String\n}', directory, { database: provider })
        const initial = migrations()[0]
        const original = fs.readFileSync(path.join(directory, 'database/migrations', initial), 'utf8')
        fs.writeFileSync(path.join(directory, 'database/keep.txt'), 'user data')
        await exportAsFromString('sql', 'model Todo {\n title: String\n done: Boolean\n}', directory, { database: provider })
        expect(migrations()).toHaveLength(2)
        expect(fs.readFileSync(path.join(directory, 'database/migrations', initial), 'utf8')).toBe(original)
        expect(fs.readFileSync(path.join(directory, 'database/keep.txt'), 'utf8')).toBe('user data')
        const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'database/schema.snapshot.json'), 'utf8'))
        expect(snapshot.version).toBe(2)
        const second = require(path.join(directory, 'database/migrations', migrations()[1]))
        expect(second.requiresReview).toBe(false)
        const raw = jest.fn().mockResolvedValue(undefined)
        await second.up({ raw })
        expect(raw).toHaveBeenCalledWith(expect.stringMatching(/ALTER TABLE .*Todo.* ADD COLUMN .*done.* boolean/))
        await exportAsFromString('sql', 'model Todo {\n title: String\n done: Boolean\n}', directory, { database: provider })
        expect(migrations()).toHaveLength(2)
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
        expect(manifest.dependencies).not.toHaveProperty('mongoose')
        expect(manifest.dependencies.knex).toBeDefined()
        expect(manifest.dependencies[provider === 'mysql' ? 'mysql2' : 'pg']).toBeDefined()
        expect(manifest.scripts['db:migrate']).toBe('ts-node gen/sql/migrate.ts up')
        expect(fs.readFileSync(path.join(directory, 'gen/services/Todo.ts'), 'utf8')).toContain('transactionalServices')
        expect(fs.readFileSync(path.join(directory, 'gen/models/Todo.ts'), 'utf8')).not.toContain('mongoose')
    })

    it('requires review for destructive changes and required additions without a default', async () => {
        const a = await schema('model Todo {\n title: String\n}')
        const b = await schema('model Todo {\n done: Boolean!\n}')
        const diff = diffSchemas(a, b)
        expect(diff.changes).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'dropColumn', column: 'title', review: true }),
            expect.objectContaining({ kind: 'addColumn', column: 'done', review: true }),
        ]))
        prepareMigration(directory, a).commit()
        prepareMigration(directory, b).commit()
        const migration = require(path.join(directory, 'database/migrations', migrations()[1]))
        const raw = jest.fn()
        const original = process.env.GMB_ALLOW_DESTRUCTIVE_MIGRATIONS
        delete process.env.GMB_ALLOW_DESTRUCTIVE_MIGRATIONS
        try { await expect(migration.up({ raw })).rejects.toThrow('requires review') }
        finally { if (original !== undefined) process.env.GMB_ALLOW_DESTRUCTIVE_MIGRATIONS = original }
        expect(raw).not.toHaveBeenCalled()
    })

    it('checks the provider and snapshot before clearing the generated backend', async () => {
        await exportAsFromString('sql', 'model Todo {\n title: String\n}', directory, { database: 'postgresql' })
        fs.writeFileSync(path.join(directory, 'gen/keep.txt'), 'preserve on failure')
        await expect(exportAsFromString('sql', 'model Todo {\n title: String\n}', directory, { database: 'mysql' })).rejects.toThrow('Cannot change')
        expect(fs.readFileSync(path.join(directory, 'gen/keep.txt'), 'utf8')).toBe('preserve on failure')
        const snapshotPath = path.join(directory, 'database/schema.snapshot.json')
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
        snapshot.hash = 'corrupt'
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot))
        await expect(exportAsFromString('sql', 'model Todo {\n title: String\n}', directory, { database: 'postgresql' })).rejects.toThrow('Invalid database schema snapshot')
    })

    it('does not overwrite an edited historical migration after a partial generation failure', async () => {
        const current = await schema('model Todo {\n title: String\n}')
        prepareMigration(directory, current).commit()
        const file = path.join(directory, 'database/migrations', migrations()[0])
        fs.appendFileSync(file, '\n// edited\n')
        fs.unlinkSync(path.join(directory, 'database/schema.snapshot.json'))
        expect(() => prepareMigration(directory, current).commit()).toThrow('different contents')
        expect(fs.readFileSync(file, 'utf8')).toContain('// edited')
    })

    it('maps scalar fields, embedded entities, arrays and unique indexes', async () => {
        const result = await schema('entity Address {\n city: String!\n}\nmodel Todo {\n title: String @unique\n tags: [String]\n address: Address\n price: Float\n}')
        const todo = result.tables.find(t => t.name === 'Todo')
        expect(todo.columns).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'address', type: 'json', entity: [expect.objectContaining({ name: 'city', required: true })] }),
            expect.objectContaining({ name: 'tags', type: 'json', array: true }),
            expect.objectContaining({ name: 'price', type: 'float' }),
        ]))
        expect(result.tables.some(t => t.name === 'Address')).toBe(false)
    })

    it('rejects unknown providers', () => { expect(() => databaseProvider('sqlite')).toThrow('Unsupported database') })

    it.each(['postgresql', 'mysql'] as const)('quotes defaults and generates %s alterations for types and nullability', provider => {
        const previous: DatabaseSchema = { format: 1, provider, tables: [{ name: 'Item', columns: [{ name: 'value', type: 'integer', required: false }], unique: [] }] }
        const next: DatabaseSchema = { format: 1, provider, tables: [{ name: 'Item', columns: [{ name: 'value', type: 'text', required: true, default: "O'Reilly\\path" }], unique: [] }] }
        const plan = diffSchemas(previous, next)
        expect(plan.changes).toEqual([expect.objectContaining({ kind: 'alterColumn', review: true })])
        expect(plan.statements.join('\n')).toContain("O''Reilly\\\\path")
        expect(plan.statements.join('\n')).toContain(provider === 'mysql' ? 'MODIFY COLUMN' : 'USING "value"::text')
    })

    it('rejects a missing migration even when the current schema has not changed', async () => {
        const current = await schema('model Todo {\n title: String\n}')
        prepareMigration(directory, current).commit()
        fs.unlinkSync(path.join(directory, 'database/migrations', migrations()[0]))
        expect(() => prepareMigration(directory, current)).toThrow('Incomplete database migration history')
    })

    it('does not generate SQL into an existing MongoDB backend', async () => {
        await exportAsFromString('mongo', 'model Todo {\n title: String\n}', directory)
        await expect(exportAsFromString('sql', 'model Todo {\n title: String\n}', directory, { database: 'postgresql' })).rejects.toThrow('new backends')
        expect(fs.readFileSync(path.join(directory, 'gen/models/Todo.ts'), 'utf8')).toContain('mongoose')
    })
})
