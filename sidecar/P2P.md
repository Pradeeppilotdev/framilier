# How to test p2p

This walks through a real two-node gossip round trip for EIP-8141 frame transactions: a bootnode
and a regular node, both real `skandha node` processes, peered over real libp2p, against a real
[ethrex](https://github.com/lambdaclass/ethrex) execution client in dev mode. A frame transaction
submitted to the bootnode's RPC should show up, moments later, in the regular node's own mempool.

This doc is kept in sync with `test/e2e/frameTx.e2e.test.ts` and `test/e2e/ethrex-devnet.sh`,
which script this exact scenario (including signing) and tear it down automatically — if you'd
rather not do it by hand, that's the fast path:

```sh
./test/e2e/ethrex-devnet.sh build   # once; compiles ethrex in Docker, slow
bun run build
bun run test:e2e
```

Everything below is that same scenario, done by hand.

## Wire format version

Nodes must run the same frame-transaction wire format to share a mempool. Adding EIP-8250 keyed
nonces (`nonce_keys`, `nonce_seq`) and EIP-8272 `recent_root_references` changed the SSZ
`FrameTransaction`, so both protocols that carry it were versioned:

| Protocol | Before | Now |
| --- | --- | --- |
| Gossip topic | `/account_abstraction/<mempool>/frame_transaction/ssz_snappy` | `…/frame_transaction_v2/ssz_snappy` |
| Req/resp `pooled_frame_txs_by_hash` | version 1 | version 2 |

Old and new nodes therefore simply do not exchange frame transactions (different topic, failed
protocol negotiation), instead of failing to decode and downscoring each other. Upgrade every
node of a network together. `pooled_frame_tx_hashes`, `status`, `ping`, `metadata` and `goodbye`
are unchanged.

## 1. Build ethrex

ethrex is currently the only execution client implementing EIP-8141 frame-transaction semantics
(geth has none of it) — specifically the `ethrex_simulateFrameTransaction` RPC that this bundler's
`FrameTxValidationService`/`FrameTxSimulationService` call on every `eth_sendFrameTransaction`.
`ethrex-devnet.sh` expects a local checkout of ethrex's `eip8141-tracer` branch (default
`$ETHREX_REPO`, see the top of the script — override it to point at your own checkout). ethrex
doesn't build natively on macOS (its `sha3-asm`/`keccak-asm` dependencies emit assembly the Mach-O
assembler rejects), so the script builds and runs it inside a Linux Docker container:

```sh
ETHREX_REPO=/path/to/your/ethrex/checkout ./test/e2e/ethrex-devnet.sh build   # slow, once
```

## 2. Start the devnet

```sh
./test/e2e/ethrex-devnet.sh up
```

This runs ethrex against `fixtures/genesis/l1-hegota.json` (chain id `9`, EIP-8141/Hegota active
from genesis, a handful of pre-funded accounts) on `http://127.0.0.1:8555`, with
`--http.api eth,net,web3,ethrex,debug` — the `ethrex` namespace is not in ethrex's default
`eth,net,web3` set, and without it every `eth_sendFrameTransaction` fails with "Method not found".
Confirm it's answering:

```sh
curl -s -X POST http://127.0.0.1:8555 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x9"}
```

