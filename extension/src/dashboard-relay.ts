import { installRelay, type Runtime } from "./dashboard-bridge";
declare const chrome: { runtime: Runtime };
installRelay(window, chrome.runtime);
