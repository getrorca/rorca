/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-message' });
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: mockCreateTransport },
}));

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn() } })),
}));

describe('email security boundaries', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'operator@example.test';
    process.env.SMTP_PASS = 'not-a-real-secret';
    delete process.env.RESEND_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    mockSendMail.mockClear();
    mockCreateTransport.mockClear();
    jest.resetModules();
  });

  it('disables message file/URL dereferencing and escapes HTML-controlled fields', async () => {
    const { sendTeamInviteEmail } = await import('../email');

    await sendTeamInviteEmail(
      'recipient@example.test',
      '<img src=x onerror=alert(1)>',
      'Team & "friends"',
      'https://rorca.test/invite?next=" onmouseover="alert(1)',
    );

    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({
      disableFileAccess: true,
      disableUrlAccess: true,
    }));
    expect(mockSendMail).toHaveBeenCalledTimes(1);

    const message = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(message).toEqual(expect.objectContaining({
      disableFileAccess: true,
      disableUrlAccess: true,
    }));
    expect(message).not.toHaveProperty('raw');
    expect(message).not.toHaveProperty('attachments');

    const html = String(message.html);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Team &amp; &quot;friends&quot;');
    expect(html).toContain('next=&quot; onmouseover=&quot;alert(1)');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
