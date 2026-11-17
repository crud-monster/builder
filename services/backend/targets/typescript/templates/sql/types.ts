import type { Knex } from 'knex'

export type SqlProvider = 'postgresql' | 'mysql'
export type SqlColumnType = 'id' | 'string' | 'text' | 'integer' | 'float' | 'boolean' | 'datetime' | 'json'
export interface SqlColumn {
    name: string
    type: SqlColumnType
    required?: boolean
    default?: string | number | boolean
    array?: boolean
    itemType?: SqlColumnType
    relation?: string
    entity?: SqlColumn[]
    pattern?: string
}
export interface SqlTable {
    name: string
    columns: SqlColumn[]
    unique?: string[][]
}
export interface SqlSnapshot {
    format: 1
    version: number
    hash: string
    schema: { format: 1; provider: SqlProvider; tables: SqlTable[] }
}
export interface ConnectionOptions { host?: string; db?: string }
export type SqlRecord = Record<string, any>
export type SqlFilter = Record<string, any>
export type SqlField = string | Knex.Raw
export type SqlQuery = Knex.QueryBuilder<any, any>
export interface JsonPath { root: SqlField; segments: string[] }
export interface SqlDialect {
    readonly client: 'pg' | 'mysql2'
    readonly port: number
    jsonContains(query: SqlQuery, field: SqlField, value: unknown): void
    jsonContainsColumn(query: SqlQuery, field: SqlField, column: string): void
    jsonExtract(connection: Knex, root: SqlField, segments: string[], type: SqlColumnType): SqlField
    regex(query: SqlQuery, field: SqlField, pattern: string, insensitive: boolean): void
    jsonCompare(query: SqlQuery, field: SqlField, operator: '=' | '<>', value: unknown): void
}
