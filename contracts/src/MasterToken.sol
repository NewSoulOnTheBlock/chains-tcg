// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MASTER — the wager token for On-Chain Virtual Arena on Robinhood Chain.
/// @notice Standard 18-decimal ERC-20. Owner can mint (for faucet / distribution).
contract MasterToken is ERC20, Ownable {
    constructor() ERC20("On-Chain Master", "MASTER") Ownable(msg.sender) {
        _mint(msg.sender, 1_000_000 ether); // initial supply to the deployer
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
