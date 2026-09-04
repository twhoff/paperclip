import {
  SECRET_REDACTION_TOKEN,
  createStreamingTextRedactor,
  redactDiagnosticResponseValue,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";

export const MAX_COMMENT_PAGE_ROWS = 100;

export function redactStrictDiagnosticText(
  value: string,
  opts?: CurrentUserRedactionOptions,
) {
  const redactor = createStreamingTextRedactor(opts);
  return `${redactor.push(value)}${redactor.flush()}`;
}

export function redactCommentRecords<T extends { body: string }>(
  comments: readonly T[],
  opts?: CurrentUserRedactionOptions,
): T[] {
  const bounded = comments.slice(0, MAX_COMMENT_PAGE_ROWS);
  if (bounded.length === 0) return [];
  const projection = redactDiagnosticResponseValue(
    { payload: bounded.map((comment) => comment.body) },
    opts,
  ).payload;
  const bodies = Array.isArray(projection)
    ? projection
    : bounded.map(() => SECRET_REDACTION_TOKEN);
  const result = bounded.map((comment, index) => ({
    ...comment,
    body: typeof bodies[index] === "string"
      ? bodies[index]
      : SECRET_REDACTION_TOKEN,
  }));
  for (const comment of result) {
    comment.body = redactStrictDiagnosticText(comment.body, opts);
  }
  return result;
}
