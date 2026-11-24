use std::{future::Future, time::Duration};
use async_graphql::{Error, Result};
use mongodb::{bson::{self, doc, oid::ObjectId, Bson, Document}, options::ReturnDocument, Database};
use serde::{de::DeserializeOwned, Serialize};

pub fn authorize(public: bool) -> Result<()> {
    if public { Ok(()) } else { Err(Error::new("Forbidden: this operation requires unsupported authentication or access rules")) }
}

pub fn value<T: Serialize>(value: &T) -> Result<Bson> {
    bson::to_bson(value).map_err(|_| Error::new("Invalid input value"))
}

fn decode<T: DeserializeOwned>(doc: Document) -> Result<T> {
    bson::from_document(doc).map_err(|_| Error::new("Stored record does not match the generated schema"))
}

fn id_filter(id: &str) -> Result<Document> {
    ObjectId::parse_str(id).map_err(|_| Error::new("Invalid record ID"))?;
    Ok(doc! { "_id": id })
}

async fn execute<T>(operation: impl Future<Output = mongodb::error::Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(5), operation).await
        .map_err(|_| Error::new("Database operation timed out"))?
        .map_err(|_| Error::new("Database operation failed"))
}

pub async fn one<T: DeserializeOwned>(db: &Database, name: &str, id: &str) -> Result<Option<T>> {
    execute(db.collection::<Document>(name).find_one(id_filter(id)?).into_future()).await?
        .map(decode).transpose()
}

pub async fn all<T: DeserializeOwned>(db: &Database, name: &str, limit: i32, offset: i32) -> Result<Vec<T>> {
    if !(1..=100).contains(&limit) || !(0..=10_000).contains(&offset) {
        return Err(Error::new("limit must be 1..100 and offset 0..10000"));
    }
    execute(async {
        let mut cursor = db.collection::<Document>(name).find(doc! {})
            .sort(doc! { "_id": 1 }).limit(i64::from(limit)).skip(offset as u64).await?;
        let mut documents = Vec::new();
        while cursor.advance().await? { documents.push(cursor.deserialize_current()?); }
        Ok(documents)
    }).await?.into_iter().map(decode).collect()
}

pub async fn create<T: DeserializeOwned>(db: &Database, name: &str, mut doc: Document) -> Result<T> {
    doc.insert("_id", ObjectId::new().to_hex());
    let now = chrono::Utc::now().to_rfc3339();
    doc.insert("createdAt", now.clone());
    doc.insert("updatedAt", now);
    // Check the response representation before committing a write.
    let result = decode(doc.clone())?;
    execute(db.collection::<Document>(name).insert_one(doc).into_future()).await?;
    Ok(result)
}

pub async fn update<T: DeserializeOwned>(db: &Database, name: &str, id: &str, mut patch: Document) -> Result<Option<T>> {
    let filter = id_filter(id)?;
    if patch.is_empty() { return one(db, name, id).await; }
    patch.insert("updatedAt", chrono::Utc::now().to_rfc3339());
    execute(db.collection::<Document>(name).find_one_and_update(filter, doc! { "$set": patch })
        .return_document(ReturnDocument::After).into_future()).await?.map(decode).transpose()
}

pub async fn remove(db: &Database, name: &str, id: &str) -> Result<bool> {
    Ok(execute(db.collection::<Document>(name).delete_one(id_filter(id)?).into_future()).await?.deleted_count == 1)
}

use std::future::IntoFuture;
