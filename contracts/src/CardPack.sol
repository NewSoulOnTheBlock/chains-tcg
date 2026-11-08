// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title CardPack
/// @notice Booster packs for On-Chain Virtual Arena on Robinhood Chain. A pack is bought in
///         two steps — `commitPack()` (pays, reserves the tokens) then `revealPack()` (mints
///         `cardsPerPack` cards + 1 foil once a future block is known). Each card's metadata is
///         served from `baseURI`: `<baseURI><cardIndex>.json` (foils use `<cardIndex>-foil.json`).
/// @dev Randomness fixes (audit H-8 + Orbit note):
///      - contracts-01: the single-tx `mintPack()` wrote the pull result and then called
///        `onERC721Received`, letting a contract buyer read the result and revert bad packs for
///        free, re-rolling until a chase card appeared. Pack contents are now derived from a
///        FUTURE block's hash in a separate `revealPack` tx. The seed is fixed the moment the
///        commit lands, so a reverting receiver can retry reveal but always gets the identical
///        cards — the free re-roll is gone.
///      - contracts-02: `block.prevrandao` is a constant on Arbitrum-Orbit chains, so it is no
///        longer the sole entropy. Randomness mixes `blockhash(commitBlock+1)` (unknown to the
///        buyer at commit time) with an operator-maintained `operatorSeed` beacon. Swap in a
///        Chainlink VRF reveal if/when a coordinator exists on Robinhood Chain — `revealPack`
///        is the single hook that would consume it.
///      Economic fixes:
///      - contracts-09: overpayment is refunded, an optional `maxSupply` enforces scarcity
///        on-chain, and `withdraw` rejects the zero address and can never touch funds still
///        owed back to open (un-revealed) commits.
///      - contracts-08: Ownable2Step; `renounceOwnership` disabled so sale ETH / admin cannot
///        be stranded by a stray renounce.
contract CardPack is ERC721, Ownable2Step, ReentrancyGuard {
    using Strings for uint256;

    uint256 public immutable cardCount; // distinct cards, indices 0..cardCount-1
    uint256 public packPrice;           // wei
    uint256 public cardsPerPack = 5;    // non-foil cards; +1 foil is always added
    uint256 public maxSupply;           // hard cap on total tokens ever minted (0 = uncapped)
    uint256 public nextId;              // == total tokens minted so far
    uint256 public reservedTokens;      // tokens reserved by open (un-revealed) commits
    uint256 public reservedFunds;       // wei owed back to open commits (not yet revenue)

    /// @notice Optional operator beacon mixed into reveal randomness. The operator rotates it
    ///         periodically; it removes sole sequencer control of the blockhash entropy.
    address public operator;
    bytes32 public operatorSeed;

    /// @dev Number of blocks after the commit block whose hash seeds the reveal.
    uint256 public constant REVEAL_DELAY = 1;
    /// @dev blockhash() only exposes the most recent 256 blocks; past that a commit must refund.
    uint256 public constant REVEAL_WINDOW = 256;

    string private _base;

    struct Commit {
        address buyer;
        uint64  commitBlock;
        uint32  count;    // cards to mint (cardsPerPack + 1 snapshotted at commit)
        bool    settled;  // revealed or refunded
        uint256 paid;     // wei held for this commit
    }

    uint256 public nextCommitId;
    mapping(uint256 => Commit) public commits;

    mapping(uint256 => uint256) public cardOf; // tokenId => card index
    mapping(uint256 => bool) public isFoil;    // tokenId => foil?

    event PackCommitted(uint256 indexed commitId, address indexed buyer, uint256 revealBlock, uint256 count);
    event PackRevealed(uint256 indexed commitId, address indexed buyer, uint256[] tokenIds, uint256[] cardIndexes, uint256 foilTokenId);
    event CommitRefunded(uint256 indexed commitId, address indexed buyer, uint256 amount);
    event OperatorSet(address indexed operator);
    event OperatorSeedSet(bytes32 seed);

    constructor(uint256 _cardCount, string memory baseURI_, uint256 _packPrice, uint256 _maxSupply)
        ERC721("On-Chain Virtual Arena Card", "OCVAC")
        Ownable(msg.sender)
    {
        require(_cardCount > 0, "cardCount=0");
        cardCount = _cardCount;
        _base = baseURI_;
        packPrice = _packPrice;
        maxSupply = _maxSupply; // 0 = uncapped
    }

    // ── Buy: commit then reveal ──────────────────────────────────────────────

    /// @notice Step 1: pay for a pack and reserve its tokens. Overpayment is refunded.
    ///         Cards are not chosen here, so nothing is readable/revertible by a receiver.
    function commitPack() external payable nonReentrant returns (uint256 commitId) {
        require(msg.value >= packPrice, "underpaid");

        uint256 count = cardsPerPack + 1;
        if (maxSupply != 0) {
            require(nextId + reservedTokens + count <= maxSupply, "supply cap");
        }

        commitId = nextCommitId++;
        commits[commitId] = Commit({
            buyer: msg.sender,
            commitBlock: uint64(block.number),
            count: uint32(count),
            settled: false,
            paid: packPrice
        });
        reservedTokens += count;
        reservedFunds += packPrice;

        emit PackCommitted(commitId, msg.sender, block.number + REVEAL_DELAY, count);

        // Refund any overpayment (effects already written; nonReentrant guards the call).
        uint256 excess = msg.value - packPrice;
        if (excess > 0) {
            (bool ok, ) = msg.sender.call{value: excess}("");
            require(ok, "refund failed");
        }
    }

    /// @notice Step 2: once the reveal block is mined, mint the pack. Seed is derived from the
    ///         reveal block's hash (fixed, so no re-roll) plus the operator beacon.
    function revealPack(uint256 commitId) external nonReentrant returns (uint256[] memory ids) {
        Commit storage c = commits[commitId];
        require(c.buyer != address(0), "no commit");
        require(!c.settled, "settled");
        require(msg.sender == c.buyer, "not buyer");

        uint256 revealBlock = uint256(c.commitBlock) + REVEAL_DELAY;
        require(block.number > revealBlock, "too early");
        require(block.number <= revealBlock + REVEAL_WINDOW, "reveal expired");

        bytes32 bh = blockhash(revealBlock);
        require(bh != 0, "reveal expired");

        // Effects first (CEI): mark settled and release reservations.
        c.settled = true;
        uint256 count = c.count;
        reservedTokens -= count;
        reservedFunds -= c.paid; // paid becomes withdrawable revenue

        bytes32 seed = keccak256(abi.encodePacked(bh, operatorSeed, commitId, c.buyer, address(this)));

        ids = new uint256[](count);
        uint256[] memory idxs = new uint256[](count);
        uint256 foilId;
        for (uint256 i = 0; i < count; i++) {
            uint256 id = nextId++;
            uint256 cardIdx = uint256(keccak256(abi.encodePacked(seed, i))) % cardCount;
            cardOf[id] = cardIdx;
            ids[i] = id;
            idxs[i] = cardIdx;
            bool foil = (i == count - 1); // last token is the foil
            if (foil) { isFoil[id] = true; foilId = id; }
            _safeMint(c.buyer, id);
        }

        emit PackRevealed(commitId, c.buyer, ids, idxs, foilId);
    }

    /// @notice Refund a commit whose reveal window lapsed (reveal block hash no longer
    ///         available). Guarantees no payment is ever locked.
    function refundExpired(uint256 commitId) external nonReentrant {
        Commit storage c = commits[commitId];
        require(c.buyer != address(0), "no commit");
        require(!c.settled, "settled");
        uint256 revealBlock = uint256(c.commitBlock) + REVEAL_DELAY;
        require(block.number > revealBlock + REVEAL_WINDOW, "not expired");

        c.settled = true;
        reservedTokens -= c.count;
        uint256 amount = c.paid;
        reservedFunds -= amount;

        (bool ok, ) = c.buyer.call{value: amount}("");
        require(ok, "refund failed");
        emit CommitRefunded(commitId, c.buyer, amount);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory idx = cardOf[tokenId].toString();
        return isFoil[tokenId]
            ? string(abi.encodePacked(_base, idx, "-foil.json"))
            : string(abi.encodePacked(_base, idx, ".json"));
    }

    // ── Admin ──────────────────────────────────────────────────────────────
    function setPackPrice(uint256 p) external onlyOwner { packPrice = p; }
    function setBaseURI(string calldata b) external onlyOwner { _base = b; }
    function setCardsPerPack(uint256 n) external onlyOwner { require(n > 0 && n <= 20, "bad"); cardsPerPack = n; }

    /// @notice Set/raise/lower the hard supply cap. Must be >= tokens already minted or reserved.
    function setMaxSupply(uint256 n) external onlyOwner {
        require(n == 0 || n >= nextId + reservedTokens, "below minted");
        maxSupply = n;
    }

    function setOperator(address o) external onlyOwner {
        operator = o;
        emit OperatorSet(o);
    }

    /// @notice Operator rotates the randomness beacon mixed into future reveals.
    function setOperatorSeed(bytes32 s) external {
        require(msg.sender == operator || msg.sender == owner(), "not operator");
        operatorSeed = s;
        emit OperatorSeedSet(s);
    }

    /// @notice Disabled: a stray renounce would strand sale ETH and admin controls.
    function renounceOwnership() public view override onlyOwner {
        revert("renounce disabled");
    }

    /// @notice Withdraw sale revenue. Never touches funds still owed to open commits, and
    ///         rejects the zero address (contracts-09).
    function withdraw(address to) external onlyOwner nonReentrant {
        require(to != address(0), "to=0");
        uint256 bal = address(this).balance;
        require(bal > reservedFunds, "nothing to withdraw");
        uint256 amount = bal - reservedFunds;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
    }
}
