import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAssociation } from "@/services/local-documents";
import { DEFAULT_OCR_LIMITS, type OcrJob } from "@/services/ocr-pdf";

const mock = vi.hoisted(() => ({ read: vi.fn(), context: vi.fn(), run: vi.fn() }));
vi.mock("@/services/local-documents", () => ({
  readLocalDocument: mock.read,
  currentDataset: mock.context,
}));
vi.mock("@/services/ocr-pdf", async (original) => ({
  ...(await original<typeof import("@/services/ocr-pdf")>()),
  runOcr: mock.run,
}));
import { LocalOcr } from "@/components/mh/LocalOcr";

const A: LocalAssociation = {
  datasetId: "dataset",
  courseId: "course",
  digest: "sha256-a",
  name: "scan.pdf",
  size: 100,
  source: "Local",
  createdAt: "now",
};
const B: LocalAssociation = { ...A, digest: "sha256-b" };
const page = {
  page: 1,
  width: 100,
  height: 100,
  text: "Exam",
  confidence: 92,
  regions: [],
  status: "recognized" as const,
};
const complete: OcrJob = {
  selectedPages: [1],
  pages: [page],
  complete: true,
  status: "complete",
  language: "eng+rus",
  dpi: 120,
  engine: "tesseract.js-7.0.0",
};
const LIMITS = ["Pages/job", "Render DPI", "Milliseconds/page", "Pixels/page"] as const;

beforeEach(() => {
  vi.resetAllMocks();
  mock.read.mockResolvedValue(new Blob(["pdf"]));
  mock.context.mockResolvedValue("dataset");
  mock.run.mockResolvedValue(complete);
});
afterEach(cleanup);

/** What the OCR panel shows, read from the DOM. */
function seen() {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="OCR language"]');
  return {
    rows: [...document.querySelectorAll("section > p:first-child")].map((node) => node.textContent),
    progress: !!document.querySelector('[aria-label="OCR current page progress"]'),
    statuses: [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent),
    cancel: [...document.querySelectorAll("button")].some(
      (node) => node.textContent === "Cancel OCR",
    ),
    disabled: document.querySelector("fieldset")?.disabled ?? null,
    selection:
      document.querySelector<HTMLInputElement>('[aria-label="OCR original pages"]')?.value ?? null,
    language: select?.selectedOptions[0]?.textContent ?? null,
    limits: LIMITS.map(
      (label) =>
        document.querySelector<HTMLInputElement>(`[aria-label="OCR ${label}"]`)?.value ?? null,
    ),
  };
}
const fresh = {
  rows: [],
  progress: false,
  statuses: [],
  cancel: false,
  disabled: false,
  selection: "",
  language: "English and Russian",
  limits: [
    DEFAULT_OCR_LIMITS.maxPages,
    DEFAULT_OCR_LIMITS.dpi,
    DEFAULT_OCR_LIMITS.millisecondsPerPage,
    DEFAULT_OCR_LIMITS.maxPixels,
  ].map(String),
};

/**
 * Edits a field the way a user would: sets the DOM value and dispatches a raw DOM event, not act-wrapped fireEvent, so
 * React handles it like a real user event even inside the layout phase of a commit (same technique as #66/#68).
 * For the page selection and language. A limit input's onChange reads event.target.value in a lazy state updater, and
 * inside a commit React restores the controlled DOM value before that updater runs, so limits use editLimit() there.
 */
