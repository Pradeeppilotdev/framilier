// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Approval scope return values from VERIFY frames
uint8 constant APPROVE_NONE = 0x00; // Reject / No permissions
uint8 constant APPROVE_PAY  = 0x01; // Approve gas fee payment
uint8 constant APPROVE_EXEC = 0x02; // Approve execution on behalf of account
uint8 constant APPROVE_ALL  = 0x03; // Approve both payment AND execution (Self-paid)

/// @dev Frame execution modes
enum FrameMode {
    DEFAULT, // 0: Normal EVM execution
    VERIFY,  // 1: Staticcall validation / authorization
    SENDER   // 2: Authenticated call executed as the tx.sender
}

struct Frame {
    uint8 mode;
    address target;
    uint256 gasLimit;
    uint256 value;
    bytes data;
}

interface IEIP8141 {
    // Protocol marker interface
}
