import { z } from 'zod';

// Substring matches are for words that do not hide inside innocent ones. Short or ambiguous words
// are matched as whole tokens, so "Dickens", "therapist" and "nazir" pass. Matching stays inside a
// token, so "fish_it" passes; only runs of single letters ("f_u_c_k") are joined, and two
// neighbouring tokens that together spell a blocked phrase ("white_power") are caught.
const BLOCKED_SUBSTRINGS = [
  'fuck',
  'shit',
  'bitch',
  'whore',
  'slut',
  'faggot',
  'asshole',
  'asshat',
  'bastard',
  'pussy',
  'hitler',
  'neonazi',
];
const BLOCKED_PHRASES = ['siegheil', 'whitepower'];
const BLOCKED_WORDS = new Set([
  'ass',
  'cunt',
  'cunts',
  'dick',
  'cock',
  'tits',
  'fag',
  'fags',
  'rape',
  'rapist',
  'rapists',
  'kkk',
  'sex',
  'porn',
  'nazi',
  'nazis',
  'nazism',
  'nazist',
  'retard',
  'retarded',
  'retards',
  'nigga',
  'niggas',
  'nigger',
  'niggers',
  'nigg',
]);
const ALLOWED_TOKENS = new Set(['mishit', 'mishits', 'mishitting']);
const RESERVED = new Set([
  'admin',
  'administrator',
  'api',
  'aquarium',
  'bas',
  'devfish',
  'fishbas',
  'mod',
  'moderator',
  'null',
  'official',
  'root',
  'staff',
  'support',
  'system',
  'undefined',
]);

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

function fold(text: string): string {
  return [...text.toLowerCase().normalize('NFKD')].map((c) => LEET[c] ?? c).join('');
}

function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  let letters = '';
  const flush = () => {
    if (letters.length > 0) tokens.push(letters);
    letters = '';
  };
  for (const token of fold(text)
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0)) {
    if (token.length === 1) {
      letters += token;
    } else {
      flush();
      tokens.push(token);
    }
  }
  flush();
  return tokens;
}

export function containsBlockedWord(text: string): boolean {
  const tokens = tokensOf(text);
  const joinsPhrase = tokens.some((token, i) => {
    const next = tokens[i + 1];
    if (next === undefined) return false;
    return BLOCKED_PHRASES.some((phrase) => `${token}${next}` === phrase);
  });
  if (joinsPhrase) return true;
  return tokens.some((token) => {
    if (ALLOWED_TOKENS.has(token)) return false;
    return (
      BLOCKED_WORDS.has(token) ||
      BLOCKED_SUBSTRINGS.some((w) => token.includes(w)) ||
      BLOCKED_PHRASES.some((w) => token.includes(w))
    );
  });
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(handle);
}

// A handle released by a change or an account deletion cannot be claimed by someone else for this
// long, so anything addressed to it does not reach a stranger.
export const HANDLE_COOLDOWN_DAYS = 30;

export const handleFormatSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,19}$/, 'use 3 to 20 lowercase letters, digits or underscores');

// Input only: the filter and the reserved list change over time, stored handles must still parse.
export const handleSchema = handleFormatSchema
  .refine((h) => !isReservedHandle(h), 'this handle is reserved')
  .refine((h) => !containsBlockedWord(h), 'this handle is not allowed');

export const setHandleRequestSchema = z.strictObject({ handle: handleSchema });
export type SetHandleRequest = z.infer<typeof setHandleRequestSchema>;

export const handleResponseSchema = z.object({ handle: handleFormatSchema.nullable() });
