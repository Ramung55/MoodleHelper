import { installWorker } from "./dashboard-bridge";
declare const chrome: Parameters<typeof installWorker>[0];
installWorker(chrome);
