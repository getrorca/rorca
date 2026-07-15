import { AppError, ValidationError } from '../src/lib/errors';

describe('errors', () => {
  it('creates validation errors', () => {
    expect(new ValidationError('bad')).toBeInstanceOf(AppError);
  });
});
