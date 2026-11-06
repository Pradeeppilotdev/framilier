import { createContext, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import {
  configuredInstances,
  defaultInstances,
  instancesReducer,
  loadState,
  saveState,
  type Instance,
  type InstancesAction,
  type InstancesState,
} from "./store";

interface InstancesValue {
  instances: Instance[];
  selected: Instance | null;
  dispatch: Dispatch<InstancesAction>;
}

const InstancesContext = createContext<InstancesValue | null>(null);

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // some browsers throw when storage is blocked
  }
}

export function InstancesProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Tests pass a fixed starting state; the app loads the saved list. */
  initial?: InstancesState;
}) {
  const [state, dispatch] = useReducer(instancesReducer, undefined, () => {
    if (initial) return initial;
    const configured = import.meta.env.VITE_EXPLORER_INSTANCES as string | undefined;
    return loadState(browserStorage(), defaultInstances(configured), configuredInstances(configured));
  });

  useEffect(() => {
    if (!initial) saveState(browserStorage(), state);
  }, [state, initial]);

  const value = useMemo<InstancesValue>(
    () => ({
      instances: state.instances,
      selected: state.instances.find((i) => i.url === state.selectedUrl) ?? null,
      dispatch,
    }),
    [state],
  );
  return <InstancesContext.Provider value={value}>{children}</InstancesContext.Provider>;
}

export function useInstances(): InstancesValue {
  const value = useContext(InstancesContext);
  if (!value) throw new Error("useInstances must be used inside <InstancesProvider>");
  return value;
}
