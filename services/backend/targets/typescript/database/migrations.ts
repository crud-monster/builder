import { prepareMigration as prepareDatabaseMigration, MigrationRenderContext } from '../../../database/migrations'
import { DatabaseSchema } from '../../../database/schema'

function renderMigration({ id, version, hash, schema, plan }: MigrationRenderContext): string {
    return `// Generated database schema version ${version}. Review before applying.\n// Renames are represented as drop/add; edit this migration to preserve existing data.\nexports.schemaHash = ${JSON.stringify(hash)};\nexports.requiresReview = ${plan.changes.some(c => c.review)};\nexports.changes = ${JSON.stringify(plan.changes, null, 2)};\nexports.up = async (knex) => {\n    if (exports.requiresReview && process.env.GMB_ALLOW_DESTRUCTIVE_MIGRATIONS !== '1') {\n        throw new Error('Migration ${id} requires review. Review/edit it and set GMB_ALLOW_DESTRUCTIVE_MIGRATIONS=1 to apply.');\n    }\n    for (const sql of ${JSON.stringify(plan.statements, null, 2)}) await knex.raw(sql);\n};\nexports.down = async () => { throw new Error('Automatic rollback is not supported. Write and review a forward migration.'); };\nexports.config = { transaction: ${schema.provider === 'postgresql'} };\n`
}

export function prepareMigration(outDir: string, schema: DatabaseSchema) {
    return prepareDatabaseMigration(outDir, schema, { extension: 'cjs', render: renderMigration })
}