(`./test/e2e/ethrex-devnet.sh down` stops and removes the container when you're done.)

## 3. Configure and run the bootnode

Create a data directory for each node — this doubles as where each node's config file and
persisted ENR will live:

```sh
mkdir -p nodeA nodeB
```

Each node needs its own config pointing `entryPoints`/`canonicalEntryPoint`/
`supportedMempools[].entryPoint` at the fixed EIP-8141 `ENTRY_POINT` sentinel — **not** a deployed
ERC-4337 EntryPoint contract address. `config.json.default`'s addresses are stale ERC-4337
placeholders; using them here makes `Eth.sendFrameTransaction`'s publish gate silently skip
gossip. Write `nodeA/config.json`:

```json
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa",
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    {
      "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa"
    }
  ],
  "relayers": ["0x941e103320615d394a55708be13e45994c7d93b932b064dbcb2b511fe3254e2e"],
  "rpcEndpoint": "http://127.0.0.1:8555",
  "rpcEndpointSubmit": "http://127.0.0.1:8555"
}
```

(`relayers` above is ethrex's first `fixtures/keys/private_keys_l1.txt` rich account, funded from
genesis on the `l1-hegota.json` network — swap in your own key.)

Run the bootnode:

```sh
bun --bun packages/cli/bin/skandha.js node \
  --configFile ./nodeA/config.json --dataDir ./nodeA \
  --api.address 127.0.0.1 --api.port 14337 --api.wsPort 14337 \
  --p2p.host 127.0.0.1 --p2p.enrHost 127.0.0.1 --p2p.port 4337 --p2p.enrPort 4337 \
  --p2p.retainPeerId \
  --executor.bundlingMode manual
```

Two things easy to get wrong here:

- **`--api.wsPort` defaults to `14337` and does not follow `--api.port`.** Set it explicitly (equal
  to `--api.port` is fine, and shares one HTTP+WS listener) — otherwise a second node on the same
  machine tries to bind the first node's WebSocket port and dies with "Is port 14337 in use?".
- **`--p2p.retainPeerId` persists the node's ENR** to `./nodeA/enr`. That file is how the next node
  learns how to dial this one, without scraping log output.

## 4. Grab the bootnode's ENR

```sh
cat ./nodeA/enr
```

## 5. Run the second node

Write `nodeB/config.json` (the `nodeB` directory already exists from step 3's `mkdir -p nodeA
nodeB`) — same shape as step 3's config, own `rpcEndpoint`/relayer key if you like — then run the
node, own `dataDir`/ports, dialing the ENR from step 4 via `--p2p.bootEnrs`:

```sh
bun --bun packages/cli/bin/skandha.js node \
  --configFile ./nodeB/config.json --dataDir ./nodeB \
  --api.address 127.0.0.1 --api.port 14338 --api.wsPort 14338 \
  --p2p.host 127.0.0.1 --p2p.enrHost 127.0.0.1 --p2p.port 4338 --p2p.enrPort 4338 \
  --p2p.retainPeerId \
  --p2p.bootEnrs <the ENR from step 4> \
  --executor.bundlingMode manual
```

## 6. Confirm the two nodes peered

Gossipsub silently drops a publish with no peers subscribed to the topic, so check this before
sending anything — on both nodes:

```sh
curl -s http://127.0.0.1:14337/rpc/ -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_connectedPeers","params":[]}'
```

Wait until this returns a non-empty array for both `14337` and `14338`.

## 7. Build and sign a frame transaction

The simplest shape that passes validation is "Self Relay, Basic Transaction": one `VERIFY` frame
(`APPROVE_SCOPE.EXECUTION_AND_PAYMENT`, `target: null` meaning implicitly `tx.sender`) followed by
one `SENDER`-mode body frame doing a plain value transfer, SECP256K1-signed over
`computeSigHash(tx)`. `buildUnsignedFrameTx`/`signFrameTx`/`toWire` in
`test/e2e/frameTx.e2e.test.ts` build and sign exactly this shape and are the easiest way to
reproduce it — the codec lives at
`packages/executor/src/services/FrameTxService/codec.ts` (`computeSigHash`/`encodeRawFrameTx`),
and the frame/signature enums at `packages/types/src/contracts/FrameTx.ts`. `toWire` in the test
file shows the hex-string RPC wire shape `eth_sendFrameTransaction` expects (`bigint` fields become
`0x`-prefixed hex strings).

## 8. Submit it to node A

```sh
curl -s http://127.0.0.1:14337/rpc/ -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_sendFrameTransaction","params":[<wire-shape tx from step 7>]}'
```

The result is the transaction's own hash — `keccak256(encodeRawFrameTx(tx))`.

## 9. Confirm it reached node B's mempool

```sh
curl -s http://127.0.0.1:14338/rpc/ -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getFrameTransactionByHash","params":["<hash from step 8>"]}'
```

A non-null result here is the real proof: it means the transaction reached node A's RPC, was
published over real libp2p gossipsub, and node B's own gossip handler
(`handleValidVerifiedFrameTx` in `packages/node/src/network/processor/gossipHandlers.ts`) called
`eth_sendFrameTransaction` internally and stored it in node B's own mempool — not merely that node
B observed it in transit.
