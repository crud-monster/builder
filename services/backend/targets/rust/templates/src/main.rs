use __CRATE_IDENT__::{auth::{self, AuthService}, config::Config, database::mongo, server};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let auth_service = AuthService::new(config.jwt_secret()?)?;
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && (args.len() != 3 || args[1] != "create-user") {
        return Err("Usage: cargo run [-- create-user email]".into());
    }
    let database = mongo::connect(config.database_url()).await?;
    auth::ensure_indexes(&database).await?;
    if args.len() == 3 {
        let password = rpassword::prompt_password("Password (12–72 bytes): ")?;
        let confirmation = rpassword::prompt_password("Confirm password: ")?;
        if password != confirmation { return Err("Passwords do not match".into()); }
        let user = auth::create_user(&database, &args[2], password).await?;
        println!("Created user {} ({})", user.email, user.id.as_str());
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(config.address).await?;
    println!("Listening on http://{}", listener.local_addr()?);
    axum::serve(listener, server::router_with_auth(database, config.graphiql_enabled, auth_service))
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await?;
    Ok(())
}
