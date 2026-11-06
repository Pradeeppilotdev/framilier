## skandha_subscribe

Creates a new subscription for desired events over the WebSocket RPC connection. Sends data as
soon as it occurs.

The RPC method name and the three event-type strings below (`pendingUserOps`, `submittedUserOps`,
`onChainUserOps`) are unchanged from the sidecar's original ERC-4337 implementation
(`packages/executor/src/services/SubscriptionService.ts`'s `ExecutorEvent` enum) — only the
*payload* each event carries changed for this fork's EIP-8141 frame transactions: there is no more
`userOp`/`userOpHash`/`entryPoint`/`prefund` shape. Each event now carries `tx` (the full
`FrameTransaction`), `txHash` (the transaction's own hash), and the roles resolved from its
validation prefix (`sender`/`payer`/`factory?`) in place of the old `sender`/`paymaster`.

### Event Types

- `pendingUserOps` - frame transactions validated and put in the mempool
- `submittedUserOps` - frame transactions submitted on chain, reverted, or removed from the mempool
- `onChainUserOps` - frame transactions confirmed on chain

### Examples:

### Pending

```json
{
  "method": "skandha_subscribe",
  "params": [
    "pendingUserOps"
  ],
  "id": 1,
  "jsonrpc": "2.0"
}
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "0x106eb9867751ff1bf61bad4a80b8b486"
}
```


#### Event

```json
{
  "jsonrpc": "2.0",
  "method": "skandha_subscription",
  "params": {
    "subscription": "0x106eb9867751ff1bf61bad4a80b8b486",
    "result": {
      "tx": {
        "chainId": "0x9",
        "nonce": "0x5",
        "sender": "0xb582979C2136189475326c648732F76677B16B98",
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
            "target": "0x9fD4f6088F2025427AB1e89257A44747081ed59",
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
            "signature": "0x00260d...1b"
          }
        ],
        "fees": {
          "maxPriorityFeePerGas": "0x59682f00",
          "maxFeePerGas": "0x171ab3b64",
          "maxFeePerBlobGas": "0x0"
        },
        "blobVersionedHashes": []
      },
      "txHash": "0xf8a549671473d0ee532ca235b4629b239823b426b9a898d20c58ca5212a64c9e",
      "sender": "0xb582979C2136189475326c648732F76677B16B98",
      "payer": "0xb582979C2136189475326c648732F76677B16B98",
      "submittedTime": "0x18f2990121c",
      "status": "Pending"
    }
  }
}
```

---

### Submitted, Reverted, Cancelled

```json
{
  "method": "skandha_subscribe",
  "params": [
    "submittedUserOps"
  ],
  "id": 1,
  "jsonrpc": "2.0"
}
```

#### Event

```json
{
  "jsonrpc": "2.0",
  "method": "skandha_subscription",
  "params": {
    "subscription": "0x80e0632d2300aa2e1bcdb1e84329963f",
    "result": {
      "tx": { "...": "same FrameTransaction shape as above" },
      "txHash": "0xf8a549671473d0ee532ca235b4629b239823b426b9a898d20c58ca5212a64c9e",
      "transaction": "0x3612daa69ec6d4804065e107e9055c9ec25c9c801d199886524e884e98179656",
      "status": "Submitted",
      "revertReason": null
    }
  }
}
```

### Onchain

#### Request

```json
{
  "method": "skandha_subscribe",
  "params": [
    "onChainUserOps"
  ],
  "id": 1,
  "jsonrpc": "2.0"
}
```

#### Event

```json
{
  "jsonrpc": "2.0",
  "method": "skandha_subscription",
  "params": {
    "subscription": "0x2e8cf00cbe014abca180c1b6eae51173",
    "result": {
      "tx": { "...": "same FrameTransaction shape as above" },
      "txHash": "0xefafb37d346ccfaf183f0474015aacefe178707e78d56d95e19de8950c033393",
      "transaction": "0x8adba5c0463bd2cce16585871190972f49f00ead733b7005f43bf62c93296233",
      "status": "onChain"
    }
  }
}
```

### Unsubscribe

#### Request

```json
{
  "method": "skandha_unsubscribe",
  "params": [
    "0xcf47424b5f492abfaa97ca5d4aed1f1d"
  ],
  "id": 1,
  "jsonrpc": "2.0"
}
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": "ok"
}
```
