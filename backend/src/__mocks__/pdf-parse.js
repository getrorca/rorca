/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

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
