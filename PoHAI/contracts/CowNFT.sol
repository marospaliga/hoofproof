// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ITransferValidator} from "./interfaces/ITransferValidator.sol";

/// @title CowNFT — Proof of a Hoof cow record
///
/// Minting is deliberately permissionless: anyone may create a cow record.
/// The record is born `Inert` and carries no weight until CowRating stakers
/// activate it. Fraud is not prevented from *existing* — it is prevented from
/// *mattering*.
///
/// Nothing descriptive lives on-chain except a content identifier. Photos,
/// videos, names and discussion live off-chain (IPFS / the app database) so
/// they stay cheap and correctable; the chain holds the claim and its history.
contract CowNFT is ERC721, Ownable {
    enum Status {
        Inert, // created, no rating behind it
        Active, // rating threshold reached
        SelfSustaining, // funding need hit zero for K consecutive periods
        Memorial // real cow died — permanent, frozen record
    }

    struct Cow {
        string metadataCID; // IPFS CID of the cow's descriptive JSON
        Status status;
        uint256 herdId; // 0 = not in a herd
        uint256 mintedAt;
    }

    mapping(uint256 => Cow) public cows;
    mapping(uint256 => uint256) public herdCount;
    mapping(uint256 => uint256) public herdMintOrder; // position within the herd

    uint256 public nextTokenId = 1;

    /// Set once after deployment; this is the only address allowed to move status.
    address public ratingEngine;

    /// True only while an offline sale is being applied, so the rated-handshake
    /// validation is skipped for exactly that one transfer.
    bool private _realWorldOverride;

    event CowMinted(uint256 indexed tokenId, address indexed minter, string metadataCID);
    event MetadataUpdated(uint256 indexed tokenId, string metadataCID);
    event HerdSet(uint256 indexed tokenId, uint256 herdId);
    event StatusChanged(uint256 indexed tokenId, Status indexed status);

    error OnlyRatingEngine();
    error RatingEngineAlreadySet();
    error NotTokenOwner();
    error IsMemorial();
    error DoesNotExist();

    constructor() ERC721("Proof of a Hoof", "POHCOW") Ownable(msg.sender) {}

    // ---------------------------------------------------------------- admin

    function setRatingEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert OnlyRatingEngine();
        if (ratingEngine != address(0)) revert RatingEngineAlreadySet();
        ratingEngine = engine;
    }

    // --------------------------------------------------------------- minting

    /// @notice Permissionless. The cow starts `Inert` — no weight, no rewards.
    function mintCow(string calldata metadataCID) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        cows[tokenId] = Cow({
            metadataCID: metadataCID,
            status: Status.Inert,
            herdId: 0,
            mintedAt: block.timestamp
        });
        _safeMint(msg.sender, tokenId);
        emit CowMinted(tokenId, msg.sender, metadataCID);
        emit StatusChanged(tokenId, Status.Inert);
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

    // ------------------------------------------------------ status transitions

    function statusOf(uint256 tokenId) public view returns (Status) {
        _requireOwned(tokenId);
        return cows[tokenId].status;
    }

    function setStatus(uint256 tokenId, Status status) internal {
        cows[tokenId].status = status;
        emit StatusChanged(tokenId, status);
    }

    /// @notice Called by CowRating once staked rating crosses the threshold.
    function markActive(uint256 tokenId) external {
        if (msg.sender != ratingEngine) revert OnlyRatingEngine();
        if (cows[tokenId].status != Status.Inert) return;
        setStatus(tokenId, Status.Active);
    }

    /// @notice Called by CowRating when the funding need has stayed at zero.
    function markSelfSustaining(uint256 tokenId) external {
        if (msg.sender != ratingEngine) revert OnlyRatingEngine();
        if (cows[tokenId].status != Status.Active) return;
        setStatus(tokenId, Status.SelfSustaining);
    }

    /// @notice Called by Attestation when enough bonded raters report the death.
    /// @dev Terminal. The record is preserved forever and never revives.
    function markMemorial(uint256 tokenId) external {
        if (msg.sender != ratingEngine && msg.sender != owner()) revert OnlyRatingEngine();
        if (cows[tokenId].status == Status.Memorial) return;
        setStatus(tokenId, Status.Memorial);
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
            if (cows[tokenId].status == Status.Memorial) revert IsMemorial();
            if (!_realWorldOverride) {
                address engine = ratingEngine;
                if (engine == address(0)) revert DoesNotExist();
                ITransferValidator(engine).validateTransfer(tokenId, from, to);
            }
        }

        return super._update(to, tokenId, auth);
    }
}
