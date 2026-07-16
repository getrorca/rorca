import { redactMergeDiagnostics } from '../merge-handler';

describe('merge WAL redaction', () => {
  it('removes absolute workspace paths and patch lines from merge evidence', () => {
    const value = redactMergeDiagnostics(
      '--- /private/tmp/work/src/secret.ts\n+++ /private/tmp/work/src/secret.ts\n+token=secret\n@@ -1 +1 @@',
      '/private/tmp/work',
    );
    expect(value).not.toContain('/private/tmp/work');
    expect(value).not.toContain('token=secret');
    expect(value).toContain('[redacted-diff]');
  });
});
