// Mock for pdf-parse — pdfjs-dist (used internally) requires browser APIs
// (DOMMatrix, ImageData, Path2D) that are not available in the Jest Node environment.
// This mock prevents the module from loading the full pdfjs-dist bundle in tests.

class PDFParse {
  constructor() {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async loadDocument(_data) {
    return { pages: [] };
  }
}

module.exports = { PDFParse };
module.exports.default = { PDFParse };
