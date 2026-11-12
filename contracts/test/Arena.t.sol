// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArenaRegistry} from "../src/ArenaRegistry.sol";
import {Achievements} from "../src/Achievements.sol";
import {SeasonRanks} from "../src/SeasonRanks.sol";
import {Cosmetics} from "../src/Cosmetics.sol";
import {Soulbound} from "../src/Soulbound.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ArenaTest is Test {
    // Anvil key #0 — the same key the Rust fixture test signs with.
    uint256 constant SERVER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address server = vm.addr(SERVER_KEY);
    address player = address(0xAA);
    address stranger = address(0xBEEF);

    ArenaRegistry registry;
    Achievements achievements;
    SeasonRanks ranks;
    Cosmetics cosmetics;
    string fixture;

    function setUp() public {
        registry = new ArenaRegistry(address(this), server);
        achievements = new Achievements(registry);
        ranks = new SeasonRanks(address(this));
        cosmetics = new Cosmetics(registry, address(this), "https://arena.example/cosmetics/{id}.json");
        fixture = vm.readFile("test/fixtures/server_sigs.json");
        // The Rust fixture signed for this exact registry address (first contract this test creates).
        assertEq(address(registry), 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f);
    }

    // ---------------------------------------------------------------- signatures from the Rust server

    function _fixtureResult() internal view returns (ArenaRegistry.MatchResult[] memory rs, bytes[] memory sigs) {
        rs = new ArenaRegistry.MatchResult[](1);
        rs[0] = ArenaRegistry.MatchResult(
            vm.parseJsonBytes32(fixture, ".matchId"), uint64(vm.parseJsonUint(fixture, ".endedAt")), vm.parseJsonBytes32(fixture, ".resultsHash")
        );
        sigs = new bytes[](1);
        sigs[0] = vm.parseJsonBytes(fixture, ".matchSig");
    }

    function test_RustSignedMatchSettles() public {
        assertEq(vm.parseJsonAddress(fixture, ".signer"), server);
        (ArenaRegistry.MatchResult[] memory rs, bytes[] memory sigs) = _fixtureResult();
        vm.prank(stranger); // anyone may relay
        assertEq(registry.submitResults(rs, sigs), 1);
        assertTrue(registry.isSettled(rs[0].matchId));
        (bytes32 h, uint64 endedAt,) = registry.results(rs[0].matchId);
        assertEq(h, rs[0].resultsHash);
        assertEq(endedAt, rs[0].endedAt);
        // Retrying is harmless.
        assertEq(registry.submitResults(rs, sigs), 0);
        assertEq(registry.matchCount(), 1);
    }

    function test_RustResultsHashMatchesSolidityEncoding() public view {
        address[] memory players = new address[](3);
        players[0] = address(0xAA);
        players[1] = address(0xBB);
        uint32[] memory placings = new uint32[](3);
        placings[1] = 1;
        placings[2] = 2;
        int32[] memory deltas = new int32[](3);
        deltas[0] = 42;
        deltas[1] = -42;
        assertEq(keccak256(abi.encode(players, placings, deltas)), vm.parseJsonBytes32(fixture, ".resultsHash"));
    }

    function test_TamperedResultRejected() public {
        (ArenaRegistry.MatchResult[] memory rs, bytes[] memory sigs) = _fixtureResult();
        rs[0].resultsHash = keccak256("I won actually");
        vm.expectRevert(abi.encodeWithSelector(ArenaRegistry.BadSignature.selector, 0));
        registry.submitResults(rs, sigs);
    }

    function test_RustSignedCosmeticClaim() public {
        bytes memory sig = vm.parseJsonBytes(fixture, ".cosmeticSig");
        uint256 item = vm.parseJsonUint(fixture, ".cosmeticItem");
        vm.prank(player);
        cosmetics.claim(item, sig);
        assertEq(cosmetics.balanceOf(player, item), 1);
        // Once only.
        vm.prank(player);
        vm.expectRevert(Cosmetics.AlreadyClaimed.selector);
        cosmetics.claim(item, sig);
        // A voucher is bound to its wallet: someone else can't use it.
        vm.prank(stranger);
        vm.expectRevert(Cosmetics.BadVoucher.selector);
        cosmetics.claim(item, sig);
        // Cosmetics are tradable.
        vm.prank(player);
        cosmetics.safeTransferFrom(player, stranger, item, 1, "");
        assertEq(cosmetics.balanceOf(stranger, item), 1);
    }

    function test_RustSignedAchievementIsSoulbound() public {
        bytes memory sig = vm.parseJsonBytes(fixture, ".achievementSig");
        uint256 id = vm.parseJsonUint(fixture, ".achievementId");
        vm.prank(player);
        uint256 tokenId = achievements.claim(id, sig);
        assertEq(achievements.ownerOf(tokenId), player);
        assertEq(achievements.achievementOf(tokenId), id);
        assertTrue(achievements.locked(tokenId));
        assertTrue(achievements.supportsInterface(0xb45a3c0e));
        vm.prank(player);
        vm.expectRevert(Soulbound.Soulbound_NonTransferable.selector);
        achievements.transferFrom(player, stranger, tokenId);
        vm.prank(stranger);
        vm.expectRevert(Achievements.BadVoucher.selector);
        achievements.claim(id, sig);
    }

    // ---------------------------------------------------------------- property tests

    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, registry.digest(structHash));
        return abi.encodePacked(r, s, v);
    }

    function testFuzz_OnlyServerSignaturesSettle(bytes32 matchId, uint64 endedAt, bytes32 resultsHash, uint256 otherKey) public {
        otherKey = bound(otherKey, 1, 2 ** 128);
        vm.assume(otherKey != SERVER_KEY);
        bytes32 sh = keccak256(abi.encode(registry.MATCH_TYPEHASH(), matchId, endedAt, resultsHash));
        ArenaRegistry.MatchResult[] memory rs = new ArenaRegistry.MatchResult[](1);
        rs[0] = ArenaRegistry.MatchResult(matchId, endedAt, resultsHash);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(otherKey, sh);
        vm.expectRevert(abi.encodeWithSelector(ArenaRegistry.BadSignature.selector, 0));
        registry.submitResults(rs, sigs);
        sigs[0] = _sign(SERVER_KEY, sh);
        assertEq(registry.submitResults(rs, sigs), 1);
    }

    function test_SignerRotation() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setSigner(stranger);
        uint256 newKey = 0xB0B;
        registry.setSigner(vm.addr(newKey));
        // Old server signatures stop working immediately.
        (ArenaRegistry.MatchResult[] memory rs, bytes[] memory sigs) = _fixtureResult();
        vm.expectRevert(abi.encodeWithSelector(ArenaRegistry.BadSignature.selector, 0));
        registry.submitResults(rs, sigs);
    }

    function test_SeasonRanks() public {
        address[] memory ps = new address[](2);
        ps[0] = player;
        ps[1] = stranger;
        uint8[] memory tiers = new uint8[](2);
        tiers[0] = 4;
        tiers[1] = 1;
        ranks.mintSeason(1, ps, tiers);
        (bool ranked, uint8 tier) = ranks.rankOf(1, player);
        assertTrue(ranked);
        assertEq(tier, 4);
        vm.expectRevert(abi.encodeWithSelector(SeasonRanks.AlreadyRanked.selector, player));
        ranks.mintSeason(1, ps, tiers);
        vm.prank(player);
        vm.expectRevert(Soulbound.Soulbound_NonTransferable.selector);
        ranks.transferFrom(player, stranger, 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ranks.mintSeason(2, ps, tiers);
    }
}
