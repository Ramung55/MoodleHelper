import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { buildDemoSnapshot } from "@/services/fixtures";
import { looksLikeHtml, SAVED_WEB_PAGE } from "@/domain/saved-web-page";

// #24: a lost Moodle session while importing a suggested file shows sign-in guidance.
// SDU answers a signed-out file URL with its HTML login page (HTTP 200, `body#page-login-index`,
// `lang-ru`; compatibility report Addendum 6, 2026-11-02). The page below is a SYNTHETIC stand-in
// with that observed shape; it is not a capture.
const LOGIN_PAGE =
  '<!DOCTYPE html>\n<html dir="ltr" lang="ru" xml:lang="ru">\n<head><title>Synthetic sign-in page</title></head>\n<body id="page-login-index" class="lang-ru path-login pagelayout-login rui-login-page"><form><input name="username"></form></body></html>';

const mock = vi.hoisted(() => ({
  saved: 0,
  jobs: [] as Array<{ state: string; message: string }>,
}));
vi.mock("@/lib/app-store", () => ({
  useApp: () => ({ snap: buildDemoSnapshot(), views: [], run: vi.fn() }),
}));
vi.mock("@/components/mh/ReconciliationReview", () => ({ ReconciliationReview: () => null }));
vi.mock("@/components/mh/SyllabusRevisionReview", () => ({ SyllabusRevisionReview: () => null }));
vi.mock("@/domain/syllabus-suggestions", () => ({
  rankSyllabusSuggestions: (s: { courses: Array<{ id: string }> }) => [
    {
      id: "suggested",
      title: "Synthetic syllabus",
      courseId: s.courses[0]!.id,
      type: "pdf",
      reason: "Title mentions syllabus",
      uncertain: false,
      link: "https://moodle.sdu.edu.kz/mod/resource/view.php?id=990201",
    },
  ],
}));
vi.mock("@/services/local-documents", () => ({
  currentDataset: async () => "first",
  recoverLocalJobs: async () => [],
  updateLocalJob: async (job: { state: string; message: string }) => {
    mock.jobs.push(job);
  },
  acquireLocalJobLease: async () => () => {},
  saveLocalDocument: async () => {
    mock.saved++;
    return "stored";
  },
  listLocalDocuments: async () => [],
}));
import { Syllabus } from "@/routes/syllabus";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mock.saved = 0;
  mock.jobs = [];
});

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

describe("looksLikeHtml", () => {
  it("recognises an HTML document after a BOM or whitespace, in any case", () => {
    expect(looksLikeHtml(bytes(LOGIN_PAGE))).toBe(true);
    expect(looksLikeHtml(bytes("﻿  \r\n<!doctype HTML><html>"))).toBe(true);
    expect(looksLikeHtml(bytes('<HTML lang="en">'))).toBe(true);
  });
  it("does not flag PDF, DOCX (ZIP) or text that only mentions html", () => {
    expect(looksLikeHtml(bytes("%PDF-1.7\n<html>"))).toBe(false);
    expect(looksLikeHtml(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]).buffer)).toBe(false);
    expect(looksLikeHtml(bytes("Notes about <html> tags"))).toBe(false);
    expect(looksLikeHtml(new ArrayBuffer(0))).toBe(false);
  });
});

describe("#24 suggested-file import after a lost Moodle session", () => {
  it("shows sign-in guidance with the fixed login link beside the suggestions", async () => {
    vi.stubGlobal("crypto", webcrypto);
    render(<Syllabus />);
    expect(await screen.findByText(/your Moodle session has ended/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sign in to SDU Moodle" })).toHaveAttribute(
      "href",
      "https://moodle.sdu.edu.kz/login/index.php",
    );
  });
  it.each(["Synthetic syllabus.pdf", "Synthetic syllabus.docx"])(
    "refuses a saved sign-in page named %s with sign-in guidance and stores nothing",
    async (name) => {
      vi.stubGlobal("crypto", webcrypto);
      render(<Syllabus />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Choose local file for this course" }),
      );
      expect(screen.getByText(/Selected resource: Synthetic syllabus/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText("Syllabus file")).toBeEnabled());
      const file = new File([LOGIN_PAGE], name);
      Object.defineProperty(file, "arrayBuffer", { value: async () => bytes(LOGIN_PAGE) });
      fireEvent.change(screen.getByLabelText("Syllabus file"), { target: { files: [file] } });
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(`Failed: ${SAVED_WEB_PAGE}`),
      );
      expect(mock.saved).toBe(0);
      expect(mock.jobs.at(-1)).toMatchObject({
        state: "failed",
        message: `Failed: ${SAVED_WEB_PAGE}`,
      });
      expect(screen.getByRole("button", { name: "Retry selected file" })).toBeInTheDocument();
    },
  );
});
