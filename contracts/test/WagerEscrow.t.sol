// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NOTE: These tests are UNEXECUTED. `forge` is not installed in this environment and the
// Foundry libs (lib/forge-std, lib/openzeppelin-contracts) are not vendored in this checkout,
// so the suite has been written to compile by inspection against OZ v5 + forge-std, not run.
// Run `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts && forge test`
// before trusting any assertion here.

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WagerEscrow} from "../src/WagerEscrow.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Master", "MASTER") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// A hook-bearing token that re-enters the escrow on transferFrom, to prove the shared
/// ReentrancyGuard blocks cross-function reentry during a deposit (contracts-06 / H-11).
contract ReentrantToken is ERC20 {
    WagerEscrow public esc;
    bytes32 public targetId;
    bool public attack;

    constructor() ERC20("Reenter", "RNT") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function arm(WagerEscrow e, bytes32 id) external { esc = e; targetId = id; attack = true; }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        if (attack && address(esc) != address(0)) {
            // Re-enter a guarded path mid-deposit; must revert and bubble up.
            esc.reclaim(targetId);
        }
        return super.transferFrom(from, to, amt);
    }
}

contract WagerEscrowTest is Test {
    MockToken token;
    WagerEscrow esc;

    address owner = address(this);
    address operator = address(0xB0B0);
    address feeRecipient = address(0xFEE5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAC0);

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

    // ── Happy paths ──────────────────────────────────────────────────────────

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

    function testCancelMatchRefunds() public {
        _fund();
        vm.prank(operator); esc.cancelMatch(ID);
        assertEq(esc.credits(alice), WAGER);
        assertEq(esc.credits(bob), WAGER);
    }

    // ── Access control & state ─────────────────────────────────────────────────

    function testOnlyOperatorCanSettle() public {
        _fund();
        vm.expectRevert("not operator");
        vm.prank(alice); esc.settle(ID, alice);
    }

    function testOnlyOperatorCanCreate() public {
        vm.expectRevert("not operator");
        vm.prank(alice); esc.createMatch(ID, alice, bob, WAGER);
    }

    function testCannotSettleUnfunded() public {
        _open();
        vm.prank(alice); esc.deposit(ID);
        vm.expectRevert("not funded");
        vm.prank(operator); esc.settle(ID, alice);
    }

    function testSettleRejectsNonParticipant() public {
        _fund();
        vm.expectRevert("bad winner");
        vm.prank(operator); esc.settle(ID, carol);
    }

    function testDepositByNonPlayerReverts() public {
        _open();
        token.mint(carol, 1_000e18);
        vm.prank(carol); token.approve(address(esc), type(uint256).max);
        vm.expectRevert("not a player");
        vm.prank(carol); esc.deposit(ID);
    }

    function testNoDoubleDeposit() public {
        _open();
        vm.prank(alice); esc.deposit(ID);
        vm.expectRevert("already deposited");
        vm.prank(alice); esc.deposit(ID);
    }

    function testCannotDoubleSettle() public {
        _fund();
        vm.prank(operator); esc.settle(ID, alice);
        vm.expectRevert("not funded");
        vm.prank(operator); esc.settle(ID, bob);
    }

    function testClaimNothingReverts() public {
        vm.expectRevert("nothing to claim");
        vm.prank(alice); esc.claim();
    }

    // ── contracts-04: rake snapshotted at createMatch ──────────────────────────

    function testRakeSnapshotIgnoresLaterSetRake() public {
        _fund(); // created at 10% rake
        // Owner tries to raise the rake to 20% before settle — must not affect this match.
        esc.setRake(2000, feeRecipient);
        vm.prank(operator); esc.settle(ID, alice);
        assertEq(esc.credits(alice), 180e18);         // still 10%
        assertEq(esc.credits(feeRecipient), 20e18);
    }

    // ── contracts-03: timeouts snapshotted; later setTimeouts cannot lock a match ──

    function testTimeoutSnapshotLetsReclaimDespiteLaterExtend() public {
        _fund(); // snapshots settleTimeout = 1 day
        // Owner cannot extend THIS match (and is also capped at 7 days).
        esc.setTimeouts(24 hours, 7 days);
        // After the snapshotted 1 day + grace, reclaim still works.
        vm.warp(block.timestamp + 1 days + 1 hours + 1);
        esc.reclaim(ID);
        assertEq(esc.credits(alice), WAGER);
        assertEq(esc.credits(bob), WAGER);
    }

    function testSetTimeoutsBounded() public {
        vm.expectRevert("settle>max");
        esc.setTimeouts(1 hours, 8 days);
        vm.expectRevert("funding>max");
        esc.setTimeouts(25 hours, 1 days);
    }

    // ── contracts-05: reclaim race — grace window is exclusive to the operator ──

    function testReclaimRespectsGraceWindow() public {
        _fund();
        // Just past settleTimeout but inside the operator's grace window: reclaim must fail.
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert("too early");
        vm.prank(bob); esc.reclaim(ID);

        // Operator can still settle during the grace window — loser cannot escape.
        vm.prank(operator); esc.settle(ID, alice);
        assertEq(esc.credits(alice), 180e18);
    }

    function testReclaimAfterSettleTimeoutPlusGrace() public {
        _fund();
        vm.warp(block.timestamp + 1 days + 1 hours + 1);
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

    // ── contracts-06 / H-11: cross-function reentrancy is blocked ───────────────

    function testReentrantDepositReverts() public {
        ReentrantToken rt = new ReentrantToken();
        WagerEscrow e2 = new WagerEscrow(IERC20(address(rt)), operator, feeRecipient, 1000);
        rt.mint(alice, 1_000e18);
        rt.mint(bob, 1_000e18);
        vm.prank(alice); rt.approve(address(e2), type(uint256).max);
        vm.prank(bob);   rt.approve(address(e2), type(uint256).max);

        vm.prank(operator); e2.createMatch(ID, alice, bob, WAGER);
        rt.arm(e2, ID); // re-enter reclaim() during the next transferFrom

        // The re-entrant reclaim hits the shared guard; the whole deposit reverts.
        vm.expectRevert();
        vm.prank(alice); e2.deposit(ID);
    }

    // ── contracts-08: Ownable2Step; renounce disabled ──────────────────────────

    function testRenounceDisabled() public {
        vm.expectRevert("renounce disabled");
        esc.renounceOwnership();
    }

    function testTwoStepOwnershipTransfer() public {
        esc.transferOwnership(alice);
        assertEq(esc.owner(), owner);        // not yet effective
        vm.prank(alice); esc.acceptOwnership();
        assertEq(esc.owner(), alice);
    }

    // ── Invariant-style solvency check: credits never exceed escrow balance ─────

    function testSolvencyAfterSettle() public {
        _fund();
        vm.prank(operator); esc.settle(ID, alice);
        uint256 totalCredits = esc.credits(alice) + esc.credits(bob) + esc.credits(feeRecipient);
        assertLe(totalCredits, token.balanceOf(address(esc)));
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
