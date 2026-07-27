// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WagerEscrow} from "../src/WagerEscrow.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Master", "MASTER") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract WagerEscrowTest is Test {
    MockToken token;
    WagerEscrow esc;

    address operator = address(0xB0B0);
    address feeRecipient = address(0xFEE5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    bytes32 constant ID = keccak256("match-1");
    uint128 constant WAGER = 100e18;

    function setUp() public {
        token = new MockToken();
        esc = new WagerEscrow(IERC20(address(token)), operator, feeRecipient, 1000); // 10% rake
        token.mint(alice, 1_000e18);
        token.mint(bob, 1_000e18);
        vm.prank(alice); token.approve(address(esc), type(uint256).max);
        vm.prank(bob);   token.approve(address(esc), type(uint256).max);
    }

    function _open() internal {
        vm.prank(operator);
        esc.createMatch(ID, alice, bob, WAGER);
    }

    function _fund() internal {
        _open();
        vm.prank(alice); esc.deposit(ID);
        vm.prank(bob);   esc.deposit(ID);
    }

    function testSettlePaysWinnerMinusRake() public {
        _fund();
        vm.prank(operator);
        esc.settle(ID, alice);
        assertEq(esc.credits(alice), 180e18);        // pot 200 - 10% rake
        assertEq(esc.credits(feeRecipient), 20e18);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice); esc.claim();
        assertEq(token.balanceOf(alice), before + 180e18);
        assertEq(esc.credits(alice), 0);
    }

    function testDrawRefundsBoth() public {
        _fund();
        vm.prank(operator); esc.settleDraw(ID);
        assertEq(esc.credits(alice), WAGER);
        assertEq(esc.credits(bob), WAGER);
    }

    function testOnlyOperatorCanSettle() public {
        _fund();
        vm.expectRevert("not operator");
        vm.prank(alice); esc.settle(ID, alice);
    }

    function testCannotSettleUnfunded() public {
        _open();
        vm.prank(alice); esc.deposit(ID);
        vm.expectRevert("not funded");
        vm.prank(operator); esc.settle(ID, alice);
    }

    function testNoDoubleDeposit() public {
        _open();
        vm.prank(alice); esc.deposit(ID);
        vm.expectRevert("already deposited");
        vm.prank(alice); esc.deposit(ID);
    }

    function testReclaimAfterSettleTimeout() public {
        _fund();
        vm.warp(block.timestamp + 2 days);
        esc.reclaim(ID); // permissionless safety valve
        assertEq(esc.credits(alice), WAGER);
        assertEq(esc.credits(bob), WAGER);
    }

    function testReclaimFundingTimeoutRefundsOnlyDepositor() public {
        _open();
        vm.prank(alice); esc.deposit(ID);
        vm.warp(block.timestamp + 2 hours);
        esc.reclaim(ID);
        assertEq(esc.credits(alice), WAGER);
        assertEq(esc.credits(bob), 0);
    }

    function testReclaimTooEarlyReverts() public {
        _fund();
        vm.expectRevert("too early");
        esc.reclaim(ID);
    }

    function testFuzzRakeSplit(uint16 bps, uint128 wager) public {
        bps = uint16(bound(bps, 0, 2000));
        wager = uint128(bound(wager, 1, 400e18));

        WagerEscrow e2 = new WagerEscrow(IERC20(address(token)), operator, feeRecipient, bps);
        vm.prank(alice); token.approve(address(e2), type(uint256).max);
        vm.prank(bob);   token.approve(address(e2), type(uint256).max);

        vm.prank(operator); e2.createMatch(ID, alice, bob, wager);
        vm.prank(alice); e2.deposit(ID);
        vm.prank(bob);   e2.deposit(ID);
        vm.prank(operator); e2.settle(ID, bob);

        uint256 pot = uint256(wager) * 2;
        uint256 rake = pot * bps / 10_000;
        assertEq(e2.credits(bob), pot - rake);
        assertEq(e2.credits(feeRecipient), rake);
        assertEq(e2.credits(bob) + e2.credits(feeRecipient), pot); // conservation
    }
}
