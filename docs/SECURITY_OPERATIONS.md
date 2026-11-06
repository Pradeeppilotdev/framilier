# RPC and subscription security

Normal nodes require `SKANDHA_ADMIN_KEY` for every `debug_bundler_*` method, including requests received over loopback. Send the exact configured value in the HTTP Authorization header. WebSocket debug requests use the Authorization header from their opening handshake. Keep the key out of URLs, command history, reports and public configuration files. Terminate external traffic over TLS and protect the administration surface at ingress as well.

Without a key, debug methods are disabled in normal operation. Explicit testing mode permits keyless debug requests only from loopback; use that mode only for disposable local fixtures. A configured key is still required in testing mode. Do not expose testing mode through a public reverse proxy.

The private-chain comparison runner generates a random per-run key and passes it only to its sidecar process. Its admin requests use that key. This does not change signed transactions, fees or validation gas allowances.

Subscriptions are limited to 32 per socket and 4,096 per service. HTTP and WebSocket API messages are bounded to 1 MiB. Closing or failing a socket immediately releases its subscriptions. Only the socket that created an ID can unsubscribe it. Consumers with more than 1 MiB of buffered outbound data are disconnected with code 1013. These bounds complement deployment-level connection and request limits; they do not replace them.

Request and response body hooks obey `--api.enableRequestLogging`. Keep body logging disabled when inputs contain sensitive material. Protect logs even when body logging is deliberately enabled.

The API and executor pin ws 8.22.1; regenerate/install from the checked-in Bun lockfile. This updates the server dependency affected by GHSA-3h5v-q93c-6h6q. Older ws branches used by inherited client dependencies remain separate upgrade work; this change does not certify the entire dependency tree.

Checks: build the sidecar, run executor and operator suites, and run the API unit tests. Security regressions cover loopback/proxy-equivalent requests, real HTTP/WebSocket admin access, per-socket/global limits, disconnect/error cleanup, ownership, slow consumers, disabled body logging and malformed upgrade headers. Verify a disposable-chain comparison after changing admin authentication.

The optional faucet accepts at most 32 active plus waiting requests in total. Overflow returns a retryable queue-full error before entering the serialized backend queue. Successes and failures both release capacity when their underlying operation settles. The queue never releases a running submission merely because a caller disconnects or times out: doing so could overlap account nonces. Configure backend timeouts and ingress attempt-rate limits separately; successful-drip quotas alone do not limit failed attempts.

WebSocket subscription handlers own their reply: the outer dispatcher returns after they answer, preventing an unsolicited second empty response. Later subscription notifications remain separate from the request reply.

WebSocket failures use the same error mapping as HTTP: `{ jsonrpc: "2.0", id, error: { code, message, data? } }`. Valid request IDs are preserved. Malformed JSON returns a parse error with a null ID; malformed request shapes return an invalid-request error. Unexpected internal exceptions return a generic internal-error message rather than exposing backend details. Subscription errors and ordinary RPC errors each produce one reply.
