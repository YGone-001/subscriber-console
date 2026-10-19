/*
 * One refresh entry per operations page.
 *
 * Before this module every page rendered a header refresh button while its
 * sub-sections (network-element view, architecture canvas, runtime discovery)
 * rendered their own, each revalidating a different subset. The operator had to
 * guess which button would actually update the numbers in front of them.
 *
 * The registry inverts that: the page frame owns the only visible control, and
 * each mounted section registers the loader for the data it displays. One click
 * revalidates every registered loader concurrently. A failing loader is
 * isolated - `run()` never rejects - so a broken auxiliary read cannot block the
 * rest of the refresh.
 *
 * The registry is a plain object rather than a React state container so its
 * behaviour (register / replace / unregister / run) is testable without a DOM.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

export type OperationsRefreshHandler = () => void | Promise<void>;

export type OperationsRefreshRegistry = {
  /* Registers (or replaces) the loader for `key`. Returns the unregister fn. */
  register: (key: string, handler: OperationsRefreshHandler) => () => void;
  /* Runs every registered loader. Never rejects. */
  run: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  isPending: () => boolean;
  size: () => number;
};

export function createOperationsRefreshRegistry(): OperationsRefreshRegistry {
  const handlers = new Map<string, OperationsRefreshHandler>();
  const listeners = new Set<() => void>();
  let pending = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  return {
    register(key, handler) {
      handlers.set(key, handler);
      emit();
      return () => {
        if (handlers.get(key) === handler) {
          handlers.delete(key);
          emit();
        }
      };
    },
    async run() {
      const loaders = [...handlers.values()];
      if (loaders.length === 0) return;
      pending += 1;
      emit();
      try {
        await Promise.allSettled(loaders.map((loader) => Promise.resolve().then(loader)));
      } finally {
        pending -= 1;
        emit();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isPending: () => pending > 0,
    size: () => handlers.size,
  };
}

const RegistryContext = createContext<OperationsRefreshRegistry | null>(null);

const noopSubscribe = () => () => {};
const alwaysFalse = () => false;

export function OperationsRefreshProvider({ children }: { children: ReactNode }) {
  const registry = useMemo(createOperationsRefreshRegistry, []);
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/** The registry, or null when the section renders outside a page frame. */
export function useOperationsRefreshRegistry(): OperationsRefreshRegistry | null {
  return useContext(RegistryContext);
}

/**
 * Register a section loader for the frame's refresh control.
 *
 * The handler is kept in a ref so a section can pass an inline closure without
 * re-registering (and re-rendering the frame) on every render.
 */
export function useRegisterOperationsRefresh(key: string, handler: OperationsRefreshHandler): void {
  const registry = useOperationsRefreshRegistry();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!registry) return undefined;
    return registry.register(key, () => handlerRef.current());
  }, [registry, key]);
}

/** True while the frame's refresh control is running any loader. */
export function useOperationsRefreshing(): boolean {
  const registry = useContext(RegistryContext);
  return useSyncExternalStore(
    registry ? registry.subscribe : noopSubscribe,
    registry ? registry.isPending : alwaysFalse,
    alwaysFalse,
  );
}
