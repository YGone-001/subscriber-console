export type Locale = "en" | "zh";
import { en } from './locales/en';
import { zh } from './locales/zh';

export interface LocaleMeta {
  code: Locale;
  name: string;
  nativeName: string;
  htmlLang: string;
  intlLocale: string;
}

export const SUPPORTED_LOCALES: LocaleMeta[] = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    htmlLang: 'en',
    intlLocale: 'en-US',
  },
  {
    code: 'zh',
    name: 'Chinese',
    nativeName: '简体中文',
    htmlLang: 'zh-CN',
    intlLocale: 'zh-CN',
  },
];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALES: Record<Locale, Record<string, string>> = {
  en,
  zh,
};
