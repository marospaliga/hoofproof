// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Implemented by CowRating. CowNFT calls this on every non-mint transfer.
/// @dev Not a `view` on purpose: validation spends the buyer's Stasis ("liquid to steam").
interface ITransferValidator {
    /// @notice Reverts if the transfer is not allowed; otherwise burns the rating cost.
    /// @param tokenId the cow being transferred
    /// @param from current owner
    /// @param to new owner
    function validateTransfer(uint256 tokenId, address from, address to) external;
}
