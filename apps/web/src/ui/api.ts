import {
  achievementListSchema,
  addFishRequestSchema,
  apiErrorSchema,
  ateBatchRequestSchema,
  careActionSchema,
  collectionSchema,
  galleryQuerySchema,
  galleryResponseSchema,
  galleryWinnersResponseSchema,
  setGalleryRequestSchema,
  voteRequestSchema,
  voteStateSchema,
  replayQuerySchema,
  replayResponseSchema,
  createTankRequestSchema,
  moveFishRequestSchema,
  moveFishResponseSchema,
  errorCodeSchema,
  speciesListSchema,
  tankListSchema,
  tankSchema,
  updateTankRequestSchema,
  creditsSchema,
  dataExportSchema,
  privacyPolicySchema,
  publicTankSchema,
  reactionStateSchema,
  setReactionRequestSchema,
  pushDeviceListSchema,
  pushSubscriptionRequestSchema,
  removePushResultSchema,
  reminderSettingsSchema,
  removePushSubscriptionRequestSchema,
  updateReminderSettingsRequestSchema,
  emailSchema,
  passwordSchema,
  sessionListSchema,
  signInRequestSchema,
  signUpRequestSchema,
  userSchema,
  walletResponseSchema,
  purchaseRequestSchema,
  purchaseResponseSchema,
  treatRequestSchema,
  treatResponseSchema,
  type AchievementList,
  type AteReport,
  type BackgroundId,
  type CareAction,
  type Collection,
  type GalleryResponse,
  type GalleryWinnersResponse,
  type VoteState,
  type ReplayResponse,
  type DecorLayout,
  type Credits,
  type CreateTankRequest,
  type AddFishRequest,
  type LightSchedule,
  type PurchasableStage,
  type PurchaseResponse,
  type SpeciesSummary,
  type Tank,
  type TreatRequest,
  type TreatResponse,
  type ConflictReason,
  type ErrorCode,
  type MoveFishRequest,
  type MoveFishResponse,
  type PrivacyPolicy,
  type PublicTank,
  type ReactionKind,
  type ReactionState,
  type PushDevice,
  type PushSubscriptionRequest,
  type RemovePushResult,
  type ReminderSettings,
  type SessionInfo,
  type SignInRequest,
  type SignUpRequest,
  type User,
} from '@aquarium/shared';

export const VERIFY_CALLBACK_PATH = '/verify-email';
export const RESET_REDIRECT_PATH = '/reset-password';

