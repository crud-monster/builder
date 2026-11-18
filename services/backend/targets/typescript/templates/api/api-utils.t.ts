export class RequestError extends Error {
    status: number

    constructor(name = 'RequestError', status = 400) {
        super(name)
        this.name = name
        this.status = status
    }
}

export class UnauthorizedError extends RequestError {
    unauthorized: boolean

    constructor() {
        super('Unauthorized', 401)
        this.unauthorized = true
    }
}

export class TokenExpiredError extends UnauthorizedError {
    tokenExpired: boolean
    status: number

    constructor() {
        super()
        this.tokenExpired = true
    }
}

/**
 * provide query param `fields` and `alias`
 * @param ctx
 * @param data
 * @param aliasDefault
 * @returns
 */
export const apiMiddleware = (ctx, data, aliasDefault) => {
    const fields = ctx.query?.fields || []

    for (const key in data) {
        if (key.startsWith('__') || (fields?.length && !fields.includes(key))) delete data[key]
    }

    const alias = ctx.query?.alias !== undefined ? ctx.query?.alias : aliasDefault

    return alias ? { [alias]: data } : data
}

export const convertRestToResolver = (resolver, name) => async (ctx) => {
    ctx.body = apiMiddleware(ctx, await resolver(null, ctx.request.body, ctx), name)
}

export const userIsOwner = async (ctx, data, model, userRole, ownerField = 'user', idField = 'id') => {
    const userId = ctx?.state?.user?.id

    if (userId) {
        const modelData = await model.findById(data[idField] || data._id).lean()
        const isOwner = modelData && modelData[ownerField] == userId

        return isOwner || (await userRole.exists({ name: 'admin', users: userId }))
    }

    return false
}

export const userHaveRoles = async (ctx, roles, userRoleModel) => {
    const userId = ctx?.state?.user?.id
    return userId && (await userRoleModel.exists({ name: roles[0], users: userId }))
}

// REST accepts plain field assignments, not MongoDB operators or dotted update paths.
// Check presence rather than truthiness: clearing roles also requires admin privileges.
export const assertUserRoleMutationAllowed = async (ctx, data, userRoleModel) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new RequestError('Expected an object for user data')
    }
    const fields = Object.keys(data)
    if (fields.some(field => field.startsWith('$') || field.includes('.'))) {
        throw new RequestError('Database update operators and dotted paths are not supported in user data')
    }
    if (fields.some(field => field === 'roles' || field === 'rolesIds') && !(await userHaveRoles(ctx, ['admin'], userRoleModel))) {
        throw new RequestError('Unauthorized user:roles operation', 401)
    }
}

export const paramHaveFilter = (ctx, params, allowedFilters: any[], roles: string[]) => {
    const ctxUser = ctx?.state?.user
    const currentFilter = params?.filter
    if (ctxUser && currentFilter && allowedFilters?.length > 0) {
        for (const allowedFilter of allowedFilters) {
            if (allowedFilter.name) {
                const { value, pathIs } = filterValue(currentFilter, allowedFilter.name)

                return pathIs === PATHIS.ALWAYS && (allowedFilter.value == value || (allowedFilter.value == '{{userId}}' && value == ctxUser.id))
            }
        }
    }
    return false
}

export function filterValue(filter, filterName) {
    let path = null

    const properties = propertiesToArray(filter)
    const selected = properties.filter((p) => p.endsWith(filterName))

    if (selected.length > 1) return { pathIs: PATHIS.UNDETERMINED }

    const fullPath = selected[0]

    // Paths come from propertiesToArray, including numeric array indices.
    const value = fullPath
        ? fullPath in Object(filter)
            ? filter[fullPath]
            : fullPath.split('.').reduce((current, key) => current?.[key], filter)
        : null

    if (value) {
        const basePath = fullPath.split(filterName).shift()
        path =
            basePath?.length > 0
                ? basePath
                      .split('.')
                      .map((bp) => (bp === 'AND' || bp === 'OR') && bp)
                      .filter((f) => !!f)
                : []
    }

    const pathIs = checkPath(path)
    return { value, path, pathIs }
}

export function propertiesToArray(obj) {
    const isObject = (val) => typeof val === 'object'

    const addDelimiter = (head, key) => {
        // if ((head.endsWith('OR') || head.endsWith('AND')) && !isNaN(key)) {
        //     return head
        // } else
        return head ? `${head}.${key}` : key
    }

    const paths = (obj = {}, head = '') => {
        return Object.entries(obj).reduce((product, [key, value]) => {
            const fullPath = addDelimiter(head, key)
            return isObject(value) ? product.concat(paths(value, fullPath)) : product.concat(fullPath)
        }, [])
    }

    return paths(obj)
}

export enum PATHIS {
    ALWAYS,
    SOME,
    NEVER,
    UNDETERMINED,
}

export function checkPath(path): PATHIS {
    if (!path) return PATHIS.NEVER
    return path?.length === 0 || path.every((p) => p === 'AND') ? PATHIS.ALWAYS : PATHIS.SOME
}
