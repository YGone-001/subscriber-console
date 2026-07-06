const fs = require('fs');

const content = fs.readFileSync('src/lib/locales.ts', 'utf8');

const enStart = content.indexOf('en: {');
const zhStart = content.indexOf('zh: {');

let enBlock = content.slice(enStart + 4, zhStart).trim();
if (enBlock.endsWith(',')) enBlock = enBlock.slice(0, -1);

const localesEnd = content.lastIndexOf('};');
let zhBlock = content.slice(zhStart + 4, localesEnd).trim();

if (!fs.existsSync('src/lib/locales')) {
  fs.mkdirSync('src/lib/locales');
}

fs.writeFileSync('src/lib/locales/en.ts', 'export const en: Record<string, string> = ' + enBlock + ';\n');
fs.writeFileSync('src/lib/locales/zh.ts', 'export const zh: Record<string, string> = ' + zhBlock + ';\n');

const newLocales = `export type Locale = "en" | "zh";
import { en } from './locales/en';
import { zh } from './locales/zh';

export const LOCALES: Record<Locale, Record<string, string>> = {
  en,
  zh
};
`;

fs.writeFileSync('src/lib/locales.ts', newLocales);
console.log('Done splitting locales.ts');
