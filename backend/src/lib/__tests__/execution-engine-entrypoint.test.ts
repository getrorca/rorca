import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveExecutionEngineEntrypoint } from '../execution-engine-entrypoint';

function makeWorkspace(rootName: 'src' | 'dist', files: Array<'execution-engine.ts' | 'execution-engine.js'>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-engine-entrypoint-${rootName}-`));
  const baseDir = path.join(root, rootName);
  const libDir = path.join(baseDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(libDir, file), '// test fixture\n', 'utf8');
  }
  return baseDir;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveExecutionEngineEntrypoint', () => {
  test('prefers execution-engine.ts in source mode', () => {
    const baseDir = makeWorkspace('src', ['execution-engine.ts', 'execution-engine.js']);

    const resolved = resolveExecutionEngineEntrypoint(baseDir);

    expect(resolved.exists).toBe(true);
    expect(resolved.extension).toBe('.ts');
    expect(resolved.path).toBe(path.join(baseDir, 'lib', 'execution-engine.ts'));
  });

  test('prefers execution-engine.js in compiled mode', () => {
    const baseDir = makeWorkspace('dist', ['execution-engine.ts', 'execution-engine.js']);

    const resolved = resolveExecutionEngineEntrypoint(baseDir);

    expect(resolved.exists).toBe(true);
    expect(resolved.extension).toBe('.js');
    expect(resolved.path).toBe(path.join(baseDir, 'lib', 'execution-engine.js'));
  });

  test('falls back to the available entrypoint when the preferred one is missing', () => {
    const baseDir = makeWorkspace('dist', ['execution-engine.ts']);

    const resolved = resolveExecutionEngineEntrypoint(baseDir);

    expect(resolved.exists).toBe(true);
    expect(resolved.extension).toBe('.ts');
    expect(resolved.path).toBe(path.join(baseDir, 'lib', 'execution-engine.ts'));
  });
});
