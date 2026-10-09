export const REASON_MAX = 120;
/** A short plain text: no control, invisible, direction or line-break characters, so it cannot disguise what it says. */
export const isReason = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= REASON_MAX && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
export const isPromptId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
