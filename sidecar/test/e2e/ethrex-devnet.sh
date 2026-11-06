#!/usr/bin/env bash
#
# Starts/stops a real ethrex execution client in EIP-8141 (Hegota) dev mode,
# for the two-node gossip end-to-end test in `frameTx.e2e.test.ts`.
#
# ethrex is the only execution client that implements the EIP-8141 frame
# transaction semantics this bundler validates against - it exposes the
# `ethrex_simulateFrameTransaction` RPC (with a native ERC-7562 tracer) that
# `FrameTxValidationService`/`FrameTxSimulationService` call on every
# `eth_sendFrameTransaction`. Geth has no frame-transaction support at all.
#
# Two ways to get the ethrex binary, selected by whether
# ETHREX_PREBUILT_IMAGE is set:
#
#  - Unset (default, local dev): build from source inside a Linux container.
#    ethrex does not build natively on macOS (`sha3-asm`/`keccak-asm` emit
#    assembly the Mach-O assembler rejects). Build output goes to a named
#    Docker volume rather than a bind mount: a bind-mounted `target/` writes
#    tens of gigabytes through to host disk.
#
#  - Set (CI): run a prebuilt, self-contained image directly - the ethrex
#    binary AND the Hegota genesis/dev-key fixtures it needs are already
#    baked in (see github.com/forshtat/ethrex's
#    .github/workflows/publish-eip8141-image.yml, which publishes
#    ghcr.io/forshtat/eip8141-devnet). No repo checkout, cargo build, or
#    volume required - `docker run` on its own is enough.
#
# Usage:
#   ./ethrex-devnet.sh build   # compile the ethrex binary (slow, once) - local mode only
#   ./ethrex-devnet.sh up      # start the devnet, wait until it answers RPC
#   ./ethrex-devnet.sh down    # stop and remove the devnet container
#   ./ethrex-devnet.sh status  # print chain id, or fail if not up

set -euo pipefail

ETHREX_REPO="${ETHREX_REPO:-/Users/alexf/ethrex/.worktrees/eip8141-tracer}"
IMAGE="${ETHREX_IMAGE:-ethrex-test-runner:1.93}"
PREBUILT_IMAGE="${ETHREX_PREBUILT_IMAGE:-}"
TARGET_VOLUME="${ETHREX_TARGET_VOLUME:-ethrex-target-eip8141}"
REGISTRY_VOLUME="${ETHREX_REGISTRY_VOLUME:-ethrex-cargo-registry}"
CONTAINER="${ETHREX_CONTAINER:-skandha-e2e-ethrex}"
HOST_PORT="${ETHREX_PORT:-8555}"
GENESIS="fixtures/genesis/l1-hegota.json"
BINARY="./target/debug/ethrex"

rpc() {
  curl -s --max-time 3 -X POST "http://127.0.0.1:${HOST_PORT}" \
    -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"
}

case "${1:-}" in
  build)
    # `--bin ethrex` only; the workspace's other binaries are not needed here.
    # The `dev` cargo feature (which `--dev` requires) is on by default.
    exec docker run --rm \
      -v "${ETHREX_REPO}:/work" \
      -v "${REGISTRY_VOLUME}:/usr/local/cargo/registry" \
      -v "${TARGET_VOLUME}:/work/target" \
      -w /work "${IMAGE}" \
      cargo build -p ethrex --bin ethrex
    ;;

  up)
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true

    # --http.addr 0.0.0.0 so the host-published port actually reaches the
    # server; ethrex defaults to 127.0.0.1, which is unreachable from outside
    # the container's network namespace.
    #
    # --http.api: the `ethrex` namespace (which carries
    # `ethrex_simulateFrameTransaction`, the RPC every sidecar frame-tx
    # validation depends on) is NOT in the default `eth,net,web3` set. Without
    # it every `eth_sendFrameTransaction` fails with "Method not found".
    #
    # No --dev: ethrex's dev-mode block producer still drives the engine API
    # with `engine_forkchoiceUpdatedV4`, which rejects Hegota payload
    # attributes ("engine_forkchoiceUpdatedV4 cannot accept Hegota payload
    # attributes"); after three such failures it shuts the whole node down.
    # ethrex does implement `engine_forkchoiceUpdatedV5`, so this is a
    # version-selection gap in the dev block producer, not a missing feature -
    # but it is in the ethrex repo, not this one. It costs this test nothing:
    # a mempool-propagation test never mines anything (both nodes run
    # `--executor.bundlingMode manual`), and simulation runs against head
    # state, which genesis provides with its rich accounts already funded.
    # Without --dev the node simply idles at block 0 and serves RPC.

    if [ -n "${PREBUILT_IMAGE}" ]; then
      # CI mode: a self-contained image, ethrex binary + genesis/keys
      # fixtures already baked in at /fixtures - no repo mount, no volume.
      docker run -d --name "${CONTAINER}" \
        -p "${HOST_PORT}:8545" \
        "${PREBUILT_IMAGE}" \
        --network "/${GENESIS}" \
        --http.addr 0.0.0.0 --http.port 8545 \
        --http.api eth,net,web3,ethrex,debug >/dev/null
    else
      if ! docker run --rm -v "${TARGET_VOLUME}:/t" "${IMAGE}" \
          test -x "/t/debug/ethrex" 2>/dev/null; then
        echo "ethrex binary not found in volume ${TARGET_VOLUME}." >&2
        echo "Run './ethrex-devnet.sh build' first (slow, one time)." >&2
        exit 1
      fi

      docker run -d --name "${CONTAINER}" \
        -v "${ETHREX_REPO}:/work" \
        -v "${TARGET_VOLUME}:/work/target" \
        -p "${HOST_PORT}:8545" \
        -w /work "${IMAGE}" \
        "${BINARY}" --network "${GENESIS}" \
        --http.addr 0.0.0.0 --http.port 8545 \
        --http.api eth,net,web3,ethrex,debug >/dev/null
    fi

    echo "waiting for ethrex RPC on 127.0.0.1:${HOST_PORT} ..."
    for _ in $(seq 1 120); do
      if rpc eth_chainId | grep -q '"result"'; then
        echo "ethrex up: $(rpc eth_chainId)"
        exit 0
      fi
      sleep 1
    done
    echo "ethrex did not become ready in time; container logs:" >&2
    docker logs --tail 50 "${CONTAINER}" >&2 || true
    exit 1
    ;;

  down)
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
    ;;

  status)
    rpc eth_chainId
    echo
    ;;

  *)
    echo "usage: $0 {build|up|down|status}" >&2
    exit 2
    ;;
esac
