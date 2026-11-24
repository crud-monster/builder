const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { exportAsFromString } = require('../dist/services/backend/build.js')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmb-rust-smoke-')))
const cargo = process.env.GMB_CARGO_BIN || 'cargo'

function run(...args) {
    const result = spawnSync(cargo, args, { cwd: root, stdio: 'inherit', env: { CARGO_PROFILE_DEV_DEBUG: '0', CARGO_PROFILE_TEST_DEBUG: '0', CARGO_INCREMENTAL: '0', ...process.env } })
    if (result.error) throw new Error(`Cannot run Cargo. Install Rust with rustup or set GMB_CARGO_BIN: ${result.error.message}`)
    assert.equal(result.status, 0, `cargo ${args.join(' ')} failed`)
}

async function main() {
    const keywords = 'as async await break const continue dyn else enum extern false fn for gen if impl in let loop match mod move mut pub ref return static struct super trait true type unsafe use where while abstract become box do final macro override priv typeof unsized virtual yield try union macro_rules self crate'.split(' ')
    const schema = `
entity Address {
    city: String!
}
model Task {
    title: String! @default("hello")
    done: Boolean @default(false)
    count: Int @default(0)
    amount: Float @default(1)
    dueAt: DateTime
    tags: [String]
    address: Address
    secret: String @hidden
}
@all("public") @one("public") @create("public") @update("public") @remove("public")
model Todo {
    message: String!
    title: String! @default("untitled")
    done: Boolean @default(false)
    count: Int! @default(0)
    amount: Float
    dueAt: DateTime
    tags: [String]
    note: String
    secret: String @hidden
    marker: String @readonly
}
@all(filter:"user_every.id={{userId}}")
@one("public") @create("public") @update("public") @remove("public")
model FilteredTodo {
    message: String
}
@all("public")
model PrivateRead {
    message: String
}
model Keywords {
${keywords.map(name => `    ${name}: String`).join('\n')}
}
`
    await exportAsFromString('rust-smoke', schema, root, { target: 'rust' })
    fs.mkdirSync(path.join(root, 'tests'))
    fs.writeFileSync(path.join(root, 'tests', 'generated_models.rs'), `
use crud_rust_smoke::{TaskRecord, UserRecord, KeywordsRecord};
use serde_json::json;

#[test]
fn defaults_entities_dates_and_json_names() {
    let task: TaskRecord = serde_json::from_value(json!({
        "id": "task-id", "dueAt": "2026-11-17T12:00:00Z", "tags": ["a", "b"],
        "address": {"city": "Prague"}, "user": "owner-id", "secret": "hidden-value"
    })).unwrap();
    assert_eq!(task.title, "hello");
    assert_eq!(task.done, Some(false));
    assert_eq!(task.count, Some(0));
    assert_eq!(task.amount, Some(1.0));
    assert_eq!(task.address.as_ref().unwrap().city, "Prague");
    assert_eq!(task.user.as_deref(), Some("owner-id"));
    let value = serde_json::to_value(&task).unwrap();
    assert_eq!(value["dueAt"], "2026-11-17T12:00:00Z");
    assert_eq!(value["tags"], json!(["a", "b"]));
    assert!(value.get("secret").is_none());
    assert!(value.get("due_at").is_none());
}

#[test]
fn nullability_and_required_fields() {
    let task: TaskRecord = serde_json::from_value(json!({"id": "id", "done": null, "tags": null})).unwrap();
    assert_eq!(task.done, None);
    assert_eq!(task.tags, None);
    assert!(serde_json::from_value::<TaskRecord>(json!({})).is_err());
    assert!(serde_json::from_value::<TaskRecord>(json!({"id": "id", "title": null})).is_err());
    assert!(serde_json::from_value::<TaskRecord>(json!({"id": "id", "unexpected": "value"})).is_err());
    assert!(serde_json::from_value::<TaskRecord>(json!({"id": "id", "count": 2147483648_i64})).is_err());
}

#[test]
fn keyword_fields_keep_schema_names() {
    let record: KeywordsRecord = serde_json::from_value(json!({
        "id": "id", "type": "kind", "self": "me", "crate": "package", "super": "parent", "gen": "generation"
    })).unwrap();
    assert_eq!(record.r#type.as_deref(), Some("kind"));
    assert_eq!(record.self_.as_deref(), Some("me"));
    assert_eq!(record.crate_.as_deref(), Some("package"));
    let value = serde_json::to_value(record).unwrap();
    assert_eq!(value["self"], "me");
    assert_eq!(value["type"], "kind");
    assert_eq!(value["gen"], "generation");
}

#[test]
fn built_in_password_is_not_serialized() {
    let user: UserRecord = serde_json::from_value(json!({
        "id": "id", "email": "user@example.test", "password": "never-return-this"
    })).unwrap();
    let value = serde_json::to_value(user).unwrap();
    assert!(value.get("password").is_none());
    assert!(!value.to_string().contains("never-return-this"));
}
`)
    fs.copyFileSync(path.join(__dirname, 'rust-server-tests.rs'), path.join(root, 'tests', 'server.rs'))
    fs.copyFileSync(path.join(__dirname, 'rust-crud-tests.rs'), path.join(root, 'tests', 'crud.rs'))
    fs.copyFileSync(path.join(__dirname, 'rust-auth-tests.rs'), path.join(root, 'tests', 'auth.rs'))
    const cliSchema = path.join(root, 'input.schema')
    fs.writeFileSync(cliSchema, schema)
    const cli = path.resolve(__dirname, '../bin/cli.js')
    const cliOutput = path.join(root, 'cli-project')
    const generated = spawnSync(process.execPath, [cli, cliSchema, cliOutput, '--target', 'rust'], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr + generated.stdout)
    assert.equal(JSON.parse(fs.readFileSync(path.join(cliOutput, '.gmb-project.json'), 'utf8')).database, 'mongodb')
    assert(generated.stdout.includes('cargo check'))
    const unsupportedOutput = path.join(root, 'unsupported-project')
    const unsupported = spawnSync(process.execPath, [cli, cliSchema, unsupportedOutput, '--target', 'rust', '--database', 'mysql'], { encoding: 'utf8' })
    assert.notEqual(unsupported.status, 0)
    assert(!fs.existsSync(unsupportedOutput))
    const frontendOutput = path.join(root, 'frontend-project')
    const frontend = spawnSync(process.execPath, [cli, cliSchema, frontendOutput, '--target', 'rust', '--frontend'], { encoding: 'utf8' })
    assert.notEqual(frontend.status, 0)
    assert(frontend.stderr.includes('Rust target only supports backend generation'))
    assert(!fs.existsSync(frontendOutput))
    const tsOutput = path.join(root, 'typescript-project')
    const typescript = spawnSync(process.execPath, [cli, cliSchema, tsOutput], { encoding: 'utf8' })
    assert.equal(typescript.status, 0, typescript.stderr + typescript.stdout)
    assert(JSON.parse(fs.readFileSync(path.join(tsOutput, 'package.json'), 'utf8')).dependencies.mongoose)
    run('check')
    const lock = fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8')
    fs.appendFileSync(path.join(root, 'src/main.rs'), '\n// User customization preserved across regeneration.\n')
    await exportAsFromString('rust-smoke', schema.replace('    tags: [String]', '    tags: [String]\n    extra: Int'), root, { target: 'rust' })
    assert(fs.readFileSync(path.join(root, 'src/main.rs'), 'utf8').includes('User customization'))
    assert.equal(fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8'), lock)
    assert(fs.readFileSync(path.join(root, 'src/generated/models.rs'), 'utf8').includes('pub extra:'))
    const constrainedOutput = path.join(root, 'constrained-project')
    await exportAsFromString('constrained', 'model UniqueRecord {\n name: String! @unique\n}', constrainedOutput, { target: 'rust' })
    run('check', '--manifest-path', path.join(constrainedOutput, 'Cargo.toml'), '--target-dir', process.env.CARGO_TARGET_DIR || path.join(root, 'target'))
    run('test', '--locked')
    if (process.env.GMB_MONGODB_URL) run('test', '--locked', '--', '--ignored')
    fs.rmSync(root, { recursive: true, force: true })
    console.log('Rust smoke passed: Cargo check, model serialization, typed CRUD, permissions/input validation, HTTP routes, configuration, bcrypt/JWT authentication, and regeneration.')
}
main().catch(error => {
    console.error(error)
    console.error(`Generated Rust project retained for debugging: ${root}`)
    process.exitCode = 1
})
