// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ITransferValidator} from "./interfaces/ITransferValidator.sol";

/// @title CowNFT — Proof of a Hoof cow record
///
/// Minting is deliberately permissionless: anyone may create a cow record.
/// A record carries two independent facts, set only by executed attestations:
///
///   verified — proof of hoof. The first executed Care, Revenue, Sale or Death
///              claim proves a real animal stands behind the record. A project
///              (a cow that exists only as an idea) never earns this.
///   deceased — the real animal has died. It changes nothing about the record:
///              votes, stakes, transfers and content continue. It only ends
///              new care and funding claims and marks the record as a memorial.
///
/// There is no status ladder and no activation threshold. A cow is live the
/// moment it is minted; what it earns is rating, not a rank.
///
/// Nothing descriptive lives on-chain except a content identifier. Photos,
/// videos, names and discussion live off-chain (IPFS / the app database) so
/// they stay cheap and correctable; the chain holds the claim and its history.
contract CowNFT is ERC721, Ownable {
    struct Cow {
        string metadataCID; // IPFS CID of the cow's descriptive JSON
        bool verified; // proof of hoof: a real animal backs this record
        bool deceased; // the real animal has died
        uint256 herdId; // 0 = not in a herd
        uint256 mintedAt;
    }

    mapping(uint256 => Cow) public cows;
    mapping(uint256 => uint256) public herdCount;
    mapping(uint256 => uint256) public herdMintOrder; // position within the herd

    uint256 public nextTokenId = 1;

    /// Set once after deployment; this is the only address allowed to move facts.
    address public ratingEngine;

    /// True only while an offline sale is being applied, so the rated-handshake
    /// validation is skipped for exactly that one transfer.
    bool private _realWorldOverride;

    event CowMinted(uint256 indexed tokenId, address indexed minter, string metadataCID);
    event MetadataUpdated(uint256 indexed tokenId, string metadataCID);
    event HerdSet(uint256 indexed tokenId, uint256 herdId);
    event Verified(uint256 indexed tokenId);
    event Deceased(uint256 indexed tokenId);

    error OnlyRatingEngine();
    error RatingEngineAlreadySet();
    error NotTokenOwner();
    error DoesNotExist();

    constructor() ERC721("Proof of a Hoof", "POHCOW") Ownable(msg.sender) {}

    // ---------------------------------------------------------------- admin

    function setRatingEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert OnlyRatingEngine();
        if (ratingEngine != address(0)) revert RatingEngineAlreadySet();
        ratingEngine = engine;
    }

    // --------------------------------------------------------------- minting

    /// @notice Permissionless. The cow is live at once: no weights, no ranks.
    function mintCow(string calldata metadataCID) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        cows[tokenId] = Cow({
            metadataCID: metadataCID,
            verified: false,
            deceased: false,
            herdId: 0,
            mintedAt: block.timestamp
        });
        _safeMint(msg.sender, tokenId);
        emit CowMinted(tokenId, msg.sender, metadataCID);
    }

    // ------------------------------------------------------------- metadata

    /// @notice Unlike a plain ERC-721 string field, this stays correctable:
    ///         the owner may update the CID as evidence is refined.
    function setMetadataCID(uint256 tokenId, string calldata metadataCID) external {
        _requireOwned(tokenId);
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        cows[tokenId].metadataCID = metadataCID;
        emit MetadataUpdated(tokenId, metadataCID);
    }

    /// @notice Place the cow into a herd. Herds share upkeep and grant a rating bonus.
    function setHerd(uint256 tokenId, uint256 herdId) external {
        _requireOwned(tokenId);
        address owner_ = ownerOf(tokenId);
        if (msg.sender != owner_ && msg.sender != owner() && msg.sender != ratingEngine) {
            revert NotTokenOwner();
        }
        Cow storage cow = cows[tokenId];
        uint256 previous = cow.herdId;
        if (previous == herdId) return;

        if (previous != 0) {
            herdCount[previous] -= 1;
        }
        cow.herdId = herdId;
        if (herdId != 0) {
            herdMintOrder[tokenId] = herdCount[herdId];
            herdCount[herdId] += 1;
        }
        emit HerdSet(tokenId, herdId);
    }

    // ---------------------------------------------------------- real-world facts

    function isVerified(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        return cows[tokenId].verified;
    }

    function isDeceased(uint256 tokenId) public view returns (bool) {
        _requireOwned(tokenId);
        return cows[tokenId].deceased;
    }

    /// @notice Called by CowRating when the first executed Care, Revenue, Sale
    ///         or Death claim proves a real animal behind the record.
    function markVerified(uint256 tokenId) external {
        if (msg.sender != ratingEngine) revert OnlyRatingEngine();
        _requireOwned(tokenId);
        Cow storage cow = cows[tokenId];
        if (cow.verified) return;
        cow.verified = true;
        emit Verified(tokenId);
    }

    /// @notice Called by Attestation when enough bonded raters report the death.
    /// @dev Death is a fact, not a lock: the record stays fully tradable and
    ///      votable. It only stops new care and funding claims.
    function markDeceased(uint256 tokenId) external {
        if (msg.sender != ratingEngine && msg.sender != owner()) revert OnlyRatingEngine();
        _requireOwned(tokenId);
        Cow storage cow = cows[tokenId];
        if (cow.deceased) return;
        cow.deceased = true;
        if (!cow.verified) {
            cow.verified = true;
            emit Verified(tokenId);
        }
        emit Deceased(tokenId);
    }

    /// @notice The offline override: when the real cow is sold in the real
    ///         world, an executed Sale attestation moves the NFT to match
    ///         reality without charging the rated-handshake cost.
    function realWorldTransfer(uint256 tokenId, address to) external returns (address) {
        if (msg.sender != ratingEngine) revert OnlyRatingEngine();
        address from = ownerOf(tokenId);
        _realWorldOverride = true;
        _transfer(from, to, tokenId);
        _realWorldOverride = false;
        return to;
    }

    // ------------------------------------------------------------- transfer

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // Mint (from == 0) and burn (to == 0) bypass validation.
        if (from != address(0) && to != address(0)) {
            if (!_realWorldOverride) {
                address engine = ratingEngine;
                if (engine == address(0)) revert DoesNotExist();
                ITransferValidator(engine).validateTransfer(tokenId, from, to);
            }
        }

        return super._update(to, tokenId, auth);
    }
}
