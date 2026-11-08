// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title MASTER — the wager token for On-Chain Virtual Arena on Robinhood Chain.
/// @notice Standard 18-decimal ERC-20 with a HARD, immutable supply cap. The owner can
///         mint (for faucet / distribution) but can never exceed `MAX_SUPPLY`, so a leaked
///         owner key cannot inflate the supply without bound.
/// @dev Audit H-4: `mint` was previously uncapped. It is now bounded by `MAX_SUPPLY`.
///      Ownership uses Ownable2Step (audit medium) so a mistyped `transferOwnership`
///      cannot brick the token, and `renounceOwnership` is disabled to avoid an
///      accidental permanent freeze of `mint`.
contract MasterToken is ERC20, Ownable2Step {
    /// @notice Hard cap on total supply (minted + initial). Immutable; cannot be raised.
    uint256 public constant MAX_SUPPLY = 10_000_000 ether;
    /// @notice Amount minted to the deployer at construction.
    uint256 public constant INITIAL_SUPPLY = 1_000_000 ether;

    event Minted(address indexed to, uint256 amount);

    constructor() ERC20("On-Chain Master", "MASTER") Ownable(msg.sender) {
        _mint(msg.sender, INITIAL_SUPPLY); // initial supply to the deployer
    }

    /// @notice Mint new MASTER, bounded by the immutable supply cap.
    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        require(totalSupply() + amount <= MAX_SUPPLY, "cap exceeded");
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @notice Disabled: renouncing ownership would permanently freeze `mint`.
    ///         If minting must end, transfer ownership to a burn/zero-mint custodian
    ///         (e.g. a multisig that will never call `mint`) instead.
    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }
}
