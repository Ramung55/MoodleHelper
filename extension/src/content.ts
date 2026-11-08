import { installPageRefresh, disabledRegistry } from './page-refresh';
import { runtimeCollectionRepository } from './collection-repository';
import type { Runtime } from './dashboard-bridge';
declare const chrome:{runtime:Runtime};
// No trustworthy live HTTP envelope or observed identity exists yet (#3).
const stop=installPageRefresh(window,{source:()=>({url:location.href,documentKey:document}),repository:runtimeCollectionRepository(chrome.runtime),registry:disabledRegistry()});
window.addEventListener('pagehide',stop,{once:true});
