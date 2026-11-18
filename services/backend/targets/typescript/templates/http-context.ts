import type { FastifyReply, FastifyRequest } from 'fastify'

// Shared resolver/hook context. HTTP handling belongs to Fastify; this object
// preserves the generated API's context fields without a middleware runtime.
export function createContext(request: FastifyRequest, reply: FastifyReply) {
    return {
        request,
        reply,
        req: request.raw,
        state: { user: request.user },
        params: request.params || {},
        query: request.query || {},
        headers: request.headers,
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        body: undefined as any,
        set: (name: string, value: string) => reply.header(name, value),
        throw: (status: number, message: string) => {
            throw Object.assign(new Error(message), { status })
        },
    }
}

export function withContext(handler) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const context = createContext(request, reply)
        await handler(context)
        return context.body
    }
}
