import { apiFetch } from '../src/lib/apiFetch';

describe('apiFetch.test', () => {
  it('exports apiFetch helper', () => {
    expect(typeof apiFetch).toBe('function');
  });
});
