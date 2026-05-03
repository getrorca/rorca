import type { RequestHandler } from 'express';
import { isAgeAvailable } from './db-strategy';

let _ageAvailable: boolean | null = null;

export async function checkAge(): Promise<boolean> {
  if (_ageAvailable === null) {
    _ageAvailable = await isAgeAvailable();
  }
  return _ageAvailable;
}

export function invalidateAgeCache(): void {
  _ageAvailable = null;
}

export function getAgeUnavailableBody(): {
  error: string;
  code: 'AGE_NOT_INSTALLED';
  mode: 'lite';
  hint: string;
} {
  return {
    error: 'Apache AGE extension not available',
    code: 'AGE_NOT_INSTALLED',
    mode: 'lite',
    hint: 'Run `rorca db start` to enable graph memory (requires Docker)',
  };
}

export function requireAge(): RequestHandler {
  return async (_req, res, next) => {
    if (!(await checkAge())) {
      res.status(503).json(getAgeUnavailableBody());
      return;
    }
    next();
  };
}
