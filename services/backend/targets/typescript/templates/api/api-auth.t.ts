import { genPasswordAndTokens, getJwtSecret } from './jwt'
export { generateTokenJWT, genPasswordAndTokens } from './jwt'
import { Authenticator } from '@fastify/passport'
import secureSession from '@fastify/secure-session'
import { withContext } from './http-context'
import * as bcrypt from 'bcrypt'
import * as crypto from 'crypto'
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt'

import { apiMiddleware, TokenExpiredError, UnauthorizedError } from './api-utils'

export const passportSetupJwt = (app, userModel) => {
    const passport = new Authenticator()
    // Passport's initialization plugin requires a session decorator, including
    // for stateless strategies. API authentication still uses session: false.
    app.register(secureSession, {
        key: crypto.createHash('sha256').update('crud-monster:passport-session:').update(getJwtSecret()).digest(),
        cookie: { path: '/auth', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
    })

    // http://www.passportjs.org/packages/passport-jwt/
    passport.use(
        new JwtStrategy(
            {
                jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), ExtractJwt.fromUrlQueryParameter('token')]),
                secretOrKey: getJwtSecret(),
                algorithms: ['HS256'],
                // Preserve TokenExpiredError responses; expiration is required and checked below.
                ignoreExpiration: true,
            },
            async (jwt_payload, done) => {
                try {
                    if (!Number.isFinite(jwt_payload.exp) || Date.now() >= jwt_payload.exp * 1000) {
                        return done(new TokenExpiredError())
                    } else if (jwt_payload.tokenType !== 'access' || typeof jwt_payload.id !== 'string') {
                        return done(new UnauthorizedError())
                    } else if (!(await userModel.exists({ _id: jwt_payload.id }))) {
                        return done(new UnauthorizedError())
                    }
                    done(null, jwt_payload)
                } catch (error) {
                    done(error)
                }
            },
        ),
    )

    app.register(passport.initialize())
    app.addHook('preValidation', async (request, reply) => {
        // Missing credentials are allowed for public operations. Supplied invalid
        // credentials must never silently downgrade to an anonymous request.
        if (!request.headers.authorization && !request.query?.token) return
        return passport.authenticate('jwt', { session: false }, async (request, reply, error, user) => {
            if (error) throw error
            if (!user) throw new UnauthorizedError()
            request.user = user
        }).call(app, request, reply)
    })
    return passport
}

export async function generateHash(password) {
    return bcrypt.hash(password, 10)
}

export async function compareHash(pass, hashPass) {
    return bcrypt.compare(pass, hashPass)
}

const createVerifyToken = async (userModel) => {
    // check existence of verify token
    let __verifyToken
    do {
        __verifyToken = crypto.randomBytes(64).toString('hex')
    } while (await userModel.exists({ __verifyToken }))

    return __verifyToken
}

async function _login(userModel, data) {
    const user = await userModel.findOne({ email: data.email }).populate('roles')

    if (user && (await compareHash(data.password, user.__password))) {
        // in login allways generate new token
        // if(!user.__token) {
        genPasswordAndTokens(user)
        await user.save()
        //}

        const data = {
            token: user.__token,
            refreshToken: user.__refreshToken,
            user,
        }

        // clean user
        data.user.__password = undefined
        data.user.__forgottenPasswordToken = undefined
        data.user.__resetPasswordToken = undefined
        data.user.__token = undefined
        data.user.__refreshToken = undefined

        return data
    }

    throw new UnauthorizedError()
}

async function _register(userModel, data) {
    const { password, email } = data

    if (await userModel.exists({ email })) {
        throw `User with email: ${email} already exist`
    }

    delete data.password
    const __verifyToken = await createVerifyToken(userModel)
    const __password = await generateHash(password)
    const user = {
        ...data,
        __password,
        password: '******',
        verified: false,
        __verifyToken,
    } as any

    const createdUser = await userModel.create(user)
    // user have to be in DB to have his ID for generate token
    genPasswordAndTokens(createdUser)
    // save the tokens into model
    await createdUser.save()

    return {
        token: createdUser.__token,
        refreshToken: createdUser.__refreshToken,
        user: createdUser,
    }
}

