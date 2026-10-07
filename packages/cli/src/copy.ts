export const spanish = () => /^es(?:[-_.]|$)/i.test(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
export const copy = (en: string, es: string) => spanish() ? es : en;
export const yes = (answer: string) => ["s", "si", "sí", "y", "yes"].includes(answer.trim().toLowerCase());
export const no = (answer: string) => ["n", "no"].includes(answer.trim().toLowerCase());
