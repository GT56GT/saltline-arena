// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ArenaRegistry} from "./ArenaRegistry.sol";

/// @title Hushline cosmetics
/// @notice Visual-only items (visors, plates). Free to claim with a server-signed voucher, one per
///         wallet per item, tradable afterwards. No item affects gameplay.
contract Cosmetics is ERC1155, ERC2981, Ownable {
    bytes32 public constant CLAIM_TYPEHASH = keccak256("CosmeticClaim(address to,uint256 itemId)");

    ArenaRegistry public immutable registry;
    mapping(address player => mapping(uint256 itemId => bool)) public claimed;

    event CosmeticClaimed(address indexed player, uint256 indexed itemId);

    error AlreadyClaimed();
    error BadVoucher();

    constructor(ArenaRegistry registry_, address owner_, string memory uri_) ERC1155(uri_) Ownable(owner_) {
        registry = registry_;
        _setDefaultRoyalty(owner_, 500); // 5% on secondary sales, where marketplaces honour it
    }

    function claim(uint256 itemId, bytes calldata voucher) external {
        if (claimed[msg.sender][itemId]) revert AlreadyClaimed();
        if (!registry.verify(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, itemId)), voucher)) revert BadVoucher();
        claimed[msg.sender][itemId] = true;
        _mint(msg.sender, itemId, 1, "");
        emit CosmeticClaimed(msg.sender, itemId);
    }

    function setURI(string calldata uri_) external onlyOwner {
        _setURI(uri_);
    }

    function supportsInterface(bytes4 id) public view override(ERC1155, ERC2981) returns (bool) {
        return super.supportsInterface(id);
    }
}
