import type { SchemaModel } from '../../common/types'
import type { DatabaseProvider } from '../database/schema'

export type BackendTargetName = 'typescript'

export interface BackendConfig {
    target?: BackendTargetName
    database?: DatabaseProvider
    integrationTestsEnable?: boolean
    [template: string]: any
}

export interface BackendTargetContext {
    name: string
    source: string
    outDir: string
    models: SchemaModel[]
    config: BackendConfig
}

export interface BackendTarget {
    readonly name: BackendTargetName
    generate(context: BackendTargetContext): Promise<void>
}
