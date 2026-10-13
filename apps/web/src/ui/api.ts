import {
  addFishRequestSchema,
  apiErrorSchema,
  ateBatchRequestSchema,
  careActionSchema,
  createTankRequestSchema,
  speciesListSchema,
  tankListSchema,
  tankSchema,
  updateTankRequestSchema,
  creditsSchema,
  dataExportSchema,
  privacyPolicySchema,
  emailSchema,
  sessionListSchema,
  signInRequestSchema,
  signUpRequestSchema,
  userSchema,
  type AteReport,
  type CareAction,
  type Credits,
  type CreateTankRequest,
  type AddFishRequest,
  type SpeciesSummary,
  type Tank,
  type ErrorCode,
  type PrivacyPolicy,
  type SessionInfo,
  type SignInRequest,
  type SignUpRequest,
  type User,
} from '@aquarium/shared';

export const VERIFY_CALLBACK_PATH = '/verify-email';

export type FieldErrors = Partial<Record<string, string>>;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'unexpected_response',
    message: string,
    readonly fields: FieldErrors = {},
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class ClientValidationError extends Error {
  constructor(readonly fields: FieldErrors) {
    super('Please fix the highlighted fields.');
    this.name = 'ClientValidationError';
  }
}

interface Schema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface Issue {
  path: readonly (string | number | symbol)[];
  message: string;
}

export function issuesToFields(issues: readonly Issue[]): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && fields[key] === undefined) fields[key] = issue.message;
  }
  return fields;
}

function validate<T>(schema: Schema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ClientValidationError(issuesToFields(parsed.error.issues));
  return parsed.data;
}

function errorCodeFor(status: number, rawCode: unknown): ErrorCode {
  if (rawCode === 'EMAIL_NOT_VERIFIED') return 'email_not_verified';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'validation_failed';
}

/** Accepts both our `{error:{code,message,issues}}` envelope and Better Auth's `{code,message}`. */
async function toError(res: Response): Promise<ApiRequestError> {
  const header = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  const retryAfter = Number.isFinite(header) && header > 0 ? header : null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const own = apiErrorSchema.safeParse(body);
  if (own.success) {
    const { code, message, issues } = own.data.error;
    return new ApiRequestError(res.status, code, message, issuesToFields(issues ?? []), retryAfter);
  }
  const loose = body as { code?: unknown; message?: unknown } | null;
  const message =
    typeof loose?.message === 'string' && loose.message.length > 0
      ? loose.message
      : `Request failed (${res.status}).`;
  return new ApiRequestError(
    res.status,
    errorCodeFor(res.status, loose?.code),
    message,
    {},
    retryAfter,
  );
}

export interface ApiClient {
  signUp(input: SignUpRequest): Promise<void>;
  signIn(input: SignInRequest): Promise<void>;
  signOut(): Promise<void>;
  resendVerification(email: string): Promise<void>;
  me(): Promise<User | null>;
  sessions(): Promise<SessionInfo[]>;
  revokeSession(sessionId: string): Promise<void>;
  privacy(): Promise<PrivacyPolicy>;
  credits(): Promise<Credits>;
  exportData(): Promise<{ filename: string; text: string }>;
  deleteAccount(password: string): Promise<void>;
  species(): Promise<SpeciesSummary[]>;
  tanks(): Promise<Tank[]>;
  tank(tankId: string): Promise<Tank>;
  createTank(input: CreateTankRequest): Promise<Tank>;
  renameTank(tankId: string, name: string): Promise<Tank>;
  addFish(tankId: string, input: AddFishRequest): Promise<Tank>;
  netFish(tankId: string, fishId: string): Promise<Tank>;
  care(tankId: string, action: CareAction): Promise<Tank>;
  reportAte(tankId: string, reports: readonly AteReport[]): Promise<Tank>;
}

