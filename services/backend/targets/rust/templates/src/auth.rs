use std::{collections::HashMap, future::{Future, IntoFuture}, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use async_graphql::{Context, Error, SimpleObject, ID};
use axum::http::{header::AUTHORIZATION, HeaderMap};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use mongodb::{bson::{self, doc, oid::ObjectId, Document}, options::IndexOptions, Database, IndexModel};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

pub const USERS_COLLECTION: &str = "gmb_rust_User";
pub const ACCESS_TOKEN_SECONDS: u64 = 900;
const ISSUER: &str = "crud-monster-rust";
const AUDIENCE: &str = "crud-monster-api";
// A cost-12 dummy hash also performs bcrypt work for missing accounts.
const DUMMY_HASH: &str = "$2b$12$svoTdbFoH1muic5sTn70LeI7sDob/Jy46yfvu61qYmC2ErK3LTTCa";

#[derive(Debug, Clone, Copy)]
pub enum AuthError { Unauthorized, InvalidCredentials, RateLimited, Unavailable, InvalidAccount, AccountCreationFailed }
impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unauthorized => "Unauthorized",
            Self::InvalidCredentials => "Email or password is incorrect",
            Self::RateLimited => "Too many authentication attempts; try again later",
            Self::Unavailable => "Authentication service unavailable",
            Self::InvalidAccount => "Use a valid email and a password of 12–72 bytes without NUL characters",
            Self::AccountCreationFailed => "Cannot create account; the email may already exist",
        })
    }
}
impl std::error::Error for AuthError {}
type AuthResult<T> = std::result::Result<T, AuthError>;

#[derive(Clone, SimpleObject)]
#[graphql(name = "AuthUser")]
pub struct CurrentUser { pub id: ID, pub email: String, pub roles: Vec<String> }
#[derive(Clone, Default)]
pub struct RequestUser(pub Option<CurrentUser>);
#[derive(SimpleObject)]
pub struct LoginPayload { pub token: String, pub expires_in: i32, pub user: CurrentUser }

#[derive(Deserialize)]
struct StoredUser {
    #[serde(rename = "_id")] id: String,
    email: String,
    #[serde(default)] roles: Vec<String>,
    #[serde(default)] disabled: bool,
    #[serde(default, rename = "tokenVersion")] token_version: u32,
}
impl StoredUser {
    fn current(&self) -> CurrentUser {
        CurrentUser { id: ID(self.id.clone()), email: self.email.clone(), roles: self.roles.clone() }
    }
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String, iat: u64, nbf: u64, exp: u64, iss: String, aud: String,
    #[serde(rename = "tokenType")] token_type: String,
    ver: u32,
}

#[derive(Clone)]
pub struct AuthService {
    encoding: Arc<EncodingKey>,
    decoding: Arc<DecodingKey>,
    attempts: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
    workers: Arc<Semaphore>,
}

pub fn validate_secret(secret: &str) -> Result<(), &'static str> {
    if secret.len() < 32 || secret.trim().is_empty() {
        return Err("JWT_TOKEN_SECRET must contain at least 32 bytes; generate a random secret");
    }
    Ok(())
}

fn now() -> AuthResult<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| AuthError::Unavailable)?.as_secs())
}
fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_ascii_lowercase();
    let (local, domain) = email.split_once('@')?;
    if email.len() > 254 || !email.is_ascii() || email.bytes().any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
        || local.is_empty() || local.len() > 64 || domain.is_empty() || domain.contains('@') { return None; }
    Some(email)
}
fn valid_password(password: &str, minimum: usize) -> bool {
    (minimum..=72).contains(&password.len()) && !password.contains('\0')
}
fn valid_hash(hash: &str) -> bool {
    let parts: Vec<_> = hash.split('$').collect();
    hash.len() == 60 && parts.len() == 4 && matches!(parts[1], "2a" | "2b" | "2y")
        && parts[2].parse::<u32>().is_ok_and(|cost| (4..=16).contains(&cost))
}
async fn db_call<T>(operation: impl Future<Output = mongodb::error::Result<T>>) -> AuthResult<T> {
    tokio::time::timeout(Duration::from_secs(5), operation).await
        .map_err(|_| AuthError::Unavailable)?.map_err(|_| AuthError::Unavailable)
}
fn stored(doc: &Document) -> Option<StoredUser> {
    let user: StoredUser = bson::from_document(doc.clone()).ok()?;
    ObjectId::parse_str(&user.id).ok()?;
    Some(user)
}

