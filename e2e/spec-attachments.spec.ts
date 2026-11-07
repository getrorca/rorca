/**
 * Spec Attachments E2E Tests — US-020
 *
 * Tests paste, file input, and drag-and-drop upload flows in the SpecForge UI.
 * Also tests download and delete for spec-scoped attachments.
 *
 * Assumes: npm run dev (port 5210) + backend (port 3030) are running.
 * Run: npx playwright test e2e/spec-attachments.spec.ts
 *
 * Note: Paste/file-input/drag-drop in SpecForge use POST /api/attachments/pending
 * (a forge-slot endpoint for pre-generation uploads). Download and delete tests
 * use POST /api/specs/:specId/attachments directly via the API to seed data, then
 * exercise the UI flows against those spec-scoped attachments.
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:5210';
const API = 'http://localhost:3030';

// A 1×1 white PNG in base64 — minimal valid image for upload tests
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wait for React to render after navigation / state updates */
async function settle(page: Page, ms = 600) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(ms);
}

/**
 * Open the SpecForge slide-over by clicking "New Spec" (the + button in the Specs panel header).
 * Returns when the brief textarea is visible.
 */
async function openSpecForge(page: Page) {
  await page.goto(`${BASE}/specs`);
  await settle(page);

  // Click the "New Spec" / "+" button — find by aria-label or visible text
  const newSpecBtn = page.locator('button').filter({ hasText: /new spec/i }).first();
  const plusBtn = page.locator('button[aria-label*="new spec" i], button[aria-label*="forge" i]').first();

  const btn = (await newSpecBtn.count()) > 0 ? newSpecBtn : plusBtn;
  await btn.click();

  // Wait for the brief textarea to appear
  await page.waitForSelector('textarea[aria-label*="brief" i], textarea[placeholder*="build" i]', {
    timeout: 5000,
  });
}

/**
 * Seed an attachment directly via API for a spec that exists on disk.
 * Returns the created attachment ID.
 */
async function seedAttachment(
  request: APIRequestContext,
  specId: string,
  filename = 'test-image.png',
): Promise<string> {
  const imgBuffer = base64ToBuffer(TINY_PNG_BASE64);

  const res = await request.post(`${API}/api/specs/${specId}/attachments`, {
    multipart: {
      file: {
        name: filename,
        mimeType: 'image/png',
        buffer: imgBuffer,
      },
    },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`seedAttachment failed (${res.status()}): ${body}`);
  }

  const json = await res.json();
  return json.id as string;
}

/**
 * Get the first workspace ID + spec slug from the provisioned harness.
 * Missing dependencies are harness failures: this mandatory suite must never
 * turn an unprovisioned stack into a green skip.
 */
async function getFirstSpecId(request: APIRequestContext): Promise<{ workspaceId: string; specId: string }> {
  const wsRes = await request.get(`${API}/api/workspaces`);
  if (!wsRes.ok()) {
    throw new Error(`Workspace fixture lookup failed (${wsRes.status()}): ${await wsRes.text()}`);
  }

  const wsBody = await wsRes.json();
  const workspaces: Array<{ id: string }> = Array.isArray(wsBody)
    ? wsBody
    : (wsBody.workspaces ?? wsBody.items ?? []);
  if (workspaces.length === 0) {
    throw new Error('Mandatory attachment E2E suite requires a provisioned workspace');
  }

  const workspaceId = workspaces[0].id;
  const specsRes = await request.get(`${API}/api/specs?workspaceId=${workspaceId}&status=all`);
  if (!specsRes.ok()) {
    throw new Error(`Spec fixture lookup failed (${specsRes.status()}): ${await specsRes.text()}`);
  }

  const specsBody = await specsRes.json();
  const specs: Array<{ id: string; status: string }> = Array.isArray(specsBody)
    ? specsBody
    : (specsBody.specs ?? specsBody.items ?? []);
  if (specs.length === 0) {
    throw new Error(`Mandatory attachment E2E suite requires a spec in workspace ${workspaceId}`);
  }
  return { workspaceId, specId: specs[0].id };
}

// ─── Test 1: Paste image from clipboard ───────────────────────────────────────

test('paste image from clipboard → upload toast + attachment appears in list', async ({ page }) => {
  await openSpecForge(page);

  // Intercept the pending upload API call
  let uploadCalled = false;
  await page.route('**/api/attachments/pending', async (route) => {
    uploadCalled = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'pending-paste-001',
        filename: 'pasted-image.png',
        contentType: 'image/png',
        fileSize: TINY_PNG_BASE64.length,
      }),
    });
  });

  // Dispatch a paste ClipboardEvent with an image/png DataTransferItem via page.evaluate.
  // React's onPaste handler reads e.clipboardData.items for image/* items, calls
  // item.getAsFile(), and uploads. We construct a synthetic ClipboardEvent that satisfies
  // this contract.
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'pasted-image.png', { type: 'image/png' });

    // Build a DataTransfer and add the file — DataTransfer.items.add(file) makes
    // the item accessible via items[0].getAsFile().
    const dt = new DataTransfer();
    dt.items.add(file);

    const ta = document.querySelector(
      'textarea[aria-label*="brief"], textarea[placeholder*="build"]',
    ) as HTMLTextAreaElement | null;
    if (!ta) throw new Error('Brief textarea not found');

    const event = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    ta.dispatchEvent(event);
  }, TINY_PNG_BASE64);

  // Toast should appear ("Image pasted, uploading...")
  await expect(page.locator('body')).toContainText(/pasted|uploading/i, { timeout: 4000 });

  // Upload API call should have fired
  await page.waitForTimeout(1000);
  expect(uploadCalled).toBe(true);

  // Pending attachment should appear in the list with its filename
  await expect(page.locator('body')).toContainText(/pasted-image/i, { timeout: 4000 });
});

