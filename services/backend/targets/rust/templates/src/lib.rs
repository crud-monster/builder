#![forbid(unsafe_code)]
pub mod auth;
pub mod config;
pub mod database;
pub mod server;
pub mod generated;
pub use generated::models::*;
