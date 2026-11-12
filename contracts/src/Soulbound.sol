// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice ERC-721 that can be minted but never transferred (ERC-5192 "locked" tokens).
abstract contract Soulbound is ERC721 {
    /// @dev ERC-5192
    event Locked(uint256 tokenId);

    error Soulbound_NonTransferable();

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) revert Soulbound_NonTransferable();
        emit Locked(tokenId);
    }

    function supportsInterface(bytes4 id) public view virtual override returns (bool) {
        return id == 0xb45a3c0e || super.supportsInterface(id); // ERC-5192
    }
}
