/** Session-local evidence. Never sent to the backend or interpreted as assessments. */
export type TextEvidence = { text: string; page: number; transform: number[]; width: number; height: number };
export type TextRow = { text: string; items: TextEvidence[] };
export type ExtractedPage = { page: number; width: number; height: number; status: "text" | "ocr_needed" | "blank"; rows: TextRow[] };
export type DocxLocation = { part: "word/document.xml"; bodyBlock: number; paragraph: number; table?: number; row?: number; cell?: number };
export type DocxParagraph = { id: string; text: string; location: DocxLocation };
export type DocxBlock = { kind: "paragraph"; paragraph: DocxParagraph } | { kind: "table"; id: string; table: number; bodyBlock: number; rows: { row: number; cells: { cell: number; paragraphs: DocxParagraph[] }[] }[] };
type LocalIdentity = { datasetId: string; courseId: string; digest: string; complete: true };
export type OcrExtraction = Omit<LocalIdentity, "complete"> & import("@/services/ocr-pdf").OcrJob & { format: "ocr" };
export type LocalExtraction = (LocalIdentity & ({ format: "pdf"; pages: ExtractedPage[] } | { format: "docx"; blocks: DocxBlock[] })) | OcrExtraction;
