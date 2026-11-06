// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HegotaSupport} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Scope, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// Private-devnet fixture. Every transaction requires the owner's signature.
/// An empty validation frame authorizes the setup transaction. A 32-byte frame
/// also has to prove knowledge of a preimage for the committed hash chain.
contract HashChainWallet is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;
    bytes32 public immutable commitment;
    uint256 public immutable rounds;

    constructor(address owner_, bytes32 commitment_, uint256 rounds_) payable {
        require(rounds_ > 0 && rounds_ <= 10_000, "fixture round limit");
        owner = owner_;
        commitment = commitment_;
        rounds = rounds_;
    }

    fallback() external payable {
        require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "owner signature");
        if (msg.data.length != 0) {
            require(msg.data.length == 32, "one witness required");
            bytes32 digest;
            uint256 iterations = rounds;
            assembly ("memory-safe") {
                digest := calldataload(0)
                for { let i := 0 } lt(i, iterations) { i := add(i, 1) } {
                    mstore(0, digest)
                    digest := keccak256(0, 32)
                }
            }
            require(digest == commitment, "wrong witness");
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
