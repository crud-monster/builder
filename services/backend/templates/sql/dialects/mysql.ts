import type { SqlDialect } from '../types'

export const mysql: SqlDialect = {
    client: 'mysql2',
    port: 3306,
    jsonContains(query, field, value) {
        query.whereRaw('JSON_CONTAINS(??, ?)', [field, JSON.stringify(value)])
    },
    jsonContainsColumn(query, field, column) {
        query.whereRaw('JSON_CONTAINS(??, JSON_QUOTE(??))', [field, column])
    },
    jsonExtract(connection, root, segments, type) {
        const extraction = connection.raw(type === 'json' ? 'JSON_EXTRACT(??, ?)' : 'JSON_UNQUOTE(JSON_EXTRACT(??, ?))', [root, '$.' + segments.map(s => `"${s}"`).join('.')])
        const types: Record<string, string> = { integer: 'SIGNED', float: 'DECIMAL(65, 20)', datetime: 'DATETIME' }
        if (type === 'boolean') return connection.raw("CASE ? WHEN 'true' THEN 1 WHEN 'false' THEN 0 ELSE NULL END", [extraction])
        return types[type] ? connection.raw(`CAST(? AS ${types[type]})`, [extraction]) : extraction
    },
    regex(query, field, pattern, insensitive) {
        query.whereRaw('REGEXP_LIKE(??, ?, ?)', [field, pattern, insensitive ? 'i' : 'c'])
    },
    jsonCompare(query, field, operator, value) {
        query.whereRaw(`?? ${operator} CAST(? AS JSON)`, [field, JSON.stringify(value)])
    },
}
