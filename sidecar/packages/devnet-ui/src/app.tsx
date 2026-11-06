import { useMemo, type ReactNode } from "react";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInfo } from "./data/hooks";
import { LiveProvider, StreamFactoryContext, useLive, type StreamFactory } from "./data/live";
import { InstancesProvider, useInstances } from "./instances/context";
import { normalizeUrl, type Instance, type InstancesState } from "./instances/store";
import { hostOf } from "./rpc/errors";
import { Banner } from "./ui/Banner";
import { InstanceRail } from "./ui/shell/InstanceRail";
import { LiveChip } from "./ui/shell/LiveChip";
import { NodeGate } from "./ui/shell/NodeGate";
import { FaucetButton } from "./ui/shell/FaucetButton";
import { SearchBox } from "./ui/shell/SearchBox";
import { ActivityScreen } from "./ui/screens/ActivityScreen";
import { PeersScreen } from "./ui/screens/PeersScreen";
import { ReputationScreen } from "./ui/screens/ReputationScreen";
import { PoolScreen } from "./ui/screens/PoolScreen";
import { TxScreen } from "./ui/screens/TxScreen";

function TabLink({ to, children }: { to: "/" | "/activity" | "/peers" | "/reputation"; children: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="-mb-px border-b-2 border-transparent pb-2 text-ink-soft hover:text-ink"
      activeProps={{ className: "-mb-px border-b-2 border-ink pb-2 font-medium text-ink" }}
    >
      {children}
    </Link>
  );
}

function Header({ instance }: { instance: Instance }) {
  const info = useInfo(instance.url);
  return (
    <header className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-[2rem] font-semibold">{instance.name}</h1>
          <p className="mt-1 text-ink-soft">
            {info.data ? (
              `Chain ${info.data.chainId}, ${info.data.bundlingMode} bundling, Sidecar ${info.data.version} (${info.data.commit}), p2p ${info.data.p2pEnabled ? "on" : "off"}`
            ) : (
              <span className="font-mono text-[0.8125rem]">{instance.url}</span>
            )}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <SearchBox />
          <div className="flex items-center gap-4">
            {info.data?.faucetEnabled && <FaucetButton url={instance.url} />}
            <LiveChip />
          </div>
        </div>
      </div>
      <nav aria-label="Views" className="mt-6 flex gap-7 border-b border-line">
        <TabLink to="/">Pool</TabLink>
        <TabLink to="/activity">Activity</TabLink>
        <TabLink to="/peers">Peers</TabLink>
        <TabLink to="/reputation">Reputation</TabLink>
      </nav>
    </header>
  );
}

function Notices() {
  const { notice, dismissNotice, fatal } = useLive();
  return (
    <>
      {notice && (
        <div className="mb-4">
          <Banner
            tone="info"
            title={notice}
            action={
              <button type="button" onClick={dismissNotice} className="underline underline-offset-4">
                Dismiss
              </button>
            }
          />
        </div>
      )}
      {fatal && (
        <div className="mb-4">
          <Banner
            tone="warn"
            title="Live updates are unavailable on this node"
            hint={`${fatal} This page refreshes every few seconds instead.`}
          />
        </div>
      )}
    </>
  );
}

function EmptyInstances() {
  return (
    <div className="py-10">
      <h1 className="text-[2rem] font-semibold">No instance selected</h1>
      <p className="mt-2 max-w-[56ch] text-ink-soft">
        Add the URL of a sidecar node in the list on the left. It needs to run with --explorer.enable.
      </p>
    </div>
  );
}

function Shell() {
  const { selected } = useInstances();
  return (
    <LiveProvider instance={selected}>
      <div className="min-h-screen md:grid md:grid-cols-[17rem_1fr]">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:bg-raised focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <aside className="border-b border-line bg-rail md:min-h-screen md:border-r md:border-b-0">
          <InstanceRail />
        </aside>
        <div className="min-w-0 px-5 pt-6 pb-20 md:px-10">
          {selected ? <Header instance={selected} /> : <EmptyInstances />}
          <Notices />
          <main id="main">
            <Outlet />
          </main>
        </div>
      </div>
    </LiveProvider>
  );
}

function PoolPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return <NodeGate instance={selected}>{() => <PoolScreen instance={selected} />}</NodeGate>;
}

function ActivityPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return <NodeGate instance={selected}>{() => <ActivityScreen instance={selected} />}</NodeGate>;
}

function PeersPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return (
    <NodeGate instance={selected}>
      {(info) => <PeersScreen instance={selected} p2pEnabled={info.p2pEnabled} />}
    </NodeGate>
  );
}

function ReputationPage() {
  const { selected } = useInstances();
  if (!selected) return null;
  return <NodeGate instance={selected}>{() => <ReputationScreen instance={selected} />}</NodeGate>;
}

function TxPage() {
  const { hash } = txRoute.useParams();
  const { node } = txRoute.useSearch();
  const { instances, selected } = useInstances();
  const requested = node ?? selected?.url;
  if (!requested) return null;
  // The list holds normalized URLs; a link may write the same node differently.
  const checked = normalizeUrl(requested);
  if (!checked.ok) {
    // Never fetch a value that is not a plain http(s) node URL: a relative one would hit this page's own origin.
    return (
      <>
        <Banner tone="error" title="Not a valid node URL" hint={checked.error} />
        <p className="mt-3 font-mono text-[0.8125rem] break-all">{requested}</p>
      </>
    );
  }
  const url = checked.url;
  const instance = instances.find((i) => i.url === url) ?? { name: hostOf(url), url };
  return <NodeGate instance={instance}>{() => <TxScreen hash={hash} nodeUrl={url} />}</NodeGate>;
}

const rootRoute = createRootRoute({ component: Shell });
const poolRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: PoolPage });
const activityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/activity", component: ActivityPage });
const peersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/peers", component: PeersPage });
const reputationRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reputation", component: ReputationPage });
const txRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tx/$hash",
  // An empty `?node=` is the same as no `node`.
  validateSearch: (search: Record<string, unknown>): { node?: string } => ({
    node: typeof search.node === "string" && search.node !== "" ? search.node : undefined,
  }),
  component: TxPage,
});

const routeTree = rootRoute.addChildren([poolRoute, activityRoute, peersRoute, reputationRoute, txRoute]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter(history ? { routeTree, history } : { routeTree });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

export function App({
  router,
  queryClient,
  initialInstances,
  createStream,
}: {
  router: ReturnType<typeof createAppRouter>;
  /** Tests pass their own client so they can tune retries and caching. */
  queryClient?: QueryClient;
  /** Tests pass a fixed starting list; the app loads the saved one. */
  initialInstances?: InstancesState;
  /** Tests pass a fake stream; the app opens a real WebSocket. */
  createStream?: StreamFactory;
}) {
  const client = useMemo(
    () => queryClient ?? new QueryClient({ defaultOptions: { queries: { staleTime: 2000 } } }),
    [queryClient],
  );
  const tree = (
    <QueryClientProvider client={client}>
      <InstancesProvider initial={initialInstances}>
        <RouterProvider router={router} />
      </InstancesProvider>
    </QueryClientProvider>
  );
  return createStream ? <StreamFactoryContext.Provider value={createStream}>{tree}</StreamFactoryContext.Provider> : tree;
}
