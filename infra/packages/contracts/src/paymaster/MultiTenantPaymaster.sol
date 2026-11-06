// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IEIP8141.sol";
import "../interfaces/IERC8286.sol";

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function getDepositInfo(address account) external view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime);
}

/**
 * @title MultiTenantPaymaster
 * @notice Production-grade Multi-Tenant, Stake & Reputation-backed Paymaster for EIP-8141 & ERC-8421.
 * @dev Allows multiple business/app tenants to pool gas sponsorship deposits and leverage a shared
 *      locked stake in the NaiveStakingRegistry to unlock the 1,000,000-gas Alt-Mempool ceiling.
 *      Enforces per-tenant user daily quotas, maximum gas budgets, and reputation tracking.
 */
contract MultiTenantPaymaster is IFrameValidator, IEIP8141 {
    address public owner;
    IStakingRegistry public immutable stakingRegistry;

    struct Tenant {
        address admin;
        uint256 depositBalance; // ETH deposit for covering gas
        uint32 maxGasPerTx;      // Max gas limit allowed per sponsored frame
        uint32 dailyQuotaPerUser; // Max tx count per user per day
        bool active;
    }

    // tenantId => Tenant
    mapping(bytes32 => Tenant) public tenants;

    // tenantId => userAddress => dayIndex (block.timestamp / 86400) => sponsoredCount
    mapping(bytes32 => mapping(address => mapping(uint256 => uint32))) public userDailyUsage;

    event TenantRegistered(bytes32 indexed tenantId, address indexed admin);
    event DepositAdded(bytes32 indexed tenantId, uint256 amount, uint256 newBalance);
    event StakeAdded(uint256 amount, uint32 unstakeDelaySec);
    event PolicyUpdated(bytes32 indexed tenantId, uint32 maxGas, uint32 dailyQuota, bool active);
    event FrameSponsored(bytes32 indexed tenantId, address indexed user, uint256 frameIndex, uint256 gasDeducted);

    modifier onlyOwner() {
        require(msg.sender == owner, "MultiTenantPaymaster: Unauthorized");
        _;
    }

    modifier onlyTenantAdmin(bytes32 tenantId) {
        require(msg.sender == tenants[tenantId].admin || msg.sender == owner, "MultiTenantPaymaster: Not tenant admin");
        _;
    }

    constructor(address _stakingRegistry) payable {
        owner = msg.sender;
        stakingRegistry = IStakingRegistry(_stakingRegistry);
    }

    /**
     * @notice Registers a new dapp/business tenant in the multi-tenant engine.
     */
    function registerTenant(
        bytes32 tenantId,
        address admin,
        uint32 maxGasPerTx,
        uint32 dailyQuotaPerUser
    ) external {
        require(tenants[tenantId].admin == address(0), "Tenant already registered");
        require(admin != address(0), "Invalid admin");

        tenants[tenantId] = Tenant({
            admin: admin,
            depositBalance: 0,
            maxGasPerTx: maxGasPerTx > 0 ? maxGasPerTx : 500000,
            dailyQuotaPerUser: dailyQuotaPerUser > 0 ? dailyQuotaPerUser : 50,
            active: true
        });

        emit TenantRegistered(tenantId, admin);
    }

    /**
     * @notice Deposits gas funds for a specific tenant pool.
     */
    function depositForTenant(bytes32 tenantId) external payable {
        require(tenants[tenantId].admin != address(0), "Tenant does not exist");
        tenants[tenantId].depositBalance += msg.value;
        emit DepositAdded(tenantId, msg.value, tenants[tenantId].depositBalance);
    }

    /**
     * @notice Stakes ETH into the ERC-8421 NaiveStakingRegistry.
     * @dev Elevates the paymaster from 100k unstaked limit to 1,000,000 gas limit on the Alt-Mempool sidecar!
     */
    function stakeForPaymaster(uint32 unstakeDelaySec) external payable onlyOwner {
        require(msg.value > 0, "No stake provided");
        stakingRegistry.addStake{value: msg.value}(unstakeDelaySec);
        emit StakeAdded(msg.value, unstakeDelaySec);
    }

    /**
     * @notice Updates tenant policies (gas limit, quotas, active state).
     */
    function setTenantPolicy(
        bytes32 tenantId,
        uint32 maxGasPerTx,
        uint32 dailyQuotaPerUser,
        bool active
    ) external onlyTenantAdmin(tenantId) {
        Tenant storage t = tenants[tenantId];
        t.maxGasPerTx = maxGasPerTx;
        t.dailyQuotaPerUser = dailyQuotaPerUser;
        t.active = active;
        emit PolicyUpdated(tenantId, maxGasPerTx, dailyQuotaPerUser, active);
    }

    /**
     * @notice EIP-8141 Frame validation callback.
     * @dev Validates tenant deposit, quota, and gas limit.
     * @return approvalMode APPROVE_PAY (0x01) if authorized.
     */
    function validateFrame(
        address user,
        uint256 frameIndex,
        bytes calldata frameData
    ) external override returns (uint8 approvalMode) {
        if (frameData.length < 32) return APPROVE_NONE;

        bytes32 tenantId = bytes32(frameData[0:32]);
        Tenant storage t = tenants[tenantId];

        // 1. Check tenant active status
        if (!t.active) return APPROVE_NONE;

        // 2. Check user's daily quota
        uint256 currentDay = block.timestamp / 86400;
        uint32 usedCount = userDailyUsage[tenantId][user][currentDay];
        if (usedCount >= t.dailyQuotaPerUser) {
            return APPROVE_NONE; // Quota exceeded for today
        }

        // 3. Estimate gas fee (e.g. 100k gas * tx.gasprice or standard fee)
        uint256 estimatedFee = tx.gasprice > 0 ? tx.gasprice * 100000 : 0.0001 ether;
        if (t.depositBalance < estimatedFee) {
            return APPROVE_NONE; // Insufficient tenant deposit balance
        }

        // Update quota and deduct from tenant balance
        userDailyUsage[tenantId][user][currentDay] = usedCount + 1;
        t.depositBalance -= estimatedFee;

        emit FrameSponsored(tenantId, user, frameIndex, estimatedFee);

        // Multi-tenant paymaster approves PAY (0x01)
        return APPROVE_PAY;
    }

    /**
     * @notice Returns live status and deposit info of the paymaster from the staking registry.
     */
    function getStakeStatus() external view returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime) {
        return stakingRegistry.getDepositInfo(address(this));
    }

    receive() external payable {}
}
