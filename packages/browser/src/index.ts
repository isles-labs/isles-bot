import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export async function connectPlaywrightOverCdp(cdpUrl: string): Promise<BrowserSession> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    browser,
    context,
    page,
    close: async () => {
      await browser.close();
    },
  };
}

export * from './humanize.js';
