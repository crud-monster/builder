// SQL implementation of the small model API used by generated services and authentication.
import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import type { Knex } from 'knex'
import * as database from './database'
import { getDialect } from './dialects'
import type { JsonPath, SqlColumn, SqlField, SqlFilter, SqlQuery, SqlRecord, SqlTable } from './types'
const transactions = new AsyncLocalStorage<Knex.Transaction>()
const registry = new Map<string, SqlModel>()
const db = (): Knex => transactions.getStore() || database.getConnection()
const dialect = () => getDialect(database.snapshot().schema.provider)
const idValue = (value: any): any => value && typeof value === 'object' && !Array.isArray(value) ? String(value._id || value.id || value) : value
const comparisonOperators: Record<string, string> = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export async function transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (transactions.getStore()) return callback()
    return database.getConnection().transaction(trx => transactions.run(trx, callback))
}

export function transactionalServices<T extends Record<string, (...args: any[]) => any>>(services: T): T {
    return Object.fromEntries(Object.entries(services).map(([name, fn]) => [name, (...args) => transaction(() => fn(...args))])) as T
}

function tableFor(name: string): SqlTable {
    const table = database.snapshot().schema.tables.find(t => t.name === name)
    if (!table) throw new Error(`Unknown SQL model: ${name}`)
    return table
}

function columnFor(table: SqlTable, name: string): SqlColumn {
    const column = table.columns.find(c => c.name === name)
    if (!column) throw new Error(`Unknown SQL field: ${table.name}.${name}`)
    return column
}

function arrayContains(query: SqlQuery, field: SqlField, value: unknown) {
    dialect().jsonContains(query, field, idValue(value))
}

