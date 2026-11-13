// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Hushline match registry
/// @notice Stores the result of every match, as signed by the game server. Anyone may relay
///         signed results; only results carrying the server's EIP-712 signature are accepted.
///         Holds no funds. The other Arena contracts check vouchers through `verify`.
contract ArenaRegistry is EIP712, Ownable2Step {
    bytes32 public constant MATCH_TYPEHASH = keccak256("MatchResult(bytes32 matchId,uint64 endedAt,bytes32 resultsHash)");

    struct MatchResult {
        bytes32 matchId;
        uint64 endedAt;
        bytes32 resultsHash;
    }

    struct Settled {
        bytes32 resultsHash;
        uint64 endedAt;
        uint64 settledAt;
    }

    /// @notice The game server's signing address.
    address public signer;
    mapping(bytes32 matchId => Settled) public results;
    uint256 public matchCount;

    event SignerChanged(address indexed previous, address indexed current);
    event MatchSettled(bytes32 indexed matchId, bytes32 resultsHash, uint64 endedAt);

    error ZeroAddress();
    error LengthMismatch();
    error BadSignature(uint256 index);

    constructor(address owner_, address signer_) EIP712("Hushline", "1") Ownable(owner_) {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerChanged(address(0), signer_);
    }

    /// @notice Rotate the server signing key (e.g. after a suspected compromise).
    function setSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit SignerChanged(signer, next);
        signer = next;
    }

    /// @notice EIP-712 digest for a struct hash under this registry's domain.
    function digest(bytes32 structHash) public view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }

    /// @notice True if `sig` is the server's signature over `structHash` (EIP-712, this domain).
    function verify(bytes32 structHash, bytes calldata sig) public view returns (bool) {
        (address who, ECDSA.RecoverError err,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), sig);
        return err == ECDSA.RecoverError.NoError && who == signer;
    }

    /// @notice Settle a batch of signed results. Already-settled matches are skipped, so a
    ///         relayer can safely retry. Any bad signature reverts the whole batch.
    /// @return settled Number of matches newly recorded.
    function submitResults(MatchResult[] calldata batch, bytes[] calldata sigs) external returns (uint256 settled) {
        if (batch.length != sigs.length) revert LengthMismatch();
        for (uint256 i; i < batch.length; ++i) {
            MatchResult calldata r = batch[i];
            bytes32 structHash = keccak256(abi.encode(MATCH_TYPEHASH, r.matchId, r.endedAt, r.resultsHash));
            if (!verify(structHash, sigs[i])) revert BadSignature(i);
            if (results[r.matchId].settledAt != 0) continue;
            results[r.matchId] = Settled(r.resultsHash, r.endedAt, uint64(block.timestamp));
            ++settled;
            emit MatchSettled(r.matchId, r.resultsHash, r.endedAt);
        }
        matchCount += settled;
    }

    function isSettled(bytes32 matchId) external view returns (bool) {
        return results[matchId].settledAt != 0;
    }
}
