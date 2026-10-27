import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildDemoSnapshot } from '@/services/fixtures';
import { MockProgress } from '@/components/mh/MockProgress';
import { installPopup } from '../../../extension/src/popup';
import { createMockProgress, type ProgressState } from '../../../shared/src/mock-progress';

const mock = vi.hoisted(()=>({ current:vi.fn(), start:vi.fn(), cancel:vi.fn(), connect:vi.fn() }));
vi.mock('@/services/extension-adapter',()=>({BridgeClient:class {connect=mock.connect; currentMockRun=mock.current; startMockRun=mock.start; cancelMockRun=mock.cancel; dispose(){} }}));
vi.mock('@tanstack/react-router',()=>({Link:({children,to}:any)=><a href={to}>{children}</a>}));
const run={id:'run1',idempotencyKey:'key1',courseIds:['c-csc'],createdAt:1000,status:'pending',cancelled:false,progress:{total:1,pending:1,running:0,completed:0,failed:0,cancelled:0},jobs:[{id:'job1',courseId:'c-csc',state:'pending',attempts:0,generation:0}]};
afterEach(()=>{cleanup(); vi.useRealTimers(); vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear();});

it('dashboard real controls start and cancel a labelled mock run while retaining data',async()=>{
  mock.connect.mockResolvedValue({}); mock.current.mockResolvedValueOnce({courseIds:['c-csc']}).mockResolvedValueOnce({courseIds:['c-csc'],run}).mockResolvedValue({courseIds:['c-csc'],run:{...run,status:'cancelled',cancelled:true}});
  mock.start.mockResolvedValue(run); mock.cancel.mockResolvedValue({...run,status:'cancelled'});
  const snapshot=buildDemoSnapshot(); render(<MockProgress snapshot={snapshot}/>);
  expect(screen.getByText(/No successful full sync yet/)).toBeInTheDocument();
  await waitFor(()=>expect(screen.getByRole('button',{name:'Start mock run'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Start mock run'}));
  await screen.findByText(/Mock run: pending/);
  expect(mock.start).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Cancel mock run'}));
  await screen.findByText(/Mock run: cancelled/);
  expect(mock.cancel).toHaveBeenCalledWith('run1');
  expect(screen.getByText(/No successful full sync yet/)).toBeInTheDocument();
});

it('popup real controls call fixed mock endpoints and show recorded status',async()=>{
  document.body.innerHTML='<div id="status"></div><div id="freshness"></div><button id="start"></button><button id="cancel"></button><button id="reconnect"></button><button id="example-retry"></button>';
  const snapshot=buildDemoSnapshot(); let current:any={courseIds:['c-csc']};
  const requests:string[]=[];
  const fetcher=vi.fn(async (input:RequestInfo|URL, init?:RequestInit)=>{
    const path=new URL(String(input)).pathname; requests.push(`${init?.method} ${path}`);
    let value:any=path==='/api/bridge-context'?{version:'1',binding:'a'.repeat(32)}:path==='/api/snapshot'?snapshot:current;
    if(path==='/api/queue/current'&&init?.method==='POST') {value=run;current={courseIds:['c-csc'],run};}
    if(path.endsWith('/cancel')) {value={...run,status:'cancelled',cancelled:true};current={courseIds:['c-csc'],run:value};}
    return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
  });
  const controller=installPopup(document,fetcher as typeof fetch,localStorage);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('#start')!.disabled).toBe(false));
  document.querySelector<HTMLButtonElement>('#start')!.click();
  await waitFor(()=>expect(document.querySelector('#status')!.textContent).toContain('Mock run: pending'));
  document.querySelector<HTMLButtonElement>('#cancel')!.click();
  await waitFor(()=>expect(document.querySelector('#status')!.textContent).toContain('Mock run: cancelled'));
  expect(requests).toContain('POST /api/queue/runs/run1/cancel'); controller.dispose();
});

it('uncertain start survives reconnect and explicitly reuses its key',async()=>{
  let last:ProgressState|undefined; let key='';
  const transport={connect:vi.fn().mockResolvedValue({}),current:vi.fn().mockResolvedValue({courseIds:['c-csc']}),start:vi.fn(async (k:string)=>{key=k;throw Error('lost response');}),cancel:vi.fn()};
  const c=createMockProgress(transport,s=>{last=s;},sessionStorage);
  await waitFor(()=>expect(last?.current?.courseIds).toEqual(['c-csc']));
  await c.start(); expect(last?.unavailable).toBe(true); expect(sessionStorage.getItem('mock-start-key')).toBe(key);
  await c.reconnect(); expect(last?.uncertain).toBe(true);
  await c.start(); expect(transport.start).toHaveBeenCalledTimes(2); expect(transport.start).toHaveBeenLastCalledWith(key);
  c.dispose();
});

it('a delayed poll cannot replace a later cancellation readback',async()=>{
  let last:ProgressState|undefined, resolveOld:(value:any)=>void=()=>{};
  const cancelled={...run,status:'cancelled' as const,cancelled:true};
  const transport={connect:vi.fn().mockResolvedValue({}),current:vi.fn().mockResolvedValueOnce({courseIds:['c-csc'],run}).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({courseIds:['c-csc'],run:cancelled}),start:vi.fn(),cancel:vi.fn().mockResolvedValue(cancelled)};
  const c=createMockProgress(transport,s=>{last=s;},sessionStorage);
  await waitFor(()=>expect(last?.current?.run?.status).toBe('pending'));
  const old=c.reconnect(); await waitFor(()=>expect(transport.current).toHaveBeenCalledTimes(2));
  await c.cancel(); resolveOld({courseIds:['c-csc'],run}); await old;
  expect(last?.current?.run?.status).toBe('cancelled'); c.dispose();
});

it('empty selection prevents a start and reconnect retains previously confirmed state',async()=>{
  let last:ProgressState|undefined;
  const transport={connect:vi.fn().mockResolvedValue({}),current:vi.fn().mockResolvedValueOnce({courseIds:[]}).mockRejectedValueOnce(Error('offline')),start:vi.fn(),cancel:vi.fn()};
  const c=createMockProgress(transport,s=>{last=s;},sessionStorage);
  await waitFor(()=>expect(last?.current?.courseIds).toEqual([]));
  await c.start(); expect(transport.start).not.toHaveBeenCalled();
  await c.reconnect(); expect(last?.unavailable).toBe(true); expect(last?.current?.courseIds).toEqual([]);
  c.dispose();
});

it('serializes slow periodic reads, recovers after a network failure and stops on disposal',async()=>{
  vi.useFakeTimers();
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  let last:ProgressState|undefined, concurrent=0, maxConcurrent=0, calls=0;
  const transport={connect:vi.fn().mockResolvedValue({}), current:vi.fn(()=>{
    const attempt=++calls; concurrent++; maxConcurrent=Math.max(maxConcurrent,concurrent);
    return new Promise<any>((resolve,reject)=>setTimeout(()=>{
      concurrent--;
      if(attempt===3) reject(Error('offline'));
      else resolve({courseIds:[`course-${attempt}`]});
    },4000));
  }),start:vi.fn(),cancel:vi.fn()};
  const c=createMockProgress(transport,s=>{last=s;},sessionStorage);
  await vi.advanceTimersByTimeAsync(3000); expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1000); expect(last?.current?.courseIds).toEqual(['course-1']);
  await vi.advanceTimersByTimeAsync(5000); expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(1000); expect(last?.current?.courseIds).toEqual(['course-2']);
  await vi.advanceTimersByTimeAsync(6000); expect(last?.unavailable).toBe(true);
  expect(last?.current?.courseIds).toEqual(['course-2']);
  const reconnect=c.reconnect(); await vi.advanceTimersByTimeAsync(4000); await reconnect;
  expect(last?.current?.courseIds).toEqual(['course-4']); expect(last?.unavailable).toBe(false);
  expect(maxConcurrent).toBe(1);
  c.dispose(); await vi.advanceTimersByTimeAsync(12000); expect(calls).toBe(4);
  vi.restoreAllMocks();
});
