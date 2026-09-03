import {Locator, Page} from "playwright-core";
import {
  HumanizeOptions,
  patchPlaywrightLocator,
  patchPlaywrightPage
} from "@liwenguan/cloak-power-humanize-sdk";

export type { HumanizeOptions } from "@liwenguan/cloak-power-humanize-sdk";

export type HumanizePreset = "normal" | "careful";

export function resolveHumanizeOptions(preset: HumanizePreset = "normal"): HumanizeOptions {
  if (preset === "careful") {
    return {
      moveSteps: [24, 44],
      keyDelay: [90, 260],
      actionDelay: [420, 1400],
      clickDelay: [90, 220],
      scrollSteps: [7, 14]
    };
  }
  return {
    moveSteps: [18, 36],
    keyDelay: [70, 220],
    actionDelay: [260, 900],
    clickDelay: [70, 190],
    scrollSteps: [6, 13]
  };
}

export function humanizePlaywrightPage<T extends Page>(page: T, options?: HumanizeOptions): T {
  return patchPlaywrightPage(page as unknown as Record<string, unknown>, options) as T;
}

export function humanizePlaywrightLocator<T extends Locator>(locator: T, page: Page, options?: HumanizeOptions): T {
  return patchPlaywrightLocator(
    locator as unknown as Record<string, unknown>,
    page as unknown as Record<string, unknown>,
    options,
  ) as T;
}
