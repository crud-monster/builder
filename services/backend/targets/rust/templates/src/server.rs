use axum::{extract::{DefaultBodyLimit, State}, routing::{get, post}, Json, Router};
use serde::Serialize;
use mongodb::Database;
use axum::http::StatusCode;
use crate::database::mongo;

use crate::generated::graphql::{self as generated_graphql, AppSchema};

#[derive(Serialize)]
struct Health { status: &'static str }

async fn health() -> Json<Health> { Json(Health { status: "ok" }) }

#[derive(Clone)]
struct AppState {
    schema: AppSchema,
    database: Database,
}

async fn ready(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    match mongo::ping(&state.database).await {
        Ok(()) => (StatusCode::OK, Json(Health { status: "ok" })),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(Health { status: "unavailable" })),
    }
}

async fn graphql(
    State(state): State<AppState>,
    Json(request): Json<async_graphql::Request>,
) -> Json<async_graphql::Response> {
    Json(state.schema.execute(request).await)
}

pub fn router(database: Database) -> Router {
    let schema = generated_graphql::schema(database.clone());
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/graphql", post(graphql))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(AppState { schema, database })
}
