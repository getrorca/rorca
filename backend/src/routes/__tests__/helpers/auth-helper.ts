import type { Express } from 'express';
import request from 'supertest';

const testUser = {
  email: 'testauth@example.com',
  password: 'securepass123',
  displayName: 'Auth Test User',
};

/**
 * Register a test user and return the access token for use in Authorization headers.
 * Falls back to login if the user already exists.
 * Call this in beforeEach after resetting modules and creating the app.
 */
export async function getAuthToken(app: Express): Promise<string> {
  const regRes = await request(app).post('/api/auth/register').send(testUser);
  if (regRes.body.accessToken) return regRes.body.accessToken as string;
  // User already exists — log in instead
  const loginRes = await request(app).post('/api/auth/login').send({ email: testUser.email, password: testUser.password });
  return loginRes.body.accessToken as string;
}
