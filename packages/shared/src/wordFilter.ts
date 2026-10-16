import { z } from 'zod';

// Substring matches are for words that do not hide inside innocent ones; short or ambiguous words
// are matched whole so "Dickens" and "Scunthorpe" pass.
const BLOCKED_SUBSTRINGS = [
  'fuck',
  'shit',
  'bitch',
  'nigg',
  'fagg',
  'whore',
  'slut',
  'rapist',
  'nazi',
  'hitler',
  'asshole',
  'bastard',
  'pussy',
  'retard',
];
const BLOCKED_WORDS = new Set([
  'ass',
  'cunt',
  'cunts',
  'dick',
  'cock',
  'tits',
  'fag',
  'rape',
  'kkk',
  'sex',
  'porn',
]);
const RESERVED = new Set([
  'admin',
  'administrator',
  'aquarium',
  'bas',
  'moderator',
  'official',
  'staff',
  'support',
  'system',
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

export function containsBlockedWord(text: string): boolean {
  const folded = fold(text);
  const squashed = folded.replace(/[^a-z]/g, '');
  if (BLOCKED_SUBSTRINGS.some((w) => squashed.includes(w))) return true;
  return folded.split(/[^a-z]+/).some((token) => BLOCKED_WORDS.has(token));
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(handle);
}

export const handleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,19}$/, 'use 3 to 20 lowercase letters, digits or underscores')
  .refine((h) => !isReservedHandle(h), 'this handle is reserved')
  .refine((h) => !containsBlockedWord(h.replaceAll('_', ' ')), 'this handle is not allowed');

export const setHandleRequestSchema = z.strictObject({ handle: handleSchema });
export type SetHandleRequest = z.infer<typeof setHandleRequestSchema>;

export const handleResponseSchema = z.object({ handle: handleSchema.nullable() });
