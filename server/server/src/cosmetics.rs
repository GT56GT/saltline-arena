//! Cosmetic catalogue. Purely visual: no item changes speed, damage, armour or visibility
//! (every suit keeps the same outline; only visor and plate colours change).
//! Items are never a reward for winning a single match; they unlock by participation.

use sqlx::{Row, SqlitePool};

use crate::db::{self, SEASON};

pub struct Item {
    pub id: &'static str,
    pub token_id: u64,
    pub name: &'static str,
    pub slot: &'static str,
    pub color: &'static str,
    pub how: &'static str,
}

pub const CATALOGUE: [Item; 6] = [
    Item { id: "founders-visor", token_id: 1, name: "Founders Visor", slot: "visor", color: "#ffb347", how: "Sign in during the testnet beta" },
    Item { id: "harbour-teal", token_id: 2, name: "Harbour Teal Plates", slot: "plates", color: "#2f8f8a", how: "Finish 3 matches" },
    Item { id: "rust-red", token_id: 3, name: "Rust Red Plates", slot: "plates", color: "#a8432a", how: "25 kills this season" },
    Item { id: "signal-gold", token_id: 4, name: "Signal Gold Visor", slot: "visor", color: "#ffd36a", how: "Earn the 5-kill streak badge" },
    Item { id: "chrome-visor", token_id: 5, name: "Chrome Visor", slot: "visor", color: "#d9e3ea", how: "Reach a 1600 rating" },
    Item { id: "night-shift", token_id: 6, name: "Night-Shift Hi-Vis", slot: "plates", color: "#c8e63c", how: "Play 10 matches" },
];

pub fn item(id: &str) -> Option<&'static Item> {
    CATALOGUE.iter().find(|i| i.id == id)
}

/// Can this account claim `item` right now?
pub async fn eligible(db: &SqlitePool, account_id: i64, item: &Item) -> sqlx::Result<bool> {
    let r = sqlx::query("SELECT rating, matches, kills FROM ratings WHERE account_id = ? AND season = ?")
        .bind(account_id)
        .bind(SEASON)
        .fetch_optional(db)
        .await?;
    let (rating, matches, kills): (f64, i64, i64) = r.map(|r| (r.get(0), r.get(1), r.get(2))).unwrap_or((1500.0, 0, 0));
    let has = |code: &'static str| async move {
        sqlx::query("SELECT 1 FROM achievements WHERE account_id = ? AND code = ?").bind(account_id).bind(code).fetch_optional(db).await.map(|r| r.is_some())
    };
    Ok(match item.id {
        "founders-visor" => true,
        "harbour-teal" => matches >= 3,
        "rust-red" => kills >= 25,
        "signal-gold" => has("streak-5").await?,
        "chrome-visor" => rating >= 1600.0,
        "night-shift" => matches >= 10,
        _ => false,
    })
}

pub async fn owned(db: &SqlitePool, account_id: i64) -> sqlx::Result<Vec<String>> {
    Ok(sqlx::query("SELECT item FROM cosmetic_claims WHERE account_id = ?").bind(account_id).fetch_all(db).await?.iter().map(|r| r.get(0)).collect())
}

pub async fn record_claim(db: &SqlitePool, account_id: i64, item: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO cosmetic_claims (account_id, item, claimed_at) VALUES (?, ?, ?)")
        .bind(account_id)
        .bind(item)
        .bind(db::now())
        .execute(db)
        .await?;
    Ok(())
}
