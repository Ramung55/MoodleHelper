import {installExtension} from './bootstrap';
export {installExtension} from './bootstrap';
declare const chrome: Parameters<typeof installExtension>[0];
if (typeof chrome !== 'undefined') installExtension(chrome);
