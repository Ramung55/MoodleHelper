import {describe,it,expect} from 'vitest';
import {scanRetryDecision} from '../extension/src/scan-retry';

describe('scan retry timing',()=>{
  it('enforces two bounded retries from each failure',()=>{
    expect(scanRetryDecision(10000,1)).toEqual({kind:'retry',notBefore:12000});
    expect(scanRetryDecision(13000,2)).toEqual({kind:'retry',notBefore:18000});
    expect(scanRetryDecision(20000,3)).toEqual({kind:'stop',reason:'retry_limit'});
  });
  it('honors longer server delays without shortening them',()=>{
    expect(scanRetryDecision(10000,1,'120')).toEqual({kind:'retry',notBefore:130000});
    const now=Date.parse('Sun, 06 Nov 1994 08:49:00 GMT');
    expect(scanRetryDecision(now,2,'Sun, 06 Nov 1994 08:49:37 GMT')).toEqual({kind:'retry',notBefore:now+37000});
  });
  it('fails closed for malformed or unrepresentable values',()=>{
    for(const value of ['-1','1.5','tomorrow','999999999999999999999999','Sun, 31 Feb 1994 08:49:37 GMT'])
      expect(scanRetryDecision(10000,1,value)).toEqual({kind:'stop',reason:'invalid_retry_after'});
  });
});
