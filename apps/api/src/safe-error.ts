export interface SafeError {
  type: string;
  message: string;
  code?: string;
  cause?: SafeError;
}

// drizzle appends "\nparams: <values>" to its "Failed query" message, and the values are tokens
// and addresses. pg's `detail`, `where`, `parameters` and friends carry values too, so only
// the name, code and a trimmed message are ever copied.
const PARAMS_SUFFIX = /\r?\n\s*params:[\s\S]*$/i;
const MAX_DEPTH = 4;

export function safeError(err: unknown, depth = 0): SafeError {
  if (!(err instanceof Error)) return { type: typeof err, message: '[omitted]' };
  const code = (err as { code?: unknown }).code;
  const cause = (err as { cause?: unknown }).cause;
  return {
    type: err.name,
    message: err.message.replace(PARAMS_SUFFIX, ''),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    ...(cause !== undefined && depth < MAX_DEPTH ? { cause: safeError(cause, depth + 1) } : {}),
  };
}
