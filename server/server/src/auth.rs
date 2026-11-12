//! Sign-In With Ethereum (EIP-4361), verified locally: no RPC, no third party.
//! The wallet signs a human-readable message containing a one-time nonce we issued.

use alloy_primitives::{Address, Signature};
use rand::RngCore;
use sqlx::SqlitePool;

use crate::db::{self, Account};

const NONCE_TTL_SECS: i64 = 10 * 60;
const SESSION_DAYS: i64 = 7;

pub fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut b);
    hex::encode(b)
}

pub async fn issue_nonce(db: &SqlitePool) -> sqlx::Result<String> {
    let nonce = random_hex(12);
    sqlx::query("DELETE FROM nonces WHERE created_at < ?").bind(db::now() - NONCE_TTL_SECS).execute(db).await?;
    sqlx::query("INSERT INTO nonces (nonce, created_at) VALUES (?, ?)").bind(&nonce).bind(db::now()).execute(db).await?;
    Ok(nonce)
}

#[derive(Debug)]
pub struct SiweFields {
    pub domain: String,
    pub address: Address,
    pub nonce: String,
    pub chain_id: Option<u64>,
}

/// Parse the fields we check from an EIP-4361 message.
pub fn parse_siwe(msg: &str) -> Option<SiweFields> {
    let mut lines = msg.lines();
    let first = lines.next()?;
    let domain = first.strip_suffix(" wants you to sign in with your Ethereum account:")?.trim().to_string();
    let address: Address = lines.next()?.trim().parse().ok()?;
    let field = |name: &str| msg.lines().find_map(|l| l.strip_prefix(name).map(|v| v.trim().to_string()));
    Some(SiweFields { domain, address, nonce: field("Nonce:")?, chain_id: field("Chain ID:").and_then(|c| c.parse().ok()) })
}

/// Verify the signature and nonce; on success return (account, session token).
pub async fn verify(db: &SqlitePool, message: &str, signature: &str, allowed_domains: &[String]) -> Result<(Account, String), String> {
    let f = parse_siwe(message).ok_or("Not a Sign-In With Ethereum message")?;
    if !allowed_domains.is_empty() && !allowed_domains.iter().any(|d| d == &f.domain) {
        return Err(format!("Sign-in for domain {} is not accepted here", f.domain));
    }
    let sig: Signature = signature.parse().map_err(|_| "Bad signature format")?;
    let signer = sig.recover_address_from_msg(message.as_bytes()).map_err(|_| "Signature does not recover")?;
    if signer != f.address {
        return Err("Signature does not match the address in the message".into());
    }
    // One-time nonce: deleting it is what makes a replayed message useless.
    let used = sqlx::query("DELETE FROM nonces WHERE nonce = ? AND created_at > ?")
        .bind(&f.nonce)
        .bind(db::now() - NONCE_TTL_SECS)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    if used.rows_affected() != 1 {
        return Err("Nonce expired or already used".into());
    }
    let wallet = format!("{:#x}", f.address);
    let account = db::upsert_account(db, &wallet).await.map_err(|e| e.to_string())?;
    if account.banned {
        return Err("This account is suspended".into());
    }
    let token = random_hex(32);
    sqlx::query("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)")
        .bind(&token)
        .bind(account.id)
        .bind(db::now() + SESSION_DAYS * 86400)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok((account, token))
}

pub async fn logout(db: &SqlitePool, token: &str) {
    let _ = sqlx::query("DELETE FROM sessions WHERE token = ?").bind(token).execute(db).await;
}
