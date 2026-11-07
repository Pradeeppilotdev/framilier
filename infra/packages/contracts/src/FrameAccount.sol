// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IEIP8141.sol";
import "./interfaces/IERC8286.sol";

/**
 * @title FrameAccount
 * @notice Modular Smart Account for EIP-8141 Frame Transactions (ERC-8286 compliant)
 * @dev Supports self-paid & sponsored frame transactions, pluggable ZK validators,
 *      and anti-leak Timelocked Social Recovery with active owner veto.
 */
contract FrameAccount is IERC8286, IEIP8141 {
    address public owner;
    address public activeValidator;

    // Timelocked recovery state to prevent immediate takeover if guardian keys leak
    struct PendingRecovery {
        address proposedOwner;
        bytes32 proposedCommitment;
        uint64 executeAfter;
        bool active;
    }

    PendingRecovery public pendingRecovery;
    uint32 public recoveryTimelockDelay = 86400; // 24 hours default timelock (can be configured)

    event OwnerRotated(address indexed previousOwner, address indexed newOwner);
    event ValidatorUpdated(address indexed previousValidator, address indexed newValidator);
    event Executed(address indexed target, uint256 value, bytes data);
    event RecoveryProposed(address indexed proposedOwner, bytes32 proposedCommitment, uint64 executeAfter);
    event RecoveryCancelled(address indexed cancelledBy);
    event RecoveryCompleted(address indexed newOwner, bytes32 newCommitment);

    modifier onlyOwnerOrSelf() {
        require(msg.sender == owner || msg.sender == address(this), "FrameAccount: Unauthorized");
        _;
    }

    modifier onlyValidator() {
        require(msg.sender == activeValidator, "FrameAccount: Only active validator");
        _;
    }

    constructor(address _owner, address _initialValidator) {
        owner = _owner;
        activeValidator = _initialValidator;
    }

    /**
     * @notice ERC-8286 entry point invoked by EIP-8141 protocol during VERIFY mode.
     */
    function validateFrame(
        uint256 frameIndex,
        bytes calldata frameData
    ) external override returns (uint8 approvalMode) {
        if (activeValidator != address(0)) {
            return IFrameValidator(activeValidator).validateFrame(address(this), frameIndex, frameData);
        }

        // Fallback default: ECDSA signature check against owner
        if (frameData.length < 65) return APPROVE_NONE;
        
        bool isSelfPaid = uint8(frameData[0]) == 1;
        bytes memory sig = frameData[1:];
        
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), block.chainid, frameIndex));
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        
        (bytes32 r, bytes32 s, uint8 v) = splitSignature(sig);
        address recovered = ecrecover(ethSignedHash, v, r, s);
        
        if (recovered == owner) {
            return isSelfPaid ? APPROVE_ALL : APPROVE_EXEC;
        }

        return APPROVE_NONE;
    }

    /**
     * @notice Executes an action on a target contract.
     * @dev Called during SENDER mode where msg.sender == address(this).
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyOwnerOrSelf returns (bytes memory result) {
        bool success;
        (success, result) = target.call{value: value}(data);
        require(success, "FrameAccount: Execution failed");
        emit Executed(target, value, data);
    }

    /**
     * @notice Proposes an account recovery via the authorized ZKRecoveryValidator.
     * @dev Starts the timelock delay to protect against leaked guardian secrets.
     */
    function initiateRecovery(
        address newOwner,
        bytes32 newCommitment,
        bool instant
    ) external onlyValidator {
        require(newOwner != address(0), "FrameAccount: Invalid owner");
        
        if (instant || recoveryTimelockDelay == 0) {
            // Immediate rotation if zero delay configured or full threshold authorized
            _applyRecovery(newOwner, newCommitment);
        } else {
            uint64 unlockTime = uint64(block.timestamp) + recoveryTimelockDelay;
            pendingRecovery = PendingRecovery({
                proposedOwner: newOwner,
                proposedCommitment: newCommitment,
                executeAfter: unlockTime,
                active: true
            });
            emit RecoveryProposed(newOwner, newCommitment, unlockTime);
        }
    }

    /**
     * @notice Allows the active legitimate owner to veto/cancel any malicious or unauthorized recovery!
     */
    function cancelRecovery() external onlyOwnerOrSelf {
        require(pendingRecovery.active, "FrameAccount: No active recovery");
        pendingRecovery.active = false;
        emit RecoveryCancelled(msg.sender);
    }

    /**
     * @notice Finalizes the recovery after the timelock window has elapsed.
     */
    function completeRecovery() external {
        require(pendingRecovery.active, "FrameAccount: No active recovery");
        require(block.timestamp >= pendingRecovery.executeAfter, "FrameAccount: Timelock not elapsed");
        
        address newOwner = pendingRecovery.proposedOwner;
        bytes32 newCommitment = pendingRecovery.proposedCommitment;
        pendingRecovery.active = false;
        
        _applyRecovery(newOwner, newCommitment);
    }

    function _applyRecovery(address newOwner, bytes32 newCommitment) internal {
        emit OwnerRotated(owner, newOwner);
        owner = newOwner;
        emit RecoveryCompleted(newOwner, newCommitment);
    }

    function setRecoveryDelay(uint32 newDelay) external onlyOwnerOrSelf {
        recoveryTimelockDelay = newDelay;
    }

    function setOwner(address newOwner) external onlyOwnerOrSelf {
        require(newOwner != address(0), "FrameAccount: Invalid owner");
        emit OwnerRotated(owner, newOwner);
        owner = newOwner;
    }

    function setActiveValidator(address newValidator) external onlyOwnerOrSelf {
        emit ValidatorUpdated(activeValidator, newValidator);
        activeValidator = newValidator;
    }

    function splitSignature(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    receive() external payable {}
}