// Every identifier is checked against generated metadata; values are bound parameters.
export function conditions(query: SqlQuery, table: SqlTable, filter: SqlFilter = {}, qualifier = table.name, depth = 0, jsonPath?: JsonPath): SqlQuery {
    for (let [name, value] of Object.entries(filter || {})) {
        if (name === '$and' || name === '$or') {
            if (!Array.isArray(value)) throw new Error(`${name} expects an array`)
            query.where(function () {
                if (!value.length) this.whereRaw(name === '$or' ? '1 = 0' : '1 = 1')
                value.forEach(child => this[name === '$or' ? 'orWhere' : 'where'](function () { conditions(this, table, child, qualifier, depth, jsonPath) }))
            })
            continue
        }
        if (name === 'id') name = '_id'
        const column = columnFor(table, name)
        let field: SqlField = `${qualifier}.${name}`
        if (jsonPath) {
            const segments = [...jsonPath.segments, name]
            field = dialect().jsonExtract(db(), jsonPath.root, segments, column.type)
        }
        // Knex accepts raw expressions, but several column overloads only declare strings.
        const columnRef = field as string
        const object = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
        if (object && column.entity && (!Object.keys(value).some(k => k.startsWith('$') && !['$and', '$or'].includes(k)) || '$every' in value || '$none' in value)) {
            if (column.array) throw new Error('Filtering inside arrays of embedded entities is not supported by the SQL adapter')
            conditions(query, { name: table.name, columns: column.entity }, value, qualifier, depth,
                jsonPath ? { root: jsonPath.root, segments: [...jsonPath.segments, name] } : { root: field, segments: [] })
            continue
        }
        if (object && column.relation && (!Object.keys(value).some(k => k.startsWith('$') && !['$and', '$or'].includes(k)) || '$every' in value || '$none' in value)) {
            const related = tableFor(column.relation)
            const alias = `_gmb_relation_${depth}`
            const nested = value.$every || value.$none || value
            const subquery = db()({ [alias]: related.name }).select(`${alias}._id`)
            conditions(subquery, related, nested, alias, depth + 1)
            if (column.array) {
                const matching = db()({ [alias]: related.name }).select(db().raw('1'))
                conditions(matching, related, nested, alias, depth + 1)
                dialect().jsonContainsColumn(matching, field, `${alias}._id`)
                if ('$every' in value) {
                    const failing = db()({ [alias]: related.name }).select(db().raw('1')).whereNot(function () { conditions(this, related, nested, alias, depth + 1) })
                    dialect().jsonContainsColumn(failing, field, `${alias}._id`)
                    query.whereNotExists(failing)
                } else query['$none' in value ? 'whereNotExists' : 'whereExists'](matching)
            } else query['$none' in value ? 'whereNotIn' : 'whereIn'](columnRef, subquery)
            continue
        }
        const operators = object ? value : { $eq: value }
        for (const [operator, operand] of Object.entries<any>(operators)) {
            if (operator === '$options') continue
            if (operator === '$not') {
                query.where(function () { this.whereNull(columnRef).orWhereNot(function () { conditions(this, table, { [name]: operand }, qualifier, depth, jsonPath) }) })
            } else if (operator === '$in' || operator === '$nin') {
                const values = Array.isArray(operand) ? operand : [operand]
                if (column.array) query[operator === '$nin' ? 'whereNot' : 'where'](function () {
                    if (!values.length) this.whereRaw('1 = 0')
                    values.forEach(v => this.orWhere(function () { arrayContains(this, field, v) }))
                })
                else if (operator === '$in') query.whereIn(columnRef, values.map(idValue))
                else query.where(function () { this.whereNull(columnRef).orWhereNotIn(columnRef, values.map(idValue)) })
            } else if (operator === '$all') {
                if (!Array.isArray(operand)) throw new Error('$all expects an array')
                operand.forEach(v => arrayContains(query, field, v))
            } else if (operator === '$regex') {
                const insensitive = String(operators.$options || '').includes('i')
                dialect().regex(query, field, String(operand), insensitive)
            } else if (operator === '$exists') query[operand ? 'whereNotNull' : 'whereNull'](columnRef)
            else if (operator === '$eq' || operator === '$ne') {
                if (operand == null) query[operator === '$eq' ? 'whereNull' : 'whereNotNull'](columnRef)
                else if (column.array && !Array.isArray(operand)) {
                    if (operator === '$eq') arrayContains(query, field, operand)
                    else query.where(function () { this.whereNull(columnRef).orWhereNot(function () { arrayContains(this, field, operand) }) })
                } else if (column.type === 'json') dialect().jsonCompare(query, field, operator === '$eq' ? '=' : '<>', operand)
                else if (operator === '$eq') query.where(columnRef, idValue(operand))
                else query.where(function () { this.whereNull(columnRef).orWhere(columnRef, '<>', idValue(operand)) })
            } else if (['$gt', '$gte', '$lt', '$lte'].includes(operator)) {
                query.where(columnRef, comparisonOperators[operator], operand)
            } else throw new Error(`Unsupported SQL filter: ${name}.${operator}`)
        }
    }
    return query
}