export function createApiClient(fetcher: Fetcher = (i, init) => fetch(i, init)): ApiClient {
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetcher(path, {
        credentials: 'same-origin',
        ...init,
        headers: { accept: 'application/json', ...init.headers },
      });
    } catch (cause) {
      throw new ApiRequestError(
        0,
        'network',
        cause instanceof Error && cause.name === 'AbortError'
          ? 'The request was cancelled.'
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
    return res;
  }

  async function post(path: string, body: unknown): Promise<Response> {
    const res = await send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function patch(path: string, body: unknown): Promise<Response> {
    const res = await send(path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function parsed<T>(res: Response, schema: Schema<T>): Promise<T> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new ApiRequestError(
        res.status,
        'unexpected_response',
        'The server sent a response this version of the app cannot read. Reload the page.',
      );
    }
    return result.data;
  }

  return {
    async signUp(input) {
      const body = validate(signUpRequestSchema, input);
      await post('/api/auth/sign-up/email', { ...body, callbackURL: VERIFY_CALLBACK_PATH });
    },
    async signIn(input) {
      const body = validate(signInRequestSchema, input);
      await post('/api/auth/sign-in/email', { ...body, callbackURL: VERIFY_CALLBACK_PATH });
    },
    async signOut() {
      await post('/api/auth/sign-out', {});
    },
    async resendVerification(email) {
      const valid = emailSchema.safeParse(email);
      if (!valid.success) {
        throw new ClientValidationError({ email: 'Enter a valid email address.' });
      }
      await post('/api/auth/send-verification-email', {
        email: valid.data,
        callbackURL: VERIFY_CALLBACK_PATH,
      });
    },
    async me() {
      const res = await send('/api/me');
      if (res.status === 401) return null;
      if (!res.ok) throw await toError(res);
      return parsed(res, userSchema);
    },
    async sessions() {
      const res = await send('/api/sessions');
      if (!res.ok) throw await toError(res);
      return parsed(res, sessionListSchema);
    },
    async revokeSession(sessionId) {
      await post('/api/sessions/revoke', { sessionId });
    },
    async privacy() {
      const res = await send('/api/privacy');
      if (!res.ok) throw await toError(res);
      return parsed(res, privacyPolicySchema);
    },
    async credits() {
      const res = await send('/api/credits');
      if (!res.ok) throw await toError(res);
      return parsed(res, creditsSchema);
    },
    async exportData() {
      const res = await send('/api/me/export');
      if (!res.ok) throw await toError(res);
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (!dataExportSchema.safeParse(body).success) {
        throw new ApiRequestError(
          res.status,
          'unexpected_response',
          'The server sent an export this version of the app cannot read. Reload the page.',
        );
      }
      return { filename: 'aquarium-data.json', text };
    },
    async deleteAccount(password) {
      await post('/api/me/delete', password.length > 0 ? { password } : {});
    },
    async species() {
      const res = await send('/api/species');
      if (!res.ok) throw await toError(res);
      return parsed(res, speciesListSchema);
    },
    async tanks() {
      const res = await send('/api/tanks');
      if (!res.ok) throw await toError(res);
      return parsed(res, tankListSchema);
    },
    async tank(tankId) {
      const res = await send(`/api/tanks/${encodeURIComponent(tankId)}`);
      if (!res.ok) throw await toError(res);
      return parsed(res, tankSchema);
    },
    async createTank(input) {
      const body = validate(createTankRequestSchema, input);
      return parsed(await post('/api/tanks', body), tankSchema);
    },
    async renameTank(tankId, name) {
      const body = validate(updateTankRequestSchema, { name });
      return parsed(await patch(`/api/tanks/${encodeURIComponent(tankId)}`, body), tankSchema);
    },
    async addFish(tankId, input) {
      const body = validate(addFishRequestSchema, input);
      return parsed(await post(`/api/tanks/${encodeURIComponent(tankId)}/fish`, body), tankSchema);
    },
    async netFish(tankId, fishId) {
      const res = await send(
        `/api/tanks/${encodeURIComponent(tankId)}/fish/${encodeURIComponent(fishId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw await toError(res);
      return parsed(res, tankSchema);
    },
    async care(tankId, action) {
      const body = validate(careActionSchema, action);
      return parsed(await post(`/api/tanks/${encodeURIComponent(tankId)}/care`, body), tankSchema);
    },
    async reportAte(tankId, reports) {
      const body = validate(ateBatchRequestSchema, { reports });
      return parsed(await post(`/api/tanks/${encodeURIComponent(tankId)}/ate`, body), tankSchema);
    },
  };
}
