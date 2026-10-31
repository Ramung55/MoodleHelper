import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { LocalExtraction } from "@/components/mh/LocalExtraction";
import { buildDemoSnapshot } from "@/services/fixtures";
import type { LocalAssociation } from "@/services/local-documents";
import type { TeachingCalendar } from "@/domain/types";

const mock = vi.hoisted(() => ({
  read: vi.fn(),
  context: vi.fn(),
  extract: vi.fn(),
  route: vi.fn(),
  detect: vi.fn(),
  parse: vi.fn(),
  actual: {} as {
    detect?: (...args: unknown[]) => unknown;
    parse?: (...args: unknown[]) => unknown;
  },
}));
vi.mock("@/services/local-documents", () => ({
  readLocalDocument: mock.read,
  currentDataset: mock.context,
}));
vi.mock("@/services/extract-pdf", () => ({ extractPdf: mock.extract }));
vi.mock("@/services/route-local-syllabus", () => ({ routeLocalProposals: mock.route }));
vi.mock("@/domain/assessment-mentions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/assessment-mentions")>();
  mock.actual.detect = actual.detectAssessmentMentions;
  return { ...actual, detectAssessmentMentions: mock.detect };
});
vi.mock("@/domain/syllabus-dates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/syllabus-dates")>();
  mock.actual.parse = actual.parseSyllabusMention;
  return { ...actual, parseSyllabusMention: mock.parse };
});

const A: LocalAssociation = {
  datasetId: "dataset",
  courseId: "course",
  digest: "digest",
  name: "source.pdf",
  size: 10,
  source: "Local selection",
  createdAt: "now",
};
const TEXT = "Задание 1 29 октября";
const pages = [
  {
    page: 2,
    width: 500,
    height: 400,
    status: "text",
    rows: [
      {
        text: TEXT,
        items: [
          {
            text: "Задание 1",
            page: 2,
            transform: [12, 0, 0, 12, 40, 290],
            width: 100,
            height: 12,
          },
        ],
      },
    ],
  },
];
const calendar: TeachingCalendar = {
  startDate: "2026-09-01",
  endDate: "2026-12-31",
  timezone: "Asia/Almaty",
  excludedWeekStarts: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  mock.read.mockResolvedValue(new Blob(["pdf"]));
  mock.context.mockResolvedValue("dataset");
  mock.extract.mockResolvedValue(pages);
  mock.detect.mockImplementation((...args) => mock.actual.detect!(...args));
  mock.parse.mockImplementation((...args) => mock.actual.parse!(...args));
  let next = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:local-preview-${++next}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the page shows for the component, read from the DOM (the preview dialog is portalled into body). */
function seen() {
  const text = document.body.textContent ?? "";
  return {
    evidence: text.includes(TEXT),
    mentions: text.includes("Possible assessments · unconfirmed"),
    contextFieldset: text.includes("Explicit document context (optional)"),
    contextValues: [
      "Document numeric date order",
      "Document timezone",
      "Explicit semester start",
      "Explicit semester end",
    ].map(
      (label) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)?.value ?? null,
    ),
    statuses: [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent),
    preview: !!document.querySelector('iframe[title^="Original source.pdf"]'),
  };
}
const nothingCarried = {
  evidence: false,
  mentions: false,
  contextFieldset: false,
  contextValues: [null, null, null, null],
  statuses: [],
  preview: false,
};

/**
 * Records what is in the DOM in the layout phase of every commit that changes the association: after LocalExtraction's
 * DOM for that commit is in place, before the browser paints and before passive effects flush. This is the first render
 * of the new document as the user would see it.
 */