export const REQUEST_TIMEOUT_MS = 15_000;
export const SLOW_REQUEST_TIMEOUT_MS = 60_000;
export const TOTAL_TIMEOUT_FACTOR = 4;
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type FieldErrors = Partial<Record<string, string>>;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'timeout' | 'unexpected_response',
    message: string,
    readonly fields: FieldErrors = {},
    readonly retryAfterSeconds: number | null = null,
    readonly reason: ConflictReason | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export class ApiTimeoutError extends ApiRequestError {
  constructor(readonly timeoutMs: number) {
    super(
      0,
      'timeout',
      'The server did not answer in time. Your tank is safe; try again in a moment.',
    );
    this.name = 'ApiTimeoutError';
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
  const known = errorCodeSchema.safeParse(rawCode);
  if (known.success) return known.data;
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
    const { code, message, issues, reason } = own.data.error;
    return new ApiRequestError(
      res.status,
      code,
      message,
      issuesToFields(issues ?? []),
      retryAfter,
      reason ?? null,
    );
  }
  const loose = body as { code?: unknown; message?: unknown } | null;
  const message =
    loose?.code === 'SESSION_NOT_FRESH'
      ? 'For your security, sign in again and then retry this.'
      : typeof loose?.message === 'string' && loose.message.length > 0
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

export interface WalletView {
  balance: number;
  /** Item refs the recent ledger shows as bought and not refunded, so the shop can mark them instead of offering a 409. */
  owned: readonly string[];
  /** Item refs whose latest ledger entry is a refund, so an earlier purchase no longer counts. */
  released?: readonly string[];
}

/** The T70 contract: every add-fish names a stage and carries a key, so a retry cannot charge twice. */
export type AddFishInput = Omit<AddFishRequest, 'stage' | 'idempotencyKey'> & {
  stage: PurchasableStage;
  idempotencyKey: string;
};

export type CreateTankInput = Omit<CreateTankRequest, 'idempotencyKey'> & {
  idempotencyKey: string;
};

export interface ApiClient {
  signUp(input: SignUpRequest): Promise<void>;
  signIn(input: SignInRequest): Promise<void>;
  signOut(): Promise<void>;
  addPasskey(): Promise<void>;
  signInWithPasskey(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  resendVerification(email: string): Promise<void>;
  me(): Promise<User | null>;
  sessions(): Promise<SessionInfo[]>;
  revokeSession(sessionId: string): Promise<void>;
  privacy(): Promise<PrivacyPolicy>;
  credits(): Promise<Credits>;
  exportData(): Promise<{ filename: string; text: string }>;
  deleteAccount(password: string): Promise<void>;
  reminders(): Promise<ReminderSettings>;
  updateReminders(change: { mail?: boolean; push?: boolean }): Promise<ReminderSettings>;
  addPushSubscription(subscription: PushSubscriptionRequest): Promise<void>;
  removePushSubscription(endpoint: string): Promise<RemovePushResult>;
  pushDevices(currentEndpoint?: string | null): Promise<PushDevice[]>;
  removePushDevice(id: string): Promise<RemovePushResult>;
  species(): Promise<SpeciesSummary[]>;
  collection(): Promise<Collection>;
  achievements(): Promise<AchievementList>;
  tanks(): Promise<Tank[]>;
  tank(tankId: string): Promise<Tank>;
  createTank(input: CreateTankInput): Promise<Tank>;
  renameTank(tankId: string, name: string): Promise<Tank>;
  saveDecorLayout(tankId: string, layout: DecorLayout): Promise<Tank>;
  saveBackground(tankId: string, backgroundId: BackgroundId): Promise<Tank>;
  addFish(tankId: string, input: AddFishInput): Promise<Tank>;
  wallet(): Promise<WalletView>;
  purchase(request: {
    itemRef: string;
    idempotencyKey: string;
    tankId?: string;
  }): Promise<PurchaseResponse>;
  saveLight(tankId: string, light: LightSchedule): Promise<Tank>;
  netFish(tankId: string, fishId: string): Promise<Tank>;
  care(tankId: string, action: CareAction): Promise<Tank>;
  treat(tankId: string, request: TreatRequest): Promise<TreatResponse>;
  moveFish(tankId: string, fishId: string, request: MoveFishRequest): Promise<MoveFishResponse>;
  replay(
    tankId: string,
    query: { since: string; until?: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<ReplayResponse>;
  reportAte(tankId: string, reports: readonly AteReport[], batchId?: string): Promise<Tank>;
  /** The only call whose response carries the share token, together with `rotateShare`. */
  shareTank(tankId: string): Promise<Tank>;
  rotateShare(tankId: string): Promise<Tank>;
  revokeShare(tankId: string): Promise<Tank>;
  setGallery(tankId: string, listed: boolean): Promise<Tank>;
  publicTank(token: string): Promise<PublicTank>;
  gallery(query?: { limit?: number; offset?: number }): Promise<GalleryResponse>;
  galleryWinners(): Promise<GalleryWinnersResponse>;
  galleryTank(tankId: string): Promise<PublicTank>;
  castVote(tankId: string): Promise<VoteState>;
  clearVote(): Promise<VoteState>;
  setReaction(token: string, kind: ReactionKind): Promise<ReactionState>;
  clearReaction(token: string): Promise<ReactionState>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function passkeyFailure(cause: unknown, doing: string): ApiRequestError {
  const reason = cause instanceof Error && cause.message ? ` (${cause.message})` : '';
  return new ApiRequestError(
    400,
    'validation_failed',
    `The passkey was not ${doing}${reason}. Try again, or use your password.`,
  );
}

export interface ApiClientOptions {
  /** Aborts every request the client makes, e.g. on teardown. */
  signal?: AbortSignal;
}

function whenAborted(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => undefined);
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

class ResponseTooLargeError extends Error {}

async function readBody(
  res: Response,
  stalled: AbortSignal,
  progress: () => void,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!res.body) return new Uint8Array(0);
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  const reader = res.body.getReader();
  const aborted = whenAborted(stalled);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted.promise]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new ResponseTooLargeError();
      chunks.push(next.value);
      progress();
    }
  } catch (cause) {
    void reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    aborted.dispose();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const [only] = signals;
  if (signals.length === 1 && only !== undefined) return { signal: only, dispose() {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(signals), dispose() {} };
  }
  // AbortSignal.any needs Chrome 116 / Firefox 124 / Safari 17.4.
  const controller = new AbortController();
  const abort = (event: Event) => controller.abort((event.target as AbortSignal).reason);
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    },
  };
}

