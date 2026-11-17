import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { exportAsFromString } from '../build'
import { resolveBackendTarget } from './index'
import type { BackendConfig } from './types'

function generatedFiles(directory: string, prefix = ''): Record<string, string> {
    const result: Record<string, string> = {}
    for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
        const name = path.join(prefix, entry.name)
        if (entry.isDirectory()) Object.assign(result, generatedFiles(directory, name))
        // Each project intentionally gets its own randomly generated JWT secret.
        else if (!entry.name.startsWith('.env')) result[name] = fs.readFileSync(path.join(directory, name), 'utf8')
    }
    return result
}

describe('backend targets', () => {
    let directory: string
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-target-'))
        jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'))
        jest.spyOn(Math, 'random').mockReturnValue(0.123456789)
    })
    afterEach(() => {
        jest.restoreAllMocks()
        jest.useRealTimers()
        fs.rmSync(directory, { recursive: true, force: true })
    })

    it.each(['mongodb', 'postgresql', 'mysql'] as const)('preserves default output with explicit TypeScript target for %s', async database => {
        const implicit = path.join(directory, 'implicit')
        const explicit = path.join(directory, 'explicit')
        const source = 'model Todo {\n title: String\n done: Boolean\n}'
        await exportAsFromString('same-project', source, implicit, { database })
        await exportAsFromString('same-project', source, explicit, { database, target: 'typescript' })
        expect(generatedFiles(explicit)).toEqual(generatedFiles(implicit))
    })

    it('defaults to TypeScript', () => {
        expect(resolveBackendTarget().name).toBe('typescript')
    })

    it('rejects unsupported targets before touching existing output', async () => {
        const marker = path.join(directory, 'gen', 'keep.txt')
        fs.mkdirSync(path.dirname(marker))
        fs.writeFileSync(marker, 'keep')
        const config = { target: 'rust' } as unknown as BackendConfig
        await expect(exportAsFromString('project', 'invalid schema', directory, config)).rejects.toThrow('Unsupported target: rust')
        expect(fs.readFileSync(marker, 'utf8')).toBe('keep')
        expect(fs.readdirSync(directory)).toEqual(['gen'])
    })
})
