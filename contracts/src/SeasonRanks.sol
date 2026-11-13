// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Soulbound} from "./Soulbound.sol";

/// @title Hushline season ranks
/// @notice One soulbound rank badge per wallet per season, minted at season close from the
///         final standings (after the anti-cheat review).
contract SeasonRanks is Soulbound, Ownable {
    struct Rank {
        uint16 season;
        uint8 tier; // 0 Bronze, 1 Silver, 2 Gold, 3 Platinum, 4 Diamond, 5 Top 100
    }

    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => Rank) public rankOfToken;
    mapping(uint16 season => mapping(address player => uint8 tierPlusOne)) private _tier;

    event SeasonMinted(uint16 indexed season, uint256 count);

    error LengthMismatch();
    error AlreadyRanked(address player);
    error BadTier();

    constructor(address owner_) ERC721("Hushline Season Ranks", "HLRANK") Ownable(owner_) {}

    function mintSeason(uint16 season, address[] calldata players, uint8[] calldata tiers) external onlyOwner {
        if (players.length != tiers.length) revert LengthMismatch();
        for (uint256 i; i < players.length; ++i) {
            if (tiers[i] > 5) revert BadTier();
            if (_tier[season][players[i]] != 0) revert AlreadyRanked(players[i]);
            _tier[season][players[i]] = tiers[i] + 1;
            uint256 id = nextTokenId++;
            rankOfToken[id] = Rank(season, tiers[i]);
            _mint(players[i], id);
        }
        emit SeasonMinted(season, players.length);
    }

    /// @return ranked Whether the player has a badge for the season, and its tier.
    function rankOf(uint16 season, address player) external view returns (bool ranked, uint8 tier) {
        uint8 t = _tier[season][player];
        return (t != 0, t == 0 ? 0 : t - 1);
    }
}