export function createApiClient(
  fetcher: Fetcher = (i, init) => fetch(i, init),
  options: ApiClientOptions = {},
): ApiClient {
  async function send(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const timeout = new AbortController();
    let deadlineHit = false;
    const deadline = setTimeout(() => {
      deadlineHit = true;
      timeout.abort();
    }, timeoutMs * TOTAL_TIMEOUT_FACTOR);
    let timer = setTimeout(() => timeout.abort(), timeoutMs);
    const restartTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => timeout.abort(), timeoutMs);
    };
    const callerSignals = [init.signal, options.signal].filter(
      (candidate): candidate is AbortSignal => candidate != null,
    );
    const combined = combineSignals([...callerSignals, timeout.signal]);
    try {
      const res = await fetcher(path, {
        credentials: 'same-origin',
        ...init,
        signal: combined.signal,
        headers: { accept: 'application/json', ...init.headers },
      });
      // Buffered here, and the stall timer restarts with every chunk; the overall deadline and the
      // size cap bound a body that trickles in forever.
      restartTimer();
      const bytes = await readBody(res, timeout.signal, restartTimer, MAX_RESPONSE_BYTES);
      return new Response(bytes.byteLength > 0 ? bytes : null, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (cause) {
      if (cause instanceof ResponseTooLargeError) {
        throw new ApiRequestError(
          0,
          'unexpected_response',
          'The server sent a response that is too large to handle. Reload the page.',
        );
      }
      if (timeout.signal.aborted) {
        throw new ApiTimeoutError(deadlineHit ? timeoutMs * TOTAL_TIMEOUT_FACTOR : timeoutMs);
      }
      throw new ApiRequestError(
        0,
        'network',
        cause instanceof Error && cause.name === 'AbortError'
          ? 'The request was cancelled.'
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      combined.dispose();
    }
  }

  async function post(
    path: string,
    body: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const res = await send(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!res.ok) throw await toError(res);
    return res;
  }

  async function put(path: string, body: unknown): Promise<Response> {
    const res = await send(path, {
      method: 'PUT',
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
    async addPasskey() {
      const res = await send('/api/auth/passkey/generate-register-options');
      if (!res.ok) throw await toError(res);
      const optionsJSON: unknown = await res.json().catch(() => null);
      if (!isJsonObject(optionsJSON)) {
        throw new ApiRequestError(
          res.status,
          'unexpected_response',
          'The server sent passkey options this version of the app cannot read. Reload the page.',
        );
      }
      const { startRegistration } = await import('@simplewebauthn/browser');
      let credential;
      try {
        credential = await startRegistration({
          optionsJSON: optionsJSON as unknown as Parameters<
            typeof startRegistration
          >[0]['optionsJSON'],
        });
      } catch (cause) {
        throw passkeyFailure(cause, 'created');
      }
      const response = { ...credential, clientExtensionResults: undefined };
      await post('/api/auth/passkey/verify-registration', { response });
    },
    async signInWithPasskey() {
      const res = await send('/api/auth/passkey/generate-authenticate-options');
      if (!res.ok) throw await toError(res);
      const optionsJSON: unknown = await res.json().catch(() => null);
      if (!isJsonObject(optionsJSON)) {
        throw new ApiRequestError(
          res.status,
          'unexpected_response',
          'The server sent passkey options this version of the app cannot read. Reload the page.',
        );
      }
      const { startAuthentication } = await import('@simplewebauthn/browser');
      let credential;
      try {
        credential = await startAuthentication({
          optionsJSON: optionsJSON as unknown as Parameters<
            typeof startAuthentication
          >[0]['optionsJSON'],
        });
      } catch (cause) {
        throw passkeyFailure(cause, 'used');
      }
      const response = { ...credential, clientExtensionResults: undefined };
      await post('/api/auth/passkey/verify-authentication', { response });
    },
    async requestPasswordReset(email) {
      const valid = emailSchema.safeParse(email);
      if (!valid.success) {
        throw new ClientValidationError({ email: 'Enter a valid email address.' });
      }
      await post('/api/auth/request-password-reset', {
        email: valid.data,
        redirectTo: RESET_REDIRECT_PATH,
      });
    },
    async resetPassword(token, newPassword) {
      const valid = passwordSchema.safeParse(newPassword);
      if (!valid.success) {
        throw new ClientValidationError({
          password:
            newPassword.length > 128
              ? 'Use at most 128 characters.'
              : 'Use at least 10 characters.',
        });
      }
      await post('/api/auth/reset-password', { token, newPassword: valid.data });
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
    async reminders() {
      const res = await send('/api/me/reminders');
      if (!res.ok) throw await toError(res);
      return parsed(res, reminderSettingsSchema);
    },
    async updateReminders(change) {
      const body = validate(updateReminderSettingsRequestSchema, change);
      return parsed(await put('/api/me/reminders', body), reminderSettingsSchema);
    },
    async addPushSubscription(subscription) {
      await post(
        '/api/me/push-subscriptions',
        validate(pushSubscriptionRequestSchema, subscription),
      );
    },
    async removePushSubscription(endpoint) {
      const body = validate(removePushSubscriptionRequestSchema, { endpoint });
      return parsed(await post('/api/me/push-subscriptions/remove', body), removePushResultSchema);
    },
    async pushDevices(currentEndpoint) {
      const query = currentEndpoint ? `?endpoint=${encodeURIComponent(currentEndpoint)}` : '';
      const res = await send(`/api/me/push-subscriptions${query}`);
      if (!res.ok) throw await toError(res);
      return (await parsed(res, pushDeviceListSchema)).devices;
    },
    async removePushDevice(id) {
      const res = await send(`/api/me/push-subscriptions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw await toError(res);
      return parsed(res, removePushResultSchema);
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
      const res = await post('/api/me/export', {}, SLOW_REQUEST_TIMEOUT_MS);
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
    async collection() {
      const res = await send('/api/collection');
      if (!res.ok) throw await toError(res);
      return parsed(res, collectionSchema);
    },
    async achievements() {
      const res = await send('/api/achievements');
      if (!res.ok) throw await toError(res);
      return parsed(res, achievementListSchema);
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
    async saveDecorLayout(tankId, layout) {
      const body = validate(updateTankRequestSchema, { decorLayout: layout });
      return parsed(await patch(`/api/tanks/${encodeURIComponent(tankId)}`, body), tankSchema);
    },
    async saveBackground(tankId, backgroundId) {
      const body = validate(updateTankRequestSchema, { backgroundId });
      return parsed(await patch(`/api/tanks/${encodeURIComponent(tankId)}`, body), tankSchema);
    },
    async wallet() {
      const res = await send('/api/wallet');
      if (!res.ok) throw await toError(res);
      const body = await parsed(res, walletResponseSchema);
      const latest = new Map<string, boolean>();
      for (const e of body.ledger) {
        if (e.itemRef === null || latest.has(e.itemRef)) continue;
        if (e.reason === 'purchase') latest.set(e.itemRef, true);
        else if (e.reason === 'refund') latest.set(e.itemRef, false);
      }
      const held = new Set(body.owned);
      return {
        balance: body.wallet.balance,
        owned: body.owned,
        released: [...latest]
          .filter(([ref, bought]) => !bought && !held.has(ref))
          .map(([ref]) => ref),
      };
    },
    async purchase(request) {
      const body = validate(purchaseRequestSchema, request);
      return parsed(await post('/api/shop/purchase', body), purchaseResponseSchema);
    },
    async saveLight(tankId, light) {
      const body = validate(updateTankRequestSchema, { light });
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
    async replay(tankId, query, signal) {
      const checked = validate(replayQuerySchema, query);
      const params = new URLSearchParams({ since: checked.since, limit: String(checked.limit) });
      if (checked.until) params.set('until', checked.until);
      if (checked.cursor) params.set('cursor', checked.cursor);
      const res = await send(
        `/api/tanks/${encodeURIComponent(tankId)}/replay?${params}`,
        signal ? { signal } : {},
      );
      if (!res.ok) throw await toError(res);
      return parsed(res, replayResponseSchema);
    },
    async care(tankId, action) {
      if (action.type === 'bottled_bacteria' && action.idempotencyKey === undefined) {
        throw new ClientValidationError({
          idempotencyKey: 'Bottled bacteria cost Pearls and need a request key.',
        });
      }
      const body = validate(careActionSchema, action);
      return parsed(await post(`/api/tanks/${encodeURIComponent(tankId)}/care`, body), tankSchema);
    },
    async treat(tankId, request) {
      const body = validate(treatRequestSchema, request);
      return parsed(
        await post(`/api/tanks/${encodeURIComponent(tankId)}/treat`, body),
        treatResponseSchema,
      );
    },
    async moveFish(tankId, fishId, request) {
      const body = validate(moveFishRequestSchema, request);
      return parsed(
        await post(
          `/api/tanks/${encodeURIComponent(tankId)}/fish/${encodeURIComponent(fishId)}/move`,
          body,
        ),
        moveFishResponseSchema,
      );
    },
    async reportAte(tankId, reports, batchId) {
      const body = validate(ateBatchRequestSchema, { reports, ...(batchId ? { batchId } : {}) });
      return parsed(await post(`/api/tanks/${encodeURIComponent(tankId)}/ate`, body), tankSchema);
    },
    async shareTank(tankId) {
      return parsed(await post(`/api/tanks/${encodeURIComponent(tankId)}/share`, {}), tankSchema);
    },
    async rotateShare(tankId) {
      return parsed(
        await post(`/api/tanks/${encodeURIComponent(tankId)}/share/rotate`, {}),
        tankSchema,
      );
    },
    async revokeShare(tankId) {
      const res = await send(`/api/tanks/${encodeURIComponent(tankId)}/share`, {
        method: 'DELETE',
      });
      if (!res.ok) throw await toError(res);
      return parsed(res, tankSchema);
    },
    async setGallery(tankId, listed) {
      const body = validate(setGalleryRequestSchema, { listed });
      const res = await send(`/api/tanks/${encodeURIComponent(tankId)}/gallery`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await toError(res);
      return parsed(res, tankSchema);
    },
    async gallery(query = {}) {
      const checked = validate(galleryQuerySchema, query);
      const res = await send(
        `/api/gallery?${new URLSearchParams(
          Object.entries(checked).map(([k, v]) => [k, String(v)]),
        )}`,
      );
      if (!res.ok) throw await toError(res);
      return parsed(res, galleryResponseSchema);
    },
    async galleryWinners() {
      const res = await send('/api/gallery/winners');
      if (!res.ok) throw await toError(res);
      return parsed(res, galleryWinnersResponseSchema);
    },
    async galleryTank(tankId) {
      const res = await send(`/api/gallery/${encodeURIComponent(tankId)}`);
      if (!res.ok) throw await toError(res);
      return parsed(res, publicTankSchema);
    },
    async castVote(tankId) {
      const body = validate(voteRequestSchema, { tankId });
      const res = await send('/api/gallery/vote', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await toError(res);
      return parsed(res, voteStateSchema);
    },
    async clearVote() {
      const res = await send('/api/gallery/vote', { method: 'DELETE' });
      if (!res.ok) throw await toError(res);
      return parsed(res, voteStateSchema);
    },
    async publicTank(token) {
      const res = await send(`/api/public/${encodeURIComponent(token)}`);
      if (!res.ok) throw await toError(res);
      return parsed(res, publicTankSchema);
    },
    async setReaction(token, kind) {
      const body = validate(setReactionRequestSchema, { kind });
      const res = await send(`/api/public/${encodeURIComponent(token)}/reaction`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await toError(res);
      return parsed(res, reactionStateSchema);
    },
    async clearReaction(token) {
      const res = await send(`/api/public/${encodeURIComponent(token)}/reaction`, {
        method: 'DELETE',
      });
      if (!res.ok) throw await toError(res);
      return parsed(res, reactionStateSchema);
    },
  };
}
