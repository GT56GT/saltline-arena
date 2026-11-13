// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Soulbound} from "./Soulbound.sol";
import {ArenaRegistry} from "./ArenaRegistry.sol";

/// @title Hushline achievements
/// @notice Soulbound badges for in-game milestones. A player mints their own badge with a
///         voucher signed by the game server; badges can never be sold or transferred.
contract Achievements is Soulbound {
    bytes32 public constant AWARD_TYPEHASH = keccak256("AchievementAward(address to,uint256 achievementId)");

    ArenaRegistry public immutable registry;
    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => uint256 achievementId) public achievementOf;
    mapping(address player => mapping(uint256 achievementId => bool)) public hasAchievement;

    event AchievementClaimed(address indexed player, uint256 indexed achievementId, uint256 tokenId);

    error AlreadyClaimed();
    error BadVoucher();

    constructor(ArenaRegistry registry_) ERC721("Hushline Achievements", "HLACH") {
        registry = registry_;
    }

    function claim(uint256 achievementId, bytes calldata voucher) external returns (uint256 tokenId) {
        if (hasAchievement[msg.sender][achievementId]) revert AlreadyClaimed();
        if (!registry.verify(keccak256(abi.encode(AWARD_TYPEHASH, msg.sender, achievementId)), voucher)) revert BadVoucher();
        hasAchievement[msg.sender][achievementId] = true;
        tokenId = nextTokenId++;
        achievementOf[tokenId] = achievementId;
        _safeMint(msg.sender, tokenId);
        emit AchievementClaimed(msg.sender, achievementId, tokenId);
    }
}
