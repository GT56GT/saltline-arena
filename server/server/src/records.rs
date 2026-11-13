//! Turns a finished match into permanent records: placings, Glicko-2 ratings, history,
//! achievements, and an EIP-712 signature over the result for on-chain settlement.

use alloy_primitives::{keccak256, Address, B256};
use sqlx::{Row, SqlitePool};

use crate::db::{self, SEASON};
use crate::rating::{self, Rating};
use crate::room::MatchSummary;
use crate::sign::ArenaSigner;

/// Bots count as opponents with a fixed, confident rating; they are never updated.
const BOT_RATING: Rating = Rating { rating: 1400.0, rd: 150.0, vol: 0.06 };

pub const ACHIEVEMENTS: [(&str, u64, &str); 6] = [
    ("first-blood", 1, "Score your first kill"),
    ("double-digits", 2, "10 kills in one match"),
    ("sharpshooter", 3, "5 headshot kills in one match"),
    ("streak-5", 4, "5 kills without dying"),
    ("veteran", 5, "Finish 10 matches"),
    ("victor", 6, "Win a match against at least 3 others"),
];

pub struct Recorded {
    pub match_id: String,
    /// (player slot in the match, rating delta) for signed-in players.
    pub deltas: Vec<(u32, i32)>,
}

/// Placings by kills (desc), then deaths (asc). Ties share a placing.
pub fn placings(rows: &[(u32, u32)]) -> Vec<u32> {
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|&a, &b| rows[b].0.cmp(&rows[a].0).then(rows[a].1.cmp(&rows[b].1)));
    let mut out = vec![0; rows.len()];
    for (rank, &i) in order.iter().enumerate() {
        out[i] = if rank > 0 && rows[order[rank - 1]] == rows[i] { out[order[rank - 1]] } else { rank as u32 };
    }
    out
}

pub async fn save(db: &SqlitePool, signer: &ArenaSigner, m: &MatchSummary) -> sqlx::Result<Option<Recorded>> {
    // Private rooms (host-made, any teams or bots) are casual: no ratings, no records.
    if !m.ranked {
        return Ok(None);
    }
    // Matches with no humans (bots alone) are not recorded.
    if m.players.iter().all(|p| p.7) {
        return Ok(None);
    }
    let places = placings(&m.players.iter().map(|p| (p.3, p.4)).collect::<Vec<_>>());

    // Current ratings for everyone in the match.
    let mut before = Vec::with_capacity(m.players.len());
    for p in &m.players {
        before.push(match (p.7, p.2.account) {
            (true, _) => BOT_RATING,
            (false, Some(acc)) => db::rating(db, acc).await?,
            (false, None) => Rating::default(),
        });
    }
    let after = rating::ffa(&before.iter().copied().zip(places.iter().copied()).collect::<Vec<_>>());

    let ended_at = db::now();
    let match_id = keccak256(format!("{}:{}:{}:{}", m.room, m.ended_tick, ended_at, crate::auth::random_hex(8)));
    let wallets: Vec<Address> = m.players.iter().map(|p| p.2.wallet.as_deref().and_then(|w| w.parse().ok()).unwrap_or(Address::ZERO)).collect();
    let deltas: Vec<i32> = m
        .players
        .iter()
        .enumerate()
        .map(|(i, p)| if p.2.account.is_some() { (after[i].rating - before[i].rating).round() as i32 } else { 0 })
        .collect();
    let results_hash = ArenaSigner::results_hash(&wallets, &places, &deltas);
    let signature = signer.sign_match(match_id, ended_at as u64, results_hash);
    let duration = ((m.ended_tick - m.started_tick) / game_core::TICK_HZ) as i64;

    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO matches (id, room, season, ended_at, duration_s, results_hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(format!("{match_id:#x}"))
        .bind(m.room as i64)
        .bind(SEASON)
        .bind(ended_at)
        .bind(duration)
        .bind(format!("{results_hash:#x}"))
        .bind(&signature)
        .execute(&mut *tx)
        .await?;
    let mut out = Vec::new();
    for (slot, p) in m.players.iter().enumerate() {
        let (pid, name, ident, kills, deaths, heads, streak, is_bot) = p;
        let rated = ident.account.is_some() && !is_bot;
        sqlx::query("INSERT INTO match_players VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(format!("{match_id:#x}"))
            .bind(slot as i64)
            .bind(ident.account)
            .bind(&ident.wallet)
            .bind(name)
            .bind(*is_bot as i64)
            .bind(*kills as i64)
            .bind(*deaths as i64)
            .bind(*heads as i64)
            .bind(*streak as i64)
            .bind(places[slot] as i64)
            .bind(rated.then_some(before[slot].rating))
            .bind(rated.then_some(after[slot].rating))
            .execute(&mut *tx)
            .await?;
        if let (Some(acc), false) = (ident.account, *is_bot) {
            let r = after[slot];
            let won = places[slot] == 0 && m.players.len() >= 2;
            sqlx::query(
                "INSERT INTO ratings (account_id, season, rating, rd, vol, matches, wins, kills, deaths, headshots)
                 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                 ON CONFLICT(account_id, season) DO UPDATE SET rating = excluded.rating, rd = excluded.rd, vol = excluded.vol,
                   matches = matches + 1, wins = wins + excluded.wins, kills = kills + excluded.kills,
                   deaths = deaths + excluded.deaths, headshots = headshots + excluded.headshots",
            )
            .bind(acc)
            .bind(SEASON)
            .bind(r.rating)
            .bind(r.rd)
            .bind(r.vol)
            .bind(won as i64)
            .bind(*kills as i64)
            .bind(*deaths as i64)
            .bind(*heads as i64)
            .execute(&mut *tx)
            .await?;
            out.push((*pid, deltas[slot]));
        }
    }
    tx.commit().await?;

    // Achievements (idempotent: each is awarded once per account).
    for (slot, p) in m.players.iter().enumerate() {
        let Some(acc) = p.2.account else { continue };
        if p.7 {
            continue;
        }
        let total = sqlx::query("SELECT matches, kills FROM ratings WHERE account_id = ? AND season = ?").bind(acc).bind(SEASON).fetch_one(db).await?;
        let (matches, kills): (i64, i64) = (total.get(0), total.get(1));
        let earned = [
            ("first-blood", kills >= 1),
            ("double-digits", p.3 >= 10),
            ("sharpshooter", p.5 >= 5),
            ("streak-5", p.6 >= 5),
            ("veteran", matches >= 10),
            ("victor", places[slot] == 0 && m.players.len() >= 4 && p.3 > 0),
        ];
        for (code, ok) in earned {
            if ok {
                sqlx::query("INSERT OR IGNORE INTO achievements (account_id, code, match_id, awarded_at) VALUES (?, ?, ?, ?)")
                    .bind(acc)
                    .bind(code)
                    .bind(format!("{match_id:#x}"))
                    .bind(db::now())
                    .execute(db)
                    .await?;
            }
        }
    }
    Ok(Some(Recorded { match_id: format!("{match_id:#x}"), deltas: out }))
}

pub fn parse_b256(s: &str) -> Option<B256> {
    s.parse().ok()
}