function normalize(column: SqlColumn, value: any, label: string): any {
    if (value === undefined) value = column.default !== undefined ? column.default : column.array ? [] : null
    if (column.required && value === null) throw new Error(`Required field: ${label}`)
    if (value === null) return null
    const pattern = column.pattern
    if (pattern && !(column.array ? value : [value]).every((v: string) => new RegExp(pattern).test(v))) throw new Error(`Invalid value: ${label}`)
    if (column.array) {
        if (!Array.isArray(value)) throw new Error(`Expected array: ${label}`)
        return value.map(item => normalize({ ...column, array: false, type: column.itemType || (column.entity ? 'json' : 'id'), pattern: undefined }, item, label))
    }
    if (column.entity) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected entity: ${label}`)
        const result: SqlRecord = { _id: value._id || randomUUID(), createdAt: value.createdAt || new Date(), updatedAt: new Date() }
        result.id = result._id
        for (const child of column.entity) result[child.name] = normalize(child, value[child.name], `${label}.${child.name}`)
        return result
    }
    if (column.type === 'id') return idValue(value)
    if (column.type === 'datetime') {
        const date = new Date(value)
        if (!Number.isFinite(date.getTime())) throw new Error(`Expected datetime: ${label}`)
        return date
    }
    if (column.type === 'text' || column.type === 'string') {
        if (typeof value !== 'string') throw new Error(`Expected string: ${label}`)
    } else if (column.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`Expected boolean: ${label}`)
    } else if (column.type === 'integer' || column.type === 'float') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (column.type === 'integer' && !Number.isInteger(value))) throw new Error(`Expected ${column.type}: ${label}`)
    }
    return value
}

function serialize(table: SqlTable, data: SqlRecord, creating = false): SqlRecord {
    const result: SqlRecord = {}
    for (const column of table.columns) {
        let value = data[column.name]
        if (!creating && !(column.name in data)) continue
        // Explicit undefined on an update clears the field (e.g. consumed reset tokens).
        value = normalize(column, !creating && value === undefined ? null : value, `${table.name}.${column.name}`)
        if (value !== null && column.type === 'json') value = JSON.stringify(value)
        result[column.name] = value
    }
    return result
}

function decode(table: SqlTable, row: SqlRecord | undefined): SqlRecord | null {
    if (!row) return null
    const result = { ...row }
    for (const column of table.columns) {
        const value = result[column.name]
        if (value == null) continue
        if (column.type === 'json' && typeof value === 'string') result[column.name] = JSON.parse(value)
        if (column.type === 'boolean') result[column.name] = !!value
        if (column.type === 'datetime' && !(value instanceof Date)) result[column.name] = new Date(value)
    }
    result.id = result._id
    return result
}

function document(table: SqlTable, row: SqlRecord | undefined): SqlRecord | null {
    const value = decode(table, row)
    if (!value) return null
    let original = JSON.parse(JSON.stringify({ ...value }))
    Object.defineProperties(value, {
        save: { value: async () => {
            const patch: SqlRecord = {}
            for (const column of table.columns) if (column.name !== '_id' && !same(value[column.name], original[column.name])) patch[column.name] = value[column.name]
            if (Object.keys(patch).length) await model(table.name).findByIdAndUpdate(value._id, patch)
            original = JSON.parse(JSON.stringify({ ...value }))
            return value
        } },
        toObject: { value: () => ({ ...value }) },
        toJSON: { value: () => Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_id' && !key.startsWith('__'))) },
    })
    return value
}

class Query implements PromiseLike<any> {
    private population: string[] = []
    private plain = false
    private projection?: string | Record<string, unknown>
    private offset?: number
    private maximum?: number
    private order?: Record<string, string | number> | [string, string | number][]

    constructor(private table: SqlTable, private filter: SqlFilter, private one = false, private count = false) {}
    lean() { this.plain = true; return this }
    select(value?: string | Record<string, unknown>) { this.projection = value; return this }
    skip(value: number) { this.offset = value; return this }
    limit(value: number) { this.maximum = value; return this }
    sort(value: Record<string, string | number> | [string, string | number][]) { this.order = value; return this }
    populate(value: string) { this.population.push(value); return this }
    then<TResult1 = any, TResult2 = never>(resolve?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): Promise<TResult1 | TResult2> { return this.exec().then(resolve, reject) }
    async exec(): Promise<any> {
        const { table } = this
        const query = conditions(db()(table.name), table, this.filter)
        if (this.count) return Number((await query.count({ total: '*' }).first()).total)
        if (this.projection) {
            const projection = this.projection
            const fields = typeof projection === 'string' ? projection.split(/\s+/).filter(Boolean) : Object.keys(projection).filter(k => projection[k])
            if (fields.length) query.select([...new Set(['_id', ...fields.map(f => columnFor(table, f).name)])])
        }
        if (this.order) for (const [field, direction] of Array.isArray(this.order) ? this.order : Object.entries(this.order)) query.orderBy(columnFor(table, field === 'id' ? '_id' : field).name, direction === 'desc' || direction === -1 ? 'desc' : 'asc')
        if (this.offset !== undefined) query.offset(this.offset)
        if (this.maximum !== undefined) query.limit(this.maximum)
        const rows = this.one ? [await query.first()] : await query
        const results = []
        for (const row of rows) {
            const result = this.plain ? decode(table, row) : document(table, row)
            if (result) for (const field of this.population) {
                const column = columnFor(table, field)
                if (!column.relation) throw new Error(`Cannot populate ${field}`)
                result[field] = column.array ? await model(column.relation).find({ _id: { $in: result[field] || [] } }) : await model(column.relation).findById(result[field])
            }
            results.push(result)
        }
        return this.one ? results[0] : results
    }
}

export function model(name: string): SqlModel {
    const cached = registry.get(name)
    if (cached) return cached
    // Metadata is loaded lazily, after the generation snapshot has been committed.
    const table = () => tableFor(name)
    const query = (filter: SqlFilter, one = false, count = false, projection?: string | Record<string, unknown>) => new Query(table(), filter, one, count).select(projection)
    const update = (filter: SqlFilter, patch: SqlRecord, one = false) => transaction(async () => {
        const t = table()
        let selection = conditions(db()(name), t, filter).forUpdate()
        if (one) selection = selection.limit(1)
        const rows = await selection
        for (const row of rows) {
            const current = decode(t, row)!
            const data: SqlRecord = { ...(patch.$set || {}) }
            for (const [field, value] of Object.entries(patch)) if (!field.startsWith('$')) data[field] = value
            for (const [field, value] of Object.entries<any>(patch.$push || {})) data[field] = [...(current[field] || []), ...(value && !Array.isArray(value) && value.$each ? value.$each : [value])].map(idValue)
            for (const [field, value] of Object.entries(patch.$pull || {})) data[field] = (current[field] || []).filter((v: unknown) => String(v) !== String(idValue(value)))
            for (const field of Object.keys(patch.$unset || {})) data[field] = null
            for (const op of Object.keys(patch).filter(k => k.startsWith('$'))) if (!['$set', '$push', '$pull', '$unset'].includes(op)) throw new Error(`Unsupported SQL update: ${op}`)
            delete data._id
            data.updatedAt = new Date()
            await db()(name).where('_id', row._id).update(serialize(t, data))
        }
        return { acknowledged: true, matchedCount: rows.length, modifiedCount: rows.length, ids: rows.map((r: SqlRecord) => r._id) }
    })
    const result: SqlModel = {
        find: (filter = {}, projection) => query(filter, false, false, projection),
        findOne: (filter = {}, projection) => query(filter, true, false, projection),
        findById: (id, projection) => query({ _id: idValue(id) || null }, true, false, projection),
        countDocuments: (filter = {}) => query(filter, false, true),
        exists: async filter => (await query(filter, true, false, { _id: 1 })) || null,
        create: async data => {
            const now = new Date()
            const record = serialize(table(), { ...data, _id: data._id ? idValue(data._id) : randomUUID(), createdAt: now, updatedAt: now }, true)
            await db()(name).insert(record)
            return result.findById(record._id)
        },
        updateMany: (filter, patch) => update(filter, patch),
        updateOne: (filter, patch) => update(filter, patch, true),
        findByIdAndUpdate: async (id, patch) => { await update({ _id: idValue(id) }, patch, true); return result.findById(id) },
        findByIdAndDelete: id => transaction(async () => {
            const row = await conditions(db()(name), table(), { _id: idValue(id) }).forUpdate().first()
            if (row) await db()(name).where('_id', row._id).del()
            return document(table(), row)
        }),
        deleteMany: async (filter = {}) => ({ deletedCount: await conditions(db()(name), table(), filter).del() }),
    }
    registry.set(name, result)
    return result
}

export interface SqlModel {
    find(filter?: SqlFilter, projection?: string | Record<string, unknown>): Query
    findOne(filter?: SqlFilter, projection?: string | Record<string, unknown>): Query
    findById(id: unknown, projection?: string | Record<string, unknown>): Query
    countDocuments(filter?: SqlFilter): Query
    exists(filter: SqlFilter): Promise<any>
    create(data: SqlRecord): Promise<any>
    updateMany(filter: SqlFilter, patch: SqlRecord): Promise<any>
    updateOne(filter: SqlFilter, patch: SqlRecord): Promise<any>
    findByIdAndUpdate(id: unknown, patch: SqlRecord): Promise<any>
    findByIdAndDelete(id: unknown): Promise<any>
    deleteMany(filter?: SqlFilter): Promise<{ deletedCount: number }>
}
