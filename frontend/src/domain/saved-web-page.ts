// A signed-out SDU Moodle file URL answers with the HTML login page (HTTP 200, compatibility
// report Addendum 6), so a "PDF" or "DOCX" that is really a web page most likely means the
// student's Moodle session ended, not that the document is corrupt.
export const SAVED_WEB_PAGE =
  "This file is a web page, not a PDF or DOCX. If it is the SDU Moodle sign-in page, your Moodle session has ended: sign in to SDU Moodle, download the file again and choose the new copy.";

/** True when the file starts (after an optional BOM and whitespace) with an HTML document. */
export function looksLikeHtml(bytes: ArrayBuffer): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 512))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}
