import * as fs from 'fs'
import * as path from 'path'
import { getModelsFromSchema } from '../parser/scan'
import { resolveBackendTarget } from './targets'
import type { BackendConfig } from './targets/types'

export type { BackendConfig, BackendTarget, BackendTargetContext, BackendTargetName } from './targets/types'
// Preserve the existing low-level TypeScript generation API.
export { generateAll } from './targets/typescript/index'

export const exportAs = async (name, from, base = '.', config: BackendConfig = {}) => {
    const importedSchema = fs.readFileSync(from, { encoding: 'utf8' })
    return exportAsFromString(name, importedSchema, base, config)
}

export const exportAsFromString = async (name, importedSchema, outDir = '.', config: BackendConfig = {}) => {
    const target = resolveBackendTarget(config.target)
    const metadataPath = path.join(outDir, '.gmb-project.json')
    if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
        if (!metadata || metadata.format !== 1 || metadata.target !== target.name) throw new Error('Output directory belongs to a different backend target or has incompatible project metadata')
    }
    const models = await getModelsFromSchema(importedSchema)
    await target.generate({ name, source: importedSchema, outDir, models, config })
}
