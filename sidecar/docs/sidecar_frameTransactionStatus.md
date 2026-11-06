## skandha_frameTransactionStatus

Returns the status of an EIP-8141 frame transaction by its hash. Replaces the old
`skandha_userOperationStatus` (there is no more `UserOperation`/`entryPoint` concept in this
fork's mempool — see `FrameTransactionStatus` in
`packages/executor/src/modules/interfaces.ts`).

This is a plain request/response JSON-RPC call, not a push notification — unlike
[`skandha_subscribe`](./sidecar_subscribe.md), a client polls this method itself; it does not
arrive wrapped in a `skandha_subscription` envelope.

`status` is one of `New`, `Pending`, `Submitted`, `OnChain`, `Finalized`, `Cancelled`, `Reverted`
(`MempoolEntryStatus` in `packages/types/src/executor/entities/MempoolEntry.ts`). If the hash is
unknown to this node's mempool, the call returns a JSON-RPC error (`"Frame transaction not
found"`) rather than a `null` result.

### Example

#### Request

```json
{
  "id": 3,
  "method": "skandha_frameTransactionStatus",
  "params": [
    "0x63e222d108878e7f7440036bce49aeb83007708f067ec8d01153961e97fe1c53"
  ],
  "jsonrpc": "2.0"
}
```

#### Response (pending)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "tx": {
      "chainId": "0x9",
      "nonce": "0x2",
      "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
      "frames": [
        {
          "mode": 1,
          "flags": 3,
          "target": null,
          "limits": { "execution": "0x7530", "state": "0x0" },
          "value": "0x0",
          "data": "0x"
        },
        {
          "mode": 2,
          "flags": 0,
          "target": "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
          "limits": { "execution": "0xc350", "state": "0x0" },
          "value": "0x1",
          "data": "0x"
        }
      ],
      "signatures": [
        {
          "scheme": 1,
          "signer": "0x",
          "msg": "0x",
          "signature": "0x00b3f1...1c"
        }
      ],
      "fees": {
        "maxPriorityFeePerGas": "0x3b9aca00",
        "maxFeePerGas": "0x28030e335c",
        "maxFeePerBlobGas": "0x0"
      },
      "blobVersionedHashes": []
    },
    "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
    "payer": "0x310788f30062415E1c6f154dB377bf3F39200178",
    "status": "Pending"
  }
}
```

`frames[0]` here is a self-relay `VERIFY` frame (`mode: 1`) with
`APPROVE_SCOPE.EXECUTION_AND_PAYMENT` (`flags: 3`) and a `null` target (implicitly `tx.sender`);
`frames[1]` is a `SENDER`-mode (`mode: 2`) body frame doing a plain value transfer. See
`packages/types/src/contracts/FrameTx.ts` for the full `FRAME_MODE`/`APPROVE_SCOPE`/`SIG_SCHEME`
enums.

#### Response (after submission on chain)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "tx": { "...": "same shape as above" },
    "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
    "payer": "0x310788f30062415E1c6f154dB377bf3F39200178",
    "status": "OnChain",
    "transaction": "0xf27d85b4e29a33a66eb91d692938cb94a2c35bd1db736e659afa660ad6d40997"
  }
}
```

`factory` is present only when the transaction's validation prefix carries a `deploy`-role frame
(there is no `factory` field at all otherwise). `reason` is present only for a `Reverted` entry.
