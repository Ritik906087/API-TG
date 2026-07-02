// Polyfill browser globals referenced at module scope by libraries (e.g. the
// auto-generated Supabase client uses `localStorage` for auth persistence).
// Import this file BEFORE any module that may transitively touch those globals.
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}
