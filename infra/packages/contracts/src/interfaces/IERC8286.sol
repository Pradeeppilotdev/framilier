// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC8286
 * @notice Modular Accounts for EIP-8141 Frame Transactions (extending ERC-7579)
 * @author Chiranjeev Mishra, Pedro Gomes, Alex Forshtat
 */
interface IERC8286 {
    /**
     * @notice Validates a frame in VERIFY mode.
     * @param frameIndex The index of the frame being validated
     * @param frameData Data passed for validation (e.g. signature, ZK proof, or context)
     * @return approvalMode uint8 bitmask (0x00=Reject, 0x01=Pay, 0x02=Exec, 0x03=All)
     */
    function validateFrame(
        uint256 frameIndex,
        bytes calldata frameData
    ) external returns (uint8 approvalMode);
}

/**
 * @title IFrameValidator
 * @notice Interface for modular frame validator plugins
 */
interface IFrameValidator {
    function validateFrame(
        address account,
        uint256 frameIndex,
        bytes calldata frameData
    ) external returns (uint8 approvalMode);
}
