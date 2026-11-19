use crud_rust_smoke::{config::Config, server};
use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}};
use tower::ServiceExt;

#[test]
fn configuration_validates_without_leaking_secrets() {
    let config = Config::parse("mongodb://user:secret@localhost/todo", "127.0.0.1", "3001").unwrap();
    assert_eq!(config.address.port(), 3001);
    assert!(config.database_url().contains("todo"));
    for url in ["mysql://user:secret@localhost/todo", "postgresql://localhost", "secret"] {
        let error = Config::parse(url, "127.0.0.1", "3001").err().unwrap();
        assert!(!error.contains("secret"));
    }
    assert!(Config::parse("mongodb://localhost/todo", "invalid", "3001").is_err());
    assert!(Config::parse("mongodb://localhost/todo", "127.0.0.1", "65536").is_err());
}

#[tokio::test]
async fn http_health_graphql_and_request_limits() {
    let client = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1/todo?serverSelectionTimeoutMS=50").await.unwrap();
    let app = server::router(client.default_database().unwrap());
    let response = app.clone().oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), r#"{"status":"ok"}"#);
    for (body, status) in [
        (r#"{"query":"{ health }"}"#.to_owned(), StatusCode::OK),
        ("invalid".to_owned(), StatusCode::BAD_REQUEST),
        ("x".repeat(33 * 1024), StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        let response = app.clone().oneshot(Request::post("/graphql").header("content-type", "application/json").body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(), status);
        if status == StatusCode::OK {
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["data"]["health"], true);
        }
    }
    let response = app.oneshot(Request::builder().uri("/graphql").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test]
async fn mongodb_failures_are_redacted_and_readiness_fails() {
    use crud_rust_smoke::database::mongo;
    let invalid = mongo::connect("mongodb://user:secret@/todo").await.err().unwrap();
    assert!(!invalid.contains("secret"));
    assert!(mongo::connect("mongodb://127.0.0.1").await.is_err());
    let uri = "mongodb://user:secret@127.0.0.1:1/todo?serverSelectionTimeoutMS=50";
    let error = mongo::connect(uri).await.err().unwrap();
    assert_eq!(error, "MongoDB is unavailable");
    let client = mongodb::Client::with_uri_str(uri).await.unwrap();
    let response = server::router(client.default_database().unwrap()).oneshot(
        Request::builder().uri("/ready").body(Body::empty()).unwrap()
    ).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), r#"{"status":"unavailable"}"#);
}

#[tokio::test]
#[ignore = "requires GMB_MONGODB_URL pointing to a running MongoDB instance"]
async fn mongodb_connection_and_readiness() {
    let uri = std::env::var("GMB_MONGODB_URL").expect("Set GMB_MONGODB_URL");
    let database = crud_rust_smoke::database::mongo::connect(&uri).await.unwrap();
    let response = server::router(database).oneshot(
        Request::builder().uri("/ready").body(Body::empty()).unwrap()
    ).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[test]
fn graphiql_is_opt_in_and_rejects_invalid_configuration() {
    let config = || Config::parse("mongodb://localhost/todo", "127.0.0.1", "3001").unwrap();
    assert!(!config().graphiql_enabled);
    assert!(config().with_graphiql("true").unwrap().graphiql_enabled);
    assert!(!config().with_graphiql("false").unwrap().graphiql_enabled);
    for value in ["", "TRUE", "1", "yes"] {
        assert!(config().with_graphiql(value).is_err());
    }
}

#[tokio::test]
async fn graphiql_serves_html_and_keeps_post_api_available() {
    let client = mongodb::Client::with_uri_str("mongodb://127.0.0.1:1/todo?serverSelectionTimeoutMS=50").await.unwrap();
    let app = server::router_with_graphiql(client.default_database().unwrap(), true);
    let response = app.clone().oneshot(Request::builder().uri("/graphql").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
    let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    let html = std::str::from_utf8(&body).unwrap();
    assert!(html.contains("CRUD Monster GraphiQL"));
    assert!(html.contains("GraphiQL.createFetcher"));
    assert!(html.contains("/graphql"));
    let response = app.oneshot(Request::post("/graphql").header("content-type", "application/json")
        .body(Body::from(r#"{"query":"{ health }"}"#)).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["data"]["health"], true);
}
