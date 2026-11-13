import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const dist = new URL("../extension/dist/", import.meta.url);
const expected = {
  manifest_version: 3,
  name: "Moodle Helper",
  version: "0.0.0",
  background: { service_worker: "index.js", type: "module" },
  action: { default_popup: "popup.html" },
  minimum_chrome_version: "109",
  host_permissions: ["http://127.0.0.1:8000/*", "https://moodle.sdu.edu.kz/*"],
  permissions: ["alarms", "downloads", "notifications", "offscreen"],
  icons: { "128": "icon-128.png" },
  content_scripts: [{ matches: ["https://moodle.sdu.edu.kz/*"], js: ["content.js"] },
    {matches:["http://127.0.0.1:5173/*","http://localhost:5173/*","https://ramung55.github.io/MoodleHelper/*"],js:["dashboard-relay.js"]}],
};

function validateManifest(manifest: unknown) {
  expect(manifest).toEqual(expected);
}

describe("emitted Chrome shell", () => {
  it("registers only an internal asynchronous callback worker listener", async () => {
    const source=await readFile(new URL("index.js",dist),"utf8");
    const listeners:any[]=[];
    const lifecycle:any[]=[];
    runInNewContext(source,{chrome:{runtime:{id:"test",onMessage:{addListener:(f:any)=>listeners.push(f)},onStartup:{addListener:(f:any)=>lifecycle.push(f)},onInstalled:{addListener:(f:any)=>lifecycle.push(f)}},alarms:{onAlarm:{addListener:(f:any)=>lifecycle.push(f)},create:()=>{},clear:()=>{}},permissions:{contains:()=>{}}},fetch:()=>Promise.reject(Error("Offline")),crypto:{randomUUID:()=>"generation"},Map,Set,URL,TextEncoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
    expect(lifecycle).toHaveLength(6); // queue + #38 reminder: onAlarm, onStartup, onInstalled each
    expect(listeners).toHaveLength(3); // dashboard bridge, collection relay, #95 page visits
    for(const listener of listeners) expect(listener({}, {id:"bad"},()=>{})).toBeUndefined();
  });
  it("makes no Moodle request from the installed worker until a scan run exists", async () => {
    const source=await readFile(new URL("index.js",dist),"utf8");
    const calls:string[]=[];const callbacks:any[]=[];
    const chrome={runtime:{id:'test',onMessage:{addListener:()=>{}},onStartup:{addListener:(f:any)=>callbacks.push(f)},onInstalled:{addListener:(f:any)=>callbacks.push(f)}},
      alarms:{onAlarm:{addListener:(f:any)=>callbacks.push(f)},create:()=>{},clear:()=>{}},permissions:{contains:()=>{}}};
    const fetcher=async(url:string)=>{calls.push(String(url));return new Response(JSON.stringify(url.endsWith('/bridge-context')?{binding:'b'}:{unfinished:false}),{headers:{'Content-Type':'application/json'}});};
    runInNewContext(source,{chrome,fetch:fetcher,crypto:{randomUUID:()=>'generation'},Map,Set,URL,TextEncoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
    await new Promise(resolve=>setTimeout(resolve,20));callbacks[0]?.({name:'moodle-helper-mock-queue'});callbacks[1]?.();callbacks[2]?.();
    await new Promise(resolve=>setTimeout(resolve,20));
    // #20: the live scan worker only asks the local queue for work; with no run it
    // never contacts Moodle, never touches the gate and never writes scan results.
    expect(calls.some(url=>url.includes('moodle.sdu.edu.kz'))).toBe(false);
    expect(calls.filter(url=>url.includes('/api/scan/')).every(url=>url.endsWith('/api/scan/claim'))).toBe(true);
  });
  it("ships exactly the local manifest references with the minimal SDU grant", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
    validateManifest(manifest);
    const references = [manifest.background.service_worker, manifest.action.default_popup, manifest.icons["128"],
      ...manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js)];
    expect((await readdir(dist)).sort()).toEqual(["manifest.json", "popup.js", "transfer.html", "transfer.js", "offscreen.html", "offscreen.js", ...references].sort());
    for (const reference of references) {
      const bytes = await readFile(new URL(reference, dist));
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it.each([
    { permissions: ["storage"] }, { host_permissions: ["<all_urls>"] },
    { optional_permissions: ["tabs"] }, { externally_connectable: { matches: ["*://*/*"] } },
    { content_scripts: [{ matches: ["https://*.sdu.edu.kz/*"], js: ["content.js"] }] },
    { content_scripts: [{ matches: ["http://moodle.sdu.edu.kz/*"], js: ["content.js"] }] },
    { content_scripts: [{ matches: ["https://moodle.sdu.edu.kz/*"], js: ["content.js"], all_frames: true }] },
  ])("rejects broadened declarations %j", (change) => {
    expect(() => validateManifest({ ...expected, ...change })).toThrow();
  });

  it("#95: the emitted content script sends one visit message and never fetches, parses or stores", async () => {
    const source = await readFile(new URL("content.js", dist), "utf8");
    const run = (top: boolean, origin = "https://moodle.sdu.edu.kz") => {
      const calls: any[] = [];
      const context = Object.create(null);
      for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "indexedDB", "localStorage", "sessionStorage", "navigator", "setInterval", "MutationObserver"])
        Object.defineProperty(context, name, { get() { throw new Error(`Forbidden ${name}`); } });
      const doc = { body: { className: "lang-en cmid-990102 course-9001" }, querySelectorAll() { throw Error("The content script must never parse a page"); } };
      const win: any = { location: { origin }, document: doc }; win.top = top ? win : {};
      context.window = win; context.document = doc; context.location = win.location;
      context.chrome = { runtime: { sendMessage: (message: any, reply: () => void) => { calls.push(message); reply(); } } };
      runInNewContext(source, context, { timeout: 1000 });
      return calls;
    };
    expect(run(true)).toEqual([{ source: "moodle-helper-page-visit", version: "1", sourceCourseId: "9001" }]);
    expect(run(false)).toEqual([]);
    expect(run(true, "https://example.com")).toEqual([]);
  });

  it("ships the local mock progress popup with a fixed sign-in link", async () => {
    const html = await readFile(new URL("popup.html", dist), "utf8");
    expect(html).toMatch(/<title>Moodle Helper<\/title>/);
    expect(html).toMatch(/<h1>Moodle Helper<\/h1>/);
    expect(html).toMatch(/Demo data — mock scan progress/);
    expect(html).toMatch(/src="popup.js"/);
    expect(html).toMatch(/href="https:\/\/moodle.sdu.edu.kz\/login\/index.php"/);
    expect(html).not.toMatch(/\bon\w+\s*=/i);
  });
});
