import { ensureGeneratedJwtSecret } from './jwt-config'
import * as fs from 'fs'
import { templateFileToText } from '../common/files'
import { SchemaModel, SchemaModelType } from '../common/types'
import { getModelsFromSchema } from '../parser/scan'
import { BackendDirectory } from './backendDirectory'
import { generateDataloaders } from './generators/dataloaders'
import { generateEntry } from './generators/entry'
import { generateIntegrationTests } from './generators/integration'
import { generateMongoModelToFile } from './generators/model'
import { createModelTypeFromModel } from './generators/model-types'
import { generateResolverToFile } from './generators/resolvers'
import { generateRestToFile } from './generators/rest'
import { generateSchema } from './generators/schema'
import { generateServiceToFile } from './generators/service'
import { DatabaseProvider, databaseProvider, schemaFromModels } from './database/schema'
import { prepareMigration } from './database/migrations'
import { generatedPackage, generateSqlModel, generateSqlRuntime, generateSqlService, sqlExtras } from './database/generate'

export interface BackendConfig {
    database?: DatabaseProvider
    integrationTestsEnable?: boolean
    [template: string]: any
}

export const exportAs = async (name, from, base = '.', config: BackendConfig = {}) => {
    const importedSchema = fs.readFileSync(from, { encoding: 'utf8' })
    return exportAsFromString(name, importedSchema, base, config)
}

export const exportAsFromString = async (name, importedSchema, outDir = '.', config: BackendConfig = {}) => {
    const provider = databaseProvider(config.database)
    const models = await getModelsFromSchema(importedSchema)
    if (provider !== 'mongodb' && !fs.existsSync(`${outDir}/database/schema.snapshot.json`) && fs.existsSync(`${outDir}/gen/source.schema`)) {
        throw new Error('SQL generation is supported for new backends. Choose a new output directory instead of replacing an existing MongoDB backend.')
    }
    // Validate and compute the diff before clearing any generated files.
    const migration = provider === 'mongodb' ? undefined : prepareMigration(outDir, schemaFromModels(models, provider))
    if (provider === 'mongodb' && fs.existsSync(`${outDir}/database/schema.snapshot.json`)) throw new Error('Cannot change an existing SQL backend to MongoDB')

    const backendDirectory = new BackendDirectory()
    backendDirectory.init(name, outDir)
    // TODO: in some times 'services/' is not used,
    //       so not create directory what is not necessary
    backendDirectory.prepareDirectory()
    ensureGeneratedJwtSecret(outDir)

    generateAll(backendDirectory, models, config)

    backendDirectory.writeWithConfig('server', config)
    backendDirectory.writeWithConfig('sendMail', config, 'services')
    backendDirectory.writeWithConfig('passport', config, 'services')
    if (provider === 'mongodb') backendDirectory.writeWithConfig('extras', config, 'gen')
    else backendDirectory.genWrite('extras.ts', sqlExtras(config))
    backendDirectory.writeWithConfig('storage.t', config, 'gen')

    backendDirectory.genWrite('jwt', templateFileToText('jwt.ts', null))

    backendDirectory.genWrite(`schemaLoad`, templateFileToText(`schemaLoad.ts`, null))

    backendDirectory.genWrite(`services/db`, templateFileToText(provider === 'mongodb' ? 'db.ts' : 'sql/db.ts', null))
    backendDirectory.genWrite(`source.schema`, importedSchema)
    backendDirectory.write('tsconfig.json', templateFileToText('tsconfig.json', null))
    backendDirectory.write('jest.config.js', templateFileToText('jest.config.js', null))
    backendDirectory.write(`package.json`, generatedPackage(provider))
    const helper = templateFileToText(`integration-test-helper.ts`, null)
    backendDirectory.genWrite(`integration-tests/helper.ts`, provider === 'mongodb' ? helper : helper.replace("import * as mongoose from 'mongoose'", ''))

    backendDirectory.genWrite('api-auth.ts', templateFileToText(`api/api-auth.t.ts`, null))
    backendDirectory.genWrite('api-utils.ts', templateFileToText(`api/api-utils.t.ts`, null))
    if (migration) {
        generateSqlRuntime(backendDirectory)
        migration.commit()
    }
}

export function generateAll(backendDirectory: BackendDirectory, models: SchemaModel[], config: BackendConfig) {
    const provider = databaseProvider(config.database)
    generateSchema(backendDirectory, models)

    let typesAll = provider === 'mongodb' ? `import { Document } from 'mongoose'\n` : `interface Document { _id: string; id: string; save(): Promise<this>; toObject(): any; toJSON(): any }\n`
    for (const model of models) {
        const notVirtualMembers = model.members.filter((member) => !member.isVirtual)
        if (provider === 'mongodb') generateMongoModelToFile(backendDirectory, model, notVirtualMembers)
        else generateSqlModel(backendDirectory, model)
        typesAll += createModelTypeFromModel(model, notVirtualMembers)

        if (provider === 'mongodb') generateServiceToFile(backendDirectory, model)
        else generateSqlService(backendDirectory, model)
        if (model.type === SchemaModelType.MODEL) {
            generateRestToFile(backendDirectory, model)
            generateResolverToFile(backendDirectory, model)
        }

        console.log(`${model.modelName} generated with ${model.members.length} members`)
    }

    backendDirectory.genWrite(`model-types.ts`, typesAll)

    generateDataloaders(backendDirectory, models, provider !== 'mongodb')

    // if (config.integrationTestsEnable)
    generateIntegrationTests(backendDirectory, models)

    generateEntry(backendDirectory, models)
}
