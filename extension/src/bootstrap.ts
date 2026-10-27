/** Shared installed background bootstrap. Optional dependencies are in-process test seams only. */
import {installWorker} from './dashboard-bridge';
import {installCollectionWorker} from './collection-repository';
import {installQueueWorker} from './queue';

type ChromeApi=Parameters<typeof installWorker>[0] & Parameters<typeof installQueueWorker>[0];
export function installExtension(chrome:ChromeApi, options:Parameters<typeof installQueueWorker>[1]={}) {
  installWorker(chrome);
  installCollectionWorker(chrome);
  return installQueueWorker(chrome,options);
}
