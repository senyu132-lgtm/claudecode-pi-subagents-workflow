// Tiny i18n helper shared by pisub and the workflow engine.
// Language: env PISUB_LANG wins, then "language" in ~/.pi-subagents/config.json, default English.
// Only "en" and "zh" (Simplified Chinese) are supported.
let lang = 'en';

export function normalizeLanguage(v) {
  return /^zh/i.test(String(v || '').trim()) ? 'zh' : 'en';
}

export function setLanguage(v) {
  lang = normalizeLanguage(v);
  return lang;
}

export const language = () => lang;

// L('English text', '中文文本') -> the text for the current language
export const L = (en, zh) => (lang === 'zh' ? zh : en);
