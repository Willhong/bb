interface CacheEntry<TValue> {
  value: TValue;
  freshUntil: number;
}

export interface StaleWhileRevalidateReadArgs<TValue> {
  key: string;
  load: () => Promise<TValue>;
  onChanged: () => void;
  onRefreshError: (error: unknown) => void;
}

export interface StaleWhileRevalidateCache<TValue> {
  read(args: StaleWhileRevalidateReadArgs<TValue>): Promise<TValue>;
}

export function createStaleWhileRevalidateCache<TValue>(options: {
  freshMs: number;
  maxEntries: number;
  now?: () => number;
}): StaleWhileRevalidateCache<TValue> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry<TValue>>();
  const pending = new Map<string, Promise<TValue>>();

  function store(key: string, value: TValue): void {
    entries.delete(key);
    entries.set(key, { value, freshUntil: now() + options.freshMs });
    for (const oldest of entries.keys()) {
      if (entries.size <= options.maxEntries) break;
      entries.delete(oldest);
    }
  }

  function start(
    args: StaleWhileRevalidateReadArgs<TValue>,
    onLoaded: (value: TValue) => void,
  ): Promise<TValue> {
    const started = args
      .load()
      .then((value) => {
        onLoaded(value);
        return value;
      })
      .finally(() => {
        if (pending.get(args.key) === started) pending.delete(args.key);
      });
    pending.set(args.key, started);
    return started;
  }

  function revalidate(
    args: StaleWhileRevalidateReadArgs<TValue>,
    previous: CacheEntry<TValue>,
  ): void {
    start(args, (value) => {
      if (entries.get(args.key) !== previous) return;
      store(args.key, value);
      if (JSON.stringify(value) !== JSON.stringify(previous.value)) {
        args.onChanged();
      }
    }).catch(args.onRefreshError);
  }

  return {
    async read(args) {
      const entry = entries.get(args.key);
      if (entry !== undefined) {
        if (entry.freshUntil <= now() && !pending.has(args.key)) {
          revalidate(args, entry);
        }
        return entry.value;
      }
      return (
        pending.get(args.key) ??
        start(args, (value) => store(args.key, value))
      );
    },
  };
}
