#!/usr/bin/env bash
#
# Starts/stops a real single-node ethrex+Lighthouse Hegota devnet via
# Kurtosis + ethpandaops/ethereum-package, for the frame-tx-inclusion e2e
# test (frameTxInclusion.e2e.test.ts) - the one test in this suite that
# needs a REAL mined block, not just mempool admission/propagation.
#
# Why this is a completely different devnet from ethrex-devnet.sh's
# (single `docker run`, ethrex's own `--dev` block producer, never mines):
# Hegota is layered ON TOP OF Amsterdam, not before it - a genesis that's
# already Hegota-active at block 0 produces a beacon genesis state a real
# consensus client rejects outright. The real fix is staged fork
# activation (Osaka at genesis, Amsterdam at epoch 1, Hegota at epoch 2)
# driven by a real, spec-compliant CL - not ethrex's own hand-rolled `--dev`
# producer, which has no staged-activation concept and has to guess which
# Engine API version to call from the current timestamp alone. This
# mirrors ethrex's own real, running public Hegota devnet
# (fixtures/networks/eip8141-devnet.yaml on the eip8141-tracer branch),
# trimmed to one participant instead of three - see
# kurtosis/eip8141-single-node.yaml's own header comment for the fork
# schedule.
#
# Usage:
#   ./ethrex-mining-devnet.sh up        # start the devnet, wait until it answers RPC
#   ./ethrex-mining-devnet.sh down      # tear down the enclave
#   ./ethrex-mining-devnet.sh status    # print chain id and current block, or fail if not up
#   ./ethrex-mining-devnet.sh rpc-url   # print the devnet's RPC URL (for scripting)
#   ./ethrex-mining-devnet.sh chain-id  # print just the chain id, decimal-in-hex string (for scripting)

set -euo pipefail

ETHREX_BASE_IMAGE="${ETHREX_BASE_IMAGE:-ghcr.io/forshtat/ethrex:eip8141-tracer-latest}"
ENCLAVE="${ETHREX_MINING_ENCLAVE:-skandha-e2e-mining}"
# Pinned per ethrex's own Makefile (ETHEREUM_PACKAGE_REVISION): a revision
# whose genesis generator is 6.1.4+, deploying the EIP-8282 builder
# deposit/exit predeploys. EIP-8282 is part of Glamsterdam and invalidates
# every block from Amsterdam onward when either predeploy has no code, so
# an older generator produces a genesis on which any Amsterdam-scheduled
# devnet (Hegota included, since it's layered on Amsterdam) silently stops
# producing blocks at the fork boundary. Not a hypothetical - this is the
# exact revision the ethrex team found this the hard way for and pinned.
ETHEREUM_PACKAGE_REF="github.com/ethpandaops/ethereum-package@b5b3af65248f11702216e377d0377bcd8ccf4caf"
CONFIG_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kurtosis/eip8141-single-node.yaml"
EL_SERVICE="el-1-ethrex-lighthouse"
# Cache file for the RPC URL resolved by `up` - `status`/`rpc-url`/`chain-id`
# read it back rather than re-deriving, since they need to work as separate
# invocations after `up` has already exited.
RPC_URL_CACHE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.mining-devnet-rpc-url"

# `port_publisher.el.public_port_start: 32000` in the kurtosis config does
# NOT mean the EL's `rpc` port itself lands on 32000 - Kurtosis assigns
# published ports sequentially across ALL of the service's exposed ports in
# whatever order the ethrex launcher registers them, not in a fixed,
# predictable per-port-name order (observed: `tcp-discovery` got 32000,
# `rpc` got 32003). Query the actual mapping by port NAME instead of
# assuming an offset.
resolve_rpc_url() {
  local port
  port="$(kurtosis port print "${ENCLAVE}" "${EL_SERVICE}" rpc --format number)"
  echo "http://127.0.0.1:${port}" | tee "${RPC_URL_CACHE}"
}

rpc() {
  local url
  url="$(cat "${RPC_URL_CACHE}")"
  curl -s --max-time 5 -X POST "${url}" \
    -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"
}

case "${1:-}" in
  up)
    docker pull "${ETHREX_BASE_IMAGE}"
    docker tag "${ETHREX_BASE_IMAGE}" ethrex:local

    kurtosis engine start

    echo "Starting enclave ${ENCLAVE} (this stages Osaka -> Amsterdam -> Hegota over ~2 epochs, several minutes)..."
    kurtosis run --enclave "${ENCLAVE}" \
      "${ETHEREUM_PACKAGE_REF}" \
      --args-file "${CONFIG_FILE}"

    echo "--- kurtosis enclave inspect ${ENCLAVE} ---"
    kurtosis enclave inspect "${ENCLAVE}" || true
    echo "-------------------------------------------"

    RPC_URL="$(resolve_rpc_url)"
    echo "waiting for ethrex RPC on ${RPC_URL} ..."
    for _ in $(seq 1 120); do
      if rpc eth_chainId | grep -q '"result"'; then
        echo "ethrex up: $(rpc eth_chainId)"
        exit 0
      fi
      sleep 2
    done
    echo "ethrex did not become ready in time; enclave state:" >&2
    kurtosis enclave inspect "${ENCLAVE}" >&2 || true
    kurtosis service logs "${ENCLAVE}" "${EL_SERVICE}" --num 200 >&2 || true
    exit 1
    ;;

  down)
    # Dump the EL's own logs before tearing down - the enclave is gone by
    # the time any separate post-mortem step in a calling workflow runs
    # (the test's own afterAll calls this unconditionally, pass or fail),
    # so this is the only reliable place to capture them.
    echo "--- ${EL_SERVICE} logs (before teardown) ---"
    kurtosis service logs "${ENCLAVE}" "${EL_SERVICE}" --num 500 2>&1 || true
    echo "-------------------------------------------"
    kurtosis enclave rm "${ENCLAVE}" --force >/dev/null 2>&1 || true
    rm -f "${RPC_URL_CACHE}"
    ;;

  status)
    rpc eth_chainId
    echo
    rpc eth_blockNumber
    echo
    ;;

  rpc-url)
    cat "${RPC_URL_CACHE}"
    ;;

  chain-id)
    rpc eth_chainId | grep -o '"result":"[^"]*"' | cut -d'"' -f4
    ;;

  *)
    echo "usage: $0 {up|down|status|rpc-url|chain-id}" >&2
    exit 2
    ;;
esac
