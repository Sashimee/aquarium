import { z } from 'zod';
import { authIdSchema, slugSchema, timestampSchema } from './common.js';

export const deleteAccountRequestSchema = z.strictObject({
  password: z.string().min(1).max(128).optional(),
});
export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

const exportedRow = z.record(z.string(), z.unknown());

export const dataExportSchema = z.strictObject({
  exportedAt: timestampSchema,
  format: z.literal('aquarium-export-v1'),
  user: z.strictObject({
    id: authIdSchema,
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
  sessions: z.array(exportedRow),
  signInMethods: z.array(exportedRow),
  passkeys: z.array(exportedRow),
  tanks: z.array(
    z.strictObject({
      tank: exportedRow,
      fish: z.array(exportedRow),
      events: z.array(exportedRow),
      memorials: z.array(exportedRow),
    }),
  ),
});
export type DataExport = z.infer<typeof dataExportSchema>;

export const privacyCookieSchema = z.strictObject({
  name: z.string(),
  purpose: z.string(),
  lifetime: z.string(),
  attributes: z.string(),
  essential: z.literal(true),
});

export const privacySectionSchema = z.strictObject({
  id: slugSchema,
  title: z.string(),
  paragraphs: z.array(z.string()).min(1),
});

export const privacyPolicySchema = z.strictObject({
  version: z.string(),
  updatedAt: z.iso.date(),
  contact: z.email(),
  sections: z.array(privacySectionSchema).min(1),
  cookies: z.array(privacyCookieSchema).min(1),
  analytics: z.literal(false),
  thirdPartyTracking: z.literal(false),
});
export type PrivacyPolicy = z.infer<typeof privacyPolicySchema>;

export const creditEntrySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  author: z.string().min(1),
  authorUrl: z.url(),
  sourceUrl: z.url(),
  licence: z.string().min(1),
  licenceUrl: z.url(),
  attribution: z.string().min(1),
  shareAlike: z.boolean(),
  species: slugSchema.nullable(),
  modifications: z.array(z.string()),
});
export type CreditEntry = z.infer<typeof creditEntrySchema>;

export const creditsSchema = z.strictObject({
  generatedFrom: z.literal('assets/manifest.json'),
  shareAlikeNotice: z.string(),
  entries: z.array(creditEntrySchema),
});
export type Credits = z.infer<typeof creditsSchema>;

export const PRIVACY_POLICY: PrivacyPolicy = privacyPolicySchema.parse({
  version: '2026-10-13',
  updatedAt: '2026-10-13',
  contact: 'fish@bas.lu',
  analytics: false,
  thirdPartyTracking: false,
  cookies: [
    {
      name: '__Secure-better-auth.session_token',
      purpose: 'Keeps you signed in. Without it you would have to sign in on every page load.',
      lifetime:
        '30 days, renewed while you use the site; removed when you sign out or delete your account.',
      attributes: 'HttpOnly, Secure, SameSite=Lax, first-party only.',
      essential: true,
    },
    {
      name: '__Secure-better-auth-passkey',
      purpose: 'Holds the one-time challenge while you register or use a passkey.',
      lifetime: 'A few minutes, only during a passkey sign-in or registration.',
      attributes: 'HttpOnly, Secure, SameSite=Lax, first-party only.',
      essential: true,
    },
  ],
  sections: [
    {
      id: 'who',
      title: 'Who runs this site',
      paragraphs: [
        'Aquarium is a personal hobby project hosted in the European Union. The operator is the controller of the personal data described here. Questions and requests about your data go to the contact address on this page.',
      ],
    },
    {
      id: 'data',
      title: 'What we store',
      paragraphs: [
        'Account: your email address, display name, a salted hash of your password (never the password itself), and any passkeys you register (public key and device label only).',
        'Sessions: for every signed-in browser, a session record with its creation and expiry time, IP address and browser user-agent, so you can review and revoke sessions.',
        'Game data: your tanks, fish, their care history and memorials of fish that have died.',
        'Email: verification mail is sent from fish@bas.lu through the operator mail relay. Nothing else is mailed to you.',
        'Server logs record the request method and path without query strings, never email addresses, passwords or tokens.',
      ],
    },
    {
      id: 'purpose',
      title: 'Why and on what legal basis',
      paragraphs: [
        'We process this data to run your account and your aquarium, which is performing the service you asked for (GDPR Art. 6(1)(b)), and to keep the service secure and prevent abuse such as mail flooding (Art. 6(1)(f)).',
        'There is no advertising, profiling, analytics, or sale or sharing of data with third parties.',
      ],
    },
    {
      id: 'cookies',
      title: 'Cookies',
      paragraphs: [
        'Only essential, first-party cookies are used, listed below. There are no analytics, advertising or tracking cookies, and no third-party scripts, so no consent banner is needed.',
      ],
    },
    {
      id: 'retention',
      title: 'How long we keep it',
      paragraphs: [
        'Account and game data are kept until you delete your account. Care events older than 90 days are pruned.',
        'Deleting your account removes your user record, sessions, sign-in methods, passkeys, tanks, fish, care history and memorials from the database immediately. Routine database backups, if any, expire on their normal schedule.',
      ],
    },
    {
      id: 'rights',
      title: 'Your rights',
      paragraphs: [
        'You can download all your data as JSON (access and portability, Art. 15 and 20) and delete your account (erasure, Art. 17) yourself from your account settings, using the API endpoints GET /api/me/export and POST /api/me/delete.',
        'For correction, restriction or objection (Art. 16, 18, 21), write to the contact address. You may also lodge a complaint with your national data protection authority.',
      ],
    },
    {
      id: 'credits',
      title: 'Third-party assets',
      paragraphs: [
        'Models, textures and photographs are used under open licences and credited on the credits page.',
      ],
    },
  ],
});
