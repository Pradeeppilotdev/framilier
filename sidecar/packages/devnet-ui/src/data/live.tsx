import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { explorerApi } from "../rpc/methods";
import { ExplorerStream, type SocketLike, type StreamCallbacks, type StreamStatus } from "../rpc/stream";
import { wsUrl, type Instance } from "../instances/store";
import { keys } from "./keys";
import { LiveFeed } from "./liveFeed";

export interface StreamHandle {
  start(): void;
  stop(): void;
}

export type StreamFactory = (instance: Instance, callbacks: StreamCallbacks) => StreamHandle;

/** The real stream: a browser WebSocket to the instance, with `info` for restart and gap checks. */
export const createBrowserStream: StreamFactory = (instance, callbacks) =>
  new ExplorerStream(
    wsUrl(instance.url),
    {
      // `SocketLike` is the small subset of WebSocket the stream uses.
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      fetchInfo: () => explorerApi.info(instance.url),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    callbacks,
  );

/** Lets the app (and tests) choose how streams are created without threading a prop through the router. */
export const StreamFactoryContext = createContext<StreamFactory>(createBrowserStream);

export interface LiveState {
  /** The instance URL the state below belongs to; `null` without a selected instance. */
  url: string | null;
  status: StreamStatus;
  /** Set when the stream can never work here (the explorer is off); polling stays on. */
  fatal: string | null;
  /** A one-off message, such as "The node restarted"; cleared by `dismissNotice`. */
  notice: string | null;
  dismissNotice(): void;
  feed: LiveFeed;
}

const defaultFeed = new LiveFeed();
const LiveContext = createContext<LiveState>({
  url: null,
  status: "connecting",
  fatal: null,
  notice: null,
  dismissNotice: () => {},
  feed: defaultFeed,
});

export function useLive(): LiveState {
  return useContext(LiveContext);
}

/** True while `txHash` changed a moment ago. Re-renders when the highlight starts and ends. */
export function useFresh(txHash: string): boolean {
  const { feed } = useLive();
  useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  return feed.isFresh(txHash);
}

interface StoredLive {
  url: string | null;
  status: StreamStatus;
  fatal: string | null;
  notice: string | null;
}

const blankLive = (url: string | null): StoredLive => ({ url, status: "connecting", fatal: null, notice: null });

/** How long to batch stream events before refetching what they touched. */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * Owns the stream for the selected instance. Events refresh that instance's
 * queries (batched); reconnects refresh everything; a restart or history gap
 * resets everything and shows a notice. Switching instance stops the old stream.
 */
export function LiveProvider({
  instance,
  children,
  createStream,
}: {
  instance: Instance | null;
  children: ReactNode;
  /** Overrides the factory from `StreamFactoryContext`. */
  createStream?: StreamFactory;
}) {
  const queryClient = useQueryClient();
  const contextFactory = useContext(StreamFactoryContext);
  const feed = useMemo(() => new LiveFeed(), []);
  const url = instance?.url ?? null;
  // Stored with the URL it belongs to, so a render for a new URL never shows the previous instance's state.
  const [stored, setStored] = useState<StoredLive>(() => blankLive(url));
  const current = stored.url === url ? stored : blankLive(url);
  const factoryRef = useRef(createStream ?? contextFactory);
  factoryRef.current = createStream ?? contextFactory;

  useEffect(() => {
    setStored(blankLive(url));
    if (!instance || url === null) return;

    // Set false on cleanup so a stream that keeps calling back cannot touch the next instance's state.
    let active = true;
    const update = (change: Partial<Omit<StoredLive, "url">>) =>
      setStored((prev) => ({ ...(prev.url === url ? prev : blankLive(url)), ...change }));

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      refreshTimer = null;
      void queryClient.invalidateQueries({ queryKey: keys.all(url) });
    };

    const stream = factoryRef.current(instance, {
      onEvent: (event) => {
        if (!active) return;
        feed.push(event);
        if (refreshTimer === null) refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
      },
      onStatus: (next) => {
        if (!active) return;
        update({ status: next });
        if (next === "live") void queryClient.invalidateQueries({ queryKey: keys.all(url) });
      },
      onReset: (reason) => {
        if (!active) return;
        void queryClient.resetQueries({ queryKey: keys.all(url) });
        update({
          notice:
            reason === "restart"
              ? "This node restarted, so its history was reloaded."
              : "This node dropped some history while you were disconnected, so it was reloaded.",
        });
      },
      onFatal: (message) => {
        if (!active) return;
        update({ fatal: message });
      },
    });
    stream.start();

    return () => {
      active = false;
      stream.stop();
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
    // The stream belongs to the instance's URL; renaming an instance must not restart it.
  }, [url, queryClient, feed]);

  const { status, fatal, notice } = current;
  const value = useMemo<LiveState>(
    () => ({
      url,
      status,
      fatal,
      notice,
      dismissNotice: () => setStored((prev) => (prev.url === url ? { ...prev, notice: null } : prev)),
      feed,
    }),
    [url, status, fatal, notice, feed],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}
