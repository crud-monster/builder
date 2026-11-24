use std::{collections::HashMap, env, net::{IpAddr, SocketAddr}};

// Deliberately no Debug: the database URL can contain credentials.
pub struct Config {
    pub address: SocketAddr,
    pub graphiql_enabled: bool,
    database_url: String,
    jwt_secret: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, &'static str> {
        // Parse the file without modifying the process environment in Tokio worker threads.
        let file: HashMap<String, String> = match dotenvy::from_path_iter(".env") {
            Ok(entries) => entries.collect::<Result<_, _>>().map_err(|_| "Cannot load .env configuration")?,
            Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(_) => return Err("Cannot load .env configuration"),
        };
        let value = |name: &str| -> Result<Option<String>, &'static str> {
            match env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(env::VarError::NotPresent) => Ok(file.get(name).cloned()),
                Err(_) => Err("Invalid environment configuration"),
            }
        };
        Self::parse(
            &value("DATABASE_URL")?.ok_or("DATABASE_URL is required")?,
            &value("HOST")?.unwrap_or_else(|| "127.0.0.1".into()),
            &value("PORT")?.unwrap_or_else(|| "3001".into()),
        )?
            .with_graphiql(&value("GRAPHIQL_ENABLED")?.unwrap_or_else(|| "false".into()))?
            .with_jwt_secret(value("JWT_TOKEN_SECRET")?.ok_or("JWT_TOKEN_SECRET is required")?)
    }

    pub fn parse(database_url: &str, host: &str, port: &str) -> Result<Self, &'static str> {
        if !database_url.starts_with("mongodb://") && !database_url.starts_with("mongodb+srv://") {
            return Err("DATABASE_URL must use mongodb:// or mongodb+srv://");
        }
        // The MongoDB driver validates hosts, credentials, options and database name.
        let host: IpAddr = host.parse().map_err(|_| "HOST must be an IP address")?;
        let port: u16 = port.parse().map_err(|_| "PORT must be between 0 and 65535")?;
        Ok(Self { address: SocketAddr::new(host, port), database_url: database_url.into(), graphiql_enabled: false, jwt_secret: None })
    }

    pub fn with_graphiql(mut self, enabled: &str) -> Result<Self, &'static str> {
        self.graphiql_enabled = match enabled {
            "true" => true,
            "false" => false,
            _ => return Err("GRAPHIQL_ENABLED must be true or false"),
        };
        Ok(self)
    }

    pub fn with_jwt_secret(mut self, secret: String) -> Result<Self, &'static str> {
        crate::auth::validate_secret(&secret)?;
        self.jwt_secret = Some(secret);
        Ok(self)
    }

    pub fn jwt_secret(&self) -> Result<&str, &'static str> {
        self.jwt_secret.as_deref().ok_or("JWT_TOKEN_SECRET is required")
    }

    pub fn database_url(&self) -> &str { &self.database_url }
}
