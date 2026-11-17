import { graphql, ExecutionResult } from 'graphql'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { SchemaModelProtectionParam, SchemaModelProtectionType, SchemaModelType, StructureBackend } from '@common/types'
import { getModelsFromSchema } from '../../../../parser/scan'
import { createResolver } from './resolvers'
import { createResolvers } from './entry'
import { generateDataloadersWorker } from './dataloaders'
import { cleanApplayedRelations, generateSchemaAsString } from './schema'
import * as extras from '../templates/extras'
import * as apiUtils from '../templates/api/api-utils.t'

function evaluate(source: string, entry?: any) {
    const output = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } }).outputText
    const exports: Record<string, any> = {}
    const dependencies = { '../extras': extras, '../api-utils': apiUtils, './api-utils': apiUtils }
    new Function('exports', 'require', 'entry', output)(exports, name => dependencies[name] || require(name), entry)
    return exports
}

function setup(rule: SchemaModelProtectionParam = { type: SchemaModelProtectionType.OWNER }, people = ['alice']) {
    const models = getModelsFromSchema(`
        @one("public") @all("public")
        model Page {
            title: String
            people: [@relation(name: "PagePeople")]
        }
        model Person {
            email: String
            pages: [@relation(name: "PagePeople")]
        }
    `)
    const userModel = models.find(model => model.modelName === 'User')
    userModel.protection.one = [rule]
    models.find(model => model.modelName === 'Person').protection.one = [rule]
    const rows = {
        user: [
            { _id: 'alice', id: 'alice', email: 'alice@private.test' },
            { _id: 'bob', id: 'bob', email: 'bob@private.test' },
        ],
        page: [{ _id: 'page', id: 'page', title: 'public', user: 'alice', people }],
    }
    rows['person'] = rows.user.map(user => ({ ...user, user: user.id }))
    const memberships = { admin: ['admin'], reader: ['reader'] }
    const entry = { models: {}, services: {}, resolvers: {}, dataloaders: {}, hooks: { resolvers: {} } } as any
    for (const model of models.filter(model => model.type === SchemaModelType.MODEL)) {
        const lower = model.modelName[0].toLowerCase() + model.modelName.slice(1)
        const records = rows[lower] || []
        const selected = (filter) => {
            const ids = filter._id.$in
            return records.filter(row => (Array.isArray(ids) ? ids : [ids]).map(String).includes(String(row._id)))
        }
        entry.models[lower] = {
            findById: jest.fn(id => ({ lean: async () => records.find(row => row._id === id) || null })),
            // Return reverse order to detect wrong identity assignment in batch caches.
            find: jest.fn(async filter => selected(filter).slice().reverse().map(row => ({ ...row }))),
            countDocuments: jest.fn(async filter => selected(filter).length),
            exists: jest.fn(async query => memberships[query.users]?.includes(query.name) ? { _id: query.name } : null),
        }
        entry.services[lower] = { one: jest.fn(async id => records.find(row => row._id === id) || null) }
    }
    for (const model of models.filter(model => model.type === SchemaModelType.MODEL)) {
        const lower = model.modelName[0].toLowerCase() + model.modelName.slice(1)
        entry.resolvers[lower] = evaluate(createResolver(model))['generate' + model.modelName + 'Resolver'](entry)
    }
    evaluate(generateDataloadersWorker(models)).generateDataloaders(entry)
    const resolvers = evaluate("import * as extras from '../extras';\nexport const resolvers = " + createResolvers({} as StructureBackend, models), entry).resolvers
    cleanApplayedRelations()
    const schema = makeExecutableSchema({ typeDefs: generateSchemaAsString(models), resolvers })
    const context = (actor?: string) => ({ state: { user: actor ? { id: actor } : undefined }, request: { body: {} } })
    const execute = (source: string, actor?: string) => graphql({ schema, source, contextValue: context(actor) }) as Promise<ExecutionResult<{ Page: { user: { email: string }; people: { email: string }[] } }>>
    const link = models.find(model => model.modelName === 'Page').members.find(member => member.name === 'people').relation.linkNames
    const resultType = link.linkName[0].toUpperCase() + link.linkName.slice(1) + 'Result'
    return { entry, execute, context, resolvers, link, linkResult: resolvers[resultType][link.res2] }
}

const single = '{ Page(id: "page") { user { email } } }'
const many = '{ Page(id: "page") { people { email } } }'

