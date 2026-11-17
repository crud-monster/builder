import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { exportAsFromString } from '../../build'
import { getModelsFromSchema } from '../../../parser/scan'
import { generateRustModels, rustString } from './generators/models'

const schema = `
entity Address {
    city: String!
}
model Task {
    title: String! @default("hello")
    type: String
    self: String
    done: Boolean @default(false)
    count: Int @default(0)
    amount: Float @default(1)
    tags: [String]
    dueAt: DateTime
    address: Address
    secret: String @hidden
}
`

describe('Rust target', () => {
    let directory: string
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-rust-unit-')) })
    afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }) })

    it('generates a standalone Rust project with nullable fields, typed entities, ID relations and defaults', async () => {
        await exportAsFromString('../rust-demo', schema, directory, { target: 'rust' })
        const models = fs.readFileSync(path.join(directory, 'src/generated/models.rs'), 'utf8')
        expect(models).toContain('pub struct TaskRecord')
        expect(models).toContain('pub struct AddressEntity')
        expect(models).toContain('pub address: std::option::Option<AddressEntity>')
        expect(models).toContain('pub tags: std::option::Option<std::vec::Vec<std::string::String>>')
        expect(models).toContain('pub due_at: std::option::Option<chrono::DateTime<chrono::Utc>>')
        expect(models).toContain('pub user: std::option::Option<std::string::String>')
        expect(models).toContain('pub r#type: std::option::Option<std::string::String>')
        expect(models).toContain('pub self_: std::option::Option<std::string::String>')
        expect(models).toContain('#[serde(rename = "dueAt")]')
        expect(models).toContain('Some(false)')
        expect(models).toContain('Some(0)')
        expect(models).toContain('Some(1f64)')
        expect(models).toContain('#[serde(skip_serializing)]\n    #[serde(default)]\n    pub secret:')
        expect(models).not.toContain('derive(Debug')
        expect(fs.readFileSync(path.join(directory, 'Cargo.toml'), 'utf8')).toContain('name = "crud-rust-demo"')
        expect(fs.readFileSync(path.join(directory, 'src/generated/source.schema'), 'utf8')).toBe(schema)
        expect(fs.existsSync(path.join(directory, 'package.json'))).toBe(false)
        expect(fs.existsSync(path.join(directory, 'database'))).toBe(false)
    })

    it('preserves editable project files and updates only generated models on regeneration', async () => {
        await exportAsFromString('rust', schema, directory, { target: 'rust', database: 'postgresql' })
        for (const file of ['Cargo.toml', 'src/main.rs', 'src/lib.rs', 'README.md', 'Cargo.lock']) fs.writeFileSync(path.join(directory, file), 'custom ' + file)
        const updated = schema.replace('    tags: [String]', '    tags: [String]\n    extra: Int!')
        await exportAsFromString('rust', updated, directory, { target: 'rust' })
        expect(fs.readFileSync(path.join(directory, 'src/generated/models.rs'), 'utf8')).toContain('pub extra: i32')
        for (const file of ['Cargo.toml', 'src/main.rs', 'src/lib.rs', 'README.md', 'Cargo.lock']) expect(fs.readFileSync(path.join(directory, file), 'utf8')).toBe('custom ' + file)
    })

    it.each(['mongodb', 'mysql'] as const)('rejects unsupported database %s before writing files', async database => {
        await expect(exportAsFromString('rust', schema, directory, { target: 'rust', database })).rejects.toThrow('only postgresql')
        expect(fs.readdirSync(directory)).toEqual([])
    })

    it('does not overwrite an existing TypeScript project or an unrelated Cargo project', async () => {
        fs.writeFileSync(path.join(directory, 'Cargo.toml'), 'existing project')
        await expect(exportAsFromString('rust', schema, directory, { target: 'rust' })).rejects.toThrow('Choose a new output directory')
        expect(fs.readdirSync(directory)).toEqual(['Cargo.toml'])
        expect(fs.readFileSync(path.join(directory, 'Cargo.toml'), 'utf8')).toBe('existing project')
    })

    it('prevents switching an existing Rust output directory back to TypeScript', async () => {
        await exportAsFromString('rust', schema, directory, { target: 'rust' })
        const file = path.join(directory, 'src/generated/models.rs')
        const original = fs.readFileSync(file, 'utf8')
        await expect(exportAsFromString('typescript', schema, directory)).rejects.toThrow('different backend target')
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
        expect(fs.existsSync(path.join(directory, 'package.json'))).toBe(false)
    })

    it('rejects incompatible generation metadata', async () => {
        await exportAsFromString('rust', schema, directory, { target: 'rust' })
        const file = path.join(directory, '.gmb-project.json')
        fs.writeFileSync(file, JSON.stringify({ format: 1, target: 'rust', database: 'mysql' }))
        await expect(exportAsFromString('rust', schema, directory, { target: 'rust' })).rejects.toThrow('Incompatible Rust project metadata')
    })

    it('rejects field collisions before touching generated output', async () => {
        await exportAsFromString('rust', schema, directory, { target: 'rust' })
        const file = path.join(directory, 'src/generated/models.rs')
        const original = fs.readFileSync(file, 'utf8')
        const invalid = schema.replace('    tags: [String]', '    tags: [String]\n    due_at: String')
        await expect(exportAsFromString('rust', invalid, directory, { target: 'rust' })).rejects.toThrow('Rust field name collision')
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
    })

    it('rejects type-name collisions', () => {
        const models = getModelsFromSchema('model Task {\n title: String\n}\nmodel TASK {\n title: String\n}')
        expect(() => generateRustModels(models)).toThrow('Rust type name collision')
    })

    it('rejects recursive embedded entities before output writes', async () => {
        const recursive = 'entity Address {\n next: Address\n}\nmodel Task {\n address: Address\n}'
        await expect(exportAsFromString('rust', recursive, directory, { target: 'rust' })).rejects.toThrow('Recursive embedded entity')
        expect(fs.readdirSync(directory)).toEqual([])
    })

    it('rejects defaults that cannot be represented by the generated scalar type', async () => {
        const invalid = 'model Task {\n count: Int @default(2147483648)\n}'
        await expect(exportAsFromString('rust', invalid, directory, { target: 'rust' })).rejects.toThrow('out-of-range Rust default')
        expect(fs.readdirSync(directory)).toEqual([])
    })

    it('rejects unsupported types rather than emitting uncompilable fields', () => {
        const models = getModelsFromSchema('model Task {\n title: String\n}')
        models.find(model => model.modelName === 'Task').members.find(member => member.name === 'title').modelName = 'Unsupported'
        expect(() => generateRustModels(models)).toThrow('Unsupported Rust type')
    })

    it('does not follow a generated-file symlink, including a dangling link', async () => {
        await exportAsFromString('rust', schema, directory, { target: 'rust' })
        const file = path.join(directory, 'src/generated/models.rs')
        const outside = path.join(directory, 'must-not-be-created.rs')
        fs.unlinkSync(file)
        fs.symlinkSync(outside, file)
        await expect(exportAsFromString('rust', schema, directory, { target: 'rust' })).rejects.toThrow('symbolic link')
        expect(fs.existsSync(outside)).toBe(false)
    })

    it('rejects TypeScript template overrides and unsupported integration-test generation', async () => {
        await expect(exportAsFromString('rust', schema, directory, { target: 'rust', extras: {} })).rejects.toThrow('template overrides')
        await expect(exportAsFromString('rust', schema, directory, { target: 'rust', integrationTestsEnable: true })).rejects.toThrow('integration test generation')
        expect(fs.readdirSync(directory)).toEqual([])
    })

    it('escapes Rust string literals without interpreting literal backslash sequences', () => {
        expect(rustString('a\\b"c\n\t\b\f')).toBe('"a\\\\b\\"c\\n\\t\\u{8}\\u{c}"')
        expect(() => rustString('\ud800')).toThrow('unpaired Unicode surrogates')
    })
})
