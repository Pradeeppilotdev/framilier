// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HashChainWallet} from "./HashChainWallet.sol";
import {Scope} from "@forshtat/hegota-support/contracts/Params.sol";

/// Setup uses a self-paid frame. Measured frames authorize execution and let the
/// shared paymaster authorize payment. The owner signs the scope in both cases.
contract SponsoredHashChainWallet is HashChainWallet {
    constructor(address owner_, bytes32 commitment_, uint256 rounds_)
        payable HashChainWallet(owner_, commitment_, rounds_) {}

    // The signed trailing byte requests sponsorship. A witness, when present,
    // always occupies the first 32 bytes, exactly as in the self-paid fixture.
    function witnessLength() internal pure override returns (uint256) {
        return msg.data.length & ~uint256(1);
    }

    function approvalScope() internal pure override returns (Scope) {
        if ((msg.data.length & 1) == 0) return Scope.EXECUTION_AND_PAYMENT;
        require(msg.data[msg.data.length - 1] == 0x01, "invalid sponsor marker");
        return Scope.EXECUTION;
    }
}
