import { installPopup } from './popup';
const controller=installPopup(document);
window.addEventListener('unload',()=>controller.dispose(),{once:true});