function edit(label: string, value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  );
  if (!field) throw new Error(`${label} is not rendered`);
  const prototype =
    field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(
    new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

/**
 * Edits a limit input inside the layout phase of a commit. A limit input's onChange reads event.target.value in a lazy
 * state updater, and React restores the controlled DOM value right after the event, before that updater runs. Setting
 * the DOM value again after the event (no new event) makes the updater read the edited value, as it would outside a
 * commit, so the edit lands in the same commit window as edit() and a later reset of the limits cannot hide behind it.
 */
function editLimit(label: string, value: string) {
  edit(label, value);
  const field = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
}

/**
 * Runs in the layout phase of every commit that mounts or changes the document: after LocalOcr's DOM for that commit is
 * in place and its layout effects ran, before the browser paints and before passive effects flush. It records the DOM
 * (the new document's first render as the user would see it), then runs `onCommit`, such as an early user edit.
 */
function OnDocumentCommit({
  document: association,
  record,
  onCommit,
}: {
  document: LocalAssociation;
  record: () => void;
  onCommit?: (() => void) | undefined;
}) {
  useLayoutEffect(() => {
    record();
    onCommit?.();
  }, [association.datasetId, association.courseId, association.digest]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

type Props = {
  document: LocalAssociation;
  onInspect?: (page: number) => Promise<void>;
  onCommit?: () => void;
};
/** `probe` is read in the layout phase of every document commit, for example whether an old signal is aborted. */
function setup(
  props: Props,
  { strict = false, probe }: { strict?: boolean; probe?: () => unknown } = {},
) {
  const firstRenders: ReturnType<typeof seen>[] = [];
  const probes: unknown[] = [];
  const ui = (next: Props) => {
    const tree = (
      <>
        <LocalOcr document={next.document} onInspect={next.onInspect ?? vi.fn(async () => {})} />
        <OnDocumentCommit
          document={next.document}
          onCommit={next.onCommit}
          record={() => {
            firstRenders.push(seen());
            probes.push(probe?.());
          }}
        />
      </>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const view = render(ui(props));
  fireEvent.click(screen.getByText("OCR selected scanned PDF pages"));
  return { view, firstRenders, probes, rerender: (next: Props) => view.rerender(ui(next)) };
}
const start = () => fireEvent.click(screen.getByText("Start selected-page OCR"));
function editEverything() {
  fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "1, 3" } });
  fireEvent.change(screen.getByLabelText("OCR language"), { target: { value: "rus" } });
  fireEvent.change(screen.getByLabelText("OCR Render DPI"), { target: { value: "150" } });
  fireEvent.change(screen.getByLabelText("OCR Pixels/page"), { target: { value: "4000000" } });
}
const edited = ["1, 3", "Russian", ["20", "150", "60000", "4000000"]] as const;
let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
const hold = () =>
  new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });

