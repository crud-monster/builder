# Experimental Rust target: model scaffold

The builder still runs in Node.js and uses the same schema parser as the
TypeScript target. This first Rust implementation emits a Cargo project and
serializable data-record types. It is not a running backend yet.

```sh
npm run build
node bin/cli.js examples/todo.schema ../todo-rust --target rust
cd ../todo-rust
cargo check
cargo test
```

Rust 1.85 or newer and Cargo are required to compile the generated project.
Generation itself does not run Cargo, install dependencies, connect to a database
or apply migrations. The Rust target currently accepts only `postgresql` and
uses it by default. The TypeScript target remains the default target and still
uses MongoDB unless `--database` is selected explicitly.

The programmatic API accepts `{ target: 'rust', database: 'postgresql' }`.
Frontend generation, TypeScript template overrides and
`integrationTestsEnable: true` are rejected for this scaffold.

## Generated project

```text
Cargo.toml
README.md
.gmb-project.json
src/
  main.rs
  lib.rs
  generated/
    mod.rs
    models.rs
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
They are data structures, not API input DTOs: permission rules, readonly
attributes, uniqueness and regular-expression validation have no runtime
implementation yet. They must not be exposed directly as a write API.

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

The next step is a small PostgreSQL/GraphQL CRUD backend. Authentication,
authorization and broader schema support must have parity tests before the
Rust target can be used as a production backend.
