use __CRATE_IDENT__::{config::Config, database::mongo, server};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let database = mongo::connect(config.database_url()).await?;
    let listener = tokio::net::TcpListener::bind(config.address).await?;
    println!("Listening on http://{}", listener.local_addr()?);
    axum::serve(listener, server::router_with_graphiql(database, config.graphiql_enabled))
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await?;
    Ok(())
}
