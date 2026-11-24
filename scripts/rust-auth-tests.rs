use axum::{body::{to_bytes, Body}, http::{header::AUTHORIZATION, HeaderMap, Request}, Router};
use crud_rust_smoke::{auth::{self, AuthService}, config::Config, server};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use mongodb::{bson::{doc, oid::ObjectId, Document}, Client};
use serde_json::{json, Value};
use tower::ServiceExt;

const SECRET: &str = "auth-integration-test-key-only-64-bytes-000000000000000000000000000";
async fn request(app: &Router, operation: &str, variables: Value, token: Option<&str>) -> (u16, Value) {
    let mut req = Request::post("/graphql").header("content-type", "application/json");
    if let Some(token) = token { req = req.header(AUTHORIZATION, format!("Bearer {token}")); }
    let response = app.clone().oneshot(req.body(Body::from(json!({"query":operation,"variables":variables}).to_string())).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let value = serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap();
    (status, value)
}
fn sign(claims: &Value, secret: &str, algorithm: Algorithm) -> String {
    encode(&Header::new(algorithm), claims, &EncodingKey::from_secret(secret.as_bytes()).unwrap()).unwrap()
}
fn claims(id: &str) -> Value {
    let now = chrono::Utc::now().timestamp();
    json!({"sub":id,"iat":now,"nbf":now,"exp":now+900,"iss":"crud-monster-rust","aud":"crud-monster-api","tokenType":"access","ver":0})
}

#[test]
fn secrets_and_authorization_headers_are_validated() {
    let config = || Config::parse("mongodb://localhost/test", "127.0.0.1", "3001").unwrap();
    assert!(config().jwt_secret().is_err());
    for secret in ["", "short", "                                "] {
        assert!(config().with_jwt_secret(secret.into()).is_err());
        assert!(AuthService::new(secret).is_err());
    }
    assert!(config().with_jwt_secret(SECRET.into()).is_ok());
    let mut headers = HeaderMap::new();
    assert!(auth::bearer_token(&headers).unwrap().is_none());
    for header in ["Bearer", "Basic user:pass", "Bearer a b", ""] {
        headers.insert(AUTHORIZATION, header.parse().unwrap());
        assert!(auth::bearer_token(&headers).is_err());
    }
    headers.insert(AUTHORIZATION, "bearer token".parse().unwrap());
    assert_eq!(auth::bearer_token(&headers).unwrap(), Some("token"));
    headers.append(AUTHORIZATION, "Bearer second".parse().unwrap());
    assert!(auth::bearer_token(&headers).is_err());
}

#[test]
fn application_loads_private_env_and_rejects_bad_secret_without_disclosing_it() {
    let executable = env!("CARGO_BIN_EXE_crud-rust-smoke");
    let valid = std::process::Command::new(executable).arg("invalid-command")
        .env_remove("JWT_TOKEN_SECRET").env("DATABASE_URL", "mongodb://127.0.0.1:1/test")
        .output().unwrap();
    let error = String::from_utf8_lossy(&valid.stderr);
    assert!(error.contains("Usage:"), "{error}");
    let invalid = std::process::Command::new(executable).env("JWT_TOKEN_SECRET", "secret-must-not-appear")
        .env("DATABASE_URL", "mongodb://127.0.0.1:1/test").output().unwrap();
    let error = String::from_utf8_lossy(&invalid.stderr);
    assert!(error.contains("JWT_TOKEN_SECRET"));
    assert!(!error.contains("secret-must-not-appear"));
}

#[tokio::test]
async fn bad_tokens_are_rejected_before_database_access_and_anonymous_me_is_null() {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/test?serverSelectionTimeoutMS=50").await.unwrap();
    let app = server::router_with_auth(client.default_database().unwrap(), false, AuthService::new(SECRET).unwrap());
    let (status, value) = request(&app, "{ health me { id email roles } }", json!({}), None).await;
    assert_eq!(status, 200);
    assert_eq!(value["data"]["health"], true);
    assert!(value["data"]["me"].is_null());
    let id = ObjectId::new().to_hex();
    let original = claims(&id);
    let mut bad = vec!["invalid.jwt.token".to_owned(), "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.e30.".to_owned(), sign(&original, &"x".repeat(64), Algorithm::HS256), sign(&original, SECRET, Algorithm::HS512)];
    for (key, value) in [("exp", json!(1)), ("aud",json!("other-api")), ("iss",json!("other-issuer")), ("tokenType",json!("refresh")), ("sub",json!("invalid-id")), ("iat",json!(chrono::Utc::now().timestamp()+600)), ("nbf",json!(chrono::Utc::now().timestamp()+600))] {
        let mut changed = original.clone(); changed[key] = value;
        bad.push(sign(&changed, SECRET, Algorithm::HS256));
    }
    for missing in ["exp", "sub", "iss", "aud", "iat", "nbf", "tokenType", "ver"] {
        let mut changed = original.clone(); changed.as_object_mut().unwrap().remove(missing);
        bad.push(sign(&changed, SECRET, Algorithm::HS256));
    }
    for token in bad {
        let (status, error) = request(&app, "{ health }", json!({}), Some(&token)).await;
        assert_eq!(status, 401, "{error}");
        assert_eq!(error, json!({"error":"Unauthorized"}));
    }
}

#[tokio::test]
#[ignore = "requires GMB_MONGODB_URL; creates and drops an isolated authentication test database"]
async fn login_bcrypt_and_current_user_use_database_identity() {
    let client = Client::with_uri_str(std::env::var("GMB_MONGODB_URL").unwrap()).await.unwrap();
    let db = client.database(&format!("gmb_rust_auth_test_{}", ObjectId::new().to_hex()));
    let user = auth::create_user(&db, " User@Example.Test ", "correct-password-123".into()).await.unwrap();
    assert_eq!(user.email, "user@example.test");
    assert!(auth::create_user(&db, "USER@example.test", "different-password-123".into()).await.is_err());
    let users = db.collection::<Document>(auth::USERS_COLLECTION);
    let stored = users.find_one(doc! {"_id":user.id.as_str()}).await.unwrap().unwrap();
    let hash = stored.get_str("passwordHash").unwrap();
    assert!(hash.starts_with("$2b$12$"));
    assert_ne!(hash, "correct-password-123");
    let app = server::router_with_auth(db.clone(), true, AuthService::new(SECRET).unwrap());
    let operation = "mutation($email:String!, $password:String!) { login(email:$email,password:$password) { token expiresIn user { id email roles } } }";
    let (status, value) = request(&app, operation, json!({"email":" USER@EXAMPLE.TEST ","password":"correct-password-123"}), None).await;
    assert_eq!(status, 200);
    assert!(value.get("errors").is_none(), "{value}");
    assert_eq!(value["data"]["login"]["expiresIn"], 900);
    assert!(!value.to_string().contains("passwordHash"));
    assert!(!value.to_string().contains("correct-password-123"));
    let token = value["data"]["login"]["token"].as_str().unwrap();
    let (_, me) = request(&app, "{ me { id email roles } }", json!({}), Some(token)).await;
    assert_eq!(me["data"]["me"]["id"], user.id.as_str());
    for (email,password) in [("user@example.test","wrong-password"),("absent@example.test","correct-password-123")] {
        let (_, error) = request(&app, operation, json!({"email":email,"password":password}), None).await;
        assert_eq!(error["errors"][0]["message"], "Email or password is incorrect");
    }
    // Roles are reloaded from the database, never trusted from token claims.
    users.update_one(doc! {"_id":user.id.as_str()}, doc! {"$set":{"roles":["reader"]}}).await.unwrap();
    let mut forged_roles = claims(user.id.as_str()); forged_roles["roles"] = json!(["admin"]);
    let (_, me) = request(&app, "{ me { roles } }", json!({}), Some(&sign(&forged_roles,SECRET,Algorithm::HS256))).await;
    assert_eq!(me["data"]["me"]["roles"], json!(["reader"]));
    let (_, denied) = request(&app, "{ filteredTodoAll { id } }", json!({}), Some(token)).await;
    assert!(denied["errors"][0]["message"].as_str().unwrap().starts_with("Forbidden"));
    users.update_one(doc! {"_id":user.id.as_str()}, doc! {"$set":{"disabled":true}}).await.unwrap();
    assert_eq!(request(&app,"{ health }",json!({}),Some(token)).await.0,401);
    let (_, error) = request(&app,operation,json!({"email":user.email,"password":"correct-password-123"}),None).await;
    assert_eq!(error["errors"][0]["message"], "Email or password is incorrect");
    users.update_one(doc! {"_id":user.id.as_str()}, doc! {"$set":{"disabled":false,"tokenVersion":1}}).await.unwrap();
    assert_eq!(request(&app,"{ health }",json!({}),Some(token)).await.0,401);
    // Existing bcrypt hashes from the TypeScript runtime verify unchanged.
    users.update_one(doc! {"_id":user.id.as_str()}, doc! {"$set":{"passwordHash":"$2b$04$5FicjiuYszDbF8N6.gxUYuM5v/P/mQcGJIk1XeOmehsC8CwjQNfcO"}}).await.unwrap();
    let (_, legacy) = request(&app,operation,json!({"email":user.email,"password":"legacy-test-password"}),None).await;
    assert!(legacy.get("errors").is_none(), "{legacy}");
    let legacy_token = legacy["data"]["login"]["token"].as_str().unwrap();
    users.delete_one(doc! {"_id":user.id.as_str()}).await.unwrap();
    assert_eq!(request(&app,"{ health }",json!({}),Some(legacy_token)).await.0,401);
    db.drop().await.unwrap();
}
