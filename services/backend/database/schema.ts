import { createHash } from 'crypto'
import { SchemaModel, SchemaModelRelationType, SchemaModelType } from '../../common/types'

export type DatabaseProvider = 'mongodb' | 'postgresql' | 'mysql'
export interface DatabaseColumn {
    name: string
    type: 'id' | 'string' | 'text' | 'integer' | 'float' | 'boolean' | 'datetime' | 'json'
    required: boolean
    default?: string | number | boolean
    array?: boolean
    itemType?: DatabaseColumn['type']
    relation?: string
    entity?: DatabaseColumn[]
    pattern?: string
}
export interface DatabaseTable {
    name: string
    columns: DatabaseColumn[]
    unique: string[][]
}
export interface DatabaseSchema {
    format: 1
    provider: DatabaseProvider
    tables: DatabaseTable[]
}

export function databaseProvider(value: unknown = 'mongodb'): DatabaseProvider {
    if (value !== 'mongodb' && value !== 'postgresql' && value !== 'mysql') {
        throw new Error(`Unsupported database: ${value}. Use mongodb, postgresql or mysql.`)
    }
    return value
}

const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0
const identifier = (name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid database identifier: ${name} (maximum 63 ASCII characters)`)
    return name
}

export function schemaFromModels(models: SchemaModel[], provider: DatabaseProvider): DatabaseSchema {
    const columnsFor = (model: SchemaModel, parents: string[] = []): DatabaseColumn[] => {
        if (parents.includes(model.modelName)) throw new Error(`Recursive embedded entity: ${model.modelName}`)
        return model.members.filter(m => !m.isVirtual && !['id', 'createdAt', 'updatedAt'].includes(m.name)).map(member => {
            const column: DatabaseColumn = {
                name: identifier(member.name),
                type: member.isArray || member.relation?.type === SchemaModelRelationType.ENTITY ? 'json'
                    : member.relation ? 'id'
                    : ({ ID: 'id', String: member.isUnique ? 'string' : 'text', Int: 'integer', Float: 'float', Boolean: 'boolean', DateTime: 'datetime' } as const)[member.modelName],
                required: !!member.isRequired,
            }
            if (!column.type) throw new Error(`Unsupported database type: ${model.modelName}.${member.name}: ${member.modelName}`)
            if (member.default !== undefined) column.default = member.default
            if (member.isArray) {
                column.array = true
                if (!member.relation) column.itemType = ({ ID: 'id', String: 'text', Int: 'integer', Float: 'float', Boolean: 'boolean', DateTime: 'datetime' } as const)[member.modelName]
            }
            if (member.regExp) column.pattern = member.regExp
            if (member.relation?.type === SchemaModelRelationType.ENTITY) column.entity = columnsFor(member.relation.relatedModel, [...parents, model.modelName])
            else if (member.relation) column.relation = member.relation.relatedModel.modelName
            return column
        }).sort(byName)
    }
    const tables = models.filter(m => m.type === SchemaModelType.MODEL).map(model => {
        const columns = columnsFor(model)
        columns.push({ name: '_id', type: 'id', required: true }, { name: 'createdAt', type: 'datetime', required: true }, { name: 'updatedAt', type: 'datetime', required: true })
        const unique = model.members.filter(m => !m.isVirtual && m.isUnique && m.name !== 'id').map(m => [m.name, ...(Array.isArray(m.isUnique) ? m.isUnique : [])].map(name => name === 'id' ? '_id' : name))
        if (model.modelName === 'User') {
            for (const name of ['__token', '__refreshToken', '__verifyToken', '__password', '__resetPasswordToken', '__parent_access_token']) {
                columns.push({ name, type: ['__verifyToken', '__resetPasswordToken'].includes(name) ? 'string' : 'text', required: name === '__password' })
            }
            unique.push(['__verifyToken'], ['__resetPasswordToken'])
        }
        if (model.modelName === 'File') columns.push({ name: '__path', type: 'text', required: true })
        const seen = new Set<string>()
        for (const column of columns) {
            const key = column.name.toLowerCase()
            if (seen.has(key)) throw new Error(`Duplicate database column: ${model.modelName}.${column.name}`)
            seen.add(key)
        }
        for (const names of unique) {
            for (const name of names) {
                const column = columns.find(c => c.name === name)
                if (!column || column.type === 'json') throw new Error(`Unsupported unique index: ${model.modelName}.${names.join(',')}`)
                if (column.type === 'text') column.type = 'string'
            }
        }
        return { name: identifier(model.modelName), columns: columns.sort(byName), unique: unique.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) }
    }).sort(byName)
    if (new Set(tables.map(t => t.name.toLowerCase())).size !== tables.length) throw new Error('Model names must be unique ignoring case')
    return { format: 1, provider, tables }
}

export const schemaHash = (schema: DatabaseSchema) => createHash('sha256').update(JSON.stringify(schema)).digest('hex')
