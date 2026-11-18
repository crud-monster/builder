import { SchemaModel, SchemaModelMember, SchemaModelProtectionType, SchemaModelType, SYSTEM_MODELS } from '@common/types'
import { defaultValue, fieldName, memberType, rustString, rustTypeName } from './models'

// Do not expose models whose persistence constraints or nested permissions are not implemented.
export function supportsRustCrud(model: SchemaModel): boolean {
    return model.type === SchemaModelType.MODEL && !SYSTEM_MODELS.includes(model.modelName)
        && !model.members.some(member => member.isSystem && member.relation && member.isRequired)
        && model.members.some(member => !member.isSystem && !member.isVirtual && !member.isHidden && !member.isReadonly && !member.name.startsWith('_'))
        && model.members.filter(member => !member.isSystem && !member.isVirtual).every(member =>
            !member.relation && !member.isUnique && !member.regExp
            && !((member.isHidden || member.isReadonly || member.name.startsWith('_')) && (member.isRequired || member.default !== undefined)))
}

function isPublic(model: SchemaModel, operation: keyof SchemaModel['protection']): boolean {
    return model.protection[operation]?.some(rule => rule.type === SchemaModelProtectionType.PUBLIC
        && !rule.param && !rule.filter?.length && !rule.whitelist?.length && !rule.blacklist?.length && !rule.roles?.length) ?? false
}

function graphqlType(member: SchemaModelMember): string {
    const type = memberType(member)
    return member.modelName === 'ID' ? type.replace('std::string::String', 'async_graphql::ID') : type
}

export function generateRustGraphql(models: SchemaModel[]): string {
    const supported = models.filter(supportsRustCrud)
    const types: string[] = []
    const queries = ['    async fn health(&self) -> bool { true }']
    const mutations: string[] = []
    supported.forEach((model, index) => {
        const name = rustTypeName(model)
        const output = `Crud${name}Output`
        const create = `Crud${name}Create`
        const update = `Crud${name}Update`
        const prefix = model.modelName[0].toLowerCase() + model.modelName.slice(1)
        const collection = rustString(`gmb_rust_${model.modelName}`)
        const visible = model.members.filter(member => !member.isVirtual && !member.relation && !member.isHidden && !member.name.startsWith('_'))
        const writable = visible.filter(member => !member.isSystem && !member.isReadonly)
        const fieldAttributes = (member: SchemaModelMember) => `    #[graphql(name = ${rustString(member.name)})]\n    #[serde(rename = ${rustString(member.name === 'id' ? '_id' : member.name)})]`
        types.push(`#[derive(async_graphql::SimpleObject, serde::Deserialize)]
pub struct ${output} {
${visible.map(member => `${fieldAttributes(member)}\n    pub ${fieldName(member, model)}: ${graphqlType(member)},`).join('\n')}
}`)
        const input = (patch: boolean) => `#[derive(async_graphql::InputObject)]
pub struct ${patch ? update : create} {
${writable.map(member => {
    const base = graphqlType({ ...member, isRequired: true })
    const defaultAttribute = !patch && member.isRequired && member.default !== undefined
        ? `\n    #[graphql(default_with = ${rustString(defaultValue(model, member))})]` : ''
    return `    #[graphql(name = ${rustString(member.name)})]${defaultAttribute}\n    pub ${fieldName(member, model)}: ${!patch && member.isRequired ? base : `async_graphql::MaybeUndefined<${base}>`},`
}).join('\n')}
}`
        types.push(input(false), input(true))
        const assignments = (patch: boolean) => writable.map(member => {
            const field = `input.${fieldName(member, model)}`
            const key = rustString(member.name)
            if (!patch && member.isRequired) return `        doc.insert(${key}, crud::value(&${field})?);`
            const missing = !patch && member.default !== undefined
                ? `doc.insert(${key}, crud::value(&${defaultValue(model, { ...member, isRequired: true })})?);` : ''
            const nullValue = member.isRequired ? 'return Err(async_graphql::Error::new("Required field cannot be null"));' : `doc.insert(${key}, mongodb::bson::Bson::Null);`
            return `        match ${field} {
            async_graphql::MaybeUndefined::Undefined => { ${missing} }
            async_graphql::MaybeUndefined::Null => { ${nullValue} }
            async_graphql::MaybeUndefined::Value(value) => { doc.insert(${key}, crud::value(&value)?); }
        }`
        }).join('\n')
        const permission = (op: keyof SchemaModel['protection'], returningRecord = false) => String(isPublic(model, op) && (!returningRecord || isPublic(model, 'one')))
        queries.push(`    #[graphql(name = ${rustString(prefix + 'One')})]
    async fn m${index}_one(&self, ctx: &async_graphql::Context<'_>, id: async_graphql::ID) -> async_graphql::Result<Option<${output}>> {
        crud::authorize(${permission('one')})?;
        crud::one(ctx.data::<mongodb::Database>()?, ${collection}, id.as_str()).await
    }
    #[graphql(name = ${rustString(prefix + 'All')})]
    async fn m${index}_all(&self, ctx: &async_graphql::Context<'_>, #[graphql(default = 20)] limit: i32, #[graphql(default = 0)] offset: i32) -> async_graphql::Result<Vec<${output}>> {
        crud::authorize(${permission('all', true)})?;
        crud::all(ctx.data::<mongodb::Database>()?, ${collection}, limit, offset).await
    }`)
        mutations.push(`    #[graphql(name = ${rustString(prefix + 'Create')})]
    async fn m${index}_create(&self, ctx: &async_graphql::Context<'_>, input: ${create}) -> async_graphql::Result<${output}> {
        crud::authorize(${permission('create', true)})?;
        let mut doc = mongodb::bson::Document::new();
${assignments(false)}
        crud::create(ctx.data::<mongodb::Database>()?, ${collection}, doc).await
    }
    #[graphql(name = ${rustString(prefix + 'Update')})]
    async fn m${index}_update(&self, ctx: &async_graphql::Context<'_>, id: async_graphql::ID, input: ${update}) -> async_graphql::Result<Option<${output}>> {
        crud::authorize(${permission('update', true)})?;
        let mut doc = mongodb::bson::Document::new();
${assignments(true)}
        crud::update(ctx.data::<mongodb::Database>()?, ${collection}, id.as_str(), doc).await
    }
    #[graphql(name = ${rustString(prefix + 'Remove')})]
    async fn m${index}_remove(&self, ctx: &async_graphql::Context<'_>, id: async_graphql::ID) -> async_graphql::Result<bool> {
        crud::authorize(${permission('remove')})?;
        crud::remove(ctx.data::<mongodb::Database>()?, ${collection}, id.as_str()).await
    }`)
    })
    return `// Generated by CRUD Monster Builder. Regenerate instead of editing.
${supported.length ? 'use crate::database::crud;' : ''}
${types.join('\n\n')}

pub struct QueryRoot;
#[async_graphql::Object]
impl QueryRoot {
${queries.join('\n')}
}
${supported.length ? `pub struct MutationRoot;
#[async_graphql::Object]
impl MutationRoot {
${mutations.join('\n')}
}` : 'pub type MutationRoot = async_graphql::EmptyMutation;'}

pub type AppSchema = async_graphql::Schema<QueryRoot, MutationRoot, async_graphql::EmptySubscription>;

pub fn schema(database: mongodb::Database) -> AppSchema {
    async_graphql::Schema::build(QueryRoot, ${supported.length ? 'MutationRoot' : 'async_graphql::EmptyMutation'}, async_graphql::EmptySubscription)
        .data(database)
        .limit_depth(8)
        .limit_complexity(64)
        .finish()
}
`
}
