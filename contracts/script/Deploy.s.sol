// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ArenaRegistry} from "../src/ArenaRegistry.sol";
import {Achievements} from "../src/Achievements.sol";
import {SeasonRanks} from "../src/SeasonRanks.sol";
import {Cosmetics} from "../src/Cosmetics.sol";

/// forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_KEY --broadcast
/// Env: SIGNER_ADDRESS (game server signing address), OWNER (defaults to the deployer),
///      COSMETICS_URI (metadata URI template with {id}).
contract Deploy is Script {
    function run() external {
        address signer = vm.envAddress("SIGNER_ADDRESS");
        address owner = vm.envOr("OWNER", msg.sender);
        string memory uri = vm.envOr("COSMETICS_URI", string("https://hushline-game.vercel.app/cosmetics/{id}.json"));
        vm.startBroadcast();
        ArenaRegistry registry = new ArenaRegistry(owner, signer);
        Achievements achievements = new Achievements(registry);
        SeasonRanks ranks = new SeasonRanks(owner);
        Cosmetics cosmetics = new Cosmetics(registry, owner, uri);
        vm.stopBroadcast();
        console2.log("ArenaRegistry", address(registry));
        console2.log("Achievements", address(achievements));
        console2.log("SeasonRanks", address(ranks));
        console2.log("Cosmetics", address(cosmetics));
    }
}
