import type {Locator, Page} from "playwright-core";

export type PageLike = Record<string, unknown>;
export type LocatorLike = Record<string, unknown>;

export interface HumanizeOptions {
  enabled?: boolean;
  mouse?: boolean;
  keyboard?: boolean;
  scroll?: boolean;
  clickDelay?: [number, number];
  keyDelay?: [number, number];
  actionDelay?: [number, number];
  moveSteps?: [number, number];
  scrollSteps?: [number, number];
}

function randomInRange([min, max]: [number, number]): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOptions(options?: HumanizeOptions): Required<Pick<HumanizeOptions, "clickDelay" | "keyDelay" | "actionDelay" | "scrollSteps">> {
  return {
    clickDelay: options?.clickDelay ?? [60, 180],
    keyDelay: options?.keyDelay ?? [45, 140],
    actionDelay: options?.actionDelay ?? [180, 520],
    scrollSteps: options?.scrollSteps ?? [6, 12]
  };
}

function asPage(page: PageLike): Page {
  return page as unknown as Page;
}

function asLocator(locator: LocatorLike): Locator {
  return locator as unknown as Locator;
}

export function patchPlaywrightPage<T extends PageLike>(page: T, options?: HumanizeOptions): T {
  const pwPage = asPage(page);
  const originalLocator = pwPage.locator.bind(pwPage);
  (pwPage as unknown as { locator: typeof originalLocator }).locator = ((selector: string, locatorOptions?: Parameters<Page["locator"]>[1]) => {
    const locator = originalLocator(selector, locatorOptions);
    return patchPlaywrightLocator(locator as unknown as LocatorLike, page, options) as unknown as Locator;
  }) as typeof originalLocator;
  return page;
}

export function patchPlaywrightLocator<T extends LocatorLike>(locator: T, _page: PageLike, options?: HumanizeOptions): T {
  const target = asLocator(locator);
  const resolved = resolveOptions(options);
  const mark = "__humanized_by_cloak_sdk__";
  if ((target as unknown as Record<string, unknown>)[mark]) return locator;

  const originalClick = target.click.bind(target);
  const originalType = target.type.bind(target);
  const originalFill = target.fill.bind(target);

  (target as unknown as { click: Locator["click"] }).click = (async (clickOptions?: Parameters<Locator["click"]>[0]) => {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    const delay = clickOptions?.delay ?? randomInRange(resolved.clickDelay);
    await originalClick({ ...clickOptions, delay });
    await sleep(randomInRange(resolved.actionDelay));
  }) as Locator["click"];

  (target as unknown as { type: Locator["type"] }).type = (async (text: string, typeOptions?: Parameters<Locator["type"]>[1]) => {
    const delay = typeOptions?.delay ?? randomInRange(resolved.keyDelay);
    await originalType(text, { ...typeOptions, delay });
    await sleep(randomInRange(resolved.actionDelay));
  }) as Locator["type"];

  (target as unknown as { fill: Locator["fill"] }).fill = (async (value: string, fillOptions?: Parameters<Locator["fill"]>[1]) => {
    await originalFill(value, fillOptions);
    await sleep(randomInRange(resolved.actionDelay));
  }) as Locator["fill"];

  (target as unknown as Record<string, unknown>)[mark] = true;
  return locator;
}
