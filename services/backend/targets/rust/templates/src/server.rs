use axum::{extract::{DefaultBodyLimit, State}, routing::{get, post}, Json, Router};
use serde::Serialize;
use axum::response::Html;
use async_graphql::http::GraphiQLSource;
use mongodb::Database;
use axum::http::{StatusCode, HeaderMap};
use crate::auth::{self, AuthService, RequestUser, AuthError};
use crate::database::mongo;

use crate::generated::graphql::{self as generated_graphql, AppSchema};

#[derive(Serialize)]
struct Health { status: &'static str }

async fn health() -> Json<Health> { Json(Health { status: "ok" }) }

#[derive(Clone)]
struct AppState {
    schema: AppSchema,
    database: Database,
    auth: Option<AuthService>,
}

async fn ready(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    match mongo::ping(&state.database).await {
        Ok(()) => (StatusCode::OK, Json(Health { status: "ok" })),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, Json(Health { status: "unavailable" })),
    }
}

#[derive(Serialize)]
struct AuthFailure { error: String }

async fn graphql(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<async_graphql::Request>,
) -> Result<Json<async_graphql::Response>, (StatusCode, Json<AuthFailure>)> {
    let authenticate = async {
        match auth::bearer_token(&headers)? {
            None => Ok(None),
            Some(token) => {
                let auth = state.auth.as_ref().ok_or(AuthError::Unauthorized)?;
                Ok(Some(auth.authenticate(&state.database, token).await?))
            }
        }
    };
    let user = authenticate.await.map_err(|error| {
        let status = match error { AuthError::Unavailable => StatusCode::SERVICE_UNAVAILABLE, _ => StatusCode::UNAUTHORIZED };
        (status, Json(AuthFailure { error: error.to_string() }))
    })?;
    Ok(Json(state.schema.execute(request.data(RequestUser(user))).await))
}

async fn graphiql() -> Html<String> {
    Html(GraphiQLSource::build().endpoint("/graphql").title("CRUD Monster GraphiQL").finish())
}

pub fn router(database: Database) -> Router {
    router_with_graphiql(database, false)
}

pub fn router_with_graphiql(database: Database, graphiql_enabled: bool) -> Router {
    build_router(database, graphiql_enabled, None)
}

pub fn router_with_auth(database: Database, graphiql_enabled: bool, auth: AuthService) -> Router {
    build_router(database, graphiql_enabled, Some(auth))
}

fn build_router(database: Database, graphiql_enabled: bool, auth: Option<AuthService>) -> Router {
    let schema = generated_graphql::schema_with_auth(database.clone(), auth.clone());
    let graphql_route = post(graphql);
    let graphql_route = if graphiql_enabled { graphql_route.get(graphiql) } else { graphql_route };
    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/graphql", graphql_route)
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(AppState { schema, database, auth })
}
