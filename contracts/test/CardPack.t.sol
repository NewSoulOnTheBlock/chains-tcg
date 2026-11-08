// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// NOTE: UNEXECUTED. `forge` is not installed and the Foundry libs are not vendored in this
// checkout. Written to compile by inspection against OZ v5 + forge-std, not run. Some reveal
// assertions depend on `blockhash()` behaviour under the Foundry VM (advance with `vm.roll`).

import {Test} from "forge-std/Test.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {CardPack} from "../src/CardPack.sol";

/// Receiver that reverts on receipt — the classic H-8 re-roll griefer. Under the old
/// single-tx mint it could read the pull and veto it; under commit/reveal it can only make
/// its own reveal tx revert, and the seed is already fixed, so it can never re-roll.
contract RevertingReceiver is IERC721Receiver {
    bool public reject = true;
    function setReject(bool r) external { reject = r; }
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(!reject, "nope");
        return IERC721Receiver.onERC721Received.selector;
    }
    function commit(CardPack p) external payable returns (uint256) { return p.commitPack{value: msg.value}(); }
    function reveal(CardPack p, uint256 id) external { p.revealPack(id); }
}

contract CardPackTest is Test {
    CardPack pack;
    address owner = address(this);
    address buyer = address(0xB0B);
    uint256 constant PRICE = 0.0035 ether;
    uint256 constant CARD_COUNT = 80;

    function setUp() public {
        pack = new CardPack(CARD_COUNT, "https://x/nft/", PRICE, 0 /* uncapped */);
        vm.deal(buyer, 10 ether);
    }

    function _commitReveal(address who) internal returns (uint256 commitId) {
        vm.prank(who);
        commitId = pack.commitPack{value: PRICE}();
        vm.roll(block.number + 2); // advance past the reveal block
        vm.prank(who);
        pack.revealPack(commitId);
    }

    function testCommitRevealMintsPack() public {
        uint256 id = _commitReveal(buyer);
        // 5 cards + 1 foil = 6 tokens, ids 0..5.
        assertEq(pack.nextId(), 6);
        assertEq(pack.ownerOf(0), buyer);
        assertEq(pack.ownerOf(5), buyer);
        assertTrue(pack.isFoil(5));
        assertEq(pack.reservedTokens(), 0);
        id; // silence
    }

    function testRevealTooEarlyReverts() public {
        vm.prank(buyer);
        uint256 id = pack.commitPack{value: PRICE}();
        vm.expectRevert("too early");
        vm.prank(buyer); pack.revealPack(id);
    }

    function testOverpaymentRefunded() public {
        uint256 before = buyer.balance;
        vm.prank(buyer);
        pack.commitPack{value: PRICE + 1 ether}();
        // Only PRICE is kept/reserved; the extra 1 ether is returned.
        assertEq(buyer.balance, before - PRICE);
        assertEq(pack.reservedFunds(), PRICE);
    }

    function testUnderpaidReverts() public {
        vm.expectRevert("underpaid");
        vm.prank(buyer); pack.commitPack{value: PRICE - 1}();
    }

    function testSupplyCapEnforced() public {
        // Cap at exactly one pack (6 tokens).
        pack.setMaxSupply(6);
        _commitReveal(buyer);
        vm.expectRevert("supply cap");
        vm.prank(buyer); pack.commitPack{value: PRICE}();
    }

    function testRevertingReceiverCannotReroll() public {
        RevertingReceiver r = new RevertingReceiver();
        vm.deal(address(r), 1 ether);
        uint256 id = r.commit{value: PRICE}(pack);
        vm.roll(block.number + 2);
        // Receiver rejects — reveal reverts, nothing minted, commit stays unsettled.
        vm.expectRevert();
        r.reveal(pack, id);
        assertEq(pack.nextId(), 0);
        // It can stop rejecting and reveal, but the cards are fixed by the reveal block —
        // no re-roll was possible.
        r.setReject(false);
        r.reveal(pack, id);
        assertEq(pack.nextId(), 6);
    }

    function testRefundExpired() public {
        vm.prank(buyer);
        uint256 id = pack.commitPack{value: PRICE}();
        vm.roll(block.number + pack.REVEAL_DELAY() + pack.REVEAL_WINDOW() + 1);
        uint256 before = buyer.balance;
        vm.prank(buyer); pack.refundExpired(id);
        assertEq(buyer.balance, before + PRICE);
        assertEq(pack.reservedFunds(), 0);
    }

    function testWithdrawRejectsZeroAddress() public {
        _commitReveal(buyer);
        vm.expectRevert("to=0");
        pack.withdraw(address(0));
    }

    function testWithdrawSkipsReservedFunds() public {
        // One open (un-revealed) commit: its payment is reserved and not withdrawable.
        vm.prank(buyer);
        pack.commitPack{value: PRICE}();
        vm.expectRevert("nothing to withdraw");
        pack.withdraw(owner);
    }

    function testWithdrawPaysRevenue() public {
        _commitReveal(buyer); // PRICE becomes revenue
        address sink = address(0xDEAD);
        pack.withdraw(sink);
        assertEq(sink.balance, PRICE);
    }

    function testRenounceDisabled() public {
        vm.expectRevert("renounce disabled");
        pack.renounceOwnership();
    }
}