impl AuthService {
    pub fn new(secret: &str) -> Result<Self, &'static str> {
        validate_secret(secret)?;
        Ok(Self {
            encoding: Arc::new(EncodingKey::from_secret(secret.as_bytes()).map_err(|_| "Invalid JWT key")?),
            decoding: Arc::new(DecodingKey::from_secret(secret.as_bytes()).map_err(|_| "Invalid JWT key")?),
            attempts: Arc::new(Mutex::new(HashMap::new())),
            workers: Arc::new(Semaphore::new(4)),
        })
    }

    fn check_attempt(&self, email: &str) -> AuthResult<()> {
        let mut attempts = self.attempts.lock().map_err(|_| AuthError::Unavailable)?;
        attempts.retain(|_, (start, _)| start.elapsed() < Duration::from_secs(60));
        if !attempts.contains_key(email) && attempts.len() >= 1024 { return Err(AuthError::RateLimited); }
        let (_, count) = attempts.entry(email.into()).or_insert((Instant::now(), 0));
        if *count >= 10 { return Err(AuthError::RateLimited); }
        *count += 1;
        Ok(())
    }

    fn issue(&self, user: &StoredUser) -> AuthResult<String> {
        let iat = now()?;
        encode(&Header::new(Algorithm::HS256), &Claims {
            sub: user.id.clone(), iat, nbf: iat, exp: iat + ACCESS_TOKEN_SECONDS,
            iss: ISSUER.into(), aud: AUDIENCE.into(), token_type: "access".into(), ver: user.token_version,
        }, &self.encoding).map_err(|_| AuthError::Unavailable)
    }

    fn verify(&self, token: &str) -> AuthResult<Claims> {
        if token.len() > 4096 { return Err(AuthError::Unauthorized); }
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_required_spec_claims(&["sub", "exp", "nbf", "iss", "aud"]);
        validation.set_issuer(&[ISSUER]);
        validation.set_audience(&[AUDIENCE]);
        validation.validate_nbf = true;
        validation.leeway = 0;
        let claims = decode::<Claims>(token, &self.decoding, &validation).map_err(|_| AuthError::Unauthorized)?.claims;
        let current = now()?;
        if claims.token_type != "access" || claims.iat > current || claims.nbf != claims.iat
            || claims.exp <= current || claims.exp <= claims.iat || claims.exp - claims.iat > ACCESS_TOKEN_SECONDS
            || ObjectId::parse_str(&claims.sub).is_err() { return Err(AuthError::Unauthorized); }
        Ok(claims)
    }

    pub async fn login(&self, db: &Database, email: &str, password: String) -> AuthResult<LoginPayload> {
        let email = normalize_email(email).ok_or(AuthError::InvalidCredentials)?;
        if !valid_password(&password, 1) { return Err(AuthError::InvalidCredentials); }
        self.check_attempt(&email)?;
        let permit = self.workers.clone().try_acquire_owned().map_err(|_| AuthError::RateLimited)?;
        let doc = db_call(db.collection::<Document>(USERS_COLLECTION).find_one(doc! { "email": email }).into_future()).await?;
        let user = doc.as_ref().and_then(stored);
        let real_hash = doc.as_ref().and_then(|doc| doc.get_str("passwordHash").ok()).filter(|hash| valid_hash(hash));
        let hash = real_hash.unwrap_or(DUMMY_HASH).to_owned();
        let has_hash = real_hash.is_some();
        let verified = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            bcrypt::verify(password, &hash).unwrap_or(false)
        }).await.map_err(|_| AuthError::Unavailable)?;
        let user = user.filter(|user| !user.disabled && has_hash && verified).ok_or(AuthError::InvalidCredentials)?;
        Ok(LoginPayload { token: self.issue(&user)?, expires_in: ACCESS_TOKEN_SECONDS as i32, user: user.current() })
    }

    pub async fn authenticate(&self, db: &Database, token: &str) -> AuthResult<CurrentUser> {
        let claims = self.verify(token)?;
        let doc = db_call(db.collection::<Document>(USERS_COLLECTION).find_one(doc! { "_id": &claims.sub })
            .projection(doc! { "passwordHash": 0 }).into_future()).await?;
        let user = doc.as_ref().and_then(stored).filter(|user| !user.disabled && user.token_version == claims.ver)
            .ok_or(AuthError::Unauthorized)?;
        Ok(user.current())
    }
}

