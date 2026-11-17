# Database backends and schema migrations

New backends can use MongoDB (the default), PostgreSQL or MySQL:

```sh
graphql-monster-builder models.schema ./server --database postgresql
graphql-monster-builder models.schema ./server --database mysql
```

The programmatic `exportAs` / `exportAsFromString` API accepts `{ database: 'postgresql' }` or `{ database: 'mysql' }` as its configuration. Regenerate with the same provider and output directory every time. Switching an existing backend between providers and moving existing MongoDB data into SQL are not supported.

## Backend target

TypeScript is the default backend target. It can also be selected explicitly:

```sh
graphql-monster-builder models.schema ./server --target typescript --database postgresql
```

The programmatic `exportAs` / `exportAsFromString` configuration accepts
`{ target: 'typescript', database: 'postgresql' }`. Target selection is independent
of the database provider. TypeScript is currently the only supported target;
unsupported targets are rejected before output files are changed. The builder
parses the schema once and passes the models to the selected target generator.

The TypeScript target owns its generators, templates, output directory layout,
and database runtime under `services/backend/targets/typescript/`. Database
metadata, schema diffs, SQL statements and snapshot history remain shared under
`services/backend/database/`. The selected target supplies the migration file
format; TypeScript retains the existing `.cjs` migrations and Knex runner.

## Running a SQL backend

Install the generated project's dependencies. Configure either `DATABASE_URL`, or `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`. Configuration is loaded through the existing dotenv-flow setup, so local values can live in `.env.development.local`.

```sh
cd server
npm install
# PostgreSQL example; use mysql:// for MySQL.
export DATABASE_URL='postgresql://app:password@localhost:5432/my_database'
npm run db:status
npm run db:migrate
npm start
```

Create the database and credentials beforehand. The migrator creates tables inside that database. Generation never connects to a database or applies migrations. Server startup refuses to proceed while migrations are pending.

## Schema history

Commit the entire `database/` directory with the generated backend:

```text
database/
  schema.snapshot.json
  snapshots/000001_<hash>.json
  migrations/000001_<hash>.cjs
```

Each successful generation compares normalized persistence metadata with the last generated snapshot. It appends a migration and immutable snapshot when the schema changes, and updates the current snapshot last. An unchanged schema creates no new version. Source ordering and API authorization changes do not create database migrations. The history lives outside `gen/`, which is recreated during generation.

Snapshots track generated versions, while `_gmb_migrations` and `_gmb_migration_checksums` track versions actually applied in each database. Knex serializes migrators with its migration lock. Checksums reject edits or deletions of applied migrations. Edit a pending migration when a data transformation is needed; never edit an applied one.

Generated migrations contain dialect-specific SQL in a self-contained CommonJS `up` function. They remain executable without the builder. Database-independent model metadata is retained in the corresponding snapshot for inspection.

## Reviewing changes

Removing tables/columns, changing column definitions, changing uniqueness or adding a required column without a default requires review. The generated migration refuses to run until it has been reviewed and this explicit flag is set:

```sh
GMB_ALLOW_DESTRUCTIVE_MIGRATIONS=1 npm run db:migrate
```

Review the SQL first and add backfills/conversions as needed. The flag does not make a destructive migration safe, and a newly required field still needs values for existing rows. The generator cannot infer a rename: it emits drop/add operations. Replace those with an appropriate rename/data migration **before applying** them. There is no automatic rollback; write a reviewed forward migration instead.

PostgreSQL migrations run in transactions. MySQL DDL implicitly commits, so a failed migration may have partially changed the database. Inspect and repair that state before retrying. Never make the runner mark a partially applied migration as successful.

## SQL storage and compatibility

- Each model is a table, with UUID string IDs and `createdAt`/`updatedAt` timestamps. Scalars use typed columns. Indexed strings have a 255-character limit; unindexed strings use text.
- Embedded entities and arrays (including collections of relation IDs) use PostgreSQL JSONB / MySQL JSON columns. Relations retain the builder's application-managed behavior; this version does not generate foreign keys or normalized join tables. Do not treat it as a drop-in relational schema for external writers.
- Unique constraints on JSON fields are rejected during generation. Required fields and regular expression validation on embedded data are enforced by the generated adapter, not by JSON column constraints.
- Generated CRUD services run in transactions, including recursive relation updates. Authentication, role lookup, document saving and file metadata use the SQL model adapter. The GraphQL/REST API and service hook names are retained; hooks that call Mongoose-specific APIs need adapting.
- Scalar filters, AND/OR, relation filters and filters inside a single embedded entity are supported. Filtering inside arrays of embedded entities is explicitly rejected. Uniqueness, collation and regular expression behavior can differ between database engines.
- Existing MongoDB generation remains available without Knex or SQL driver dependencies in its generated manifest. MongoDB does not receive SQL migrations.

## Verification

```sh
npm run test:unit -- --runInBand
npm run test:sql
```

The default SQL smoke test uses pg-mem for migration execution, generated GraphQL CRUD, registration, login, token refresh, role relations and checksum checks, plus MySQL query compilation. pg-mem does not verify real transaction rollback or all server-specific SQL behavior.

For real-engine checks, start fresh, disposable databases and run each provider separately:

```sh
docker compose -f compose.sql-tests.yml up -d --wait
GMB_SQL_TEST_DATABASE_URL='postgresql://gmb:gmb_test_only@127.0.0.1:15432/gmb_test' npm run test:sql
GMB_SQL_TEST_PROVIDER=mysql GMB_SQL_TEST_DATABASE_URL='mysql://gmb:gmb_test_only@127.0.0.1:13306/gmb_test' npm run test:sql
docker compose -f compose.sql-tests.yml down -v
```

The real-engine smoke tests expect empty test databases, apply two migrations and exercise transaction rollback. Recreate the test databases before rerunning. Do not point them at application databases.
