import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const dist = new URL("../extension/dist/", import.meta.url);
const expected = {
  manifest_version: 3,
  name: "Moodle Helper",
  version: "0.0.0",
  background: { service_worker: "index.js", type: "module" },
  action: { default_popup: "popup.html" },
  minimum_chrome_version: "106",
  host_permissions: ["http://127.0.0.1:8000/*", "https://moodle.sdu.edu.kz/*"],
  permissions: ["alarms", "downloads", "notifications"],
  icons: { "128": "icon-128.png" },
  content_scripts: [{ matches: ["https://moodle.sdu.edu.kz/*"], js: ["content.js"] },
    {matches:["http://127.0.0.1:5173/*","http://localhost:5173/*"],js:["dashboard-relay.js"]}],
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
    expect(listeners).toHaveLength(2);
    for(const listener of listeners) expect(listener({}, {id:"bad"},()=>{})).toBeUndefined();
  });
  it("never starts scan work in the ordinary installed background worker", async () => {
    const source=await readFile(new URL("index.js",dist),"utf8");
    const calls:string[]=[];const callbacks:any[]=[];
    const chrome={runtime:{id:'test',onMessage:{addListener:()=>{}},onStartup:{addListener:(f:any)=>callbacks.push(f)},onInstalled:{addListener:(f:any)=>callbacks.push(f)}},
      alarms:{onAlarm:{addListener:(f:any)=>callbacks.push(f)},create:()=>{},clear:()=>{}},permissions:{contains:()=>{}}};
    const fetcher=async(url:string)=>{calls.push(String(url));return new Response(JSON.stringify(url.endsWith('/bridge-context')?{binding:'b'}:{unfinished:false}),{headers:{'Content-Type':'application/json'}});};
    runInNewContext(source,{chrome,fetch:fetcher,crypto:{randomUUID:()=>'generation'},Map,Set,URL,TextEncoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
    await new Promise(resolve=>setTimeout(resolve,20));callbacks[0]?.({name:'moodle-helper-mock-queue'});callbacks[1]?.();callbacks[2]?.();
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(calls.some(url=>url.includes('/api/scan/'))).toBe(false);
  });
  it("ships exactly the local manifest references with the minimal SDU grant", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
    validateManifest(manifest);
    const references = [manifest.background.service_worker, manifest.action.default_popup, manifest.icons["128"],
      ...manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js)];
    expect((await readdir(dist)).sort()).toEqual(["manifest.json", "popup.js", "transfer.html", "transfer.js", ...references].sort());
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

  it("installs the emitted lifecycle but disabled context causes zero collection, DOM parsing, network or storage", async () => {
    const source = await readFile(new URL("content.js", dist), "utf8");
    const calls: any[] = [];
    const context = Object.create(null);
    for (const name of ["fetch", "XMLHttpRequest", "WebSocket",
      "indexedDB", "localStorage", "sessionStorage", "navigator", "setInterval"])
      Object.defineProperty(context, name, { get() { throw new Error(`Forbidden ${name}`); } });
    const events=new Map<string,()=>void>();let disconnected=false;
    const win:any={location:{origin:'https://moodle.sdu.edu.kz',href:'https://moodle.sdu.edu.kz/mod/assign/view.php?id=303'},addEventListener:(event:string,listener:()=>void)=>events.set(event,listener),removeEventListener:(event:string)=>events.delete(event)};win.top=win;
    const doc={querySelectorAll(){throw Error('Disabled context must never parse a page');}};win.document=doc;
    context.window=win;context.document=doc;context.location=win.location;
    context.chrome={runtime:{sendMessage:(message:any,reply:(r:any)=>void)=>{calls.push(message);reply({requestId:message.requestId,ok:true,result:{version:'1',binding:'a'.repeat(32),mode:'disabled',selectionRevision:'revision',courses:[],reason:'collection_disabled'}});}}};
    context.crypto={randomUUID:()=>'synthetic-uuid'};context.structuredClone=structuredClone;context.TextEncoder=TextEncoder;context.setTimeout=setTimeout;context.clearTimeout=clearTimeout;
    context.MutationObserver=class {observe(){}disconnect(){disconnected=true;}};
    runInNewContext(source, context, { timeout: 1000 });
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(calls.map(c=>c.operation)).toEqual(['collectionContext']);
    events.get('popstate')?.();events.get('hashchange')?.();
    expect(calls).toHaveLength(1);events.get('pagehide')?.();expect(disconnected).toBe(true);
    // The guard is live, rather than a stub that would silently allow activity.
    for (const probe of ["fetch('https://example.com')", "localStorage.getItem('student')", "document.querySelectorAll('main')"])
      expect(() => runInNewContext(probe, context)).toThrow();
  });

  it("ships the local mock progress popup with a fixed sign-in link", async () => {
    const html = await readFile(new URL("popup.html", dist), "utf8");
    expect(html).toMatch(/<title>Moodle Helper<\/title>/);
    expect(html).toMatch(/Mock scan progress/);
    expect(html).toMatch(/src="popup.js"/);
    expect(html).toMatch(/href="https:\/\/moodle.sdu.edu.kz\/login\/index.php"/);
    expect(html).not.toMatch(/\bon\w+\s*=/i);
  });
});
