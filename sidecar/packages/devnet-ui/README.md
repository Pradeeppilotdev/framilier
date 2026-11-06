# @skandha/devnet-ui

A web explorer for the sidecar EIP-8141 instances. Point it at one or more nodes started with
`--explorer.enable` and it shows, for the selected node:

- **Pool**: what is in the mempool now, updating live.
- **Activity**: every admission, including what the node turned away, with the failing rule.
- **Transaction**: the frames, the rule-by-rule admission report, what happened to the transaction,
  and which of your other instances have it and when they first saw it.
- **Peers**: the node's p2p peers.
- **Faucet**: a button, shown only when the node has a faucet (`SKANDHA_FAUCET_KEY`), that asks the node to send 1 ETH to an address.

It is a static single-page app. It talks to each node directly over JSON-RPC and WebSocket
(`skandha_explorer_*`, see [`docs/sidecar_explorer.md`](../../docs/sidecar_explorer.md)), so a node
must allow this page's origin (`--api.cors`, default `*`).

## Run it

```sh
bun install                      # from the repo root
cd packages/types && bun run build && cd ../devnet-ui   # the app imports the explorer wire types

bun run mock                     # three fake nodes on :14401 (busy), :14402 (peer), :14403 (explorer off)
VITE_EXPLORER_INSTANCES='[{"name":"Devnet miner","url":"http://localhost:14401/rpc"},{"name":"Local peer","url":"http://localhost:14402/rpc"},{"name":"No explorer","url":"http://localhost:14403/rpc"}]' \
  bun run dev                    # http://localhost:5173
```

Against a real node, skip the mock and set `VITE_EXPLORER_INSTANCES` to its URL, or add it from the
**Add instance** form. Instances from `VITE_EXPLORER_INSTANCES` are **pinned**: they are always listed
first, cannot be renamed or removed, and are read from the build on every load, so changing the
variable takes effect for returning visitors. Instances a visitor adds are remembered in their
browser. Without `VITE_EXPLORER_INSTANCES` the first visit lists `http://localhost:14337/rpc`.

## Test it

```sh
bun run typecheck                # app and tooling projects
bun run test                     # Vitest: protocol, RPC, stream, logic, mock node, components, app
bun run test:e2e                 # Playwright against the mock nodes and a Vite dev server
```

`test:e2e` drives the Chrome installed on your machine (`channel: "chrome"`), because Playwright
cannot install its own Chromium on some older macOS versions. In CI, run
`bunx playwright install chromium` and set `PW_CHANNEL=chromium`.

## Build and host it

```sh
bun run build                    # type-checks, then writes dist/
```

`dist/` is plain static files: serve it from any static host. Set `VITE_EXPLORER_INSTANCES` at build
time to preset the instance list. A page served over https can only call https nodes (browsers block
mixed content), so put nodes behind TLS or serve the page over http.

### Cloudflare (Workers static assets)

`wrangler.jsonc` publishes `dist/` as static assets with single-page-app fallback (so `/tx/<hash>`
deep links work). In the Cloudflare dashboard, create a Workers Builds project from this repo with:

| Setting | Value |
| --- | --- |
| Worker name | `skandha-explorer` (must match `name` in `wrangler.jsonc`) |
| Root directory | `packages/devnet-ui` |
| Build command | `bun install --filter @skandha/devnet-ui && bun run build:hosted` |
| Deploy command | `npx wrangler deploy` |
| Build variables | `VITE_EXPLORER_INSTANCES` (JSON list of `{name, url}`), `BUN_VERSION` = `1.2.19` |

`build:hosted` builds `@skandha/types` first (the app imports its wire types), then runs `build`.

## How it is put together

| Folder | Role |
| --- | --- |
| `src/protocol` | zod schemas for every explorer response, a compile-time guard against the backend's wire types, and the protocol-version check |
| `src/rpc` | the JSON-RPC client and its error kinds, and `ExplorerStream`: the resumable WebSocket follower (`sinceSeq`, `bootId` restart check, history-gap check, backoff) |
| `src/instances` | the instance list: a pure reducer, URL normalization, and tolerant persistence |
| `src/data` | React Query keys and hooks, the live feed for row highlights, and the provider that owns the selected node's stream |
| `src/logic` | pure formatting, frame decoding and rule grouping |
| `src/ui` | the primitives (`FrameStrip`, `VerdictMark`, ...), the shell and the screens |
| `mock/` | a fake explorer node with the real protocol behavior, and a thin Bun server around it (`bun run mock`) |
| `e2e/` | Playwright tests |

Design in one paragraph: a frame transaction is an ordered strip of frames checked by rules, so the
UI draws exactly that. Each frame is a block whose style says what it is (solid: verify, outlined:
sender, dashed: default) and the verdict of each rule that checked it sits beneath. Verdicts differ in
shape as well as color (ringed tick, diamond cross, dashed ring). Failure is the only saturated color.
