// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IEIP8141.sol";

/**
 * @title SimplePaymaster
 * @notice EIP-8141 compliant gas sponsorship paymaster.
 * @dev Returns APPROVE_PAY (0x01) during its VERIFY frame.
 */
contract SimplePaymaster is IEIP8141 {
    address public owner;
    mapping(address => bool) public authorizedSenders;
    mapping(address => uint256) public sponsoredGasLimit;

    event GasSponsored(address indexed sender, uint256 maxCost);
    event FundsDeposited(address indexed sender, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "SimplePaymaster: Unauthorized");
        _;
    }

    constructor() payable {
        owner = msg.sender;
    }

    /**
     * @notice Called during VERIFY mode (Frame 0 in a sponsored transaction).
     * @param frameIndex Frame index
     * @param paymasterData Encoded sponsor authorization or tenant signature
     * @return approvalMode APPROVE_PAY (0x01) if sponsorship is granted
     */
    function validateFrame(
        uint256 frameIndex,
        bytes calldata paymasterData
    ) external returns (uint8 approvalMode) {
        if (address(this).balance == 0) return APPROVE_NONE;
        
        // Check if caller or target is approved
        if (paymasterData.length >= 20) {
            address user = address(bytes20(paymasterData[:20]));
            if (authorizedSenders[user] || authorizedSenders[address(0)]) {
                emit GasSponsored(user, tx.gasprice);
                return APPROVE_PAY;
            }
        }

        // Default open sponsorship if wildcard address(0) is authorized
        if (authorizedSenders[address(0)]) {
            return APPROVE_PAY;
        }

        return APPROVE_NONE;
    }

    function setAuthorizedSender(address sender, bool authorized) external onlyOwner {
        authorizedSenders[sender] = authorized;
    }

    function deposit() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }

    function withdraw(address payable recipient, uint256 amount) external onlyOwner {
        require(amount <= address(this).balance, "Insufficient balance");
        (bool ok, ) = recipient.call{value: amount}("");
        require(ok, "Withdraw failed");
    }

    receive() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }
}
