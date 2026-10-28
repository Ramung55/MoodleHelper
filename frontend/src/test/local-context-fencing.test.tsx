import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildDemoSnapshot } from '@/services/fixtures';
const mock = vi.hoisted(() => ({ dataset: 'first', unavailable: false, calls: 0, delayAt: 3, initialRows: [] as unknown[], jobs: [] as unknown[], delayed: undefined as undefined | ((v: unknown[]) => void) }));
vi.mock('@/lib/app-store', () => ({ useApp: () => ({ snap: buildDemoSnapshot(), views: [], run: vi.fn() }) }));
vi.mock('@/components/mh/ReconciliationReview', () => ({ ReconciliationReview: () => null }));
vi.mock('@/components/mh/SyllabusRevisionReview', () => ({ SyllabusRevisionReview: () => null }));
vi.mock('@/services/validate-docx', () => ({ validateDocx: async () => {} }));
vi.mock('@/services/local-documents', () => ({
  currentDataset: async () => { if (mock.unavailable) throw new Error('offline'); return mock.dataset; },
  recoverLocalJobs: async () => mock.jobs, updateLocalJob: async () => {},
  acquireLocalJobLease: async () => () => {},
  saveLocalDocument: async () => 'stored',
  listLocalDocuments: async () => { mock.calls++; if (mock.calls === mock.delayAt) return new Promise(resolve => { mock.delayed = resolve; }); return mock.calls === 1 ? mock.initialRows : []; },
}));
import { Syllabus } from '@/routes/syllabus';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); mock.calls=0; mock.dataset='first'; mock.unavailable=false; mock.delayed=undefined; mock.delayAt=3; mock.initialRows=[]; mock.jobs=[]; });
it.each(['changed','unavailable'])('does not redisplay a delayed prior-dataset result when context is %s', async (condition) => {
  vi.stubGlobal('crypto', webcrypto); render(<Syllabus />);
  const select = screen.getByLabelText('Course for import');
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select,{target:{value:'c-csc'}});
  const file = new File(['fixture'],'source.docx');
  Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('fixture').buffer});
  fireEvent.change(screen.getByLabelText('Syllabus file'),{target:{files:[file]}});
  await waitFor(() => expect(mock.delayed).toBeDefined());
  if (condition === 'changed') mock.dataset='second'; else mock.unavailable=true;
  fireEvent(window,new Event('focus'));
  await waitFor(() => expect(screen.getByText(condition === 'changed' ? /dataset changed/i : /local files are unavailable/i)).toBeInTheDocument());
  await act(async () => { mock.delayed!([{ datasetId:'first',courseId:'c-csc',digest:'secret',name:'stale-private.docx',size:1,source:'local',createdAt:'now' }]); await Promise.resolve(); });
  expect(screen.queryByText(/stale-private/)).not.toBeInTheDocument();
  expect(select).toBeDisabled();
});
it('shows unconfirmed legacy guidance without presenting a live locked job as interrupted', async () => {
  mock.delayAt=99;
  mock.jobs=[
    {datasetId:'first',owner:'old',id:'legacy',courseId:'c-csc',name:'legacy.docx',state:'parsing',message:'Older import status cannot be confirmed. If no other tab is working on it, reselect the file.'},
    {datasetId:'first',owner:'active',id:'live',courseId:'c-csc',name:'live.docx',state:'parsing',message:'Validating locally',leaseVersion:1},
  ];
  vi.stubGlobal('crypto', webcrypto); render(<Syllabus />);
  expect(await screen.findByText(/Unconfirmed older import: legacy.docx/)).toHaveTextContent('If no other tab is working on it');
  expect(screen.queryByText(/live.docx/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Course for import'),{target:{value:'c-csc'}});
  const file = new File(['fixture'],'legacy.docx');
  Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode('fixture').buffer});
  fireEvent.change(screen.getByLabelText('Syllabus file'),{target:{files:[file]}});
  await screen.findByText(/Complete: validated and stored locally/);
  expect(screen.getByText(/Unconfirmed older import: legacy.docx/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Hide guidance for now'}));
  expect(screen.queryByText(/Unconfirmed older import: legacy.docx/)).not.toBeInTheDocument();
});
it.each(['focus','pageshow'])('hides prior rows on %s until a fresh context check completes', async (event) => {
  mock.initialRows=[{datasetId:'first',courseId:'c-csc',digest:'known',name:'visible-before.docx',size:1,source:'local',createdAt:'now'}];
  mock.delayAt=2;
  vi.stubGlobal('crypto', webcrypto); render(<Syllabus />);
  expect(await screen.findByText(/visible-before.docx/)).toBeInTheDocument();
  fireEvent(window,new Event(event));
  expect(screen.queryByText(/visible-before.docx/)).not.toBeInTheDocument();
  await waitFor(() => expect(mock.delayed).toBeDefined());
  await act(async () => { mock.delayed!(mock.initialRows); await Promise.resolve(); });
  expect(await screen.findByText(/visible-before.docx/)).toBeInTheDocument();
});

