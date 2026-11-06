import { useEffect, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { explorerApi } from "../rpc/methods";
import { RpcMethodError } from "../rpc/errors";
import type { TransactionDetail } from "../protocol/schemas";
import { keys } from "./keys";
import { useLive } from "./live";

/**
 * Poll unless the stream is delivering for this very URL: a live stream
 * refreshes only the selected instance's queries, so any other node's queries
 * still need polling.
 */
const POLL_MS = 5000;
const INFO_POLL_MS = 10_000;

function pollInterval(live: { url: string | null; status: string }, url: string): number | false {
  return live.url === url && live.status === "live" ? false : POLL_MS;
}

function usePollInterval(url: string): number | false {
  return pollInterval(useLive(), url);
}

/** Node facts, polled so the instance list can show which nodes are up. */
export function useInfo(url: string) {
  return useQuery({
    queryKey: keys.info(url),
    queryFn: ({ signal }) => explorerApi.info(url, { signal }),
    refetchInterval: INFO_POLL_MS,
    retry: false,
  });
}

export function usePool(url: string, status: string) {
  const refetchInterval = usePollInterval(url);
  return useInfiniteQuery({
    queryKey: keys.pool(url, status),
    queryFn: ({ pageParam, signal }) =>
      explorerApi.listTransactions(
        url,
        { status: status === "all" ? undefined : status, cursor: pageParam, limit: 50 },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
    retry: false,
  });
}

export function useActivity(
  url: string,
  outcome: "all" | "accepted" | "rejected" | "included" | "replaced" | "dropped",
) {
  const refetchInterval = usePollInterval(url);
  return useInfiniteQuery({
    queryKey: keys.activity(url, outcome),
    queryFn: ({ pageParam, signal }) =>
      explorerApi.listAdmissions(
        url,
        { outcome: outcome === "all" ? undefined : outcome, cursor: pageParam, limit: 50 },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
    retry: false,
  });
}

export function usePeers(url: string) {
  const refetchInterval = usePollInterval(url);
  return useQuery({
    queryKey: keys.peers(url),
    queryFn: ({ signal }) => explorerApi.peers(url, { signal }),
    refetchInterval,
    retry: false,
  });
}

export function useReputation(url: string) {
  const refetchInterval = usePollInterval(url);
  return useInfiniteQuery({
    queryKey: keys.reputation(url),
    queryFn: ({ pageParam, signal }) =>
      explorerApi.listReputation(url, { cursor: pageParam, limit: 50 }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval,
    retry: false,
  });
}

/** JSON-RPC "invalid request", the code the backend uses for every explorer validation error. */
const INVALID_REQUEST = -32600;

/**
 * The backend reports an unknown hash as INVALID_REQUEST "Frame transaction not
 * found". The code alone is ambiguous (a malformed hash or cursor uses it too),
 * so the message must match as well.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof RpcMethodError && err.code === INVALID_REQUEST && /not found/i.test(err.message);
}

/**
 * One node's view of a transaction. Resolves to `null` when the node has never
 * heard of it: that is an answer, not an error, so callers can tell "not there"
 * from "could not ask".
 */
export async function fetchTransaction(
  url: string,
  hash: string,
  signal?: AbortSignal,
): Promise<TransactionDetail | null> {
  try {
    return await explorerApi.getTransaction(url, hash, { signal });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export function useTransaction(url: string, hash: string) {
  const refetchInterval = usePollInterval(url);
  return useQuery<TransactionDetail | null>({
    queryKey: keys.tx(url, hash),
    queryFn: ({ signal }) => fetchTransaction(url, hash, signal),
    refetchInterval,
    retry: false,
  });
}

/** Asks every listed instance about one transaction, for the cross-instance view. */
export function useAcrossInstances(urls: string[], hash: string) {
  const live = useLive();
  return useQueries({
    queries: urls.map((url) => ({
      queryKey: keys.tx(url, hash),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchTransaction(url, hash, signal),
      refetchInterval: pollInterval(live, url),
      retry: false,
    })),
  });
}

/** The current time, refreshed on an interval, so "12 s ago" labels stay honest. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
