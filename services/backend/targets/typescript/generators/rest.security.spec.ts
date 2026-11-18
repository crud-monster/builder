import { getModelsFromSchema } from '../../../../parser/scan'
import { SchemaModelProtectionType } from '@common/types'
import { createGeneratedFixture } from './generator-fixtures'

function setup(actor = 'regular', publicAccess = false) {
    const user = getModelsFromSchema('@update("owner")\nmodel User {\n displayName: String\n}').find(model => model.modelName === 'User')
    if (publicAccess) {
        user.protection.create = [{ type: SchemaModelProtectionType.PUBLIC }]
        user.protection.update = [{ type: SchemaModelProtectionType.PUBLIC }]
    }
    const fixture = createGeneratedFixture(user, 'rest')
    const routes: Record<string, (ctx: any) => Promise<void>> = {}
    const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, handler) => { routes[method + ' ' + url] = handler }]))
    const entry = {
        hooks: { api: {} },
        models: {
            user: { findById: jest.fn(id => ({ lean: async () => ({ _id: id }) })) },
            userRole: { exists: jest.fn(query => Promise.resolve(query.name === 'admin' && query.users === 'admin' ? { _id: 'admin-role' } : null)) },
        },
        services: { user: {
            create: jest.fn().mockResolvedValue({ id: 'created' }),
            update: jest.fn().mockResolvedValue({ id: 'regular' }),
        } },
    }
    fixture.module.connectUserApi(router, entry)
    const context = (body: any) => ({ body, params: { id: 'regular' }, user: actor ? { id: actor, roles: ['admin'] } : undefined, query: {} })
    return { ...fixture, routes, entry, context }
}

const rolePayloads = [
    { rolesIds: ['admin-role'] },
    { roles: [{ name: 'admin' }] },
    { rolesIds: [] },
    { roles: [] },
    { rolesIds: null },
    { roles: null },
]
const rawUpdates = [
    { $set: { roles: ['admin-role'] } },
    { $set: { rolesIds: ['admin-role'] } },
    { $push: { roles: 'admin-role' } },
    { $unset: { roles: 1 } },
    { $rename: { displayName: 'roles' } },
    { 'roles.0': 'admin-role' },
    { 'rolesIds.0': 'admin-role' },
]

describe('generated REST User role authorization', () => {
    it.each(rolePayloads)('blocks role mutation by an owner before any service side effects: %p', async payload => {
        const fixture = setup()
        try {
            await expect(fixture.routes['put /user/:id'](fixture.context(payload))).rejects.toMatchObject({ status: 401 })
            expect(fixture.entry.services.user.update).not.toHaveBeenCalled()
            expect(fixture.entry.models.userRole.exists).toHaveBeenCalledWith({ name: 'admin', users: 'regular' })
        } finally { fixture.dispose() }
    })

    it.each(['post /user', 'put /user/:id'])('does not let public access bypass the role guard: %s', async route => {
        const fixture = setup('', true)
        try {
            await expect(fixture.routes[route](fixture.context({ rolesIds: ['admin-role'] }))).rejects.toMatchObject({ status: 401 })
            expect(fixture.entry.services.user.create).not.toHaveBeenCalled()
            expect(fixture.entry.services.user.update).not.toHaveBeenCalled()
        } finally { fixture.dispose() }
    })

    it.each(rawUpdates)('rejects raw database update operators and dotted paths: %p', async payload => {
        const fixture = setup()
        try {
            await expect(fixture.routes['put /user/:id'](fixture.context(payload))).rejects.toMatchObject({ status: 400 })
            expect(fixture.entry.services.user.update).not.toHaveBeenCalled()
        } finally { fixture.dispose() }
    })

    it.each(['post /user', 'put /user/:id'])('allows a database-authorized admin to assign roles: %s', async route => {
        const fixture = setup('admin')
        try {
            await fixture.routes[route](fixture.context({ rolesIds: ['editor-role'] }))
            const service = route.startsWith('post') ? fixture.entry.services.user.create : fixture.entry.services.user.update
            expect(service).toHaveBeenCalledWith(expect.objectContaining({ rolesIds: ['editor-role'] }), 'admin')
        } finally { fixture.dispose() }
    })

    it('allows an owner to update ordinary profile fields', async () => {
        const fixture = setup()
        try {
            await fixture.routes['put /user/:id'](fixture.context({ displayName: 'Alice' }))
            expect(fixture.entry.services.user.update).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Alice' }), 'regular')
        } finally { fixture.dispose() }
    })
})
