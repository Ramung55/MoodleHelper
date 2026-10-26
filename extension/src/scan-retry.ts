/** Timing calculation only: this does not issue or authorize requests. */
export type RetryDecision = {kind:'retry'; notBefore:number}|{kind:'stop'; reason:'retry_limit'|'invalid_retry_after'};

export function scanRetryDecision(failedAt:number, attempts:number, retryAfter?:string):RetryDecision {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts >= 3) return {kind:'stop',reason:'retry_limit'};
  if (!Number.isSafeInteger(failedAt) || failedAt < 0) return {kind:'stop',reason:'invalid_retry_after'};
  let deadline = failedAt + (attempts === 1 ? 2000 : 5000);
  if (retryAfter !== undefined) {
    const value = retryAfter.trim();
    let serverDeadline:number;
    if (/^[0-9]+$/.test(value)) {
      const seconds = Number(value);
      serverDeadline = failedAt + seconds * 1000;
    } else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
      serverDeadline = Date.parse(value);
      if (!Number.isFinite(serverDeadline) || new Date(serverDeadline).toUTCString() !== value) return {kind:'stop',reason:'invalid_retry_after'};
    } else return {kind:'stop',reason:'invalid_retry_after'};
    if (!Number.isSafeInteger(serverDeadline)) return {kind:'stop',reason:'invalid_retry_after'};
    deadline = Math.max(deadline,serverDeadline);
  }
  if (!Number.isSafeInteger(deadline)) return {kind:'stop',reason:'invalid_retry_after'};
  return {kind:'retry',notBefore:deadline};
}
