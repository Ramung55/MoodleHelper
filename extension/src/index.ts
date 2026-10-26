import { installWorker } from "./dashboard-bridge";
import { installCollectionWorker } from './collection-repository';
import { installQueueWorker } from './queue';
declare const chrome: Parameters<typeof installWorker>[0] & Parameters<typeof installQueueWorker>[0];
installWorker(chrome);
installCollectionWorker(chrome);
installQueueWorker(chrome);
