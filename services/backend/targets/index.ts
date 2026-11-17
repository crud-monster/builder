import type { BackendTarget, BackendTargetName } from './types'
import { rustTarget } from './rust'
import { typescriptTarget } from './typescript/index'

const targets: Record<BackendTargetName, BackendTarget> = {
    typescript: typescriptTarget,
    rust: rustTarget,
}

export function resolveBackendTarget(value: unknown = 'typescript'): BackendTarget {
    if (value !== 'typescript' && value !== 'rust') {
        throw new Error(`Unsupported target: ${String(value)}. Use typescript or rust.`)
    }
    return targets[value]
}
