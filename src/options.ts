import type { OptionItem } from "./types.js";

export const flattenOptions = (options: OptionItem[]): OptionItem[] =>
  options.flatMap(option => [option, ...flattenOptions(option.children ?? [])]);
