/** Shared installed background bootstrap. Optional dependencies are in-process test seams only. */
import {installWorker} from './dashboard-bridge';
import {installCollectionWorker} from './collection-repository';
import {installQueueWorker} from './queue';
import {installReminderWorker} from './reminders';

type ChromeApi=Parameters<typeof installWorker>[0] & Parameters<typeof installQueueWorker>[0] & Parameters<typeof installReminderWorker>[0];
export function installExtension(chrome:ChromeApi, options:Parameters<typeof installQueueWorker>[1]={}) {
  installWorker(chrome);
  installCollectionWorker(chrome);
  const queue=installQueueWorker(chrome,options);
  // Registered after the queue listeners; reminder alarms use separate fixed names.
  installReminderWorker(chrome,{...(options.base?{base:options.base}:{}),...(options.fetcher?{fetcher:options.fetcher}:{})});
  return queue;
}
