/*
 * Test-only commit instrumentation.
 *
 * Installed before React loads, so the renderer injects its internals and every
 * committed tree is visible here. `PerformedWork` is set on a fiber that
 * actually rendered in the commit; memoized subtrees that bailed out do not
 * carry it. The import order in the benchmark entry guarantees React has not
 * been imported yet.
 */

type FiberNode = {
  elementType?: unknown;
  type?: unknown;
  flags: number;
  child: FiberNode | null;
  sibling: FiberNode | null;
};

type Renderer = {
  findFiberByHostInstance?: (instance: unknown) => FiberNode | null;
};

type CommitStats = {
  commits: number;
  byName: Record<string, number>;
};

type InjectedCounters = {
  renders: Record<string, number>;
  commits: Record<string, number>;
  propChanges: Record<string, string[]>;
};

const PERFORMED_WORK = 0b1;

const stats: CommitStats = { commits: 0, byName: {} };
const injected: InjectedCounters = { renders: {}, commits: {}, propChanges: {} };
const previousProps = new Map<string, Record<string, unknown>>();

/* The benchmark build transforms the two measured components to call these at
 * render and commit time. Function-call counting is exact; the fiber flag above
 * stays as a secondary signal only. */
function bump(bucket: Record<string, number>, name: string): void {
  bucket[name] = (bucket[name] || 0) + 1;
}

function componentName(fiber: FiberNode): string | null {
  const candidates = [fiber.type, fiber.elementType];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      const named = candidate as { displayName?: string; name?: string };
      return named.displayName || named.name || null;
    }
    if (candidate && typeof candidate === 'object') {
      const object = candidate as { displayName?: string; type?: unknown; render?: { displayName?: string; name?: string } };
      if (typeof object.displayName === 'string' && object.displayName) return object.displayName;
      if (typeof object.type === 'function') {
        const inner = object.type as { displayName?: string; name?: string };
        if (inner.displayName || inner.name) return inner.displayName || inner.name || null;
      }
      if (object.render) return object.render.displayName || object.render.name || null;
    }
  }
  return null;
}

function collect(fiber: FiberNode | null, seen: Set<string>): void {
  let node = fiber;
  while (node) {
    if ((node.flags & PERFORMED_WORK) !== 0) {
      const name = componentName(node);
      if (name) seen.add(name);
    }
    if (node.child) collect(node.child, seen);
    node = node.sibling;
  }
}

type GlobalHook = {
  supportsFiber: boolean;
  renderers: Map<number, Renderer>;
  inject: () => number;
  onCommitFiberRoot: (rendererId: number, root: { current: FiberNode }) => void;
  onCommitFiberUnmount: () => void;
};

const hook: GlobalHook = {
  supportsFiber: true,
  renderers: new Map(),
  inject() {
    this.renderers.set(1, {} as Renderer);
    return 1;
  },
  onCommitFiberRoot(_rendererId, root) {
    stats.commits += 1;
    const seen = new Set<string>();
    collect(root.current, seen);
    for (const name of seen) stats.byName[name] = (stats.byName[name] || 0) + 1;
  },
  onCommitFiberUnmount() {
    void 0;
  },
};

Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
  value: hook,
  configurable: true,
});

let domMutations = 0;
function resetDomMutations(): void {
  domMutations = 0;
}

Object.defineProperty(window, '__renderBench', {
  value: {
    render(name: string) { bump(injected.renders, name); },
    commit(name: string) { bump(injected.commits, name); },
    props(name: string, props: Record<string, unknown>) {
      const previous = previousProps.get(name);
      if (previous) {
        const changed: string[] = [];
        for (const key of new Set([...Object.keys(previous), ...Object.keys(props)])) {
          if (!Object.is(previous[key], props[key])) changed.push(key);
        }
        if (changed.length) injected.propChanges[name] = [...(injected.propChanges[name] || []), ...changed];
      }
      previousProps.set(name, { ...props });
    },
    reset() {
      stats.commits = 0;
      stats.byName = {};
      injected.renders = {};
      injected.commits = {};
      injected.propChanges = {};
      previousProps.clear();
      resetDomMutations();
    },
    snapshot() {
      return {
        commits: stats.commits,
        byName: { ...stats.byName },
        renders: { ...injected.renders },
        componentCommits: { ...injected.commits },
        propChanges: { ...injected.propChanges },
        domMutations,
      };
    },
    observeTable(tbody: Element | null) {
      resetDomMutations();
      if (!tbody || typeof MutationObserver === 'undefined') return false;
      const observer = new MutationObserver(() => { domMutations += 1; });
      observer.observe(tbody, { childList: true, subtree: true, attributes: true });
      (window as unknown as { __renderBenchObserver?: MutationObserver }).__renderBenchObserver = observer;
      return true;
    },
  },
  configurable: true,
});

export {};