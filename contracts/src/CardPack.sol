// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title CardPack
/// @notice Booster packs for On-Chain Virtual Arena on Robinhood Chain. Buying a pack
///         (price in native ETH) mints `cardsPerPack` random cards plus 1 foil random card
///         as ERC-721 NFTs. Each card's metadata is served from `baseURI`:
///         `<baseURI><cardIndex>.json` (foils use `<cardIndex>-foil.json`).
/// @dev Adapted from the eguajardo/nft-pack pattern. Randomness is on-chain pseudo-random
///      (block.prevrandao based) — appropriate for a low-stakes game pack; swap in Chainlink
///      VRF if/when a coordinator is available on Robinhood Chain.
contract CardPack is ERC721, Ownable, ReentrancyGuard {
    using Strings for uint256;

    uint256 public immutable cardCount; // distinct cards, indices 0..cardCount-1
    uint256 public packPrice;           // wei
    uint256 public cardsPerPack = 5;    // non-foil cards; +1 foil is always added
    uint256 public nextId;
    uint256 private nonce;
    string private _base;

    mapping(uint256 => uint256) public cardOf; // tokenId => card index
    mapping(uint256 => bool) public isFoil;    // tokenId => foil?

    event PackMinted(address indexed buyer, uint256[] tokenIds, uint256[] cardIndexes, uint256 foilTokenId);

    constructor(uint256 _cardCount, string memory baseURI_, uint256 _packPrice)
        ERC721("On-Chain Virtual Arena Card", "OCVAC")
        Ownable(msg.sender)
    {
        require(_cardCount > 0, "cardCount=0");
        cardCount = _cardCount;
        _base = baseURI_;
        packPrice = _packPrice;
    }

    function _rand(uint256 salt) internal returns (uint256) {
        nonce++;
        return uint256(keccak256(abi.encodePacked(block.prevrandao, block.timestamp, msg.sender, nonce, salt)));
    }

    /// @notice Buy a booster pack. Mints `cardsPerPack` random cards + 1 foil random card.
    function mintPack() external payable nonReentrant returns (uint256[] memory ids) {
        require(msg.value >= packPrice, "underpaid");

        uint256 total = cardsPerPack + 1;
        ids = new uint256[](total);
        uint256[] memory idxs = new uint256[](total);

        for (uint256 i = 0; i < cardsPerPack; i++) {
            uint256 id = nextId++;
            uint256 c = _rand(i) % cardCount;
            cardOf[id] = c;
            ids[i] = id;
            idxs[i] = c;
            _safeMint(msg.sender, id);
        }

        uint256 foilId = nextId++;
        uint256 fc = _rand(0xF0) % cardCount;
        cardOf[foilId] = fc;
        isFoil[foilId] = true;
        ids[cardsPerPack] = foilId;
        idxs[cardsPerPack] = fc;
        _safeMint(msg.sender, foilId);

        emit PackMinted(msg.sender, ids, idxs, foilId);
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
    function withdraw(address to) external onlyOwner nonReentrant {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
