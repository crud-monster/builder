import * as fs from 'fs'
import * as path from 'path'
import { templateFileToText } from '../files'
import { SchemaModel, SchemaModelType } from '@common/types'
import { firstToLower } from '@common/utils'
import { BackendDirectory } from '../backendDirectory'
import { createService, generateServiceToFile } from '../generators/service'
import { DatabaseProvider } from '../../../database/schema'

export function generateSqlModel(directory: BackendDirectory, model: SchemaModel) {
    // Embedded entities live in JSON columns and do not have their own SQL table.
    directory.modelsWrite(model.modelName, model.type === SchemaModelType.ENTITY
        ? `export type { ${model.modelName}Model } from '../model-types'\n`
        : `import { model } from '../sql/models'\nexport const ${firstToLower(model.modelName)}Model = model(${JSON.stringify(model.modelName)})\n`)
}

export function generateSqlService(directory: BackendDirectory, model: SchemaModel) {
    if (model.type === SchemaModelType.ENTITY) return generateServiceToFile(directory, model)
    let service = createService(model)
    service = service.replace(', Types }', ' }')
        .replace('const id = new Types.ObjectId()', 'const id = randomUUID()\n        data._id = id')
        .replace(`export const generate${model.modelName}Service =`, `const generateRaw${model.modelName}Service =`)
    service = `import { randomUUID } from 'crypto'\nimport { transactionalServices } from '../sql/models'\n` + service
    service += `\nexport const generate${model.modelName}Service = entry => transactionalServices(generateRaw${model.modelName}Service(entry))\n`
    directory.servicesWrite(model.modelName, service)
}

export function generateSqlRuntime(directory: BackendDirectory) {
    fs.mkdirSync(path.join(directory.baseDir, 'gen/sql'), { recursive: true })
    fs.mkdirSync(path.join(directory.baseDir, 'gen/sql/dialects'), { recursive: true })
    for (const file of ['database.ts', 'models.ts', 'filter.ts', 'types.ts', 'migrate.ts', 'dialects/index.ts', 'dialects/postgresql.ts', 'dialects/mysql.ts']) {
        directory.genWrite(`sql/${file}`, templateFileToText(`sql/${file}`))
    }
}

export function generatedPackage(provider: DatabaseProvider) {
    const manifest = JSON.parse(templateFileToText('package.json'))
    if (provider !== 'mongodb') {
        delete manifest.dependencies.mongoose
        // SQL is an optional generated-backend dependency, not a builder dependency.
        manifest.dependencies.knex = '^3.3.0'
        manifest.dependencies[provider === 'postgresql' ? 'pg' : 'mysql2'] = provider === 'postgresql' ? '^8.23.1' : '^3.24.6'
        manifest.scripts['db:migrate'] = 'ts-node gen/sql/migrate.ts up'
        manifest.scripts['db:status'] = 'ts-node gen/sql/migrate.ts status'
    }
    return JSON.stringify(manifest, null, 2) + '\n'
}

export function sqlExtras(config: any) {
    const custom = config.extras
    const source = templateFileToText(custom?.template || 'extras.ts', custom?.config)
    // SQL filters retain nested AND/OR and relation scopes.
    return source.replace('export const filterGen =', 'const legacyFilterGen =')
        .replace(/__forgottenPasswordToken:/g, '__resetPasswordToken:')
        + `\nexport { filterGen } from './sql/filter'\n`
}
