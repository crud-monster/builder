import type { SqlDialect } from '../types'

export const postgresql: SqlDialect = {
    client: 'pg',
    port: 5432,
    jsonContains(query, field, value) {
        query.whereRaw('?? @> ?::jsonb', [field, JSON.stringify([value])])
    },
    jsonContainsColumn(query, field, column) {
        query.whereRaw('?? @> jsonb_build_array(??)', [field, column])
    },
    jsonExtract(connection, root, segments, type) {
        const types: Record<string, string> = { integer: 'integer', float: 'double precision', boolean: 'boolean', datetime: 'timestamptz' }
        const extraction = connection.raw(`?? ${type === 'json' ? '#>' : '#>>'} ?::text[]`, [root, segments])
        return types[type] ? connection.raw(`CAST(? AS ${types[type]})`, [extraction]) : extraction
    },
    regex(query, field, pattern, insensitive) {
        query.whereRaw(`?? ${insensitive ? '~*' : '~'} ?`, [field, pattern])
    },
    jsonCompare(query, field, operator, value) {
        query.whereRaw(`?? ${operator} ?::jsonb`, [field, JSON.stringify(value)])
    },
}
