use std::{future::IntoFuture, time::Duration};
use mongodb::{bson::doc, Client, Database};
use tokio::time::timeout;

// A cloned Database shares the driver's connection pool; never create a client per request.
pub async fn connect(uri: &str) -> Result<Database, &'static str> {
    timeout(Duration::from_secs(10), async {
        let client = Client::with_uri_str(uri).await.map_err(|_| "Invalid MongoDB configuration")?;
        let database = client.default_database().ok_or("DATABASE_URL must specify a database name")?;
        ping(&database).await?;
        Ok(database)
    }).await.map_err(|_| "MongoDB connection timed out")?
}

pub async fn ping(database: &Database) -> Result<(), &'static str> {
    timeout(Duration::from_secs(2), database.run_command(doc! { "ping": 1 }).into_future())
        .await.map_err(|_| "MongoDB is unavailable")?
        .map_err(|_| "MongoDB is unavailable")?;
    Ok(())
}
