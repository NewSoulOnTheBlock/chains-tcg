// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NOTE: UNEXECUTED. `forge` is not installed and the Foundry libs are not vendored in this
// checkout. Written to compile by inspection against OZ v5 + forge-std, not run.

import {Test} from "forge-std/Test.sol";
import {MasterToken} from "../src/MasterToken.sol";

contract MasterTokenTest is Test {
    MasterToken tok;
    address owner = address(this);
    address alice = address(0xA11CE);

    function setUp() public {
        tok = new MasterToken();
    }

    function testInitialSupplyToDeployer() public {
        assertEq(tok.totalSupply(), tok.INITIAL_SUPPLY());
        assertEq(tok.balanceOf(owner), tok.INITIAL_SUPPLY());
    }

    function testOwnerCanMintUpToCap() public {
        uint256 room = tok.MAX_SUPPLY() - tok.totalSupply();
        tok.mint(alice, room);
        assertEq(tok.totalSupply(), tok.MAX_SUPPLY());
        assertEq(tok.balanceOf(alice), room);
    }

    function testMintOverCapReverts() public {
        uint256 room = tok.MAX_SUPPLY() - tok.totalSupply();
        vm.expectRevert("cap exceeded");
        tok.mint(alice, room + 1);
    }

    function testMintToZeroReverts() public {
        vm.expectRevert("to=0");
        tok.mint(address(0), 1 ether);
    }

    function testOnlyOwnerCanMint() public {
        vm.expectRevert(); // OwnableUnauthorizedAccount
        vm.prank(alice); tok.mint(alice, 1 ether);
    }

    function testRenounceDisabled() public {
        vm.expectRevert("renounce disabled");
        tok.renounceOwnership();
    }

    function testTwoStepOwnership() public {
        tok.transferOwnership(alice);
        assertEq(tok.owner(), owner);
        vm.prank(alice); tok.acceptOwnership();
        assertEq(tok.owner(), alice);
    }
}
