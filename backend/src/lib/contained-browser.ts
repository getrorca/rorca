/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { UnprocessableError } from './errors';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  BrowserServer,
  Download,
  Page,
  Request,
} from 'playwright';

/**
 * Playwright is an optional runtime dependency: the compiled CLI ships without
 * it, and browser capture is only available when the package is installed
 * alongside the binary. Loading it lazily keeps `rorca start` bootable in a
 * release install instead of failing at module load.
 */
async function loadChromium(): Promise<typeof import('playwright').chromium> {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch (err) {
    throw new UnprocessableError(
      'Browser capture requires the optional "playwright" package. Install it with `npm i playwright` in the Rorca install directory, then restart.'
    );
  }
}

export type BrowserPartition = Readonly<{ programId: string; missionId: string; accountId: string; role: string }>;
export type BrowserEffect = 'document' | 'frame' | 'subresource' | 'popup' | 'form' | 'download' | 'websocket' | 'upload';
export type BrowserGrant = Readonly<{ artifactId: string; expiresAt: number }>;
export type BrowserAction =
  | Readonly<{ type: 'navigate'; url: string }>
  | Readonly<{ type: 'click'; selector: string }>
  | Readonly<{ type: 'fill'; selector: string; value: string }>
  | Readonly<{ type: 'select'; selector: string; value: string }>
  | Readonly<{ type: 'check'; selector: string; checked: boolean }>
  | Readonly<{ type: 'readText'; selector: string }>
  | Readonly<{ type: 'upload'; selector: string; grant: BrowserGrant }>;

export interface BrowserAuthorization {
  authorize(input: { partition: BrowserPartition; effect: BrowserEffect; url: string; method?: string }): boolean | Promise<boolean>;
  /** Resolve an opaque, previously admitted artifact ID. Never accepts a worker-supplied path. */
  resolveAdmittedArtifact(artifactId: string, partition: BrowserPartition): string | undefined | Promise<string | undefined>;
}

export type BrowserAuthenticationSignal =
  | 'login_prompt'
  | 'consent_prompt'
  | 'mfa_prompt'
  | 'passkey_prompt'
  | 'captcha_challenge'
  | 'account_lock_notice'
  | 'provider_step_up_prompt'
  | 'anti_automation_notice';

export interface BrowserAuthenticationSnapshot {
  signal: BrowserAuthenticationSignal | null;
  currentOrigin: string | null;
  providerStateDigest: `sha256:${string}`;
  accessibilityDigest: `sha256:${string}`;
  screenshotDigest: `sha256:${string}` | null;
  authenticatedSessionObserved: boolean;
}

export interface RedactedBrowserNetworkMetadata {
  observedAt: string;
  origin: string | null;
  pathDigest: `sha256:${string}`;
  method: string;
  effect: BrowserEffect;
  decision: 'allowed' | 'denied';
}

export interface RedactedBrowserEvidenceCapture {
  currentOrigin: string | null;
  screenshot: Buffer;
  screenshotDigest: `sha256:${string}`;
  accessibilitySnapshot: string;
  accessibilityDigest: `sha256:${string}`;
  networkMetadata: RedactedBrowserNetworkMetadata[];
  providerStateDigest: `sha256:${string}`;
  authenticatedSessionObserved: boolean;
  redaction: 'sensitive-elements-masked-and-accessible-text-removed';
}

/** A fresh, non-persistent browser context. It never exposes Browser/CDP/Page objects to workers. */
export class ContainedBrowser {
  readonly id = randomUUID();
  readonly quarantinePath: string;
  #server?: BrowserServer;
  #browser?: Browser;
  #context?: BrowserContext;
  #recoveryEndpoint?: string;
  #page?: Page;
  #stopped = false;
  #automationSuspended = false;
  #networkMetadata: RedactedBrowserNetworkMetadata[] = [];

  constructor(
    readonly partition: BrowserPartition,
    private readonly authorization: BrowserAuthorization,
    quarantineRoot: string,
    private readonly options: { headless?: boolean } = {},
  ) {
    if (Object.values(partition).some(value => !value.trim())) throw new Error('Browser partition fields are required');
    this.quarantinePath = path.join(quarantineRoot, this.id);
  }

