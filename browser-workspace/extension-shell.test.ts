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
  host_permissions: ["http://127.0.0.1:8000/*"],
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
    runInNewContext(source,{chrome:{runtime:{id:"test",onMessage:{addListener:(f:any)=>listeners.push(f)}},permissions:{contains:()=>{}}},fetch:()=>{throw Error("No fetch during registration");},crypto:{randomUUID:()=>"generation"},Map,Set,URL,TextEncoder,setTimeout,clearTimeout});
    expect(listeners).toHaveLength(2);
    for(const listener of listeners) expect(listener({}, {id:"bad"},()=>{})).toBeUndefined();
  });
  it("ships exactly the local manifest references with the minimal SDU grant", async () => {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", dist), "utf8"));
    validateManifest(manifest);
    const references = [manifest.background.service_worker, manifest.action.default_popup,
      ...manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js)];
    expect((await readdir(dist)).sort()).toEqual(["manifest.json", ...references].sort());
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

  it("keeps the popup blank and local, with a title and usable dimensions", async () => {
    const html = await readFile(new URL("popup.html", dist), "utf8");
    expect(html).toMatch(/<title>Moodle Helper<\/title>/);
    expect(html).toMatch(/<body>\s*<\/body>/);
    expect(html).toMatch(/width:\s*280px/);
    expect(html).toMatch(/min-height:\s*160px/);
    expect(html).not.toMatch(/<script|\bsrc\s*=|\bhref\s*=|\bon\w+\s*=/i);
  });
});
