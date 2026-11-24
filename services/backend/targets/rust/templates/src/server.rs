use axum::{extract::{DefaultBodyLimit, State}, routing::{get, post}, Json, Router};
use serde::Serialize;
use axum::response::Html;
use async_graphql::http::GraphiQLSource;
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

async fn graphiql() -> Html<String> {
    Html(GraphiQLSource::build().endpoint("/graphql").title("CRUD Monster GraphiQL").finish())
}

pub fn router(database: Database) -> Router {
    router_with_graphiql(database, false)
}

pub fn router_with_graphiql(database: Database, graphiql_enabled: bool) -> Router {
    let schema = generated_graphql::schema(database.clone());
    let graphql_route = post(graphql);
    let graphql_route = if graphiql_enabled { graphql_route.get(graphiql) } else { graphql_route };
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/graphql", graphql_route)
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(AppState { schema, database })
}