  async start(storageState?: Exclude<BrowserContextOptions['storageState'], string>): Promise<void> {
    if (this.#context || this.#stopped) throw new Error('Browser partition cannot be reused');
    await mkdir(this.quarantinePath, { recursive: true, mode: 0o700 });
    const chromium = await loadChromium();
    this.#server = await chromium.launchServer({ headless: this.options.headless ?? true });
    this.#recoveryEndpoint = this.#server.wsEndpoint();
    this.#browser = await chromium.connect(this.#recoveryEndpoint);
    this.#context = await this.#browser.newContext({
      acceptDownloads: true,
      serviceWorkers: 'block',
      permissions: [],
      extraHTTPHeaders: { 'Sec-GPC': '1' },
      storageState,
    });
    await this.#context.addInitScript(() => {
      // Disable ambient peer/network APIs. No broker secret or channel is injected into the page realm.
      Object.defineProperties(globalThis, {
        WebSocket: { value: undefined },
        WebTransport: { value: undefined },
        RTCPeerConnection: { value: undefined },
        webkitRTCPeerConnection: { value: undefined },
      });
      if ('serviceWorker' in navigator) Object.defineProperty(navigator, 'serviceWorker', { value: undefined });
    });
    await this.#bindContext(this.#context);
    this.#page = await this.#context.newPage();
    this.#page.on('download', download => void this.#quarantine(download));
  }

  async recover(recoveryEndpoint: string): Promise<void> {
    if (this.#context || this.#stopped) throw new Error('Browser partition cannot be reused');
    await mkdir(this.quarantinePath, { recursive: true, mode: 0o700 });
    this.#recoveryEndpoint = recoveryEndpoint;
    const chromium = await loadChromium();
    this.#browser = await chromium.connect(recoveryEndpoint);
    const contexts = this.#browser.contexts();
    if (contexts.length !== 1) throw new Error('Recovered browser runner has an invalid context count');
    this.#context = contexts[0];
    await this.#bindContext(this.#context);
    this.#page = this.#context.pages()[0];
    if (!this.#page) throw new Error('Recovered browser runner has no active page');
    this.#page.on('download', download => void this.#quarantine(download));
    this.#automationSuspended = true;
  }

  recoveryEndpoint(): string {
    if (!this.#recoveryEndpoint) throw new Error('Browser partition has no recovery endpoint');
    return this.#recoveryEndpoint;
  }

  suspendAutomation(): void {
    this.#automationSuspended = true;
  }

  resumeAutomation(): void {
    this.#automationSuspended = false;
  }

  async act(action: BrowserAction): Promise<string | void> {
    if (this.#automationSuspended) throw new Error('Browser automation is suspended for operator authentication');
    const page = this.#requirePage();
    switch (action.type) {
      case 'navigate': await page.goto(this.#safeUrl(action.url)); return;
      case 'click': {
        const locator = page.locator(action.selector);
        const effect: BrowserEffect = await locator.evaluate((el: { tagName?: string; closest?: (selector: string) => unknown }) => el.tagName === 'FORM' || (typeof el.closest === 'function' && el.closest('form')) ? 'form' : 'subresource');
        if (effect === 'form' && !await this.authorization.authorize({ partition: this.partition, effect, url: page.url(), method: 'POST' })) throw new Error('Form action denied');
        await locator.click(); return;
      }
      case 'fill': await page.locator(action.selector).fill(action.value); return;
      case 'select': await page.locator(action.selector).selectOption(action.value); return;
      case 'check': await page.locator(action.selector).setChecked(action.checked); return;
      case 'readText': return await page.locator(action.selector).innerText();
      case 'upload': {
        if (action.grant.expiresAt <= Date.now()) throw new Error('Upload grant expired');
        const admitted = await this.authorization.resolveAdmittedArtifact(action.grant.artifactId, this.partition);
        if (!admitted) throw new Error('Artifact is not admitted');
        const artifact = path.resolve(admitted);
        if (!await this.authorization.authorize({ partition: this.partition, effect: 'upload', url: `artifact:${action.grant.artifactId}` })) throw new Error('Upload denied');
        await page.locator(action.selector).setInputFiles(artifact); return;
      }
    }
  }

  async observeAuthentication(): Promise<BrowserAuthenticationSnapshot> {
    const page = this.#requirePage();
    const url = new URL(page.url());
    const currentOrigin = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.origin
      : null;
    const declaredState = await page.locator('[data-rorca-auth-state]').first().getAttribute('data-rorca-auth-state').catch(() => null);
    const selectors: ReadonlyArray<readonly [BrowserAuthenticationSignal, string]> = [
      ['anti_automation_notice', '[data-rorca-auth-state=\"anti-automation\"], [data-rorca-automation-policy=\"prohibited\"]'],
      ['account_lock_notice', '[data-rorca-auth-state=\"account-locked\"], [data-testid*=\"account-locked\" i]'],
      ['captcha_challenge', '[data-rorca-auth-state=\"captcha\"], iframe[src*=\"captcha\" i], iframe[title*=\"captcha\" i], [class*=\"captcha\" i]'],
      ['mfa_prompt', '[data-rorca-auth-state=\"mfa\"], input[autocomplete=\"one-time-code\"]'],
      ['passkey_prompt', '[data-rorca-auth-state=\"passkey\"], [data-testid*=\"passkey\" i], [aria-label*=\"passkey\" i]'],
      ['consent_prompt', '[data-rorca-auth-state=\"consent\"], form[action*=\"consent\" i], [data-testid*=\"consent\" i]'],
      ['login_prompt', '[data-rorca-auth-state=\"login-expired\"], input[type=\"password\"], input[autocomplete=\"current-password\"]'],
      ['provider_step_up_prompt', '[data-rorca-auth-state=\"provider-step-up\"], [data-testid*=\"step-up\" i]'],
    ];
    const visibility = await Promise.all(selectors.map(async ([signal, selector]) => ({
      signal,
      visible: await page.locator(selector).first().isVisible().catch(() => false),
    })));
    const declaredSignal: Record<string, BrowserAuthenticationSignal> = {
      'login-expired': 'login_prompt',
      consent: 'consent_prompt',
      mfa: 'mfa_prompt',
      passkey: 'passkey_prompt',
      captcha: 'captcha_challenge',
      'account-locked': 'account_lock_notice',
      'provider-step-up': 'provider_step_up_prompt',
      'anti-automation': 'anti_automation_notice',
    };
    const signal = (declaredState ? declaredSignal[declaredState] : undefined)
      ?? visibility.find(candidate => candidate.visible)?.signal
      ?? null;
    const authenticatedSessionObserved = await page.locator(
      '[data-rorca-session-state="healthy"], [data-testid*="profile-button" i], [data-testid*="user-menu" i], button[aria-label*="profile" i], button[aria-label*="account" i]',
    ).first().isVisible().catch(() => false);
    const safeState = { currentOrigin, signal, authenticatedSessionObserved, visibility };
    let screenshotDigest: `sha256:${string}` | null = null;
    try {
      const screenshot = await page.screenshot({ animations: 'disabled' });
      screenshotDigest = `sha256:${createHash('sha256').update(screenshot).digest('hex')}`;
      screenshot.fill(0);
    } catch {
      screenshotDigest = null;
    }
    return {
      signal,
      currentOrigin,
      providerStateDigest: `sha256:${createHash('sha256').update(JSON.stringify({
        currentOrigin,
        signal,
        authenticatedSessionObserved,
      })).digest('hex')}`,
      accessibilityDigest: `sha256:${createHash('sha256').update(JSON.stringify(safeState)).digest('hex')}`,
      screenshotDigest,
      authenticatedSessionObserved,
    };
  }

  async captureRedactedEvidence(): Promise<RedactedBrowserEvidenceCapture> {
    const page = this.#requirePage();
    const url = new URL(page.url());
    const currentOrigin = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.origin
      : null;
    const sensitive = page.locator([
      '[data-rorca-sensitive]',
      'input',
      'textarea',
      '[contenteditable="true"]',
      '[autocomplete]',
      '[data-testid*="token" i]',
      '[data-testid*="account" i]',
      '[data-testid*="profile" i]',
      '[aria-label*="account" i]',
      '[aria-label*="profile" i]',
    ].join(','));
    const screenshot = await page.screenshot({
      animations: 'disabled',
      mask: [sensitive],
      maskColor: '#000000',
    });
    const rawAccessibility = await page.locator('body').ariaSnapshot();
    const accessibilitySnapshot = rawAccessibility
      .split('\n')
      .map((line) => line
        .replace(/"[^"]*"/g, '"[redacted]"')
        .replace(/(:\s+)(?!true$|false$|checked$|unchecked$|\d+$).+$/i, '$1[redacted]'))
      .join('\n');
    const providerState = await this.observeAuthentication();
    const networkMetadata = this.#networkMetadata.splice(0);
    return {
      currentOrigin,
      screenshot,
      screenshotDigest: this.#digest(screenshot),
      accessibilitySnapshot,
      accessibilityDigest: this.#digest(accessibilitySnapshot),
      networkMetadata,
      providerStateDigest: providerState.providerStateDigest,
      authenticatedSessionObserved: providerState.authenticatedSessionObserved,
      redaction: 'sensitive-elements-masked-and-accessible-text-removed',
    };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#page = undefined;
    let failure: unknown;
    if (this.#context) {
      try {
        await this.#context.close();
        this.#context = undefined;
      } catch (error) {
        failure = error;
      }
    }
    if (this.#server) {
      try {
        await this.#server.close();
        this.#server = undefined;
        this.#browser = undefined;
      } catch (error) {
        failure ??= error;
      }
    } else if (this.#browser) {
      try {
        await this.#browser.close();
        this.#browser = undefined;
      } catch (error) {
        failure ??= error;
      }
    }
    if (!this.#context && !this.#browser) {
      try {
        await rm(this.quarantinePath, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  async #bindContext(context: BrowserContext): Promise<void> {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.route('**/*', route => this.#route(route.request()).then(ok => (
      ok ? route.continue() : route.abort('blockedbyclient')
    )));
    context.on('page', page => this.#handlePopup(page));
    context.on('request', request => {
      if (request.resourceType() === 'websocket') void request.failure();
    });
  }

  async #route(request: Request): Promise<boolean> {
    const safeUrl = this.#safeUrl(request.url());
    const url = new URL(safeUrl);
    const headers = request.headers();
    const resource = request.resourceType();
    const effect: BrowserEffect = resource === 'document'
      ? (request.frame().parentFrame() ? 'frame' : 'document')
      : 'subresource';
    let allowed = headers.purpose !== 'prefetch'
      && !headers['sec-purpose']?.includes('prefetch')
      && resource !== 'websocket';
    if (allowed) {
      allowed = await this.authorization.authorize({
        partition: this.partition,
        effect,
        url: safeUrl,
        method: request.method(),
      });
    }
    this.#networkMetadata.push({
      observedAt: new Date().toISOString(),
      origin: ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null,
      pathDigest: this.#digest(url.pathname),
      method: request.method().toUpperCase(),
      effect,
      decision: allowed ? 'allowed' : 'denied',
    });
    if (this.#networkMetadata.length > 256) this.#networkMetadata.splice(0, this.#networkMetadata.length - 256);
    return allowed;
  }

  async #handlePopup(page: Page): Promise<void> {
    if (!page.opener()) return;
    if (!await this.authorization.authorize({ partition: this.partition, effect: 'popup', url: page.url() })) await page.close();
  }

  async #quarantine(download: Download): Promise<void> {
    if (!await this.authorization.authorize({ partition: this.partition, effect: 'download', url: download.url() })) { await download.cancel(); return; }
    await download.saveAs(path.join(this.quarantinePath, randomUUID()));
  }

  #safeUrl(value: string): string {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`Forbidden browser URL: ${url.protocol}`);
    return url.href;
  }

  #digest(value: Buffer | string): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }

  #requirePage(): Page {
    if (this.#stopped || !this.#page) throw new Error('Browser partition is not active');
    return this.#page;
  }
}