pub fn bearer_token(headers: &HeaderMap) -> AuthResult<Option<&str>> {
    let mut values = headers.get_all(AUTHORIZATION).iter();
    let Some(value) = values.next() else { return Ok(None) };
    if values.next().is_some() { return Err(AuthError::Unauthorized); }
    let header = value.to_str().map_err(|_| AuthError::Unauthorized)?;
    let mut parts = header.split_ascii_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(scheme), Some(token), None) if scheme.eq_ignore_ascii_case("bearer") && token.len() <= 4096 => Ok(Some(token)),
        _ => Err(AuthError::Unauthorized),
    }
}

pub fn me(ctx: &Context<'_>) -> Option<CurrentUser> {
    ctx.data_opt::<RequestUser>().and_then(|user| user.0.clone())
}
pub async fn login(ctx: &Context<'_>, email: String, password: String) -> async_graphql::Result<LoginPayload> {
    let auth = ctx.data_opt::<Option<AuthService>>().and_then(Option::as_ref)
        .ok_or_else(|| Error::new("Authentication is not configured"))?;
    auth.login(ctx.data::<Database>()?, &email, password).await.map_err(|error| Error::new(error.to_string()))
}

pub async fn ensure_indexes(db: &Database) -> AuthResult<()> {
    let index = IndexModel::builder().keys(doc! { "email": 1 }).options(IndexOptions::builder()
        .name("auth_email_unique".to_owned()).unique(true).build()).build();
    db_call(db.collection::<Document>(USERS_COLLECTION).create_index(index).into_future()).await?;
    Ok(())
}

// Local CLI only; no public registration or role assignment endpoint.
pub async fn create_user(db: &Database, email: &str, password: String) -> AuthResult<CurrentUser> {
    let email = normalize_email(email).ok_or(AuthError::InvalidAccount)?;
    if !valid_password(&password, 12) { return Err(AuthError::InvalidAccount); }
    ensure_indexes(db).await?;
    let hash = tokio::task::spawn_blocking(move || bcrypt::hash(password, 12))
        .await.map_err(|_| AuthError::Unavailable)?.map_err(|_| AuthError::Unavailable)?;
    let id = ObjectId::new().to_hex();
    let now = chrono::Utc::now().to_rfc3339();
    let doc = doc! { "_id": &id, "email": &email, "passwordHash": hash, "roles": [], "disabled": false,
        "tokenVersion": 0, "createdAt": &now, "updatedAt": &now };
    db_call(db.collection::<Document>(USERS_COLLECTION).insert_one(doc).into_future()).await
        .map_err(|_| AuthError::AccountCreationFailed)?;
    Ok(CurrentUser { id: ID(id), email, roles: vec![] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_budget_is_bounded_and_expires() {
        let auth = AuthService::new(&"s".repeat(64)).unwrap();
        for _ in 0..10 { assert!(auth.check_attempt("user@example.test").is_ok()); }
        assert!(matches!(auth.check_attempt("user@example.test"), Err(AuthError::RateLimited)));
        auth.attempts.lock().unwrap().insert("user@example.test".into(), (Instant::now() - Duration::from_secs(61), 10));
        assert!(auth.check_attempt("user@example.test").is_ok());
        for index in 1..1024 { auth.check_attempt(&format!("{index}@example.test")).unwrap(); }
        assert!(matches!(auth.check_attempt("overflow@example.test"), Err(AuthError::RateLimited)));
    }

    #[test]
    fn password_boundaries_and_bcrypt_compatibility() {
        assert!(valid_password(&"a".repeat(72), 12));
        assert!(!valid_password(&"a".repeat(73), 12));
        assert!(!valid_password("short", 12));
        assert!(!valid_password("contains\0nul", 1));
        assert!(valid_hash(DUMMY_HASH));
        assert!(!valid_hash("plaintext"));
        assert!(!valid_hash(&DUMMY_HASH.replace("$12$", "$31$")));
        let legacy = "$2b$04$5FicjiuYszDbF8N6.gxUYuM5v/P/mQcGJIk1XeOmehsC8CwjQNfcO";
        assert!(bcrypt::verify("legacy-test-password", legacy).unwrap());
        assert!(!bcrypt::verify("wrong-password", legacy).unwrap());
    }
}
