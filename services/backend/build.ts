import * as fs from 'fs'
import { getModelsFromSchema } from '../parser/scan'
import { resolveBackendTarget } from './targets'
import type { BackendConfig } from './targets/types'

export type { BackendConfig, BackendTarget, BackendTargetContext, BackendTargetName } from './targets/types'
// Preserve the existing low-level TypeScript generation API.
export { generateAll } from './targets/typescript'

export const exportAs = async (name, from, base = '.', config: BackendConfig = {}) => {
    const importedSchema = fs.readFileSync(from, { encoding: 'utf8' })
    return exportAsFromString(name, importedSchema, base, config)
}

export const exportAsFromString = async (name, importedSchema, outDir = '.', config: BackendConfig = {}) => {
    const target = resolveBackendTarget(config.target)
    const models = await getModelsFromSchema(importedSchema)
    await target.generate({ name, source: importedSchema, outDir, models, config })
}
