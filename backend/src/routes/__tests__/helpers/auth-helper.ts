import type { Express } from 'express';
import request from 'supertest';

const testUser = {
  email: 'testauth@example.com',
  password: 'securepass123',
  displayName: 'Auth Test User',
};

/**
 * Register a test user and return the access token for use in Authorization headers.
 * Call this in beforeEach after resetting modules and creating the app.
 */
export async function getAuthToken(app: Express): Promise<string> {
  const res = await request(app).post('/api/auth/register').send(testUser);
  return res.body.accessToken as string;
}
