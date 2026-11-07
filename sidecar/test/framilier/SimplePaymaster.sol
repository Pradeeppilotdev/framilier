// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEIP8141 {
    uint8 constant APPROVE_NONE = 0x00;
    uint8 constant APPROVE_PAY  = 0x01;
    uint8 constant APPROVE_EXEC = 0x02;
    uint8 constant APPROVE_ALL  = 0x03;
}

/**
 * @title SimplePaymaster
 * @notice EIP-8141 compliant gas sponsorship paymaster for shared-paymaster benchmarks.
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
     */
    function validateFrame(
        uint256 frameIndex,
        bytes calldata paymasterData
    ) external returns (uint8 approvalMode) {
        if (address(this).balance == 0) return APPROVE_NONE;
        
        if (paymasterData.length >= 20) {
            address user = address(bytes20(paymasterData[:20]));
            if (authorizedSenders[user] || authorizedSenders[address(0)]) {
                emit GasSponsored(user, tx.gasprice);
                return APPROVE_PAY;
            }
        }

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