describe("LocalOcr state belongs to one document (#72)", () => {
  it.each([
    ["digest", { digest: "re-imported" }],
    ["courseId", { courseId: "other-course" }],
    ["datasetId", { datasetId: "other-dataset" }],
  ])(
    "shows nothing from an in-flight OCR, selection, language or limits in the first render after %s changes",
    async (_field, change) => {
      mock.run.mockImplementationOnce((...args) => {
        args[5]({
          total: 2,
          completed: 1,
          failed: 0,
          remaining: 1,
          currentPage: 3,
          currentProgress: 0.5,
          pages: [page],
        });
        return hold();
      });
      const signal = () => mock.run.mock.calls[0]?.[4] as AbortSignal | undefined;
      const { firstRenders, probes, rerender } = setup(
        { document: A },
        { probe: () => signal()?.aborted },
      );
      editEverything();
      start();
      // Waits for the held run's progress to render.
      await screen.findByText(/Selected 2 · completed 1/);
      expect(seen()).toEqual({
        rows: ["scan.pdf · original page 1 · Text found · incomplete job"],
        progress: true,
        statuses: ["Opening selected local pages for OCR…"],
        cancel: true,
        disabled: true,
        selection: edited[0],
        language: edited[1],
        limits: edited[2],
      });
      rerender({ document: { ...A, ...change } });
      // The layout-phase record of the switching commit: the new document's first render, before any passive effect.
      expect(firstRenders.at(-1)).toEqual(fresh);
      // The old run was aborted in that same commit.
      expect(probes.at(-1)).toBe(true);
      // Right after the prop change, without waiting.
      expect(seen()).toEqual(fresh);
      expect(signal()!.aborted).toBe(true);
      // The panel is the same uncontrolled <details> element, so it stays open.
      expect(document.querySelector("details")!.open).toBe(true);
      // Settles the old run after the switch; nothing may render.
      await act(async () => {
        resolve(complete);
      });
      expect(seen()).toEqual(fresh);
    },
  );

  it("shows no previous OCR result or message in the first render after a digest-only change", async () => {
    const { firstRenders, rerender } = setup({ document: A });
    editEverything();
    start();
    // Waits for the completed run to render.
    await screen.findByText(/Selected-page OCR finished/);
    expect(seen()).toMatchObject({
      rows: ["scan.pdf · original page 1 · Text found"],
      selection: "1, 3",
    });
    rerender({ document: B });
    expect(firstRenders.at(-1)).toEqual(fresh);
    expect(seen()).toEqual(fresh);
  });

  it.each([
    "reading",
    "recognition",
    "context check",
    "failing read",
    "cancelled recognition",
  ] as const)(
    "never lets an old-document OCR land in the new document when the switch happens during %s",
    async (stage) => {
      let signal: () => AbortSignal | undefined = () => undefined;
      if (stage === "reading" || stage === "failing read") {
        mock.read.mockImplementationOnce(hold);
        signal = () => mock.read.mock.calls[0]?.[1];
      } else if (stage === "context check") {
        mock.context.mockImplementationOnce(hold);
        signal = () => mock.context.mock.calls[0]?.[0];
      } else {
        mock.run.mockImplementationOnce(hold);
        signal = () => mock.run.mock.calls[0]?.[4];
      }
      const { firstRenders, probes, rerender } = setup(
        { document: A },
        { probe: () => signal()?.aborted },
      );
      editEverything();
      start();
      // Waits for the held stage to start.
      await waitFor(() => expect(signal()).toBeDefined());
      if (stage === "cancelled recognition") {
        fireEvent.click(screen.getByText("Cancel OCR"));
        expect(screen.getByRole("status")).toHaveTextContent(
          "OCR cancelled. Any partial results remain incomplete.",
        );
      }
      rerender({ document: B });
      expect(probes.at(-1)).toBe(true);
      expect(signal()!.aborted).toBe(true);
      expect(firstRenders.at(-1)).toEqual(fresh);
      if (stage === "recognition" || stage === "cancelled recognition") {
        // A late progress callback from the old run.
        act(() =>
          mock.run.mock.calls[0]![5]({
            total: 2,
            completed: 2,
            failed: 0,
            remaining: 0,
            currentProgress: 1,
            pages: [{ ...page, text: "late private text" }],
          }),
        );
      }
      // Settles the held old-document stage after the switch.
      await act(async () => {
        if (stage === "failing read") reject(new Error("Local file unavailable"));
        else
          resolve(
            stage === "reading"
              ? new Blob(["pdf"])
              : stage === "context check"
                ? "dataset"
                : complete,
          );
      });
      expect(screen.queryByText(/late private text/)).not.toBeInTheDocument();
      expect(seen()).toEqual(fresh);
      expect(screen.getByText("Start selected-page OCR")).toBeEnabled();
      // A new run for the new document starts and completes normally.
      fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "1" } });
      start();
      // Waits for the new document's run to complete.
      expect(await screen.findByText(/Selected-page OCR finished/)).toBeVisible();
      expect(mock.read).toHaveBeenLastCalledWith(B, expect.any(AbortSignal));
      expect(mock.run).toHaveBeenLastCalledWith(
        expect.any(Blob),
        [1],
        "eng+rus",
        expect.objectContaining({
          dpi: DEFAULT_OCR_LIMITS.dpi,
          maxPixels: DEFAULT_OCR_LIMITS.maxPixels,
        }),
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(seen()).toMatchObject({
        rows: ["scan.pdf · original page 1 · Text found"],
        cancel: false,
        disabled: false,
      });
    },
  );

  it("keeps a validation message shown right after a switch", () => {
    const { rerender } = setup({ document: A });
    rerender({
      document: B,
      onCommit: () =>
        [...document.querySelectorAll("button")]
          .find((node) => node.textContent === "Start selected-page OCR")!
          .click(),
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Enter selected original page numbers separated by commas, such as 1, 3.",
    );
  });

  it("keeps edits made right after mount, right after a switch and across same-document re-renders, and runs OCR with them", async () => {
    const { rerender } = setup({
      document: A,
      onCommit: () => {
        edit("OCR original pages", "1");
        edit("OCR language", "rus");
      },
    });
    fireEvent.change(screen.getByLabelText("OCR Render DPI"), { target: { value: "100" } });
    const kept = () => [seen().selection, seen().language, seen().limits];
    const keptA = ["1", "Russian", ["20", "100", "60000", "8000000"]];
    expect(kept()).toEqual(keptA);
    // A new but equal document object, a changed name and a new onInspect keep everything.
    rerender({ document: { ...A } });
    rerender({ document: { ...A, name: "renamed.pdf" }, onInspect: vi.fn(async () => {}) });
    expect(kept()).toEqual(keptA);
    start();
    // Waits for the run on A to complete.
    await screen.findByText(/Selected-page OCR finished/);
    expect(mock.run).toHaveBeenLastCalledWith(
      expect.any(Blob),
      [1],
      "rus",
      { ...DEFAULT_OCR_LIMITS, dpi: 100 },
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(screen.getByText(/renamed.pdf · original page 1 · Text found/)).toBeVisible();
    rerender({
      document: B,
      onCommit: () => {
        edit("OCR original pages", "2, 4");
        edit("OCR language", "eng");
      },
    });
    fireEvent.change(screen.getByLabelText("OCR Pixels/page"), { target: { value: "5000000" } });
    const keptB = ["2, 4", "English", ["20", "120", "60000", "5000000"]];
    expect(kept()).toEqual(keptB);
    expect(seen()).toMatchObject({ rows: [], statuses: [] });
    rerender({ document: { ...B }, onInspect: vi.fn(async () => {}) });
    expect(kept()).toEqual(keptB);
    start();
    // Waits for the run on B to complete.
    await screen.findByText(/Selected-page OCR finished/);
    expect(mock.read).toHaveBeenLastCalledWith(B, expect.any(AbortSignal));
    expect(mock.run).toHaveBeenLastCalledWith(
      expect.any(Blob),
      [2, 4],
      "eng",
      { ...DEFAULT_OCR_LIMITS, maxPixels: 5_000_000 },
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it.each([false, true])(
    "keeps limit edits made after a digest-only switch once every effect for it has run (strict: %s)",
    async (strict) => {
      const { firstRenders, rerender } = setup({ document: A }, { strict });
      fireEvent.change(screen.getByLabelText("OCR Render DPI"), { target: { value: "150" } });
      fireEvent.change(screen.getByLabelText("OCR Pixels/page"), { target: { value: "4000000" } });
      rerender({
        document: B,
        onCommit: () => {
          // A limit edit in the layout phase of the switch commit, before any passive effect of that commit runs.
          editLimit("OCR Render DPI", "100");
          edit("OCR original pages", "1");
        },
      });
      // The real render-time reset: the new document's first render shows the default limits.
      expect(firstRenders.at(-1)).toEqual(fresh);
      // A limit edit as the first action after the switch, before a later (microtask or effect) reset could land.
      fireEvent.change(screen.getByLabelText("OCR Pixels/page"), { target: { value: "5000000" } });
      // Lets React finish every pending effect and microtask for the switch.
      await act(async () => {});
      const limits = ["20", "100", "60000", "5000000"];
      expect(limits).not.toEqual(fresh.limits);
      expect(seen().limits).toEqual(limits);
      start();
      // Waits for the run on B to complete.
      await screen.findByText(/Selected-page OCR finished/);
      expect(mock.read).toHaveBeenLastCalledWith(B, expect.any(AbortSignal));
      expect(mock.run).toHaveBeenLastCalledWith(
        expect.any(Blob),
        [1],
        "eng+rus",
        { ...DEFAULT_OCR_LIMITS, dpi: 100, maxPixels: 5_000_000 },
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(seen().limits).toEqual(limits);
    },
  );

  it("does not reset or abort OCR when the same document is re-rendered", async () => {
    mock.run.mockImplementationOnce(hold);
    const { rerender } = setup({ document: A });
    fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "1" } });
    start();
    // Waits for the held run to start.
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    const signal = mock.run.mock.calls[0]![4] as AbortSignal;
    rerender({ document: { ...A, name: "renamed.pdf" }, onInspect: vi.fn(async () => {}) });
    expect(signal.aborted).toBe(false);
    expect(seen()).toMatchObject({ cancel: true, disabled: true, selection: "1" });
    // Settles the held run; the same document keeps and publishes it.
    await act(async () => {
      resolve(complete);
    });
    expect(screen.getByText(/Selected-page OCR finished/)).toBeVisible();
    expect(screen.getByText(/renamed.pdf · original page 1 · Text found$/)).toBeVisible();
  });

  it("starts fresh when switching A -> B -> A", async () => {
    const { firstRenders, rerender } = setup({ document: A });
    editEverything();
    start();
    // Waits for the completed run to render.
    await screen.findByText(/Selected-page OCR finished/);
    rerender({ document: B });
    rerender({ document: A });
    expect(firstRenders.at(-1)).toEqual(fresh);
    expect(seen()).toEqual(fresh);
  });

  it("is correct under StrictMode: mount edits survive, switching resets and aborts, unmounting aborts", async () => {
    mock.run.mockImplementationOnce(hold);
    const signal = (call: number) => mock.run.mock.calls[call]?.[4] as AbortSignal | undefined;
    const { view, firstRenders, probes, rerender } = setup(
      { document: A, onCommit: () => edit("OCR original pages", "1") },
      { strict: true, probe: () => signal(0)?.aborted },
    );
    fireEvent.change(screen.getByLabelText("OCR Render DPI"), { target: { value: "100" } });
    expect(seen()).toMatchObject({ selection: "1", limits: ["20", "100", "60000", "8000000"] });
    start();
    // Waits for the held run to start.
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    expect(mock.run.mock.calls[0]![3]).toEqual({ ...DEFAULT_OCR_LIMITS, dpi: 100 });
    expect(signal(0)!.aborted).toBe(false);
    rerender({ document: B });
    expect(probes.at(-1)).toBe(true);
    expect(firstRenders.at(-1)).toEqual(fresh);
    mock.run.mockImplementationOnce(hold);
    fireEvent.change(screen.getByLabelText("OCR original pages"), { target: { value: "2" } });
    start();
    // Waits for the new document's held run to start.
    await waitFor(() => expect(mock.run).toHaveBeenCalledTimes(2));
    expect(signal(1)!.aborted).toBe(false);
    view.unmount();
    expect(signal(1)!.aborted).toBe(true);
    // Settles the held run after unmount; nothing may render.
    await act(async () => {
      resolve(complete);
    });
    expect(screen.queryByText("Exam")).not.toBeInTheDocument();
  });
});