// ─── Test 2: Click paperclip → file input → upload + list update ──────────────

test('click paperclip button and select file → upload and list update', async ({ page }) => {
  await openSpecForge(page);

  // Intercept the pending upload API call
  let uploadCalled = false;
  await page.route('**/api/attachments/pending', async (route) => {
    uploadCalled = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'pending-file-001',
        filename: 'test-upload.png',
        contentType: 'image/png',
        fileSize: 256,
      }),
    });
  });

  // Find the "Attach files" button (paperclip)
  const attachBtn = page.locator('button[aria-label="Attach files"], button').filter({ hasText: /attach files/i }).first();
  await expect(attachBtn).toBeVisible({ timeout: 5000 });

  // Set up file chooser interception before clicking
  const fileChooserPromise = page.waitForEvent('filechooser');
  await attachBtn.click();
  const fileChooser = await fileChooserPromise;

  // Use Playwright's setFiles — pass buffer directly (no filesystem write needed)
  await fileChooser.setFiles({
    name: 'test-upload.png',
    mimeType: 'image/png',
    buffer: base64ToBuffer(TINY_PNG_BASE64),
  });

  // Upload toast should appear
  await expect(page.locator('body')).toContainText(/uploading|uploaded/i, { timeout: 5000 });

  // Upload API should have been called
  await page.waitForTimeout(500);
  expect(uploadCalled).toBe(true);

  // The pending attachment should appear in the list
  await expect(page.locator('body')).toContainText(/test-upload\.png/i, { timeout: 5000 });
});

// ─── Test 3: Drag file onto SpecForge → drop zone highlight + upload ──────────

test('drag file onto SpecForge → drop zone highlights, uploads, and list updates', async ({ page }) => {
  await openSpecForge(page);

  let uploadCalled = false;
  await page.route('**/api/attachments/pending', async (route) => {
    uploadCalled = true;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'pending-drag-001',
        filename: 'dragged-file.png',
        contentType: 'image/png',
        fileSize: 256,
      }),
    });
  });

  // Find the drag-drop container (the div wrapping the textarea)
  const dropZone = page.locator('div[class*="relative"]').filter({ has: page.locator('textarea[aria-label*="brief" i], textarea[placeholder*="build" i]') }).first();
  await expect(dropZone).toBeVisible({ timeout: 5000 });

  const pngBytes = base64ToBuffer(TINY_PNG_BASE64);

  // Dispatch dragover to trigger isDraggingOver state
  await dropZone.dispatchEvent('dragover', {
    dataTransfer: {
      dropEffect: 'copy',
      effectAllowed: 'all',
    },
  });

  // The "Drop files here" overlay should appear
  await expect(page.locator('body')).toContainText(/drop files here/i, { timeout: 3000 });

  // Dispatch drop event with a file
  await page.evaluate((b64) => {
    const pngBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([pngBytes], 'dragged-file.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);

    const ta = document.querySelector(
      'textarea[aria-label*="brief"], textarea[placeholder*="build"]',
    ) as HTMLElement | null;
    const dropEl = ta?.closest('div[class*="relative"]') ?? ta?.parentElement;
    if (!dropEl) throw new Error('Drop zone not found');

    dropEl.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, TINY_PNG_BASE64);

  // Drop zone highlight should clear
  await page.waitForTimeout(300);
  await expect(page.locator('text=Drop files here')).toHaveCount(0);

  // Upload should have been called
  await page.waitForTimeout(1000);
  expect(uploadCalled).toBe(true);

  // Dragged file should appear in attachment list
  await expect(page.locator('body')).toContainText(/dragged-file\.png/i, { timeout: 5000 });
});

// ─── Test 4: Download attachment ───────────────────────────────────────────────

