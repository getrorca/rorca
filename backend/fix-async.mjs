/**
 * Find all non-async functions/arrow-functions containing `await` and add `async`.
 *
 * Patterns to fix:
 * 1. `router.get('/path', (req, res) => {`  → `router.get('/path', async (req, res) => {`
 * 2. `function foo() {`  → `async function foo() {`
 * 3. `const foo = () => {`  → `const foo = async () => {`
 * 4. `(req: Request, res: Response) => {`  → `async (req: Request, res: Response) => {`
 */

import fs from 'fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node fix-async.mjs <file.ts>');
  process.exit(1);
}

let content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

// Build a map of function boundaries
// For each line, track what function scope it's in and whether that function is async

// Simple approach: scan for function-defining lines, track brace depth,
// and mark functions that contain await as needing async

function findFunctionBoundaries(lines) {
  const functions = [];
  const braceStack = []; // Stack of { startLine, isAsync, containsAwait }

  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if line defines a function
    // Router handler: router.get('/path', (params) => {
    // Router handler with middleware: router.get('/path', middleware, (params) => {
    // Function declaration: function name(params) {
    // Arrow function: const name = (params) => {
    // Arrow function: (params) => {

    // Count braces in line (simplified — doesn't handle braces in strings)
    let lineOpenBraces = 0;
    let lineCloseBraces = 0;
    let inString = false;
    let stringChar = '';

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inString) {
        if (ch === '\\') { j++; continue; }
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '/' && line[j+1] === '/') break; // comment
      if (ch === '{') lineOpenBraces++;
      if (ch === '}') lineCloseBraces++;
    }

    // Track brace depth changes
    for (let b = 0; b < lineCloseBraces; b++) {
      braceDepth--;
      if (braceStack.length > 0 && braceStack[braceStack.length - 1].depth === braceDepth) {
        const fn = braceStack.pop();
        fn.endLine = i;
        functions.push(fn);
      }
    }

    // Check for function definitions
    const isAsync = /\basync\b/.test(line);

    // Arrow function in route handler
    const routeMatch = line.match(/router\.\w+\s*\(\s*['"`\/].*?,\s*(async\s+)?\(/);
    const middlewareRouteMatch = line.match(/router\.\w+\s*\(.*?,\s*(async\s+)?\([^)]*\)\s*(:\s*\w+)?\s*=>/);
    const arrowMatch = line.match(/(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/) ||
                       line.match(/(const|let|var)\s+\w+\s*=\s*(async\s+)?(\([^)]*\)|[a-zA-Z_]\w*)\s*=>/);
    const funcMatch = line.match(/(export\s+)?(async\s+)?function\s+\w+/);
    const callbackMatch = line.match(/,\s*(async\s+)?\([^)]*\)\s*(:\s*\w+)?\s*=>\s*\{/);

    let isFuncDef = false;

    if (routeMatch || middlewareRouteMatch || arrowMatch || funcMatch || callbackMatch) {
      isFuncDef = true;
    }

    for (let b = 0; b < lineOpenBraces; b++) {
      if (isFuncDef && b === lineOpenBraces - 1) {
        // This is a function opening brace
        braceStack.push({
          startLine: i,
          depth: braceDepth,
          isAsync,
          containsAwait: false,
        });
        isFuncDef = false; // Only first function on this line
      }
      braceDepth++;
    }

    // Check if line contains await
    if (/\bawait\b/.test(line)) {
      // Mark the innermost function scope
      if (braceStack.length > 0) {
        braceStack[braceStack.length - 1].containsAwait = true;
      }
    }
  }

  return functions;
}

const functions = findFunctionBoundaries(lines);

let changed = 0;

// For each function that contains await but isn't async, add async
for (const fn of functions) {
  if (fn.containsAwait && !fn.isAsync) {
    const line = lines[fn.startLine];

    // Try various patterns to add async

    // Pattern 1: router.method('/path', (params) => {
    let newLine = line.replace(/(\.\w+\s*\([^,]*(?:,\s*\w+\s*)*,\s*)\(\s*/, '$1async (');

    // Pattern 2: function name(
    if (newLine === line) {
      newLine = line.replace(/(export\s+)?function\s+/, '$1async function ');
    }

    // Pattern 3: const name = (params) => {
    if (newLine === line) {
      newLine = line.replace(/(const|let|var)(\s+\w+\s*=\s*)\(/, '$1$2async (');
    }

    // Pattern 4: , (params) => {   (middleware callback)
    if (newLine === line) {
      newLine = line.replace(/,\s*\(([^)]*)\)\s*=>\s*\{/, ', async ($1) => {');
    }

    // Pattern 5: (params) => { (standalone arrow)
    if (newLine === line) {
      newLine = line.replace(/^(\s*)\(([^)]*)\)\s*=>\s*\{/, '$1async ($2) => {');
    }

    if (newLine !== line) {
      lines[fn.startLine] = newLine;
      changed++;
    }
  }
}

fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
console.log(`Added 'async' to ${changed} functions in ${filePath}`);
