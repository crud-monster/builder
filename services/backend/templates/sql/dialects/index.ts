import type { SqlDialect, SqlProvider } from '../types'
import { postgresql } from './postgresql'
import { mysql } from './mysql'

const dialects: Record<SqlProvider, SqlDialect> = { postgresql, mysql }

export function getDialect(provider: SqlProvider): SqlDialect {
    if (provider !== 'postgresql' && provider !== 'mysql') throw new Error(`Unsupported SQL provider: ${provider}`)
    return dialects[provider]
}
