// CJS mock for chokidar v5 (ESM-only) — used by Jest test runner
const mockWatcher = {
  on: jest.fn().mockReturnThis(),
  close: jest.fn().mockResolvedValue(undefined),
  add: jest.fn().mockReturnThis(),
  unwatch: jest.fn().mockReturnThis(),
};

const chokidar = {
  watch: jest.fn().mockReturnValue(mockWatcher),
};

module.exports = chokidar;
module.exports.default = chokidar;
