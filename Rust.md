# Experimental Rust target: MongoDB CRUD and authentication

The builder still runs in Node.js and uses the same schema parser as the
TypeScript target. The Rust implementation emits a Cargo project with typed records, an Axum HTTP
server and a typed async-graphql CRUD API for supported scalar models.

```sh
npm run build
node bin/cli.js examples/todo-rust.schema ../todo-rust --target rust
cd ../todo-rust
cargo check
cargo test
DATABASE_URL=mongodb://127.0.0.1:27017/todo cargo run
```

Rust 1.89 or newer and Cargo are required to compile the generated project.
Generation itself does not run Cargo, install dependencies, connect to a database
or apply migrations. The Rust target currently accepts only `mongodb` and
uses it by default. The TypeScript target remains the default target and still
uses MongoDB unless `--database` is selected explicitly.

The programmatic API accepts `{ target: 'rust', database: 'mongodb' }`.
Frontend generation, TypeScript template overrides and
`integrationTestsEnable: true` are rejected for this scaffold.

## Generated project

```text
Cargo.toml
README.md
.env                  # private generated JWT key, excluded from Git
.gmb-project.json
src/
  main.rs
  lib.rs
  config.rs
  auth.rs
  server.rs
  database/
    mod.rs
    mongo.rs
    crud.rs
  generated/
    mod.rs
    models.rs
    graphql.rs
    source.schema
```

Model names become `PascalCaseRecord` and embedded entities become
`PascalCaseEntity`. Fields use snake_case Rust identifiers and Serde attributes
to preserve the original JSON field names. Rust keywords are escaped or renamed;
colliding identifiers are rejected before generation changes any output.

| Schema type | Rust type |
| --- | --- |
| ID / String | String |
| Boolean | bool |
| Int | i32 |
| Float | f64 |
| DateTime | chrono::DateTime<chrono::Utc> |
| Embedded entity | Generated entity struct |
| Model relation | String ID |
| Required list | Vec<T> |
| Nullable scalar / list | Option<T> / Option<Vec<T>> |

Scalar defaults apply during Serde deserialization, including false and zero.
Missing nullable fields become None, while an explicit null does not activate
a schema default. Required fields without defaults must be present. Virtual
fields are omitted from record structs because they are not persisted.
Recursive embedded entities, unsupported types and unrepresentable defaults
are rejected before output files are changed.

Hidden fields, underscore-prefixed fields and the built-in User password are
excluded from serialization. The generated records do not derive Debug.
They are data structures, not API input DTOs. Deserializing a record alone does
not enforce permissions, readonly fields or persistence constraints. The CRUD
API uses separate input/output DTOs and the restrictions described below.

## Regeneration

Use a new output directory for the first generation. The Rust target refuses
to replace an unrelated project or a TypeScript backend. The project metadata
prevents changing an existing Rust output directory back to TypeScript.

Regeneration rewrites only the builder-owned files under `src/generated/` and
`.gmb-project.json`. Existing Cargo.toml, src/lib.rs, src/main.rs, README.md,
tests and Cargo.lock are preserved. Commit Cargo.lock after the first Cargo
build. Dependency or template upgrades must be merged into preserved files
when those are introduced in later builder versions.

## Verification

```sh
npm run test:unit -- --runInBand
npm run test:rust
```

The unit suite checks target dispatch, model mappings, naming, validation,
output isolation and regeneration. The Rust smoke check requires Cargo and
compiles an emitted project, runs Rust serialization/default/keyword tests,
and checks the CLI and regeneration with a preserved lockfile. Set
`GMB_CARGO_BIN` to use a Cargo executable outside PATH.

Login and bearer-token authentication are implemented. User/owner/role
authorization and broader schema support are pending: CRUD still permits only
explicitly public operations.

## Server configuration

`DATABASE_URL` must use `mongodb://` or `mongodb+srv://` and specify a database.
The official MongoDB driver validates the URI and startup pings the database
before binding the HTTP listener. A failed connection stops startup with a generic
error that does not expose credentials. The connection attempt is bounded by 10
seconds; readiness pings by 2 seconds.

`HOST` defaults to `127.0.0.1`, `PORT` to `3001`. `.env.example` lists the variables;
set them in the environment or the project-root `.env`. Existing environment
values override the file. `GRAPHIQL_ENABLED` defaults to `false` and accepts only
`true` or `false`. GET `/health` returns `{"status":"ok"}` (process liveness).
GET `/ready` pings MongoDB and returns 200 or 503 without driver error details.
POST `/graphql` accepts `{"query":"{ health }"}`. The shared MongoDB database
handle is shared by the generated CRUD and authentication resolvers. Requests have a 32 KiB body limit,
depth 8 and complexity 64. Ctrl-C gracefully stops the HTTP server.