function OnAssociationCommit({
  document: association,
  record,
}: {
  document: LocalAssociation;
  record: (value: ReturnType<typeof seen>) => void;
}) {
  useLayoutEffect(() => {
    record(seen());
  }, [association.datasetId, association.courseId, association.digest]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

type Props = {
  document: LocalAssociation;
  teachingCalendar?: TeachingCalendar;
  commitRoute?: Parameters<typeof LocalExtraction>[0]["commitRoute"];
};
function setup(props: Props, strict = false) {
  const firstRenders: ReturnType<typeof seen>[] = [];
  const ui = (next: Props) => {
    const tree = (
      <>
        <LocalExtraction {...next} />
        <OnAssociationCommit
          document={next.document}
          record={(value) => firstRenders.push(value)}
        />
      </>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const view = render(ui(props));
  return { view, firstRenders, rerender: (next: Props) => view.rerender(ui(next)) };
}

/** Extracts, finds assessments, fills all four context fields, interprets dates and opens the original-page preview. */
async function fillEverything() {
  fireEvent.click(screen.getByText("Extract text"));
  // Waits for the extraction result to render.
  await screen.findByText(TEXT);
  fireEvent.click(screen.getByText("Find assessments"));
  // Waits for detection to show the mentions.
  await screen.findByText("Possible assessments · unconfirmed");
  fillContext();
  fireEvent.click(screen.getByText("Interpret explicit dates"));
  // Waits for date interpretation to finish.
  await screen.findByText(/Date proposals are ready for inspection/);
  fireEvent.click(screen.getByRole("button", { name: "Inspect original page 2" }));
  // Waits for the original-page preview dialog to open.
  await screen.findByTitle("Original source.pdf, page 2");
}
function fillContext() {
  fireEvent.change(screen.getByLabelText("Document numeric date order"), {
    target: { value: "DMY" },
  });
  fireEvent.change(screen.getByLabelText("Document timezone"), {
    target: { value: "Asia/Almaty" },
  });
  fireEvent.change(screen.getByLabelText("Explicit semester start"), {
    target: { value: "2026-09-01" },
  });
  fireEvent.change(screen.getByLabelText("Explicit semester end"), {
    target: { value: "2026-12-31" },
  });
}
const contextValues = () =>
  [
    "Document numeric date order",
    "Document timezone",
    "Explicit semester start",
    "Explicit semester end",
  ].map((label) => (screen.getByLabelText(label) as HTMLInputElement).value);
const keptContext = ["DMY", "Asia/Almaty", "2026-09-01", "2026-12-31"];

describe("LocalExtraction state belongs to one association (#71)", () => {
  it.each([
    ["digest", { digest: "re-imported" }],
    ["courseId", { courseId: "other-course" }],
    ["datasetId", { datasetId: "other-dataset" }],
  ])(
    "shows nothing from the previous document in the first render after %s changes",
    async (_field, change) => {
      const { firstRenders, rerender } = setup({ document: A });
      await fillEverything();
      expect(seen()).toMatchObject({
        evidence: true,
        mentions: true,
        contextFieldset: true,
        contextValues: keptContext,
        preview: true,
      });
      rerender({ document: { ...A, ...change } });
      // The layout-phase record of the switching commit: the new document's first render, before any passive effect.
      expect(firstRenders.at(-1)).toEqual(nothingCarried);
      // Right after the prop change, without waiting.
      expect(seen()).toEqual(nothingCarried);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-preview-1");
      expect(screen.getByText("Extract text")).toBeEnabled();
    },
  );

  it("is correct under StrictMode: switching clears, unmounting aborts and revokes", async () => {
    const { view, firstRenders, rerender } = setup({ document: A }, true);
    await fillEverything();
    rerender({ document: { ...A, digest: "re-imported" } });
    expect(firstRenders.at(-1)).toEqual(nothingCarried);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-preview-1");
    // The new document works from a fresh start and its own preview is released on unmount.
    let resolve!: (value: unknown) => void;
    mock.extract.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByText("Extract text"));
    // Waits for the held extraction to start, so its signal can be checked after unmount.
    await waitFor(() => expect(mock.extract).toHaveBeenCalledTimes(2));
    const signal = mock.extract.mock.calls[1]![1] as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    // Settles the held extraction after unmount; nothing may render.
    await act(async () => {
      resolve(pages);
    });
  });

  it.each(["extraction", "detection", "routing", "preview"] as const)(
    "ignores an old-document %s that finishes after the switch",
    async (work) => {
      let resolve!: (value: unknown) => void;
      const hold = () =>
        new Promise((done) => {
          resolve = done;
        });
      const publish = vi.fn();
      const commit = vi.fn(async (run: () => Promise<unknown>) => {
        try {
          publish(await run());
          return true;
        } catch {
          return false;
        }
      });
      const { rerender } = setup({ document: A, commitRoute: commit });
      let signal: () => AbortSignal | undefined = () => undefined;
      if (work === "extraction") {
        mock.extract.mockImplementationOnce(hold);
        fireEvent.click(screen.getByText("Extract text"));
        // Waits for the held extraction to start.
        await waitFor(() => expect(mock.extract).toHaveBeenCalledOnce());
        signal = () => mock.extract.mock.calls[0]![1];
      } else {
        fireEvent.click(screen.getByText("Extract text"));
        // Waits for the extraction result to render.
        await screen.findByText(TEXT);
        if (work === "detection") {
          mock.detect.mockImplementationOnce(hold);
          fireEvent.click(screen.getByText("Find assessments"));
          // Waits for the held detection to start.
          await waitFor(() => expect(mock.detect).toHaveBeenCalledOnce());
          signal = () => mock.detect.mock.calls[0]![1];
        } else if (work === "routing") {
          fireEvent.click(screen.getByText("Find assessments"));
          // Waits for detection to show the mentions.
          await screen.findByText("Possible assessments · unconfirmed");
          fireEvent.click(screen.getByText("Interpret explicit dates"));
          // Waits for date interpretation to finish, which enables routing.
          await screen.findByText(/Date proposals are ready for inspection/);
          mock.route.mockImplementationOnce(hold);
          fireEvent.click(screen.getByText("Retain evidence and route proposals"));
          // Waits for the held route to start.
          await waitFor(() => expect(mock.route).toHaveBeenCalledOnce());
          signal = () => mock.route.mock.calls[0]![5];
        } else {
          mock.read.mockImplementationOnce(hold);
          fireEvent.click(screen.getByRole("button", { name: "Inspect original page 2" }));
          // Waits for the held preview read to start.
          await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(2));
        }
      }
      rerender({ document: { ...A, digest: "re-imported" }, commitRoute: commit });
      if (work !== "preview") expect(signal()!.aborted).toBe(true);
      // Settles the held old-document work after the switch.
      await act(async () => {
        resolve(
          work === "extraction"
            ? pages
            : work === "detection"
              ? []
              : work === "routing"
                ? { snapshot: buildDemoSnapshot(), routes: [] }
                : new Blob(["pdf"]),
        );
      });
      expect(seen()).toEqual(nothingCarried);
      expect(publish).not.toHaveBeenCalled();
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      // Nothing is stuck pending: the new document can be extracted.
      expect(screen.getByText("Extract text")).toBeEnabled();
      fireEvent.click(screen.getByText("Extract text"));
      // Waits for the new document's own extraction result.
      expect(await screen.findByText(TEXT)).toBeVisible();
    },
  );

  it("keeps context edits made right after the fieldset appears and across same-association re-renders, and interprets with them", async () => {
    const first = vi.fn(async () => true);
    const { rerender } = setup({ document: A, teachingCalendar: calendar, commitRoute: first });
    fireEvent.click(screen.getByText("Extract text"));
    // Waits for the extraction result to render.
    await screen.findByText(TEXT);
    fireEvent.click(screen.getByText("Find assessments"));
    // Waits for detection to show the context fieldset; the edits below follow it immediately.
    await screen.findByText("Explicit document context (optional)");
    fillContext();
    expect(contextValues()).toEqual(keptContext);
    // A new but equal association object, a changed teachingCalendar and a new commitRoute keep everything.
    rerender({
      document: { ...A },
      teachingCalendar: { ...calendar, excludedWeekStarts: ["2026-10-05"] },
      commitRoute: vi.fn(async () => true),
    });
    expect(contextValues()).toEqual(keptContext);
    expect(seen()).toMatchObject({ evidence: true, mentions: true });
    rerender({ document: { ...A }, teachingCalendar: calendar, commitRoute: first });
    expect(contextValues()).toEqual(keptContext);
    fireEvent.click(screen.getByText("Interpret explicit dates"));
    // The proposal sits in a collapsed mention; presence is enough, the parse call below shows the context used.
    expect(await screen.findByText('{"kind":"date","date":"2026-10-29"}')).toBeInTheDocument();
    expect(mock.parse).toHaveBeenCalledWith(expect.anything(), {
      dateOrder: "DMY",
      timezone: { zone: "Asia/Almaty", source: "document" },
      semester: { start: "2026-09-01", end: "2026-12-31" },
    });
    expect(contextValues()).toEqual(keptContext);
  });

  it("does not reset or abort an extraction when the same association is re-rendered", async () => {
    let resolve!: (value: unknown) => void;
    mock.extract.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { rerender } = setup({ document: A });
    fireEvent.click(screen.getByText("Extract text"));
    // Waits for the held extraction to start.
    await waitFor(() => expect(mock.extract).toHaveBeenCalledOnce());
    const signal = mock.extract.mock.calls[0]![1] as AbortSignal;
    rerender({ document: { ...A }, teachingCalendar: calendar });
    expect(signal.aborted).toBe(false);
    expect(screen.getByText("Cancel extraction")).toBeVisible();
    // Settles the held extraction; the same association keeps its result.
    await act(async () => {
      resolve(pages);
    });
    expect(screen.getByText(TEXT)).toBeVisible();
  });

  it("starts fresh when switching A -> B -> A", async () => {
    const { rerender, firstRenders } = setup({ document: A });
    await fillEverything();
    rerender({ document: { ...A, digest: "other" } });
    rerender({ document: A });
    expect(firstRenders.at(-1)).toEqual(nothingCarried);
    expect(seen()).toEqual(nothingCarried);
  });

  it.each([
    ["a new document", [{ ...A, digest: "re-imported" }]],
    ["A -> B -> A", [{ ...A, digest: "re-imported" }, A]],
  ])(
    "re-extracting and re-detecting %s shows empty context fields and fresh mentions",
    async (_case, switches) => {
      const { rerender } = setup({ document: A });
      await fillEverything();
      fireEvent.click(screen.getByText("Задание 1 · assignment · Unconfirmed"));
      expect(screen.getByText('{"kind":"date","date":"2026-10-29"}')).toBeInTheDocument();
      for (const document of switches) rerender({ document });
      fireEvent.click(screen.getByText("Extract text"));
      // Waits for the new document's extraction result.
      await screen.findByText(TEXT);
      fireEvent.click(screen.getByText("Find assessments"));
      // Waits for the new document's detection to show the context fieldset.
      await screen.findByText("Explicit document context (optional)");
      expect(contextValues()).toEqual(["", "", "", ""]);
      expect(screen.getAllByText("Задание 1 · assignment · Unconfirmed")).toHaveLength(1);
      expect(screen.queryByText(/Date proposals are ready for inspection/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Original date expression/)).not.toBeInTheDocument();
      // Interpreting on the new document uses no context carried from the old one.
      mock.parse.mockClear();
      fireEvent.click(screen.getByText("Interpret explicit dates"));
      // Waits for date interpretation on the new document to finish.
      await screen.findByText(/Date proposals are ready for inspection/);
      expect(mock.parse).toHaveBeenCalledWith(expect.anything(), {
        dateOrder: undefined,
        timezone: undefined,
        semester: undefined,
      });
      expect(screen.getByText(/Missing year; no explicit semester/)).toBeInTheDocument();
    },
  );

  it("labels a new document's extraction as an extraction after a switch made mid-routing", async () => {
    let resolve!: (value: unknown) => void;
    const commit = vi.fn(async (run: () => Promise<unknown>) => {
      try {
        await run();
        return true;
      } catch {
        return false;
      }
    });
    const { rerender } = setup({ document: A, commitRoute: commit });
    fireEvent.click(screen.getByText("Extract text"));
    // Waits for the extraction result to render.
    await screen.findByText(TEXT);
    fireEvent.click(screen.getByText("Find assessments"));
    // Waits for detection to show the mentions.
    await screen.findByText("Possible assessments · unconfirmed");
    fireEvent.click(screen.getByText("Interpret explicit dates"));
    // Waits for date interpretation to finish, which enables routing.
    await screen.findByText(/Date proposals are ready for inspection/);
    mock.route.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByText("Retain evidence and route proposals"));
    // Waits for the never-settling route to start.
    await waitFor(() => expect(mock.route).toHaveBeenCalledOnce());
    expect(screen.getByText("Cancel routing")).toBeInTheDocument();
    rerender({ document: { ...A, digest: "re-imported" }, commitRoute: commit });
    mock.extract.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByText("Extract text"));
    // Waits for the new document's held extraction to start.
    await waitFor(() => expect(mock.extract).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Cancel extraction")).toBeInTheDocument();
    expect(screen.queryByText("Cancel routing")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel extraction"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Extraction cancelled. No complete result was saved.",
    );
    // Settles the cancelled extraction; nothing may render.
    await act(async () => {
      resolve(pages);
    });
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
  });

  it("aborts in-flight work and revokes the preview URL on unmount", async () => {
    const { view } = setup({ document: A });
    await fillEverything();
    let resolve!: (value: unknown) => void;
    mock.extract.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(screen.getByText("Extract text"));
    // Waits for the held second extraction to start while the preview stays open.
    await waitFor(() => expect(mock.extract).toHaveBeenCalledTimes(2));
    const signal = mock.extract.mock.calls[1]![1] as AbortSignal;
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-preview-1");
    // Settles the held extraction after unmount; nothing may render.
    await act(async () => {
      resolve(pages);
    });
  });
});
