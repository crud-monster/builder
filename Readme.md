# CRUD Monster Builder

CRUD Monster generates a backend from a simple schema: describe your models,
their relations and access rules, and generate the basic CRUD operations, user
management and API. Connect your own application code through hooks to add
business logic and integrations while keeping the server regenerable as the
schema evolves.

The project's goal is to bring this schema-driven workflow to Fastify and expand
code generation beyond TypeScript to Rust and Go.

CRUD Monster was previously named GraphQL Monster. The npm package and CLI are
still named `graphql-monster-builder`; existing repository and template links
below retain their original names.

## Current capabilities

-   Generate models, relations and basic create, read, update and delete operations from a [schema file](Schema.md).
-   Expose generated operations through GraphQL and REST APIs, with GraphQL documentation and Swagger for REST.
-   Provide [user registration, login and token refresh](Login.md), together with user roles.
-   Apply [access rules](Schema.md#model-permissions) to individual model operations, including role-based permissions and user-specific filters.
-   Connect custom code through [before and after hooks](#hooks) for business logic, validation and external integrations. Keep custom code outside `gen/` so it survives regeneration.
-   Generate TypeScript servers with MongoDB by default, or [PostgreSQL and MySQL](Database.md) as database options.
-   Connect React applications using the existing [CRA templates](https://github.com/graphql-monster/cra-template-graphql-monster) (ES6 or [TypeScript](https://github.com/miuan/cra-template-graphql-monster-typescript)).

## Roadmap

These are planned additions and improvements, not a list of completed features.

-   **Fastify:** add a Fastify backend target for generated Node.js servers.
-   **Rust:** add Rust code generation.
-   **Go:** add Go code generation as another backend target.
-   **Schema validation:** extend schema-defined validation with value ranges and custom rules, alongside required fields and uniqueness constraints.
-   **Query consistency:** define consistent filtering, sorting and pagination behavior across REST, GraphQL and generated backend targets.
-   **Database migrations:** make schema changes reviewable before applying them to existing databases, with explicit handling of changes that could lose data.
-   **Regeneration:** make generator-owned files and custom-code extension points explicit, and help developers review changes when updating a generated server.
-   **Backend consistency:** verify that TypeScript, Rust and Go interpret the same schema, relations and access rules consistently.
-   **Generated tests:** expand generated CRUD and permission tests, and make custom hooks easy to test independently.
-   **Deployment:** standardize environment configuration, structured logging, health endpoints and Docker-based startup across targets.

The intended scope for these targets is the same schema-driven foundation:
basic CRUD, model relations, user management, authentication, access permissions
and extension points for custom application code. Fastify, Rust and Go support
are planned; the current generated server uses the TypeScript stack described
below.

The foundational priorities are safe regeneration, database migration workflows
and consistent behavior across backend targets. No release dates are committed
for these roadmap items.

## From schema to backend

For example, define a task model with public read access and write access
restricted to the `admin` role:

```graphql
@one("public") @all("public")
@create("admin") @update("admin") @remove("admin")
type Task @model {
    title: String!
    done: Boolean @default(false)
}
```

The generated backend provides:

-   A `Task` database model and basic create, read, update and delete operations.
-   GraphQL and REST APIs for those operations, with API documentation.
-   Permission checks that allow public reads and require the `admin` role for writes.
-   User registration, login, token refresh and role support as part of the server's authentication infrastructure. Registering a user does not grant the `admin` role.
-   Before and after hooks where your code can validate a task, apply business rules or call an external service.

As the application grows, update the schema and regenerate the managed code.
Keep application-specific logic outside `gen/`, and review changes to preserved
server and configuration files as described in [Upgrading an existing generated server](#upgrading-an-existing-generated-server).
The roadmap above extends this workflow to additional backend targets and
stronger migration, testing and deployment support.

# Requirements

Node.js 22.18+ (22.x), or Node.js 24.11+ (recommended) and a running MongoDB instance.
Generated servers use Apollo Server 5, GraphQL 16, Mongoose 9 and Koa 3.

## Upgrading an existing generated server

Generate into a fresh directory first. The builder preserves existing files outside
`gen/`, including `server.ts`, `services/passport.ts`, `package.json` and
`tsconfig.json`. Merge their updated versions into your application before
regenerating `gen/` and reinstalling dependencies. Preserve your environment
configuration, generated JWT secret, hooks and stored files.

Mongoose 9 uses promise-based database APIs. Custom hooks that call Mongoose
must replace removed APIs such as `remove`, `count` and `findByIdAndRemove`
with `deleteMany`/`deleteOne`, `countDocuments` and `findByIdAndDelete`.
Database update results now expose `modifiedCount` instead of `nModified`.
The test scripts enable Jest VM module support for the MongoDB driver's dynamic imports.

Keep the `overrides` (npm) and `resolutions` (Yarn) entries when merging the
generated `package.json`. Swagger JSDoc 6.3 pins an older vulnerable `glob`;
these entries replace only its copy with patched `glob` 14.0.4 or newer.
Remove this targeted replacement once Swagger JSDoc itself depends on a patched version.

## Development checks

Builder source imports shared modules through `@common/*` (for example,
`@common/types` and `@common/utils`) and `@log`. The aliases are defined in
`tsconfig.json`, used by Jest and registered automatically for `ts-node`.
`npm run build` uses `tsconfig.build.json` and rewrites aliases to relative
imports with `tsc-alias`, so the compiled CLI runs directly in Node.js.
Backend templates retain the generated project's own import paths.


Use Node.js 22.18+ within the 22.x line, or Node.js 24.11+.

```sh
yarn lint
yarn lint:fix
yarn test --runInBand
yarn prettier-format
```

ESLint uses `eslint.config.cjs`. It checks generator source and tests, excluding
`dist/` and code templates. Existing style and unused-variable cleanup items are
reported as warnings; errors fail the command. `lint` checks files, and `lint:fix`
applies available fixes. Prettier 3 runs separately with `.prettierrc.js`.
The default test run uses two workers. To run only unit tests without MongoDB, use
`yarn test:unit`; HTTP/database tests run with `yarn test:integration`. Add
`--runInBand` for a sequential run.

Integration tests bind automatically assigned ports and use isolated generated
files and database names for each run and worker. They ignore the application's
`PORT` and `DB_NAME`; `DB_HOST` can select the MongoDB host. Global teardown removes
only the test databases recorded for that run. Unit fixtures use temporary directories
and the real schema parser. Lint rejects committed `.only` tests.

The generated Jest configuration registers the jest-extended 7 matchers explicitly.
The builder also targets patched `minimatch` versions for ESLint and the TypeScript
parser using npm overrides and Yarn resolutions until those tools update their dependencies.

# Usage

```
$ graphql-monster-builder <operation> <schema> <outdir>
```

## Example

Example of simple todo server. Create [Schema File](https://github.com/miuan/graphql-monster-builder/blob/master/Schema.md) file with name `todo.schema` and folowing content in your local directory.

_Note: Be sure on your system is running instance of [MongoDB](https://www.mongodb.com/)_

```graphql
@all(filter:"user_every.id={{userId}}")
@create("public") @one("public") @update("public") @remove("public")
type Todo @model {
  message: String
  done: Boolean @default(false)
}
```

Then run these commands to create a CRUD Monster server in the `todo-server` directory:

```
npx graphql-monster-builder --backend todo.schema todo-server

# or

npm i -g graphql-monster-builder
graphql-monster-builder --backend todo.schema todo-server
```

Now you should just move to `todo-server` directory and run generated server

```
cd todo-server/ && yarn && yarn start
```

The builder automatically creates a random 256-bit `JWT_TOKEN_SECRET_GEN` in
`config/environment/.env.defaults`. This file is excluded from Git and preserved
when regenerating the server, so tokens remain valid across restarts and rebuilds.
Keep the file private and include it when moving an existing server.

To supply your own secret, set `JWT_TOKEN_SECRET` in `config/environment/.env`
or in the process environment. It takes precedence over `JWT_TOKEN_SECRET_GEN`.
Use the same secret across all instances of the same service.

Access tokens expire after one hour; refresh tokens expire after
365 days and rotate on refresh. Refresh tokens cannot authenticate API requests.
After upgrading and regenerating an existing server, users must log in again:
older tokens do not contain the required token type.

The bootstrap administrator is configured with `ADMIN_EMAIL` and `ADMIN_PASSWORD`
in `config/environment/.env` or the process environment. Without those values,
both default to `admin@graphql.monster`. Set your own values for a deployed server:

```dotenv
ADMIN_EMAIL=admin@example.test
ADMIN_PASSWORD=your-private-password
```

Plaintext `ADMIN_PASSWORD` values are hashed with bcrypt before database storage.
Existing bcrypt hashes are also accepted and preserved. The configured admin
account and password are synchronized on every server startup, including restarts.

Now you can check the:

-   Apollo Sandbox -> [http://localhost:3001/grapqhl](http://localhost:3001/graphql)
-   Swagger -> [http://localhost:3001/swagger](http://localhost:3001/swagger)

## GraphQL

Here is some examples with GraphQL mutations over `Todo` model
![Image of graphql](doc/assets/graphql-mutations.png)
Here is some examples with GraphQL mutations over `Todo` model
![Image of graphql](doc/assets/graphql-queries.png)

# Rest API

The same can be acomplish with Rest API what is documented by Swagger
![Image of swagger](doc/assets/swagger.png)

# Documentation

For more about schema definition, please visit our documentation:

-   [Schema Description](https://github.com/miuan/graphql-monster-builder/blob/master/Schema.md) - How create a CRUD Monster model.
-   [Model Relations](https://github.com/miuan/graphql-monster-builder/blob/master/Schema.md#relations) - Managing model relations.
-   [Model Permissions](https://github.com/miuan/graphql-monster-builder/blob/master/Schema.md#model-permissions) – How secure particular CRUD operation of invidual model.
-   [Obtain Token (Login)](https://github.com/miuan/graphql-monster-builder/blob/master/Login.md) – How login, register user and retrieve token to access protected models.

[![Create models and CRUD with CRUD Monster](https://img.youtube.com/vi/SE2313FeboY/0.jpg)](https://www.youtube.com/watch?v=SE2313FeboY)

_This video shows how to create models on the former GraphQL Monster platform (www.graphql.monster)._

# Hooks

During project development You will probably very often updating the schema (adding new models or updating existing or maybe changing the protecting rules). To customize server functionality is a option of adding a hook. Hooks can be of this two type:

-   before
-   after

and can have handle these actions:

-   One (read one item)
-   All (read all items)
-   My (read all my items)
-   Create (create one item)
-   Update (update one item)
-   Delete (delete one item)

Hooks are setlet in file `entryHooks.ts` in `services/` with export object `hooks` with your defined overrides

```javascript
// example of `service/entryHooks.ts`

export const hooks = {
    services: {
        beforeTodoCreate: async (entry, todo) => {
            // do some action before Todo is stored into DB
            todo.data.message = `Created Todo: ${todo.data.message}`
            return todo.data
        },
        beforeTodoUpdate: async (entry, todo) => {
            // do some action before Todo is updated in DB
            todo.data.message = `Updated Todo: ${todo.data.message}`
            return todo.data
        },
        afterTodoCreate: async (entry, todo) => {
            // do some action after Todo is updated in DB
            return todo.data
        },
        afterTodoCreate: async (entry, todo) => {
            // do some action after Todo is updated in DB
            return todo.data
        },
    },
}
```

_Note: what is in `gen/` is have fully on control the builder generator, so what ever you will change will be in next (re)build lost!_

# Contain

-   [NodeJS](https://nodejs.org/en/)
-   [Apollo](https://www.apollographql.com)
-   [koa](https://koajs.com/)
-   [MongoDB](https://www.mongodb.com/)
-   [Swagger](https://swagger.io/)
-   [Jest](https://jestjs.io/)

## Database providers

New backends support `--database mongodb` (default), `--database postgresql` and `--database mysql`. SQL backends keep schema snapshots and generate migrations on regeneration. See [Database.md](Database.md) for setup, migration review, storage details and tests.
