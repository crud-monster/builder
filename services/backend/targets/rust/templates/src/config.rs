use std::{env, net::{IpAddr, SocketAddr}};

// Deliberately no Debug: the database URL can contain credentials.
pub struct Config {
    pub address: SocketAddr,
    pub graphiql_enabled: bool,
    database_url: String,
}

impl Config {
    pub fn from_env() -> Result<Self, &'static str> {
        Self::parse(
            &env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?,
            &env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            &env::var("PORT").unwrap_or_else(|_| "3001".into()),
        )?.with_graphiql(&env::var("GRAPHIQL_ENABLED").unwrap_or_else(|_| "false".into()))
    }

    pub fn parse(database_url: &str, host: &str, port: &str) -> Result<Self, &'static str> {
        if !database_url.starts_with("mongodb://") && !database_url.starts_with("mongodb+srv://") {
            return Err("DATABASE_URL must use mongodb:// or mongodb+srv://");
        }
        // The MongoDB driver validates hosts, credentials, options and database name.
        let host: IpAddr = host.parse().map_err(|_| "HOST must be an IP address")?;
        let port: u16 = port.parse().map_err(|_| "PORT must be between 0 and 65535")?;
        Ok(Self { address: SocketAddr::new(host, port), database_url: database_url.into(), graphiql_enabled: false })
    }

    pub fn with_graphiql(mut self, enabled: &str) -> Result<Self, &'static str> {
        self.graphiql_enabled = match enabled {
            "true" => true,
            "false" => false,
            _ => return Err("GRAPHIQL_ENABLED must be true or false"),
        };
        Ok(self)
    }

    pub fn database_url(&self) -> &str { &self.database_url }
}
