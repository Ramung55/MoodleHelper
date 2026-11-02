import {installOffscreen, type OffscreenRuntime} from './offscreen';
declare const chrome:{runtime:OffscreenRuntime};
installOffscreen(chrome.runtime);
