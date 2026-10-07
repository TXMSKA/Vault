export const spanish = () => /^es(?:[-_.]|$)/i.test(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
export const copy = (en: string, es: string) => spanish() ? es : en;
