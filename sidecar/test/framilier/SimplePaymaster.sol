// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

import {NaiveStakingRegistry} from "./NaiveStakingRegistry.sol";

/// Gas sponsor for exactly two wallets on the disposable benchmark chain.
contract SimplePaymaster is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address private immutable walletA;
    address private immutable walletB;

    constructor(
        address first,
        address second,
        NaiveStakingRegistry registry,
        uint256 stakeAmount,
        uint32 unstakeDelaySec
    ) payable {
        require(first != address(0) && second != address(0) && first != second, "distinct senders");
        walletA = first;
        walletB = second;
        require(stakeAmount > 0 && msg.value > stakeAmount, "fund stake and fees");
        registry.addStake{value: stakeAmount}(unstakeDelaySec);
    }

    fallback() external payable {
        address sender = address(uint160(txparam(TxParam.SENDER)));
        require(sender == walletA || sender == walletB, "unsponsored sender");
        approve(Scope.PAYMENT);
    }
}
