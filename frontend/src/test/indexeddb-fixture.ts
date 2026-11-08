type Row = Record<string, unknown>;
import type { StoredExtraction } from "@/services/local-extraction-store";
import type { LocalEvidenceRecord } from "@/services/local-evidence";
type Range = { lower: unknown[]; upper: unknown[] };
type FixtureRequest = { result?: unknown; onsuccess?: (event: { target: FixtureRequest }) => void };
type FixtureTransaction = {
  onabort?: () => void;
  oncomplete?: () => void;
  onerror?: () => void;
  abort(): void;
  objectStore(name: string): unknown;
};
/** Transactional event shim for repository failure tests; not native browser evidence. */
export function indexedDbFixture() {
  const data = new Map<string, Map<string, Row>>(),
    paths = new Map<string, string[] | string>();
  function rows(store: "extractions"): StoredExtraction[];
  function rows(store: "evidence"): LocalEvidenceRecord[];
  function rows(store: string): Row[];
  function rows(store: string): Row[] | StoredExtraction[] | LocalEvidenceRecord[] {
    return [...(data.get(store)?.values() ?? [])];
  }
  let version = 0,
    serial = Promise.resolve();
  const controls = {
    failNextEvidenceWrite: false,
    connections: 0,
    remove: (store: string, key: unknown[]) => data.get(store)?.delete(JSON.stringify(key)),
    rows,
  };
  const db = {
    close() {},
    objectStoreNames: { contains: (name: string) => data.has(name) },
    createObjectStore(name: string, options: { keyPath: string[] | string }) {
      data.set(name, new Map());
      paths.set(name, options.keyPath);
    },
    transaction(names: string | string[], mode: string) {
      const stores = typeof names === "string" ? [names] : names,
        operations: (() => void)[] = [];
      let working: Map<string, Map<string, Row>>,
        aborted = false;
      const tx: FixtureTransaction = {
        abort() {
          aborted = true;
        },
        objectStore(name: string) {
          if (!stores.includes(name) || !data.has(name)) throw new Error("Missing object store");
          const request = (action: () => unknown) => {
            const req: FixtureRequest = {};
            operations.push(() => {
              req.result = action();
              req.onsuccess?.({ target: req });
            });
            return req;
          };
          const write = (row: Row, add: boolean) =>
            request(() => {
              const path = paths.get(name)!,
                key = JSON.stringify(
                  Array.isArray(path) ? path.map((field) => row[field]) : row[path],
                ),
                store = working.get(name)!;
              if (add && store.has(key)) throw new Error("ConstraintError");
              store.set(key, structuredClone(row));
              return key;
            });
          // A bound range selects one dataset (its first key part), as every caller uses it.
          const matches = (key: string, range: unknown) =>
            range && typeof range === "object" && "lower" in range && Array.isArray(range.lower)
              ? JSON.parse(key)[0] === range.lower[0]
              : key === JSON.stringify(range);
          return {
            get: (key: unknown[]) =>
              request(() => structuredClone(working.get(name)!.get(JSON.stringify(key)))),
            delete: (range: unknown) =>
              request(() => {
                const store = working.get(name)!;
                for (const key of [...store.keys()]) if (matches(key, range)) store.delete(key);
              }),
            count: (range: unknown) =>
              request(
                () => [...working.get(name)!.keys()].filter((key) => matches(key, range)).length,
              ),
            add: (row: Row) => write(row, true),
            put: (row: Row) => write(row, false),
            getAll: (range?: Range) =>
              request(() =>
                [...working.get(name)!.values()]
                  .filter((row) => !range || row["datasetId"] === range.lower[0])
                  .map((row) => structuredClone(row)),
              ),
          };
        },
      };
      serial = serial.then(async () => {
        working = new Map(
          stores.map((name) => [
            name,
            new Map([...data.get(name)!].map(([key, row]) => [key, structuredClone(row)])),
          ]),
        );
        try {
          for (let index = 0; index < operations.length && !aborted; index++) {
            operations[index]!();
            await Promise.resolve();
          }
          if (
            mode === "readwrite" &&
            stores.includes("evidence") &&
            controls.failNextEvidenceWrite
          ) {
            controls.failNextEvidenceWrite = false;
            aborted = true;
          }
          if (aborted) {
            tx.onabort?.();
            return;
          }
          if (mode === "readwrite") for (const name of stores) data.set(name, working.get(name)!);
          tx.oncomplete?.();
        } catch {
          aborted = true;
          tx.onerror?.();
          tx.onabort?.();
        }
      });
      return tx;
    },
  };
  return {
    controls,
    indexedDB: {
      open(_name: string, next: number) {
        const request: { result: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void } =
          { result: db };
        controls.connections++;
        queueMicrotask(() => {
          if (next > version) {
            version = next;
            request.onupgradeneeded?.();
          }
          request.onsuccess?.();
        });
        return request;
      },
    },
    IDBKeyRange: { bound: (lower: unknown[], upper: unknown[]) => ({ lower, upper }) },
  };
}
