// One shared import budget for browser extraction, durable opinions and HTTP.
// Model output has a separate, smaller budget in review-notes.mjs.
export const REVIEW_IMPORT_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  textBytes: 32 * 1024 * 1024,
  pdfPages: 2000,
  zipEntries: 4096,
  expandedXmlBytes: 128 * 1024 * 1024,
  httpBytes: 96 * 1024 * 1024,
  ordinaryHttpBytes: 8 * 1024 * 1024,
});