/**
 * @swagger
 * components:
 *   schemas:
 *     LoginPayload:
 *       title: Login and register payload
 *       type: object
 *       properties:
 *          email:
 *              type: string
 *              description: user email
 *          password:
 *              type: string
 *              description: user password
 *       required:
 *         - email
 *         - password
 *   parameters:
 *     fieldsParam:
 *         in: query
 *         name: fields
 *         type: array
 *         collectionFormat: csv
 *         items:
 *           type: string
 *     aliasParam:
 *       in: query
 *       name: alias
 *       type: string
 *
 * paths:
 *   /auth/login_v1:
 *     post:
 *       summary: Login user and retrieve token
 *       security: []
 *       tags:
 *          - Auth
 *          - query
 *       parameters:
 *         - $ref: '#/components/parameters/fieldsParam'
 *         - $ref: '#/components/parameters/aliasParam'
 *       requestBody:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginPayload'
 *             examples:
 *                admin:
 *                  summary: admin example
 *                  value:
 *                    email: admin@admin.test
 *                    password: admin@admin.test
 *                user:
 *                  summary: user example
 *                  value:
 *                    email: user@user.test
 *                    password: user@user.test
 *                user2:
 *                  summary: user2 example
 *                  value:
 *                    email: user2@user.test
 *                    password: user2@user.test
 *       responses:
 *         '200':
 *           description: OK
 *         '401':
 *           description: unauthorized
 */
const login_v1 = (userModel) => async (ctx) => (ctx.body = apiMiddleware(ctx, await _login(userModel, ctx.request.body), 'login_v1'))

/**
 *
 * @swagger
 * components:
 *   schemas:
 *     LoginPayload:
 *       title: Login and register payload
 *       type: object
 *       properties:
 *          email:
 *              type: string
 *              description: user email
 *          password:
 *              type: string
 *              description: user password
 *       required:
 *         - email
 *         - password
 *   parameters:
 *     fieldsParam:
 *         in: query
 *         name: fields
 *         type: array
 *         collectionFormat: csv
 *         items:
 *           type: string
 *     aliasParam:
 *       in: query
 *       name: alias
 *       type: string
 * paths:
 *   /auth/register_v1:
 *     post:
 *       summary: Login user and retrieve token
 *       tags:
 *          - Auth
 *          - mutation
 *       security: []
 *       parameters:
 *         - $ref: '#/components/parameters/fieldsParam'
 *         - $ref: '#/components/parameters/aliasParam'
 *       requestBody:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginPayload'
 *             examples:
 *                user:
 *                  summary: user example
 *                  value:
 *                    email: user@user.test
 *                    password: user@user.test
 *                user2:
 *                  summary: user2 example
 *                  value:
 *                    email: user2@user.test
 *                    password: user2@user.test
 *       responses:
 *         '200':
 *           description: OK
 *         '401':
 *           description: unauthorized
 *
 * responses:
 *  401:
 *    description: Authorization information is missing or invalid.
 *
 */
const register_v1 = (userModel) => async (ctx) => (ctx.body = apiMiddleware(ctx, await _register(userModel, ctx.request.body), 'register_v1'))

/**
 *
 * @swagger
 *
 * /auth/me:
 *   get:
 *     summary: "Rest API get loget user"
 *     tags:
 *       - User
 *       - query
 *     consumes:
 *       - application/json
 *     parameters:
 *        - $ref: '#/parameters/fieldsParam'
 *        - $ref: '#/parameters/aliasParam'
 *     responses:
 *       '200':
 *         description: "loged user data"
 *       '401':
 *         description: "Unauthorized"
 */
const me_v1 = (userModel) => async (ctx) => {
    const userId = ctx.state?.user?.id
    if (!userId) throw new UnauthorizedError()
    ctx.body = apiMiddleware(ctx, await userModel.findById(userId), 'me')
}

export const setupAuth = (app, userModel) => {
    const passport = passportSetupJwt(app, userModel)
    app.post('/auth/login_v1', withContext(login_v1(userModel)))
    app.post('/auth/register_v1', withContext(register_v1(userModel)))
    app.get('/auth/me', withContext(me_v1(userModel)))
    return passport
}

export default setupAuth
