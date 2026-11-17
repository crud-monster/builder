#![forbid(unsafe_code)]
pub mod config;
pub mod database;
pub mod server;
pub mod generated;
pub use generated::models::*;
