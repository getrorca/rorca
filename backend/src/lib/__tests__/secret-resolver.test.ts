import { evaluateSecretProfileReadiness, getAgentCredentialChecks, hasAgentCredentials } from '../secret-resolver';

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
});
