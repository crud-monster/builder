import { disconnectFromServer, generateAndRunServerFromSchema } from './utils'
import * as request from 'supertest'

describe('generated Fastify HTTP runtime', () => {
    let server

    // Exercise the listening Node.js server, as the other HTTP suites do.
    const send = async (options: any) => {
        if (typeof options === 'string') options = { url: options }
        let operation = request(server.httpServer)[(options.method || 'GET').toLowerCase()](options.url)
        for (const [name, value] of Object.entries(options.headers || {})) operation = operation.set(name, value as string)
        if (options.payload !== undefined) operation = operation.send(options.payload)
        const response = await operation
        return { ...response, statusCode: response.status, json: () => response.body }
    }

    beforeAll(async () => {
        server = await generateAndRunServerFromSchema('fastify-runtime', `
            @all("public") @one("public") @create("public") @update("public") @remove("public")
            type Task @model {
                title: String!
            }
        `)
    })

    afterAll(async () => {
        await disconnectFromServer(server)
    })

    it('serves GraphQL and REST with the same per-request identity and hooks', async () => {
        const actor = await server.entry.models.user.findOne({ email: 'admin@admin.test' })
        const login = await send({
            method: 'POST', url: '/auth/login_v1',
            payload: { email: actor.email, password: 'admin@admin.test' },
        })
        const token = login.json().login_v1.token
        const before = jest.fn(async (entry, ctx, body) => {
            expect(ctx.state.user.id).toBe(actor.id)
            expect(ctx.request.headers.authorization).toBe(`Bearer ${token}`)
            expect(ctx.reply).toBeDefined()
            return { ...body, title: 'from hook' }
        })
        server.entry.hooks.api.beforeCreateTask = before
        try {
            const created = await send({
                method: 'POST', url: '/api/task', payload: { title: 'original' },
                headers: { authorization: `Bearer ${token}` },
            })
            expect(created.statusCode).toBe(200)
            expect(created.json().createTask.title).toBe('from hook')
            expect(before).toHaveBeenCalledTimes(1)
            const graphql = await send({
                method: 'POST', url: '/graphql',
                payload: { query: '{ allTask { title } }' },
                headers: { authorization: `Bearer ${token}` },
            })
            expect(graphql.json()).toEqual({ data: { allTask: [{ title: 'from hook' }] } })
            const anonymous = await send('/auth/me')
            expect(anonymous.statusCode).toBe(401)
        } finally {
            delete server.entry.hooks.api.beforeCreateTask
        }
    })

    it('serves Swagger and handles CORS preflight', async () => {
        const docs = await send('/swagger/')
        expect(docs.statusCode).toBe(200)
        expect(docs.headers['content-type']).toContain('text/html')
        const specification = await send('/swagger/json')
        expect(specification.statusCode).toBe(200)
        expect(specification.json().paths).toHaveProperty('/api/task')
        expect(specification.json().paths).toHaveProperty('/auth/login_v1')
        const preflight = await send({
            method: 'OPTIONS', url: '/graphql',
            headers: { origin: 'https://client.example.test', 'access-control-request-method': 'POST' },
        })
        expect(preflight.statusCode).toBe(204)
        expect(preflight.headers['access-control-allow-origin']).toBe('*')
    })

    it('handles malformed JSON without calling business logic', async () => {
        const before = jest.fn()
        server.entry.hooks.api.beforeCreateTask = before
        try {
            const result = await send({
                method: 'POST', url: '/api/task',
                headers: { 'content-type': 'application/json' }, payload: '{invalid',
            })
            expect(result.statusCode).toBe(400)
            expect(result.json()).toHaveProperty('errors')
            expect(before).not.toHaveBeenCalled()
        } finally {
            delete server.entry.hooks.api.beforeCreateTask
        }
    })

    it('rejects invalid credentials even for public routes', async () => {
        const result = await send({
            url: '/api/task/all', headers: { authorization: 'Bearer invalid' },
        })
        expect(result.statusCode).toBe(401)
        expect(result.json()).toHaveProperty('errors')
    })
})
