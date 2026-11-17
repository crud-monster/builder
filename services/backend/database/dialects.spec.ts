import knex, { Knex } from 'knex'
import * as database from '../templates/sql/database'
import { conditions } from '../templates/sql/models'
import { getDialect } from '../templates/sql/dialects'
import type { SqlProvider, SqlSnapshot, SqlTable } from '../templates/sql/types'

const table: SqlTable = {
    name: 'Todo',
    columns: [
        { name: '_id', type: 'id' },
        { name: 'title', type: 'text' },
        { name: 'tags', type: 'json', array: true },
        { name: 'metadata', type: 'json' },
        { name: 'users', type: 'json', array: true, relation: 'User' },
        { name: 'address', type: 'json', entity: [
            { name: 'city', type: 'text' },
            { name: 'active', type: 'boolean' },
            { name: 'number', type: 'integer' },
            { name: 'price', type: 'float' },
            { name: 'since', type: 'datetime' },
            { name: 'metadata', type: 'json' },
        ] },
    ],
}
const users: SqlTable = { name: 'User', columns: [{ name: '_id', type: 'id' }, { name: 'email', type: 'text' }] }

describe.each(['postgresql', 'mysql'] as SqlProvider[])('%s SQL dialect', provider => {
    let connection: Knex
    beforeEach(() => {
        connection = knex({ client: getDialect(provider).client })
        jest.spyOn(database, 'getConnection').mockReturnValue(connection)
        const snapshot: SqlSnapshot = { format: 1, version: 1, hash: 'test', schema: { format: 1, provider, tables: [table, users] } }
        jest.spyOn(database, 'snapshot').mockReturnValue(snapshot)
    })
    afterEach(async () => {
        jest.restoreAllMocks()
        await connection.destroy()
    })
    const compile = (filter: Record<string, unknown>) => conditions(connection('Todo'), table, filter).toSQL()

    it('binds JSON membership, comparisons and regular expression values', () => {
        const value = "x' OR 1=1 --"
        const query = compile({ tags: { $all: [value] }, metadata: { $eq: { city: value } }, title: { $regex: value, $options: 'i' } })
        expect(query.sql).not.toContain(value)
        expect(query.bindings).toContain(provider === 'postgresql' ? JSON.stringify([value]) : JSON.stringify(value))
        expect(query.bindings).toContain(JSON.stringify({ city: value }))
        expect(query.bindings).toContain(value)
        expect(query.sql).toContain(provider === 'postgresql' ? '@>' : 'JSON_CONTAINS')
        expect(query.sql).toContain(provider === 'postgresql' ? '?::jsonb' : 'CAST(? AS JSON)')
        expect(query.sql).toContain(provider === 'postgresql' ? '~*' : 'REGEXP_LIKE')
    })

    it('casts embedded scalar fields and preserves bound JSON paths', () => {
        const query = compile({ address: { city: 'Prague', active: false, number: 0, price: { $gte: 1.5 }, since: { $gte: '2026-01-01' }, metadata: { $eq: { active: false } } } })
        expect(query.bindings).toContain('Prague')
        expect(query.bindings).toContain(false)
        expect(query.bindings).toContain(0)
        expect(query.sql).toContain(provider === 'postgresql' ? '#>>' : 'JSON_EXTRACT')
        expect(query.sql).toContain(provider === 'postgresql' ? 'double precision' : 'DECIMAL(65, 20)')
        expect(query.sql).toContain(provider === 'postgresql' ? 'timestamptz' : 'DATETIME')
        expect(query.sql).toContain(provider === 'postgresql' ? 'boolean' : 'CASE')
    })

    it.each(['$every', '$none'])('correlates relation IDs for %s filters', operator => {
        const query = compile({ users: { [operator]: { email: 'writer@example.com' } } })
        expect(query.sql).toContain('not exists')
        expect(query.sql).toContain('_gmb_relation_0')
        expect(query.sql).toContain(provider === 'postgresql' ? 'jsonb_build_array' : 'JSON_QUOTE')
        expect(query.bindings).toContain('writer@example.com')
    })

    it('uses the selected driver and default port', () => {
        expect(getDialect(provider)).toMatchObject(provider === 'postgresql'
            ? { client: 'pg', port: 5432 }
            : { client: 'mysql2', port: 3306 })
    })
})

it('rejects unsupported SQL dialects', () => {
    expect(() => getDialect('sqlite' as SqlProvider)).toThrow('Unsupported SQL provider')
})
