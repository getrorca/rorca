import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_TEST_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';
const APP_URL = 'http://localhost:5210';
const API_URL = 'http://localhost:3030';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function createSupabase(): SupabaseClient {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_TEST_ANON_KEY (or VITE_SUPABASE_ANON_KEY) is required');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: 'pkce',
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function registerThroughUi(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: /create account/i }).click();
}

async function loginThroughUi(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

async function injectSupabaseSession(page: import('@playwright/test').Page, email: string, password: string) {
  const supabase = createSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw error ?? new Error('Unable to create Supabase session');
  }

  await page.addInitScript(
    ({ url, anonKey, accessToken, refreshToken }) => {
      (window as any).__E2E_SUPABASE_SESSION__ = { url, anonKey, accessToken, refreshToken };
    },
    {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    },
  );

  await page.addInitScript(() => {
    const payload = (window as any).__E2E_SUPABASE_SESSION__;
    if (!payload) return;
    const key = `sb-${new URL(payload.url).hostname.split('.')[0]}-auth-token`;
    const session = {
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: 'bearer',
      user: { id: 'e2e-user-placeholder' },
    };
    window.localStorage.setItem(key, JSON.stringify(session));
  });
}

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
});

test.describe('Supabase auth flows', () => {
  test('register new user then access /specs', async ({ page }) => {
    const email = uniqueEmail('register');
    const password = 'Password123!';

    await registerThroughUi(page, email, password);
    await expect(page.getByText(/check your email|account created|verification email|you can now sign in/i)).toBeVisible();

    await loginThroughUi(page, email, password);
    await page.goto('/specs');
    await expect(page).toHaveURL(/\/specs$/);
  });

  test('login with invalid credentials shows inline error', async ({ page }) => {
    await page.goto('/auth/login');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('RequireAuth redirects to login with returnTo', async ({ page }) => {
    await page.goto('/specs');
    await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fspecs$/);
  });

  test('login respects returnTo and lands on /specs', async ({ page }) => {
    const email = uniqueEmail('returnto');
    const password = 'Password123!';

    await registerThroughUi(page, email, password);
    await page.goto('/auth/login?returnTo=%2Fspecs');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/specs$/);
  });

  test('logout redirects future protected access to login', async ({ page }) => {
    const email = uniqueEmail('logout');
    const password = 'Password123!';

    await registerThroughUi(page, email, password);
    await loginThroughUi(page, email, password);
    await page.goto('/settings/account');

    const logoutButton = page.getByRole('button', { name: /log out|logout|sign out/i }).first();
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();

    await page.goto('/specs');
    await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fspecs$/);
  });

  test('forgot password shows confirmation message', async ({ page }) => {
    await page.goto('/auth/forgot-password');
    await page.getByLabel('Email').fill(uniqueEmail('reset'));
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByText(/password reset email sent/i)).toBeVisible();
  });

  test('GitHub OAuth callback is handled via mocked Supabase exchange', async ({ page }) => {
    await page.route('**/auth/v1/token**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: {
            id: '11111111-1111-1111-1111-111111111111',
            email: 'github-user@example.com',
            aud: 'authenticated',
            role: 'authenticated',
          },
        }),
      });
    });

    await page.goto('/auth/callback?code=fake-code&returnTo=%2Fspecs');
    await expect(page).toHaveURL(/\/specs$/);
  });

  test('invite acceptance redirects through login and shows workspace toast path', async ({ page, request }) => {
    const email = uniqueEmail('invite');
    const password = 'Password123!';

    await registerThroughUi(page, email, password);

    const seedRes = await request.post(`${API_URL}/api/test/auth/seed-invite`, {
      data: { email, teamName: 'Invite E2E Workspace' },
    });
    expect(seedRes.ok()).toBeTruthy();
    const seed = await seedRes.json();

    await page.goto(`/invites/${seed.token}`);
    await expect(page.getByRole('heading', { name: /join invite e2e workspace/i })).toBeVisible();
    await page.getByRole('button', { name: /accept invite/i }).click();
    await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Finvites%2F/);

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(APP_URL + '/');
    await expect(page.getByText(/you joined invite e2e workspace/i)).toBeVisible();
  });
});
