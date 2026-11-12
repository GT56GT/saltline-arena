//! EIP-712 signatures the contracts verify: match results, cosmetic claims, achievements.
//! The server's signing key never leaves the process; the contracts only trust its address.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{sol, Eip712Domain, SolStruct, SolValue};

sol! {
    /// One finished match. `resultsHash` = keccak256(abi.encode(players, placings, ratingDeltas)).
    struct MatchResult { bytes32 matchId; uint64 endedAt; bytes32 resultsHash; }
    /// Permission for `to` to mint cosmetic `itemId` once.
    struct CosmeticClaim { address to; uint256 itemId; }
    /// Permission for `to` to mint soulbound achievement `achievementId` once.
    struct AchievementAward { address to; uint256 achievementId; }
}

pub struct ArenaSigner {
    key: PrivateKeySigner,
    pub domain: Eip712Domain,
    pub chain_id: u64,
    pub registry: Address,
}

impl ArenaSigner {
    /// `key_hex` empty = a throwaway key (development only; nothing it signs is accepted on-chain).
    pub fn new(key_hex: &str, chain_id: u64, registry: Address) -> Self {
        let key = if key_hex.trim().is_empty() { PrivateKeySigner::random() } else { key_hex.trim().parse().expect("SIGNER_KEY must be a hex private key") };
        let domain = Eip712Domain::new(Some("SaltlineArena".into()), Some("1".into()), Some(U256::from(chain_id)), Some(registry), None);
        Self { key, domain, chain_id, registry }
    }

    pub fn address(&self) -> Address {
        self.key.address()
    }

    fn sign<T: SolStruct>(&self, msg: &T) -> String {
        let hash = msg.eip712_signing_hash(&self.domain);
        let sig = self.key.sign_hash_sync(&hash).expect("signing never fails for a local key");
        format!("0x{}", hex::encode(sig.as_bytes()))
    }

    pub fn results_hash(players: &[Address], placings: &[u32], deltas: &[i32]) -> B256 {
        // Same bytes as Solidity `abi.encode(players, placings, deltas)` (encoded as parameters, not one tuple).
        keccak256((players.to_vec(), placings.to_vec(), deltas.to_vec()).abi_encode_params())
    }

    pub fn sign_match(&self, match_id: B256, ended_at: u64, results_hash: B256) -> String {
        self.sign(&MatchResult { matchId: match_id, endedAt: ended_at, resultsHash: results_hash })
    }

    pub fn sign_cosmetic(&self, to: Address, item_id: u64) -> String {
        self.sign(&CosmeticClaim { to, itemId: U256::from(item_id) })
    }

    pub fn sign_achievement(&self, to: Address, achievement_id: u64) -> String {
        self.sign(&AchievementAward { to, achievementId: U256::from(achievement_id) })
    }

    /// Recover who signed a match result (used by tests and by anyone auditing results).
    pub fn recover_match(&self, match_id: B256, ended_at: u64, results_hash: B256, sig_hex: &str) -> Option<Address> {
        let sig: alloy_primitives::Signature = sig_hex.parse().ok()?;
        let hash = MatchResult { matchId: match_id, endedAt: ended_at, resultsHash: results_hash }.eip712_signing_hash(&self.domain);
        sig.recover_address_from_prehash(&hash).ok()
    }
}
