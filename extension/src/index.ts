import { installWorker } from "./dashboard-bridge";
import { installCollectionWorker } from './collection-repository';
declare const chrome: Parameters<typeof installWorker>[0];
installWorker(chrome);
installCollectionWorker(chrome);
