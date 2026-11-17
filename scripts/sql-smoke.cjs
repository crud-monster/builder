const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const { newDb, DataType } = require('pg-mem')
const knex = require('knex')
const { exportAsFromString } = require('../dist/services/backend/build.js')
const root = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'gmb-sql-smoke-')))
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'), 'dir')
const provider = process.env.GMB_SQL_TEST_PROVIDER || 'postgresql'
if (!['postgresql', 'mysql'].includes(provider)) throw new Error('GMB_SQL_TEST_PROVIDER must be postgresql or mysql')
const realDatabase = process.env.GMB_SQL_TEST_DATABASE_URL
const cleanup = []
if (provider === 'mysql' && !realDatabase) throw new Error('MySQL execution tests require GMB_SQL_TEST_DATABASE_URL pointing to an empty test database')
if (realDatabase) process.env.DATABASE_URL = realDatabase
else delete process.env.DATABASE_URL // The default smoke test always runs against the in-memory emulator.

async function main() {
    await exportAsFromString('smoke', '@all("public") @one("public") @create("public") @update("public") @remove("public")\nmodel Todo {\n title: String!\n done: Boolean\n price: Float\n}', root, { database: provider })
    // Check the emitted runtime itself, including nested dialect templates, with strict typing.
    const runtimeSources = ['database.ts', 'models.ts', 'filter.ts', 'types.ts', 'migrate.ts', 'dialects/index.ts']
        .map(file => path.join(root, 'gen/sql', file))
    require('child_process').execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'),
        '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2020', '--module', 'commonjs',
        ...runtimeSources, path.join(root, 'gen/services/db.ts')], { stdio: 'pipe' })
    const memory = newDb()
    memory.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'test' })
    memory.public.registerFunction({ name: 'version', returns: DataType.text, implementation: () => 'PostgreSQL 16.0' })
    const pg = memory.adapters.createKnex()
    cleanup.push(() => pg.destroy())
    require('ts-node').register({ transpileOnly: true, project: path.join(root, 'tsconfig.json'), compilerOptions: { module: 'commonjs', target: 'es2020' } })
    const databaseFile = path.join(root, 'gen/sql/database.ts')
    const runtimeFile = path.join(root, 'gen/sql/models.ts')
    const Module = require('module')
    const originalLoad = Module._load
    Module._load = function(request, parent, ...args) {
        if (!realDatabase && request === 'knex' && parent.filename === databaseFile) return { default: () => pg }
        return originalLoad.call(this, request, parent, ...args)
    }
    cleanup.push(() => { Module._load = originalLoad })
    const database = require(databaseFile)
    cleanup.push(() => database.close())
    const runtime = require(runtimeFile)
    const filterGen = require(path.join(root, 'gen/sql/filter.ts')).filterGen
    await assert.rejects(database.assertCurrent(), /not been migrated/)
    const applied = await database.migrate()
    assert.equal(applied.applied.length, 1)
    assert.equal((await database.migrate('status')).pending.length, 0)
    await database.assertCurrent()
    const todo = runtime.model('Todo')
    const first = await todo.create({ title: "O'Reilly", done: false, price: 0 })
    assert.match(first.id, /^[a-f0-9-]{36}$/)
    assert.equal(first.title, "O'Reilly")
    assert.equal(await todo.countDocuments({ done: false, price: 0 }), 1)
    await todo.create({ title: 'second', done: true, price: 10 })
    const filtered = await todo.find(filterGen({ OR: [{ done: false }, { price_gt: 20 }] })).lean()
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].id, first.id)
    const selected = await todo.findById(first.id, { title: 1 })
    selected.title = 'edited'
    await selected.save()
    assert.equal((await todo.findById(first.id)).done, false)
    assert.equal((await todo.findById(first.id)).title, 'edited')
    const countBeforeRollback = await todo.countDocuments({})
    await assert.rejects(runtime.transaction(async () => { await todo.create({ title: 'rolled back' }); throw new Error('rollback') }), /rollback/)
    // pg-mem does not implement transaction rollback; only real-engine runs assert it.
    if (realDatabase) assert.equal(await todo.countDocuments({}), countBeforeRollback)
    const userModel = runtime.model('User')
    const user = await userModel.create({ email: 'user@example.com', __password: 'secret' })
    assert.equal(user.__password, 'secret')
    assert.equal(user.toJSON().__password, undefined)
    user.__verifyToken = 'token'
    await user.save()
    user.__verifyToken = undefined
    await user.save()
    assert.equal((await userModel.findById(user.id)).__verifyToken, null)
    process.env.JWT_TOKEN_SECRET = 'sql-smoke-secret-for-tests-only'
    const { entry, resolvers } = require(path.join(root, 'gen/entry.ts')).generateResolver()
    const { makeExecutableSchema } = require('@graphql-tools/schema')
    const { graphql } = require('graphql')
    const schema = makeExecutableSchema({ typeDefs: fs.readFileSync(path.join(root, 'gen/graphql.schema'), 'utf8'), resolvers })
    const execute = async source => {
        const result = await graphql({ schema, source, contextValue: { state: {} } })
        assert.equal(result.errors, undefined, JSON.stringify(result.errors))
        return result.data
    }
    const created = await execute('mutation { createTodo(title: "GraphQL", done: false, price: 0) { id title done price } }')
    assert.equal(created.createTodo.title, 'GraphQL')
    const changed = await execute(`mutation { updateTodo(id: "${created.createTodo.id}", title: "changed") { id title } }`)
    assert.equal(changed.updateTodo.title, 'changed')
    const registered = await execute('mutation { register_v1(email: "graphql@example.com", password: "password") { token user { id email } } }')
    assert(registered.register_v1.token)
    const login = await execute('mutation { login_v1(email: "graphql@example.com", password: "password") { token user { id email } } }')
    assert.equal(login.login_v1.user.id, registered.register_v1.user.id)
    assert(login.login_v1.token)
    assert(await entry.models.user.findById(login.login_v1.user.id))
    const role = await entry.services.userRole.create({ name: 'writer' })
    await entry.services.user.update({ rolesIds: [role.id] }, registered.register_v1.user.id)
    assert.deepEqual((await entry.models.user.findById(registered.register_v1.user.id)).roles, [role.id])
    assert(await entry.models.userRole.exists({ name: 'writer', users: registered.register_v1.user.id }))
    const populated = await entry.models.user.findById(registered.register_v1.user.id).populate('roles')
    assert.equal(populated.roles[0].name, 'writer')
    const refreshed = await execute(`mutation { refreshToken_v1(userId: "${registered.register_v1.user.id}", token: "${login.login_v1.token}", refreshToken: "${(await entry.models.user.findById(registered.register_v1.user.id)).__refreshToken}") { token refreshToken } }`)
    assert(refreshed.refreshToken_v1.refreshToken)
    const before = fs.readFileSync(path.join(root, 'database/migrations', fs.readdirSync(path.join(root, 'database/migrations'))[0]), 'utf8')
    await exportAsFromString('smoke', '@all("public") @one("public") @create("public") @update("public") @remove("public")\nmodel Todo {\n title: String!\n done: Boolean\n price: Float\n note: String\n}', root, { database: provider })
    await assert.rejects(database.assertCurrent(), /pending/)
    await database.migrate()
    await database.assertCurrent()
    await todo.findByIdAndUpdate(first.id, { note: 'migration worked' })
    assert.equal((await todo.findById(first.id)).note, 'migration worked')
    const migrationPath = path.join(root, 'database/migrations', fs.readdirSync(path.join(root, 'database/migrations')).sort()[0])
    fs.writeFileSync(migrationPath, before + '\n// tampered\n')
    await assert.rejects(database.migrate(), /changed or removed/)
    Module._load = originalLoad
    const mysql = knex({ client: 'mysql2' })
    cleanup.push(() => mysql.destroy())
    const sqlTables = database.snapshot().schema.tables
    database.getConnection = () => mysql
    database.snapshot = () => ({ schema: { provider: 'mysql', tables: sqlTables } })
    const mockTable = { name: 'Todo', columns: [{ name: '_id', type: 'id' }, { name: 'title', type: 'text' }, { name: 'done', type: 'boolean' }, { name: 'price', type: 'float' }, { name: 'tags', type: 'json', array: true }, { name: 'user', type: 'id', relation: 'User' }, { name: 'address', type: 'json', entity: [{ name: 'city', type: 'text' }, { name: 'active', type: 'boolean' }] }] }
    const injection = "x' OR 1=1 --"
    const compiled = runtime.conditions(mysql('Todo'), mockTable, { $or: [{ title: injection }, { tags: { $all: ['a'] } }], done: false, price: { $gte: 0 } }).toSQL()
    assert(!compiled.sql.includes(injection))
    assert(compiled.bindings.includes(injection))
    assert(compiled.sql.includes('JSON_CONTAINS'))
    const nested = runtime.conditions(mysql('Todo'), mockTable, filterGen({ user: { email_contains: injection }, address: { city: 'Prague', active: false } })).toSQL()
    assert(nested.sql.includes('REGEXP_LIKE'))
    assert(nested.sql.includes('JSON_EXTRACT'))
    assert(nested.sql.includes('_gmb_relation_0'))
    assert(!nested.sql.includes(injection))
    assert(nested.bindings.includes('Prague'))
    console.log(`SQL smoke passed (${realDatabase ? provider : 'PostgreSQL emulation'}): migration lifecycle, CRUD, GraphQL CRUD/register/login/refresh, role relations and MySQL query compilation.`)
    fs.rmSync(root, { recursive: true, force: true })
}
main().catch(error => { console.error(error); console.error(`Generated backend retained for debugging: ${root}`); process.exitCode = 1 })
    .finally(async () => { for (const close of cleanup.reverse()) await close() })
