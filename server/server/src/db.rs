//! SQLite storage (sqlx). One file on disk in production, in-memory in tests.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::str::FromStr;

use crate::rating::Rating;

pub const SEASON: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL UNIQUE,
  callsign TEXT UNIQUE,
  cosmetic TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  season INTEGER NOT NULL,
  rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
  matches INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, headshots INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, season)
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  room INTEGER NOT NULL,
  season INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  results_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  settled_tx TEXT
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id),
  slot INTEGER NOT NULL,
  account_id INTEGER,
  wallet TEXT,
  name TEXT NOT NULL,
  is_bot INTEGER NOT NULL,
  kills INTEGER NOT NULL, deaths INTEGER NOT NULL, headshots INTEGER NOT NULL, best_streak INTEGER NOT NULL,
  placing INTEGER NOT NULL,
  rating_before REAL, rating_after REAL,
  PRIMARY KEY (match_id, slot)
);
CREATE TABLE IF NOT EXISTS achievements (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  code TEXT NOT NULL,
  match_id TEXT,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, code)
);
CREATE TABLE IF NOT EXISTS cosmetic_claims (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  item TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, item)
);
CREATE INDEX IF NOT EXISTS idx_ratings_board ON ratings (season, rating DESC);
CREATE INDEX IF NOT EXISTS idx_mp_account ON match_players (account_id);
"#;

pub async fn connect(url: &str) -> sqlx::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(url)?.create_if_missing(true).foreign_keys(true);
    // An in-memory database exists per connection, so tests use a single one.
    let max = if url.contains(":memory:") { 1 } else { 5 };
    let pool = SqlitePoolOptions::new().max_connections(max).connect_with(opts).await?;
    sqlx::raw_sql(SCHEMA).execute(&pool).await?;
    Ok(pool)
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Account {
    pub id: i64,
    pub wallet: String,
    pub callsign: Option<String>,
    pub cosmetic: Option<String>,
    pub banned: bool,
}

fn account_from(r: &sqlx::sqlite::SqliteRow) -> Account {
    Account {
        id: r.get("id"),
        wallet: r.get("wallet"),
        callsign: r.get("callsign"),
        cosmetic: r.get("cosmetic"),
        banned: r.get::<i64, _>("banned") != 0,
    }
}

pub async fn upsert_account(db: &SqlitePool, wallet: &str) -> sqlx::Result<Account> {
    sqlx::query("INSERT INTO accounts (wallet, created_at) VALUES (?, ?) ON CONFLICT(wallet) DO NOTHING")
        .bind(wallet)
        .bind(now())
        .execute(db)
        .await?;
    let r = sqlx::query("SELECT * FROM accounts WHERE wallet = ?").bind(wallet).fetch_one(db).await?;
    Ok(account_from(&r))
}

pub async fn account(db: &SqlitePool, id: i64) -> sqlx::Result<Option<Account>> {
    Ok(sqlx::query("SELECT * FROM accounts WHERE id = ?").bind(id).fetch_optional(db).await?.map(|r| account_from(&r)))
}

pub async fn account_by_token(db: &SqlitePool, token: &str) -> sqlx::Result<Option<Account>> {
    Ok(sqlx::query("SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ? AND s.expires_at > ?")
        .bind(token)
        .bind(now())
        .fetch_optional(db)
        .await?
        .map(|r| account_from(&r)))
}

pub async fn rating(db: &SqlitePool, account_id: i64) -> sqlx::Result<Rating> {
    Ok(sqlx::query("SELECT rating, rd, vol FROM ratings WHERE account_id = ? AND season = ?")
        .bind(account_id)
        .bind(SEASON)
        .fetch_optional(db)
        .await?
        .map(|r| Rating { rating: r.get("rating"), rd: r.get("rd"), vol: r.get("vol") })
        .unwrap_or_default())
}

pub async fn set_callsign(db: &SqlitePool, account_id: i64, callsign: &str) -> Result<(), String> {
    match sqlx::query("UPDATE accounts SET callsign = ? WHERE id = ?").bind(callsign).bind(account_id).execute(db).await {
        Ok(_) => Ok(()),
        Err(e) if e.to_string().contains("UNIQUE") => Err("That callsign is taken".into()),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn stat_line(db: &SqlitePool, account_id: i64) -> sqlx::Result<serde_json::Value> {
    let r = sqlx::query("SELECT * FROM ratings WHERE account_id = ? AND season = ?").bind(account_id).bind(SEASON).fetch_optional(db).await?;
    Ok(match r {
        Some(r) => serde_json::json!({
            "rating": r.get::<f64,_>("rating").round(), "rd": r.get::<f64,_>("rd").round(),
            "matches": r.get::<i64,_>("matches"), "wins": r.get::<i64,_>("wins"),
            "kills": r.get::<i64,_>("kills"), "deaths": r.get::<i64,_>("deaths"), "headshots": r.get::<i64,_>("headshots"),
        }),
        None => serde_json::json!({ "rating": 1500, "rd": 350, "matches": 0, "wins": 0, "kills": 0, "deaths": 0, "headshots": 0 }),
    })
}
