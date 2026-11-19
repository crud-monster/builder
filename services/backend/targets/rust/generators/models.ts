import { SchemaModel, SchemaModelMember, SchemaModelRelationType, SchemaModelType } from '@common/types'

const keywords = new Set('as async await break const continue dyn else enum extern false fn for gen if impl in let loop match mod move mut pub ref return static struct super trait true type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield try union macro_rules'.split(' '))
const specialIdentifiers = new Set(['self', 'super', 'crate'])
const scalarTypes: Record<string, string> = {
    ID: 'std::string::String', String: 'std::string::String', Boolean: 'bool',
    Int: 'i32', Float: 'f64', DateTime: 'chrono::DateTime<chrono::Utc>',
}

export function rustString(value: string): string {
    const escaped = [...value].map(character => {
        const code = character.codePointAt(0)
        const escape = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0' }[character]
        if (escape !== undefined) return escape
        if (code >= 0xd800 && code <= 0xdfff) throw new Error('Rust strings cannot contain unpaired Unicode surrogates')
        return code < 32 || code === 127 ? `\\u{${code.toString(16)}}` : character
    }).join('')
    return `"${escaped}"`
}

function snakeCase(name: string, location: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^_+$/.test(name)) throw new Error(`Invalid Rust identifier at ${location}: ${name}`)
    return name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

export function fieldName(member: SchemaModelMember, model: SchemaModel): string {
    const name = snakeCase(member.name, `${model.modelName}.${member.name}`)
    if (specialIdentifiers.has(name)) return name + '_'
    return keywords.has(name) ? 'r#' + name : name
}

export function rustTypeName(model: SchemaModel): string {
    const name = snakeCase(model.modelName, model.modelName).split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join('')
    return name + (model.type === SchemaModelType.ENTITY ? 'Entity' : 'Record')
}

export function memberType(member: SchemaModelMember): string {
    let base: string
    if (member.relation?.type === SchemaModelRelationType.ENTITY) base = rustTypeName(member.relation.relatedModel)
    else if (member.relation) base = scalarTypes.ID
    else base = scalarTypes[member.modelName]
    if (!base) throw new Error(`Unsupported Rust type: ${member.name}: ${member.modelName}`)
    const type = member.isArray ? `std::vec::Vec<${base}>` : base
    return member.isRequired ? type : `std::option::Option<${type}>`
}

export function defaultValue(model: SchemaModel, member: SchemaModelMember): string {
    const value = member.default
    const label = `${model.modelName}.${member.name}`
    if (member.relation || member.isArray) throw new Error(`Unsupported Rust default on relation or array: ${label}`)
    let expression: string
    if (member.modelName === 'String' && typeof value === 'string') expression = `std::string::String::from(${rustString(value)})`
    else if (member.modelName === 'Boolean' && typeof value === 'boolean') expression = String(value)
    else if (member.modelName === 'Int' && typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) expression = String(value)
    else if (member.modelName === 'Float' && typeof value === 'number' && Number.isFinite(value)) expression = `${value}f64`
    else throw new Error(`Unsupported or out-of-range Rust default: ${label}`)
    return member.isRequired ? expression : `Some(${expression})`
}

function validateEmbeddedCycles(model: SchemaModel, parents: string[] = []) {
    if (parents.includes(model.modelName)) throw new Error(`Recursive embedded entity is not supported by Rust: ${[...parents, model.modelName].join(' -> ')}`)
    for (const member of model.members.filter(member => !member.isVirtual)) {
        if (member.relation?.type === SchemaModelRelationType.ENTITY) validateEmbeddedCycles(member.relation.relatedModel, [...parents, model.modelName])
    }
}

export function generateRustModels(models: SchemaModel[]): string {
    const names = new Set<string>()
    for (const model of models) {
        const name = rustTypeName(model)
        if (names.has(name)) throw new Error(`Rust type name collision: ${model.modelName} becomes ${name}`)
        names.add(name)
        validateEmbeddedCycles(model)
    }
    const blocks = models.map(model => {
        const fields = new Set<string>()
        const defaults: string[] = []
        const members = model.members.filter(member => !member.isVirtual).map(member => {
            const name = fieldName(member, model)
            if (fields.has(name)) throw new Error(`Rust field name collision: ${model.modelName}.${member.name} becomes ${name}`)
            fields.add(name)
            const type = memberType(member)
            const attributes: string[] = []
            if (name !== member.name) attributes.push(`    #[serde(rename = ${rustString(member.name)})]`)
            if (member.isHidden || member.name.startsWith('_') || (model.modelName === 'User' && member.name === 'password')) attributes.push('    #[serde(skip_serializing)]')
            if (member.default !== undefined) {
                const functionName = `default_${snakeCase(rustTypeName(model), model.modelName)}_${name.replace(/^r#/, '')}`
                attributes.push(`    #[serde(default = ${rustString(functionName)})]`)
                defaults.push(`fn ${functionName}() -> ${type} {\n    ${defaultValue(model, member)}\n}`)
            } else if (!member.isRequired) attributes.push('    #[serde(default)]')
            return [...attributes, `    pub ${name}: ${type},`].join('\n')
        }).join('\n')
        return `#[derive(Clone, serde::Serialize, serde::Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct ${rustTypeName(model)} {\n${members}\n}\n${defaults.length ? '\n' + defaults.join('\n\n') + '\n' : ''}`
    })
    return '// Generated by CRUD Monster Builder. Regenerate instead of editing.\n\n' + blocks.join('\n') + '\n'
}
