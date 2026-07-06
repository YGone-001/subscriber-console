export type Locale = "en" | "zh";
import { en } from './locales/en';
import { zh } from './locales/zh';

export const LOCALES: Record<Locale, Record<string, string>> = {
  en,
  zh
};