`src/config.rs`, `src/server.rs`, `src/database/` and `.env.example` are also
preserved on regeneration. When upgrading an older scaffold, generate into a
fresh directory and merge Cargo.toml and src files into your application. Existing
PostgreSQL-marked Rust projects require a new output directory; the builder does
not silently switch providers. SQL runtime and migrations are deferred.

An optional live MongoDB check uses a running local or test instance:

```sh
GMB_MONGODB_URL=mongodb://127.0.0.1:27017/builder_smoke npm run test:rust
```

The live checks verify `/ready` and exercise the CRUD lifecycle in a uniquely
named `gmb_rust_crud_test_*` database, which is dropped on success. The database
from the supplied URL is pinged but its application data is not modified. A failed
test retains its temporary database for diagnosis.

## Basic CRUD API

`examples/todo-rust.schema` explicitly grants public access to each Todo operation.
The original `examples/todo.schema` keeps its user-filtered list rule: Rust denies
that list until authentication and filter authorization are implemented.

```graphql
mutation {
  todoCreate(input: {message: "Try Rust"}) { id message done createdAt }
}
query {
  todoAll(limit: 20, offset: 0) { id message done }
  todoOne(id: "REPLACE_WITH_RETURNED_ID") { id message done }
}
mutation {
  todoUpdate(id: "REPLACE_WITH_RETURNED_ID", input: {done: true}) { id message done }
}
mutation {
  todoRemove(id: "REPLACE_WITH_RETURNED_ID")
}
```

Send one operation at a time to POST `/graphql`, for example:

```sh
curl http://127.0.0.1:3001/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { todoCreate(input: {message: \"Try Rust\"}) { id message done } }"}'
```

Operation names use the model name with a lowercase first character, followed by
`Create`, `One`, `All`, `Update` or `Remove`. This initial Rust API is not yet a
replacement for the full TypeScript GraphQL contract.

- Supported fields: ID, String, Boolean, Int, Float, DateTime and scalar arrays.
- Required create inputs are checked by GraphQL; scalar defaults apply on omission.
  Explicit null does not activate a default. Updates preserve omitted fields;
  explicit null clears nullable fields and is rejected for required fields.
- IDs and timestamps are assigned by the server. Hidden, underscore-prefixed,
  readonly and system relation fields are excluded from write inputs. Hidden and
  relation fields are absent from output DTOs. System User, UserRole and File
  models have no CRUD API.
- A CRUD operation is permitted only by an unrestricted `public` rule. Lists and
  mutations that return a record also require public `one` access. Owner, user,
  role, filter and field-restricted rules are denied before database access.
- Models with custom relations/entities, uniqueness or regex validation stay
  record-only. Required hidden/readonly fields, or defaults on those fields,
  also keep a model out of the API. The builder does not bypass these constraints.
- Lists default to 20 rows; limit is 1–100, offset is 0–10000. Ordering is by ID.
  Missing records return null for One/Update and false for Remove. Empty updates
  return the existing record without changing its timestamp.
- Each database operation has a five-second timeout. Driver failures return
  generic errors. GraphQL inputs do not accept MongoDB filters or update operators.

Collections are named `gmb_rust_<ModelName>`. IDs are hex ObjectId strings and
DateTime fields, including timestamps, are stored as RFC3339 strings. This layout
is experimental and separate from the TypeScript/Mongoose storage format.

When upgrading the earlier server scaffold, merge the new `Cargo.toml` features,
`src/server.rs`, `src/database/mod.rs` and `src/database/crud.rs` from a fresh
output directory. In particular the server must build its schema through
`generated::graphql::schema(database.clone())`; its old health-only schema is
preserved on regeneration. Subsequent schema changes regenerate GraphQL DTOs and
permission checks under `src/generated/` automatically.

## GraphiQL browser interface

Start with GraphiQL explicitly enabled:

```sh
DATABASE_URL=mongodb://127.0.0.1:27017/todo GRAPHIQL_ENABLED=true cargo run
```

Open <http://127.0.0.1:3001/graphql>. GET serves the GraphiQL editor with schema
exploration, autocomplete and execution against POST `/graphql` on the same
server. For example:

```graphql
mutation {
  todoCreate(input: {message: "Try GraphiQL"}) { id message done }
}
```

The editor uses the upstream async-graphql GraphiQL HTML template and fetches
JavaScript/CSS from unpkg.com, so the browser needs internet access to load it.
The flag only enables the editor; it does not change CRUD permissions. When the
flag is absent or `false`, GET `/graphql` returns 405 and POST keeps working.
Invalid flag values stop startup.

For an existing generated application, merge updated `src/config.rs`,
`src/server.rs`, `src/main.rs`, `.env.example` and Cargo.toml from a fresh output
directory. Regeneration preserves these editable files. The new main passes
`config.graphiql_enabled` to `server::router_with_graphiql`; `server::router`
remains available with the editor disabled.

## Authentication

Every new Rust project receives a random 256-bit `JWT_TOKEN_SECRET` in `.env`,
created with permissions 0600 and excluded from Git. Regeneration preserves it.
The server reads `.env` from its current working directory without mutating the
process environment. Run commands from the generated project directory.
Environment variables take precedence. Missing, blank or shorter-than-32-byte
JWT secrets stop startup; there is no public fallback key. Rotating the key
invalidates all previously issued tokens.

Create an account locally (MongoDB must be running):

```sh
DATABASE_URL=mongodb://127.0.0.1:27017/todo cargo run -- create-user you@example.test
```

The command prompts twice without echoing the password. Passwords must contain
12–72 UTF-8 bytes and no NUL characters. They are hashed with bcrypt cost 12 on a
blocking worker. No account, password or admin role is created automatically.
The account starts with an empty roles array. Email addresses are trimmed and
normalized to lowercase ASCII and protected by a unique MongoDB index. Index
setup runs before the HTTP listener starts; invalid existing data fails startup.

Use GraphiQL (enable with `GRAPHIQL_ENABLED=true`) or POST `/graphql`:

```graphql
mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    token
    expiresIn
    user { id email roles }
  }
}
```

The access token lasts 900 seconds. Set the GraphiQL Headers panel to:

```json
{"Authorization": "Bearer REPLACE_WITH_RETURNED_TOKEN"}
```

Then query:

```graphql
query { me { id email roles } }
```

Without credentials, `me` returns null. If an Authorization header is present,
malformed, expired or invalid credentials return HTTP 401, even for public queries.
An authentication database outage returns 503 rather than accepting an anonymous
request. JWTs require HS256, expiry, issuer `crud-monster-rust`, audience
`crud-monster-api`, an access-token type and a valid subject. Password hashes and
JWT signing keys are never GraphQL fields. Roles are loaded from MongoDB on every
request rather than trusted from token claims.

Authentication stores accounts in `gmb_rust_User` with private `passwordHash`,
`disabled` and `tokenVersion` fields. Disabling/deleting an account immediately
rejects its tokens. A trusted administrator can increment `tokenVersion` to revoke
all of an account's existing tokens. Client logout discards the token; there is no
refresh-token, server logout, registration, password-change or recovery endpoint
in this step. Existing bcrypt 2a/2b/2y hashes with cost 4–16 verify unchanged,
provided passwords fit the 72-byte limit. TypeScript account storage and JWT
formats are not automatically migrated.

Login errors do not disclose whether an account exists. Missing accounts still
perform bcrypt work. Each process limits attempts to 10 per normalized email per
60 seconds, bounds the limiter to 1024 active email keys, and permits at most four
concurrent login operations. Apply shared ingress limits when running multiple
server instances; these in-memory limits are not distributed.

Authentication does not yet unlock `user`, `owner`, role or filter CRUD rules.
Those operations remain Forbidden until the authorization step. Public
registration and public role assignment are not exposed.

For an earlier generated application, merge updated Cargo.toml, src/auth.rs,
src/lib.rs, src/config.rs, src/server.rs and src/main.rs from a fresh output.
The main must use `router_with_auth` and initialize the auth indexes. Existing
editable files and `.env` are preserved, so an existing `.env` without a JWT key
must be supplied with a random `JWT_TOKEN_SECRET`. `src/generated/graphql.rs`
regenerates login/me automatically. Legacy router helpers without an auth service
keep public CRUD available but return an explicit error for login.

The optional live smoke test creates a separate `gmb_rust_auth_test_*` database,
checks login/JWT/disabled accounts/role reload/revocation, and drops it on success.
It does not create users in the database named in `GMB_MONGODB_URL`.
