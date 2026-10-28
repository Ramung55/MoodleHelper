/** Session-local evidence. Never sent to the backend or interpreted as assessments. */
export type TextEvidence = { text: string; page: number; transform: number[]; width: number; height: number };
export type TextRow = { text: string; items: TextEvidence[] };
export type ExtractedPage = { page: number; width: number; height: number; status: "text" | "ocr_needed" | "blank"; rows: TextRow[] };
export type LocalExtraction = { format: "pdf"; datasetId: string; courseId: string; digest: string; pages: ExtractedPage[]; complete: true };
