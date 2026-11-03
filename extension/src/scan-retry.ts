/** Timing calculation only: this does not issue or authorize requests. */
export type RetryDecision = {kind:'retry'; notBefore:number}|{kind:'stop'; reason:'retry_limit'|'invalid_retry_after'};

export function retryAfterDeadline(failedAt:number, retryAfter:string):number|undefined {
  if (!Number.isSafeInteger(failedAt) || failedAt < 0) return;
  const value = retryAfter.trim();
  let deadline:number;
  if (/^[0-9]+$/.test(value)) {
    deadline = failedAt + Number(value) * 1000;
  } else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    deadline = Date.parse(value);
    if (!Number.isFinite(deadline) || new Date(deadline).toUTCString() !== value) return;
  } else return;
  return Number.isSafeInteger(deadline) && deadline>=0 ? deadline : undefined;
}

export function scanRetryDecision(failedAt:number, attempts:number, retryAfter?:string):RetryDecision {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts >= 3) return {kind:'stop',reason:'retry_limit'};
  if (!Number.isSafeInteger(failedAt) || failedAt < 0) return {kind:'stop',reason:'invalid_retry_after'};
  let deadline = failedAt + (attempts === 1 ? 2000 : 5000);
  if (retryAfter !== undefined) {
    const serverDeadline=retryAfterDeadline(failedAt,retryAfter);
    if (serverDeadline===undefined) return {kind:'stop',reason:'invalid_retry_after'};
    deadline = Math.max(deadline,serverDeadline);
  }
  if (!Number.isSafeInteger(deadline)) return {kind:'stop',reason:'invalid_retry_after'};
  return {kind:'retry',notBefore:deadline};
}
