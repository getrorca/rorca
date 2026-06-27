import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evaluateSecretProfileReadiness, getAgentCredentialChecks, hasAgentCredentials, resolveSecretProfileEnvironment } from '../secret-resolver';

describe('secret-resolver', () => {
  it('detects env-backed agent credentials without exposing values', () => {
    const env = { OPENAI_API_KEY: 'secret-value' } as NodeJS.ProcessEnv;
    expect(hasAgentCredentials('codex', env, '/tmp/no-home')).toBe(true);
    const checks = getAgentCredentialChecks('codex', env, '/tmp/no-home');
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'codex.env', ok: true })]));
    expect(JSON.stringify(checks)).not.toContain('secret-value');
  });

  it('treats host-local profiles as runner-host evaluated', () => {
    const readiness = evaluateSecretProfileReadiness({
      id: 'local-host-auth',
      label: 'Local host auth',
      provider: 'host-local',
      config: {},
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.checks[0].name).toBe('host-local');
  });

  it('keeps Infisical optional but reports missing machine identity inputs', () => {
    const readiness = evaluateSecretProfileReadiness({
      id: 'infisical-prod',
      label: 'Infisical prod',
      provider: 'infisical',
      config: {},
    }, {}, '/tmp/no-home');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('infisical_credentials_missing');
  });

  it('materializes env profiles from the current process environment', () => {
    const resolved = resolveSecretProfileEnvironment({
      id: 'env-profile',
      label: 'Env profile',
      provider: 'env',
      config: { env: ['OPENAI_API_KEY', 'MISSING_KEY'] },
    }, { env: { OPENAI_API_KEY: 'secret-value' } as NodeJS.ProcessEnv });
    expect(resolved.env).toEqual({ OPENAI_API_KEY: 'secret-value' });
    expect(resolved.warnings).toContain('env_missing:MISSING_KEY');
  });

  it('materializes mounted-file profiles from dotenv and mapped files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-secret-test-'));
    fs.writeFileSync(path.join(dir, '.env'), 'OPENROUTER_API_KEY=from-dotenv\n# ignored\n');
    fs.writeFileSync(path.join(dir, 'anthropic'), 'from-file\n');
    const resolved = resolveSecretProfileEnvironment({
      id: 'file-profile',
      label: 'File profile',
      provider: 'mounted-file',
      config: {
        dotenvFiles: [path.join(dir, '.env')],
        files: [{ env: 'ANTHROPIC_API_KEY', path: path.join(dir, 'anthropic') }],
      },
    });
    expect(resolved.env.OPENROUTER_API_KEY).toBe('from-dotenv');
    expect(resolved.env.ANTHROPIC_API_KEY).toBe('from-file');
  });

  it('materializes Infisical profiles through the optional CLI without exposing values in readiness', () => {
    const execFile = jest.fn(() => JSON.stringify([{ secretKey: 'OPENAI_API_KEY', secretValue: 'from-infisical' }])) as any;
    const resolved = resolveSecretProfileEnvironment({
      id: 'infisical-profile',
      label: 'Infisical profile',
      provider: 'infisical',
      config: { projectId: 'proj', environment: 'dev', path: '/rorca' },
    }, { env: { INFISICAL_CLIENT_ID: 'id', INFISICAL_CLIENT_SECRET: 'secret' } as NodeJS.ProcessEnv, execFile });
    expect(execFile).toHaveBeenCalledWith('infisical', expect.arrayContaining(['export', '--format=json', '--projectId', 'proj', '--env', 'dev', '--path', '/rorca']), expect.any(Object));
    expect(resolved.env).toEqual({ OPENAI_API_KEY: 'from-infisical' });
    expect(resolved.warnings).toEqual([]);
  });
});
