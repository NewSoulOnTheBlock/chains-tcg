// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title WagerEscrow
/// @notice 1v1 wagered-match escrow for On-Chain Virtual Arena on Robinhood Chain (EVM, chain 4663).
///         Both players stake `wager` of a single ERC-20. The trusted match operator (the game
///         server) reports the winner, who receives the pot minus an optional rake. Withdrawals
///         are pull-based, transfers use SafeERC20, and timeouts guarantee stakes are never locked
///         even if the operator disappears.
/// @dev Security posture (per ethskills checklist): SafeERC20 for non-standard tokens, balance-delta
///      accounting for fee-on-transfer tokens, ReentrancyGuard + checks-effects-interactions on every
///      external-call path, role-gated settlement, and pull payments to eliminate push-transfer risk.
///
///      Audit fixes in this revision:
///      - H-11 / contracts-06: `nonReentrant` on deposit, settle, settleDraw, cancelMatch and
///        reclaim. Because ReentrancyGuard shares one status flag, a hook-bearing token cannot
///        re-enter any of those paths during `deposit`'s transfer.
///      - contracts-04: `rakeBps` is snapshotted onto each Match at `createMatch`, so a later
///        `setRake` cannot change the rake players agreed to.
///      - H-10 / contracts-03: `setTimeouts` is bounded (funding <= 24h, settle <= 7d) and each
///        Match snapshots its funding/settle timeouts, so a later admin change cannot lock an
///        open match.
///      - contracts-05: after `settleTimeout` the operator keeps an exclusive `RECLAIM_GRACE`
///        window; permissionless `reclaim` of a Funded match is only valid once that grace has
///        also elapsed, so a losing player can no longer front-run `settle` to force a refund.
///      - contracts-08: Ownable2Step, and `renounceOwnership` is disabled so a stray renounce
///        cannot brick `setOperator` / rake administration.
contract WagerEscrow is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The ERC-20 that matches are wagered in (e.g. $MASTER on Robinhood Chain).
    IERC20 public immutable token;

    /// @notice Upper bounds on the configurable timeouts (audit H-10 / contracts-03).
    uint64 public constant MAX_FUNDING_TIMEOUT = 24 hours;
    uint64 public constant MAX_SETTLE_TIMEOUT = 7 days;
    /// @notice Exclusive operator window after `settleTimeout` before anyone may `reclaim`
    ///         a Funded match (contracts-05). Fixed so players know it in advance.
    uint64 public constant RECLAIM_GRACE = 1 hours;
    /// @notice Rake hard cap (basis points).
    uint16 public constant MAX_RAKE_BPS = 2000; // 20%

    enum Status {
        None,      // never created
        Open,      // created, awaiting deposits
        Funded,    // both players deposited
        Settled,   // winner paid / draw refunded
        Cancelled  // refunded via cancel or reclaim
    }

    struct Match {
        address p1;
        address p2;
        uint128 wager;          // required stake per player
        uint128 amt1;           // tokens actually received from p1 (0 = not deposited)
        uint128 amt2;           // tokens actually received from p2 (0 = not deposited)
        Status  status;
        uint16  rakeBps;        // rake snapshotted at createMatch (contracts-04)
        uint64  createdAt;
        uint64  fundedAt;
        uint64  fundingTimeout; // snapshot of fundingTimeout (contracts-03)
        uint64  settleTimeout;  // snapshot of settleTimeout  (contracts-03)
    }

    /// @notice Address allowed to create and settle matches — the game server.
    address public operator;
    /// @notice Rake skimmed from the pot on a decisive settle, in basis points (max 2000 = 20%).
    uint16 public rakeBps;
    /// @notice Where the rake accrues (claimable via pull).
    address public feeRecipient;
    /// @notice If a match isn't fully funded within this window, deposits become reclaimable.
    uint64 public fundingTimeout = 1 hours;
    /// @notice If a funded match isn't settled within this window, stakes become reclaimable.
    uint64 public settleTimeout = 1 days;

    mapping(bytes32 => Match) public matches;
    /// @notice Pull-payment ledger: winnings, refunds and accrued rake accumulate here.
    mapping(address => uint256) public credits;

    event MatchCreated(bytes32 indexed id, address indexed p1, address indexed p2, uint256 wager, uint16 rakeBps);
    event Deposited(bytes32 indexed id, address indexed player, uint256 amount);
    event Funded(bytes32 indexed id, uint256 pot);
    event Settled(bytes32 indexed id, address indexed winner, uint256 payout, uint256 rake);
    event DrawSettled(bytes32 indexed id, uint256 refund1, uint256 refund2);
    event Refunded(bytes32 indexed id);
    event Claimed(address indexed account, uint256 amount);
    event OperatorSet(address indexed operator);
    event RakeSet(uint16 bps, address indexed recipient);
    event TimeoutsSet(uint64 fundingTimeout, uint64 settleTimeout);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(IERC20 _token, address _operator, address _feeRecipient, uint16 _rakeBps)
        Ownable(msg.sender)
    {
        require(address(_token) != address(0), "token=0");
        require(_operator != address(0), "operator=0");
        require(_rakeBps <= MAX_RAKE_BPS, "rake>20%");
        require(_rakeBps == 0 || _feeRecipient != address(0), "feeRecipient=0");
        token = _token;
        operator = _operator;
        feeRecipient = _feeRecipient;
        rakeBps = _rakeBps;
    }

    // ── Admin (owner) ─────────────────────────────────────────────────────────

    /// @notice Disabled: a stray renounce would brick setOperator / rake administration
    ///         and strand the fee ledger. Hand ownership to a multisig instead.
    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    function setOperator(address o) external onlyOwner {
        require(o != address(0), "operator=0");
        operator = o;
        emit OperatorSet(o);
    }

    function setRake(uint16 bps, address recipient) external onlyOwner {
        require(bps <= MAX_RAKE_BPS, "rake>20%");
        require(bps == 0 || recipient != address(0), "feeRecipient=0");
        rakeBps = bps;
        feeRecipient = recipient;
        emit RakeSet(bps, recipient);
    }

    /// @notice Set the default timeouts applied to *new* matches. Bounded so the owner
    ///         cannot pick a value that effectively locks stakes (audit H-10). Existing
    ///         matches are unaffected because each snapshots its own timeouts.
    function setTimeouts(uint64 funding, uint64 settle) external onlyOwner {
        require(funding > 0 && settle > 0, "timeout=0");
        require(funding <= MAX_FUNDING_TIMEOUT, "funding>max");
        require(settle <= MAX_SETTLE_TIMEOUT, "settle>max");
        fundingTimeout = funding;
        settleTimeout = settle;
        emit TimeoutsSet(funding, settle);
    }

    // ── Match lifecycle ───────────────────────────────────────────────────────

    /// @notice Operator opens a match between two players for a fixed per-player stake.
    ///         The current rake and timeouts are snapshotted onto the match.
    function createMatch(bytes32 id, address p1, address p2, uint128 wager) external onlyOperator {
        require(matches[id].status == Status.None, "id exists");
        require(p1 != address(0) && p2 != address(0) && p1 != p2, "bad players");
        require(wager > 0, "wager=0");
        matches[id] = Match({
            p1: p1, p2: p2, wager: wager, amt1: 0, amt2: 0,
            status: Status.Open, rakeBps: rakeBps,
            createdAt: uint64(block.timestamp), fundedAt: 0,
            fundingTimeout: fundingTimeout, settleTimeout: settleTimeout
        });
        emit MatchCreated(id, p1, p2, wager, rakeBps);
    }

    /// @notice A player stakes their wager. Balance-delta accounting credits the amount
    ///         actually received, so fee-on-transfer tokens can't desync the pot.
    function deposit(bytes32 id) external nonReentrant {
        Match storage m = matches[id];
        require(m.status == Status.Open, "not open");
        bool isP1 = msg.sender == m.p1;
        require(isP1 || msg.sender == m.p2, "not a player");
        require(isP1 ? m.amt1 == 0 : m.amt2 == 0, "already deposited");

        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), m.wager);
        uint256 received = token.balanceOf(address(this)) - balBefore;
        require(received > 0, "no tokens received");

        if (isP1) m.amt1 = uint128(received);
        else m.amt2 = uint128(received);
        emit Deposited(id, msg.sender, received);

        if (m.amt1 > 0 && m.amt2 > 0) {
            m.status = Status.Funded;
            m.fundedAt = uint64(block.timestamp);
            emit Funded(id, uint256(m.amt1) + uint256(m.amt2));
        }
    }

    /// @notice Operator reports the winner; the pot minus rake is credited for pull-withdrawal.
    function settle(bytes32 id, address winner) external onlyOperator nonReentrant {
        Match storage m = matches[id];
        require(m.status == Status.Funded, "not funded");
        require(winner == m.p1 || winner == m.p2, "bad winner");

        m.status = Status.Settled; // effects before crediting

        uint256 pot = uint256(m.amt1) + uint256(m.amt2);
        uint256 rake = (pot * m.rakeBps) / 10_000; // snapshotted rate
        uint256 payout = pot - rake;

        credits[winner] += payout;
        if (rake > 0) credits[feeRecipient] += rake;

        emit Settled(id, winner, payout, rake);
    }

    /// @notice Operator declares a draw / void; each player is refunded exactly what they
    ///         deposited. No rake is taken on a draw.
    function settleDraw(bytes32 id) external onlyOperator nonReentrant {
        Match storage m = matches[id];
        require(m.status == Status.Funded, "not funded");
        m.status = Status.Settled;
        uint256 r1 = m.amt1;
        uint256 r2 = m.amt2;
        credits[m.p1] += r1;
        credits[m.p2] += r2;
        emit DrawSettled(id, r1, r2);
    }

    /// @notice Operator aborts a match; any deposits made are refunded.
    function cancelMatch(bytes32 id) external onlyOperator nonReentrant {
        Match storage m = matches[id];
        require(m.status == Status.Open || m.status == Status.Funded, "cannot cancel");
        _refund(id, m);
    }

    /// @notice Permissionless safety valve. If a match never fully funds within its
    ///         snapshotted `fundingTimeout`, or stays funded-but-unsettled past its
    ///         `settleTimeout` + `RECLAIM_GRACE`, anyone may trigger refunds so stakes are
    ///         never locked if the operator vanishes. The grace window after `settleTimeout`
    ///         is exclusive to the operator, so a losing player cannot front-run `settle`
    ///         with `reclaim` to convert a loss into a refund (contracts-05).
    function reclaim(bytes32 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status == Status.Open) {
            require(block.timestamp >= uint256(m.createdAt) + m.fundingTimeout, "too early");
        } else if (m.status == Status.Funded) {
            require(
                block.timestamp >= uint256(m.fundedAt) + m.settleTimeout + RECLAIM_GRACE,
                "too early"
            );
        } else {
            revert("nothing to reclaim");
        }
        _refund(id, m);
    }

    function _refund(bytes32 id, Match storage m) internal {
        m.status = Status.Cancelled; // effects before crediting
        if (m.amt1 > 0) credits[m.p1] += m.amt1;
        if (m.amt2 > 0) credits[m.p2] += m.amt2;
        emit Refunded(id);
    }

    // ── Pull payments ─────────────────────────────────────────────────────────

    /// @notice Withdraw all winnings / refunds / rake owed to the caller.
    function claim() external nonReentrant {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "nothing to claim");
        credits[msg.sender] = 0; // effect before interaction
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getMatch(bytes32 id) external view returns (Match memory) {
        return matches[id];
    }

    function pot(bytes32 id) external view returns (uint256) {
        Match storage m = matches[id];
        return uint256(m.amt1) + uint256(m.amt2);
    }
}
