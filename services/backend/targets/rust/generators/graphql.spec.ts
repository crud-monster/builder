import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getModelsFromSchema } from '../../../../parser/scan'
import { exportAsFromString } from '../../../build'
import { generateRustGraphql, supportsRustCrud } from './graphql'

const publicRules = '@all("public") @one("public") @create("public") @update("public") @remove("public")'
const source = `${publicRules}\nmodel Todo {\n message: String!\n done: Boolean @default(false)\n secret: String @hidden\n marker: String @readonly\n}`

function models(schema: string) { return getModelsFromSchema(schema) }
function resolver(generated: string, suffix: string) {
    return generated.slice(generated.indexOf(`async fn m0_${suffix}(`)).split('\n    }')[0]
}

describe('Rust GraphQL CRUD', () => {
    it('generates a typed public API while excluding system models, hidden writes and readonly writes', () => {
        const generated = generateRustGraphql(models(source))
        for (const suffix of ['one', 'all', 'create', 'update', 'remove']) {
            expect(resolver(generated, suffix)).toContain('crud::authorize(true)?')
        }
        expect(generated).toContain('graphql(name = "todoCreate")')
        expect(generated).toContain('pub struct CrudTodoRecordCreate')
        expect(generated).toContain('pub message: std::string::String')
        expect(generated).toContain('pub id: async_graphql::ID')
        expect(generated).toContain('MaybeUndefined<bool>')
        expect(generated).not.toContain('pub secret:')
        const inputs = generated.slice(generated.indexOf('pub struct CrudTodoRecordCreate'), generated.indexOf('pub struct QueryRoot'))
        expect(inputs).not.toContain('pub marker:')
        expect(inputs).not.toContain('pub id:')
        expect(generated).toContain('async fn login(')
        expect(generated).toContain('async fn me(')
        expect(generated).not.toContain('async fn register(')
        expect(generated).not.toContain('userCreate')
        expect(generated).not.toContain('userRoleCreate')
        expect(generated).not.toContain('fileCreate')
    })

    it('denies owner-filtered lists without changing public single-record permissions', () => {
        const generated = generateRustGraphql(models(source.replace('@all("public")', '@all(filter:"user_every.id={{userId}}")')))
        expect(resolver(generated, 'all')).toContain('crud::authorize(false)?')
        expect(resolver(generated, 'one')).toContain('crud::authorize(true)?')
        expect(resolver(generated, 'create')).toContain('crud::authorize(true)?')
    })

    it('requires public reads before returning records from lists or mutations', () => {
        const generated = generateRustGraphql(models(source.replace('@one("public")', '@one("owner")')))
        for (const suffix of ['one', 'all', 'create', 'update']) expect(resolver(generated, suffix)).toContain('crud::authorize(false)?')
        expect(resolver(generated, 'remove')).toContain('crud::authorize(true)?')
    })

    it.each([
        'name: String! @unique',
        'name: String @regExp("[A-Za-z]+")',
        'name: String! @hidden',
        'name: String! @readonly',
        'address: Address',
    ])('keeps unsupported constraints out of the CRUD API: %s', member => {
        const parsed = models(`entity Address {\n city: String\n}\n${publicRules}\nmodel Todo {\n message: String\n ${member}\n}`)
        expect(supportsRustCrud(parsed.find(model => model.modelName === 'Todo'))).toBe(false)
        const generated = generateRustGraphql(parsed)
        expect(generated).not.toContain('todoCreate')
        expect(generated).toContain('async fn login(')
    })

    it('regenerates permissions while preserving server customizations', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-crud-unit-'))
        try {
            await exportAsFromString('crud', source, directory, { target: 'rust' })
            fs.appendFileSync(path.join(directory, 'src/server.rs'), '\n// custom server\n')
            await exportAsFromString('crud', source.replace('@update("public")', '@update("owner")'), directory, { target: 'rust' })
            const generated = fs.readFileSync(path.join(directory, 'src/generated/graphql.rs'), 'utf8')
            expect(resolver(generated, 'update')).toContain('crud::authorize(false)?')
            expect(fs.readFileSync(path.join(directory, 'src/server.rs'), 'utf8')).toContain('// custom server')
            expect(fs.readFileSync(path.join(directory, 'src/generated/mod.rs'), 'utf8')).toContain('pub mod graphql;')
        } finally {
            fs.rmSync(directory, { recursive: true, force: true })
        }
    })
})
