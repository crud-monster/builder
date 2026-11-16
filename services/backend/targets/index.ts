import type { BackendTarget, BackendTargetName } from './types'
import { typescriptTarget } from './typescript'

const targets: Record<BackendTargetName, BackendTarget> = {
    typescript: typescriptTarget,
}

export function resolveBackendTarget(value: unknown = 'typescript'): BackendTarget {
    if (value !== 'typescript') {
        throw new Error(`Unsupported target: ${String(value)}. Use typescript.`)
    }
    return targets[value]
}