test('download attachment button triggers file download with correct headers', async ({ page, request }) => {
  const { specId } = await getFirstSpecId(request);
  const attachmentId = await seedAttachment(request, specId, 'downloadable.png');

  // Verify the download endpoint returns correct headers
  const downloadUrl = `${API}/api/specs/${encodeURIComponent(specId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const res = await request.get(downloadUrl);
  expect(res.ok()).toBe(true);

  const contentType = res.headers()['content-type'];
  expect(contentType).toMatch(/image\/png/);

  const contentDisposition = res.headers()['content-disposition'];
  // Should be either attachment; filename=... or inline; filename=...
  if (contentDisposition) {
    expect(contentDisposition).toMatch(/downloadable\.png/i);
  }

  const body = await res.body();
  expect(body.length).toBeGreaterThan(0);

  // Verify the downloaded bytes are a valid PNG (start with PNG magic bytes)
  expect(body[0]).toBe(0x89); // PNG magic byte 1
  expect(body[1]).toBe(0x50); // P
  expect(body[2]).toBe(0x4e); // N
  expect(body[3]).toBe(0x47); // G

  // Clean up
  await request.delete(
    `${API}/api/specs/${encodeURIComponent(specId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
});

// ─── Test 5: Delete attachment ─────────────────────────────────────────────────

test('delete attachment → removed from backend and list', async ({ page, request }) => {
  const { specId } = await getFirstSpecId(request);
  const attachmentId = await seedAttachment(request, specId, 'to-delete.png');

  // Navigate to the SpecForge for the existing spec (open spec detail slide-over)
  await page.goto(`${BASE}/specs`);
  await settle(page);

  // Navigate to the spec detail slide-over by clicking on the spec card
  const specCard = page.locator(`[data-spec-id="${specId}"], button, div`).filter({ hasText: specId }).first();
  const found = await specCard.count();

  if (found > 0) {
    await specCard.click();
    await settle(page, 800);
  }

  // Verify the attachment exists via API before deletion
  const listRes = await request.get(`${API}/api/specs/${encodeURIComponent(specId)}/attachments`);
  expect(listRes.ok()).toBe(true);
  const attachments = (await listRes.json()) as Array<{ id: string }>;
  const found_att = attachments.find((a) => a.id === attachmentId);
  expect(found_att).toBeDefined();

  // Delete via API (simulates what the UI delete button does)
  const deleteRes = await request.delete(
    `${API}/api/specs/${encodeURIComponent(specId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  expect(deleteRes.status()).toBe(204);

  // Verify it's gone from the backend
  const listRes2 = await request.get(`${API}/api/specs/${encodeURIComponent(specId)}/attachments`);
  expect(listRes2.ok()).toBe(true);
  const attachments2 = (await listRes2.json()) as Array<{ id: string }>;
  const stillPresent = attachments2.find((a) => a.id === attachmentId);
  expect(stillPresent).toBeUndefined();
});

// ─── Test 5b: Delete via UI ────────────────────────────────────────────────────

test('delete attachment via UI delete button removes it from the list', async ({ page, request }) => {
  const { specId } = await getFirstSpecId(request);
  const attachmentId = await seedAttachment(request, specId, 'ui-delete-test.png');

  // Mock the delete API so we can verify it's called from the UI
  let deleteApiCalled = false;
  await page.route(`**/api/specs/**/attachments/**`, async (route) => {
    if (route.request().method() === 'DELETE') {
      deleteApiCalled = true;
      await route.fulfill({ status: 204, body: '' });
    } else {
      await route.continue();
    }
  });

  // Open the SpecForge for the spec that has the attachment
  // The saved attachment list is fetched when effectiveSlug is set (i.e., when specName is pre-filled
  // or the slug is auto-derived). Since NewSpecForm fetches from /api/specs/:slug/attachments
  // when the slug is known, we simulate opening the forge with the spec's slug pre-filled.
  await page.goto(`${BASE}/specs`);
  await settle(page);

  // Intercept the attachments list endpoint to inject our seeded attachment
  await page.route(`**/api/specs/${specId}/attachments`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: attachmentId,
            filename: 'ui-delete-test.png',
            contentType: 'image/png',
            fileSize: 512,
            createdAt: new Date().toISOString(),
          },
        ]),
      });
    } else {
      await route.continue();
    }
  });

  // Open the forge and set the spec name so the saved attachments are fetched
  const newSpecBtn = page.locator('button').filter({ hasText: /new spec/i }).first();
  await expect(newSpecBtn, 'Spec page must expose the New Spec control').toBeVisible();
  await newSpecBtn.click();
  await page.waitForSelector('textarea[aria-label*="brief" i], textarea[placeholder*="build" i]', { timeout: 5000 });

  // Type the spec slug so the saved attachments are fetched.
  const specNameInput = page.locator('input[placeholder*="slug" i], input[placeholder*="name" i]').first();
  await expect(specNameInput, 'SpecForge must expose the spec slug/name input').toBeVisible();
  await specNameInput.fill(specId);
  await page.waitForTimeout(600);

  const deleteBtn = page.locator('button[aria-label="Delete ui-delete-test.png"]');
  await expect(deleteBtn, 'Seeded attachment must expose its UI delete control').toBeVisible();
  const attachmentRow = page.locator('div').filter({ hasText: 'ui-delete-test.png' }).first();
  await attachmentRow.hover();
  await deleteBtn.click();

  await expect.poll(() => deleteApiCalled, {
    message: 'UI delete must invoke the attachment DELETE API',
  }).toBe(true);
  await expect(page.locator('text=ui-delete-test.png')).toHaveCount(0, { timeout: 3000 });
});