describe('authorization in generated GraphQL relation loaders', () => {
    it('denies anonymous nested User reads just like direct User reads', async () => {
        const fixture = setup()
        const direct = await fixture.execute('{ User(id: "alice") { email } }')
        const nested = await fixture.execute(single)
        expect(direct.errors?.[0].originalError).toMatchObject({ status: 401 })
        expect(nested.errors?.[0].originalError).toMatchObject({ status: 401 })
        expect(JSON.stringify(nested.data)).not.toContain('alice@private.test')
        expect(fixture.entry.models.user.find).not.toHaveBeenCalled()
    })

    it.each(['alice', 'admin'])('allows an owner or administrator to read an owner-protected relation: %s', async actor => {
        const fixture = setup()
        const result = await fixture.execute(single, actor)
        expect(result.errors).toBeUndefined()
        expect(result.data.Page.user.email).toBe('alice@private.test')
    })

    it('denies another authenticated user', async () => {
        const fixture = setup()
        const result = await fixture.execute(single, 'bob')
        expect(result.errors?.[0].originalError).toMatchObject({ status: 401 })
        expect(fixture.entry.models.user.find).not.toHaveBeenCalled()
    })

    it('checks each record in a list before loading it', async () => {
        const fixture = setup(undefined, ['alice', 'bob'])
        const result = await fixture.execute(many, 'alice')
        expect(result.errors?.[0].originalError).toMatchObject({ status: 401 })
        expect(JSON.stringify(result.data)).not.toContain('@private.test')
        expect(fixture.entry.models.person.find).not.toHaveBeenCalled()
    })

    it('preserves identities when batched database results arrive in a different order', async () => {
        const fixture = setup(undefined, ['alice', 'bob'])
        const result = await fixture.execute(many, 'admin')
        expect(result.errors).toBeUndefined()
        expect(result.data.Page.people.map(user => user.email)).toEqual(['alice@private.test', 'bob@private.test'])
    })

    it('reauthorizes reads even when data is already cached', async () => {
        const fixture = setup()
        const context = fixture.context('admin')
        expect((await fixture.entry.dataloaders.user(context, 'alice', false)).email).toBe('alice@private.test')
        context.state.user = { id: 'bob' }
        await expect(fixture.entry.dataloaders.user(context, 'alice', false)).rejects.toMatchObject({ status: 401 })
        expect(fixture.entry.models.user.find).toHaveBeenCalledTimes(1)
    })

    it('keeps explicitly public relations accessible anonymously', async () => {
        const fixture = setup({ type: SchemaModelProtectionType.PUBLIC })
        const result = await fixture.execute(single)
        expect(result.errors).toBeUndefined()
        expect(result.data.Page.user.email).toBe('alice@private.test')
    })

    it('enforces user-only read permissions', async () => {
        const fixture = setup({ type: SchemaModelProtectionType.USER })
        expect((await fixture.execute(single)).errors?.[0].originalError).toMatchObject({ status: 401 })
        expect((await fixture.execute(single, 'bob')).errors).toBeUndefined()
    })

    it('enforces named-role read permissions', async () => {
        const fixture = setup({ type: SchemaModelProtectionType.ROLE, roles: ['reader'] })
        expect((await fixture.execute(single, 'bob')).errors?.[0].originalError).toMatchObject({ status: 401 })
        expect((await fixture.execute(single, 'reader')).errors).toBeUndefined()
    })

    it('enforces read permissions on link/unlink result fields too', async () => {
        const fixture = setup()
        await expect(fixture.linkResult({ [fixture.link.param2]: 'alice' }, {}, fixture.context())).rejects.toMatchObject({ status: 401 })
        expect(fixture.entry.models.person.find).not.toHaveBeenCalled()
    })

    it('does not trust already populated relation objects', async () => {
        const fixture = setup()
        fixture.entry.services.page.one.mockResolvedValue({ id: 'page', user: { _id: 'bob', email: 'bob@private.test' } })
        const result = await fixture.execute(single, 'alice')
        expect(result.errors?.[0].originalError).toMatchObject({ status: 401 })
        expect(JSON.stringify(result.data)).not.toContain('bob@private.test')
    })

    it('does not invent a filter to bypass filter-based read permissions', async () => {
        const fixture = setup({ type: SchemaModelProtectionType.FILTER,
            filter: [{ name: 'user.id', value: '{{userId}}' }], roles: [] })
        expect((await fixture.execute(single, 'alice')).errors?.[0].originalError).toMatchObject({ status: 401 })
        expect(fixture.entry.models.user.find).not.toHaveBeenCalled()
    })

    it('preserves empty and null relations without accessing protected records', async () => {
        const fixture = setup(undefined, [])
        fixture.entry.services.page.one.mockResolvedValue({ id: 'page', user: null, people: [] })
        const result = await fixture.execute('{ Page(id: "page") { user { email } people { email } } }')
        expect(result.errors).toBeUndefined()
        expect(result.data.Page).toEqual({ user: null, people: [] })
        expect(fixture.entry.models.user.find).not.toHaveBeenCalled()
        expect(fixture.entry.models.person.find).not.toHaveBeenCalled()
    })

    it('fails closed if a target read authorizer is missing', async () => {
        const fixture = setup()
        delete fixture.entry.resolvers.user.authorizeRead
        const result = await fixture.execute(single, 'admin')
        expect(result.errors?.length).toBeGreaterThan(0)
        expect(fixture.entry.models.user.find).not.toHaveBeenCalled()
    })
})
