use axum::{body::{to_bytes, Body}, http::Request, Router};
use mongodb::{bson::{doc, oid::ObjectId, Document}, Client};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn query(app: &Router, query: &str, variables: Value) -> Value {
    let response = app.clone().oneshot(Request::post("/graphql")
        .header("content-type", "application/json")
        .body(Body::from(json!({"query": query, "variables": variables}).to_string())).unwrap())
        .await.unwrap();
    assert_eq!(response.status(), 200);
    serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
}

async fn success(app: &Router, operation: &str, variables: Value) -> Value {
    let value = query(app, operation, variables).await;
    assert!(value.get("errors").is_none(), "{value}");
    value["data"].clone()
}

#[tokio::test]
async fn permissions_and_validation_fail_before_database_access() {
    let client = Client::with_uri_str("mongodb://127.0.0.1:1/test?serverSelectionTimeoutMS=50").await.unwrap();
    let app = crud_rust_smoke::server::router(client.default_database().unwrap());
    for operation in [
        "{ filteredTodoAll { id } }",
        "{ privateReadAll { id } }",
        "mutation { privateReadCreate(input: { message: \"secret\" }) { id } }",
        "mutation { keywordsCreate(input: { type: \"secret\" }) { id } }",
    ] {
        let result = query(&app, operation, json!({})).await;
        assert!(result["errors"][0]["message"].as_str().unwrap().starts_with("Forbidden"), "{result}");
    }
    for operation in [
        "{ todoAll(limit: 0) { id } }",
        "{ todoAll(limit: 101) { id } }",
        "{ todoAll(offset: -1) { id } }",
        "{ todoAll(offset: 10001) { id } }",
        "{ todoOne(id: \"invalid\") { id } }",
        "mutation { todoCreate(input: {}) { id } }",
        "mutation { todoCreate(input: {message: \"test\", id: \"override\"}) { id } }",
        "mutation { todoCreate(input: {message: \"test\", secret: \"hidden\"}) { id } }",
        "mutation { todoUpdate(id: \"000000000000000000000000\", input: {marker: \"override\"}) { id } }",
        "mutation { todoUpdate(id: \"000000000000000000000000\", input: {message: null}) { id } }",
        "mutation { todoUpdate(id: \"000000000000000000000000\", input: {count: 2147483648}) { id } }",
        "{ userOne(id: \"000000000000000000000000\") { password } }",
        "{ todoOne(id: \"000000000000000000000000\") { secret } }",
    ] {
        let result = query(&app, operation, json!({})).await;
        let error = result["errors"][0]["message"].as_str().unwrap();
        assert!(!error.starts_with("Database"), "Validation reached database: {result}");
    }
    let result = query(&app, "mutation($input: CrudTodoRecordUpdate!) { todoUpdate(id: \"000000000000000000000000\", input: $input) { id } }", json!({"input":{"$set":{"message":"attack"}}})).await;
    assert!(result.get("errors").is_some(), "{result}");
}

#[tokio::test]
#[ignore = "requires GMB_MONGODB_URL; creates and drops a uniquely named test database"]
async fn live_mongodb_crud() {
    let client = Client::with_uri_str(std::env::var("GMB_MONGODB_URL").unwrap()).await.unwrap();
    let db = client.database(&format!("gmb_rust_crud_test_{}", ObjectId::new().to_hex()));
    let app = crud_rust_smoke::server::router(db.clone());
    let created = success(&app, r#"mutation {
        todoCreate(input: { message: "first", note: "clear me", tags: ["a"], amount: 1.5, dueAt: "2026-11-17T12:00:00Z" }) {
            id message title done count tags amount dueAt createdAt updatedAt marker
        }
    }"#, json!({})).await["todoCreate"].clone();
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["message"], "first");
    assert_eq!(created["title"], "untitled");
    assert_eq!(created["done"], false);
    assert_eq!(created["count"], 0);
    assert_eq!(created["amount"], 1.5);
    assert_eq!(created["tags"], json!(["a"]));
    assert!(created["createdAt"].is_string());
    assert!(created["marker"].is_null());
    let stored = db.collection::<Document>("gmb_rust_Todo").find_one(doc! {"_id": id}).await.unwrap().unwrap();
    assert!(!stored.contains_key("secret"));
    assert!(!stored.contains_key("user"));
    let second = success(&app, "mutation { todoCreate(input: {message: \"second\", done: null}) { id done } }", json!({})).await;
    assert!(second["todoCreate"]["done"].is_null());
    let second_id = second["todoCreate"]["id"].as_str().unwrap();
    let read = success(&app, "query($id: ID!) { todoOne(id: $id) { id message } }", json!({"id":id})).await;
    assert_eq!(read["todoOne"]["message"], "first");
    let list = success(&app, "{ todoAll(limit: 1, offset: 1) { id } }", json!({})).await;
    assert_eq!(list["todoAll"], json!([{"id":second_id}]));
    let updated = success(&app, "mutation($id: ID!) { todoUpdate(id: $id, input: {done: true, note: null}) { id message done note updatedAt } }", json!({"id":id})).await;
    assert_eq!(updated["todoUpdate"]["message"], "first");
    assert_eq!(updated["todoUpdate"]["done"], true);
    assert!(updated["todoUpdate"]["note"].is_null());
    let unchanged = success(&app, "mutation($id: ID!) { todoUpdate(id: $id, input: {}) { updatedAt } }", json!({"id":id})).await;
    assert_eq!(unchanged["todoUpdate"]["updatedAt"], updated["todoUpdate"]["updatedAt"]);
    let invalid = query(&app, "mutation($id: ID!) { todoUpdate(id: $id, input: {message: null}) { id } }", json!({"id":id})).await;
    assert!(invalid.get("errors").is_some());
    let preserved = success(&app, "query($id: ID!) { todoOne(id: $id) { message } }", json!({"id":id})).await;
    assert_eq!(preserved["todoOne"]["message"], "first");
    let missing = ObjectId::new().to_hex();
    let result = success(&app, "query($id: ID!) { todoOne(id: $id) { id } }", json!({"id":missing})).await;
    assert!(result["todoOne"].is_null());
    let result = success(&app, "mutation($id: ID!) { todoUpdate(id: $id, input: {done: true}) { id } }", json!({"id":missing})).await;
    assert!(result["todoUpdate"].is_null());
    let removed = success(&app, "mutation($id: ID!) { todoRemove(id: $id) }", json!({"id":id})).await;
    assert_eq!(removed["todoRemove"], true);
    let removed = success(&app, "mutation($id: ID!) { todoRemove(id: $id) }", json!({"id":id})).await;
    assert_eq!(removed["todoRemove"], false);
    let list = success(&app, "{ todoAll { id } }", json!({})).await;
    assert_eq!(list["todoAll"], json!([{"id":second_id}]));
    db.drop().await.unwrap();
}
