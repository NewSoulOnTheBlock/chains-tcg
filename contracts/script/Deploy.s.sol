// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WagerEscrow} from "../src/WagerEscrow.sol";

/// Deploy WagerEscrow to Robinhood Chain.
///   forge script script/Deploy.s.sol:Deploy --rpc-url robinhood --broadcast
/// Env: PRIVATE_KEY, WAGER_TOKEN, OPERATOR, FEE_RECIPIENT, RAKE_BPS (default 1000 = 10%).
contract Deploy is Script {
    function run() external returns (WagerEscrow esc) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address token = vm.envAddress("WAGER_TOKEN");
        address operator = vm.envAddress("OPERATOR");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint16 rakeBps = uint16(vm.envOr("RAKE_BPS", uint256(1000)));

        vm.startBroadcast(pk);
        esc = new WagerEscrow(IERC20(token), operator, feeRecipient, rakeBps);
        vm.stopBroadcast();

        console2.log("WagerEscrow deployed:", address(esc));
        console2.log("  token:       ", token);
        console2.log("  operator:    ", operator);
        console2.log("  feeRecipient:", feeRecipient);
        console2.log("  rakeBps:     ", rakeBps);
    }
}
