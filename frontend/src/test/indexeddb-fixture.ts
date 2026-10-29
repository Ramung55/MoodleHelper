/** Transactional event shim for repository failure tests; not native browser evidence. */
export function indexedDbFixture() {
  const data = new Map<string, Map<string, any>>(), paths = new Map<string, string[]>();
  let version = 0, serial = Promise.resolve();
  const controls = { failNextEvidenceWrite: false, connections: 0, remove: (store: string, key: unknown[]) => data.get(store)?.delete(JSON.stringify(key)), rows: (store: string) => [...data.get(store)?.values() ?? []] };
  const db: any = {
    close() {}, objectStoreNames: { contains: (name: string) => data.has(name) },
    createObjectStore(name: string, options: { keyPath: string[] }) { data.set(name, new Map()); paths.set(name, options.keyPath); },
    transaction(names: string | string[], mode: string) {
      const stores = typeof names === "string" ? [names] : names, operations: (() => void)[] = [];
      let working: Map<string, Map<string, any>>, aborted = false;
      const tx: any = { abort() { aborted = true; }, objectStore(name: string) {
        if (!stores.includes(name) || !data.has(name)) throw new Error("Missing object store");
        const request = (action: () => any) => { const req: any = {}; operations.push(() => { req.result = action(); req.onsuccess?.({ target: req }); }); return req; };
        const write = (row: any, add: boolean) => request(() => {
          const key = JSON.stringify(paths.get(name)!.map(field => row[field])), store = working.get(name)!;
          if (add && store.has(key)) throw new Error("ConstraintError"); store.set(key, structuredClone(row)); return key;
        });
        return { get: (key: unknown[]) => request(() => structuredClone(working.get(name)!.get(JSON.stringify(key)))),
          add: (row: any) => write(row, true), put: (row: any) => write(row, false),
          getAll: (range?: any) => request(() => [...working.get(name)!.values()].filter(row => !range || row.datasetId === range.lower[0]).map(row => structuredClone(row))) };
      } };
      serial = serial.then(async () => {
        working = new Map(stores.map(name => [name, new Map([...data.get(name)!].map(([key, row]) => [key, structuredClone(row)]))]));
        try {
          for (let index = 0; index < operations.length && !aborted; index++) { operations[index](); await Promise.resolve(); }
          if (mode === "readwrite" && stores.includes("evidence") && controls.failNextEvidenceWrite) { controls.failNextEvidenceWrite = false; aborted = true; }
          if (aborted) { tx.onabort?.(); return; }
          if (mode === "readwrite") for (const name of stores) data.set(name, working.get(name)!);
          tx.oncomplete?.();
        } catch { aborted = true; tx.onerror?.(); tx.onabort?.(); }
      });
      return tx;
    },
  };
  return { controls, indexedDB: { open(_name: string, next: number) { const request: any = { result: db }; controls.connections++; queueMicrotask(() => { if (next > version) { version = next; request.onupgradeneeded?.(); } request.onsuccess?.(); }); return request; } }, IDBKeyRange: { bound: (lower: any, upper: any) => ({ lower, upper }) } };
}
