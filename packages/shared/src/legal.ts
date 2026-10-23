import { z } from 'zod';
import { authIdSchema, slugSchema, timestampSchema } from './common.js';
import { exportedReminderSchema } from './reminders.js';

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
    handle: z.string().nullable(),
    emailVerified: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
  sessions: z.array(exportedRow),
  signInMethods: z.array(exportedRow),
  passkeys: z.array(exportedRow),
  reminders: exportedReminderSchema,
  reactions: z.array(exportedRow),
  galleryVotes: z.array(exportedRow),
  communityFeeds: z.array(exportedRow),
  auditLog: z.array(exportedRow),
  collection: z.strictObject({
    entries: z.array(exportedRow),
    achievements: z.array(exportedRow),
  }),
  wallet: z.strictObject({
    balance: z.int(),
    ledger: z.array(exportedRow),
  }),
  payments: z.strictObject({
    adultConfirmations: z
      .array(
        z.strictObject({ confirmedAt: timestampSchema, withdrawnAt: timestampSchema.nullable() }),
      )
      .describe('every confirm and withdraw cycle, oldest first'),
    charges: z
      .array(exportedRow)
      .describe('pack and subscription payments, with the consent timestamps given at checkout'),
    refunds: z.array(exportedRow),
    disputes: z.array(exportedRow),
    clubSubscriptions: z.array(exportedRow),
  }),
  tanks: z.array(
    z.strictObject({
      tank: exportedRow,
      fish: z.array(exportedRow),
      events: z.array(exportedRow),
      memorials: z.array(exportedRow),
      visits: z.array(exportedRow),
    }),
  ),
  giftOffers: z
    .array(exportedRow)
    .describe(
      'offers sent or received, with the escrowed fish. A fish in escrow is in no tank, so this is where it appears in the sender export.',
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
  controller: z.string().min(1),
  contact: z.email(),
  sections: z.array(privacySectionSchema).min(1),
  cookies: z.array(privacyCookieSchema).min(1),
  analytics: z.literal(false),
  thirdPartyTracking: z.literal(false),
});
export type PrivacyPolicy = z.infer<typeof privacyPolicySchema>;

export const httpUrlSchema = z.url({ protocol: /^https?$/ });

export const manifestAssetCreditFieldsSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  author: z.string().min(1),
  author_url: httpUrlSchema,
  source_url: httpUrlSchema,
  licence: z.string().min(1),
  licence_url: httpUrlSchema,
  species: slugSchema.optional(),
  modifications: z.array(z.string()),
  status: z.string(),
});

export const creditEntrySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  author: z.string().min(1),
  authorUrl: httpUrlSchema,
  sourceUrl: httpUrlSchema,
  licence: z.string().min(1),
  licenceUrl: httpUrlSchema,
  attribution: z.string().min(1),
  shareAlike: z.boolean(),
  referenceOnly: z.boolean(),
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

export const PRIVACY_CONTROLLER = 'Alexandre Baskewitsch';
export const PRIVACY_CONTACT = 'fish@bas.lu';

export const PRIVACY_POLICY: PrivacyPolicy = privacyPolicySchema.parse({
  version: '2026-10-23.2',
  updatedAt: '2026-10-23',
  controller: PRIVACY_CONTROLLER,
  contact: PRIVACY_CONTACT,
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
      name: '__Secure-better-auth.better-auth-passkey',
      purpose: 'Holds the one-time challenge while you register or use a passkey.',
      lifetime: '5 minutes at most, only during a passkey sign-in or registration.',
      attributes: 'HttpOnly, Secure, SameSite=Lax, first-party only.',
      essential: true,
    },
    {
      name: '__Secure-better-auth.dont_remember',
      purpose:
        'Set only if you sign in with "remember me" turned off; makes the session end when you close the browser.',
      lifetime: 'Browser session.',
      attributes: 'HttpOnly, Secure, SameSite=Lax, first-party only.',
      essential: true,
    },
  ],
  sections: [
    {
      id: 'who',
      title: 'Who runs this site',
      paragraphs: [
        'Aquarium is a personal hobby project hosted in the European Union. The controller of the personal data described here is named in the controller field of this page. Questions and requests about your data go to the contact address on this page.',
      ],
    },
    {
      id: 'data',
      title: 'What we store',
      paragraphs: [
        'Account: your email address, display name, the public handle you may choose (other players can see it; you can change it, and it is deleted with your account, after which the bare handle, with no link to you, is held back from reuse for 30 days) and a salted hash of your password (never the password itself).',
        'Passkeys you register: credential ID, public key, signature counter, device type, backed-up flag, transports, AAGUID (authenticator model identifier), the label you give it and its creation time. No biometric data ever leaves your device.',
        'Sessions: for every signed-in browser, a session record with its creation and expiry time, IP address and browser user-agent, so you can review and revoke sessions. Session records are kept until they expire (30 days after your last activity) and are then deleted by an hourly cleanup, or immediately when you sign out, revoke them or delete your account.',
        'Game data: your tanks, fish, their care history and memorials of fish that have died.',
        'Collection book and achievements: which species you have kept, bred and raised, with the date each was first reached, and the achievements you have earned with their dates. They are kept until you delete your account, even if you delete the tank or fish they came from, and are included in your JSON export.',
        'Pearls wallet and ledger: your Pearl balance and an append-only ledger of every change to it: the amount, what it was for (a purchase, a reward for care or an achievement, a grant, a refund), the item, the time and a request key that stops a retried request from charging twice. It is kept until you delete your account and is included in your JSON export. Entries for payments with real money are kept longer than the rest; the retention section explains how.',
        'Payments: when you buy Pearls or the Aquarist Club subscription on the web, the payment is handled by Stripe and we never see or store your card details. We store, per payment: the Stripe payment or invoice reference, the amount in euro cents, the pack or subscription it was for, the time, and the time at which you agreed to the two things shown at checkout (that delivery starts at once, and that this ends your 14-day right of withdrawal; the wording is the one fixed in the checkout for the version of these terms in force then). We also store each refund and dispute against the payment (amount and Pearls taken back), your Aquarist Club subscription (its Stripe reference, status, the period paid and whether it ends at the period end), and the time at which an adult confirmed purchases on your account (a confirmation you can withdraw, which keeps the time you withdrew it). A receipt for each payment is emailed to you. All of this is included in your JSON export.',
        'Tank visits: for each tank you open we store the date (no time of day, IP address or device) on which you opened it, used only so your fish can recognise you when you come back often. It is included in your JSON export and deleted with the tank or your account.',
        'Shared tanks: if you turn on a public link for a tank, anyone who has the link can see that tank read-only without signing in: its name (after a word filter), layout, water and fish. Your email address, display name, handle and account are never shown through the link, and the page is marked noindex. You can revoke or replace the link at any time, which stops the old one working at once. A link does not list the tank anywhere: the tank of the week gallery is a second, separate choice, off by default, that you make per tank and can undo at any time. Listing needs the link to be on, and turning the link off also takes the tank out of the gallery. In the gallery, anyone, signed in or not, sees the same read-only view and the tank name (after a word filter), never your account.',
        'Reactions: when you react to a shared tank (heart, star or wow) we store which tank, your account and the kind, one reaction per tank. Reaction counts are public; who reacted is not. A shared tank also shows when it was last updated, rounded down to the hour.',
        'Gallery votes: when you vote in the tank of the week gallery we store the week, the tank and your account, one vote per week. Only totals are public; who voted is not. Votes are included in your JSON export, deleted with your account and with the tank, and deleted after 90 days in any case. The winner of each finished week (the tank, not who voted) is kept until the tank is deleted. It is hidden while the tank is unlisted and shows again if you list the tank again.',
        'Community tank feeds: when you feed the shared community tank we store your account, the food, the portion and the time, so a daily feeding quota can be enforced. Viewers of the tank see your public handle, if you set one, next to the feed, never your email. Entries are kept for 7 days, are included in your JSON export and are deleted with your account.',
        'Audit log: turning a link on, replacing or revoking it, listing a tank in or removing it from the gallery, setting or removing a reaction, and setting or removing a gallery vote are recorded with the time, your account and the tank, never the link itself. Entries are deleted after 180 days, and immediately when you delete your account. The same data is included in your JSON export.',
        'Email: verification and password-reset mail is sent from fish@bas.lu through the operator mail relay. Care reminders are mailed only if you turn them on.',
        "Care reminders: both channels are off until you turn them on in your account settings. If you do, we store your choices, the time of the last reminder and, for web push, the push endpoint and encryption keys your browser gives us for each device you enable. At most one reminder per day is sent, only when your fish have not been fed for a while, and it never contains details about your tank. Every reminder email has a one-click unsubscribe link that works without signing in, and you can switch either channel off or remove a device at any time. This data is included in your JSON export. Web push goes through your browser vendor's push service (Google, Mozilla, Apple or Microsoft), which sees the endpoint and that a message was sent.",
        "Server logs of this application record the request method and path without query strings, never email addresses, passwords or tokens. The hosting platform's reverse proxy keeps standard access logs (including IP addresses) and the mail relay logs delivery of the mail we send you (including the recipient address); both are operated by the same operator and kept only as long as needed for security and troubleshooting.",
      ],
    },
    {
      id: 'purpose',
      title: 'Why and on what legal basis',
      paragraphs: [
        'We process this data to run your account and your aquarium, which is performing the service you asked for (GDPR Art. 6(1)(b)), and to keep the service secure and prevent abuse such as mail flooding (Art. 6(1)(f)).',
        'Payments are processed to carry out your purchase (Art. 6(1)(b)), and the payment records are kept to meet our accounting and consumer-law obligations (Art. 6(1)(c)).',
        'There is no advertising, profiling or analytics, and no sale of data. Your data is shared with no third party except the processors named in the next section.',
      ],
    },
    {
      id: 'processors',
      title: 'Who else handles your data',
      paragraphs: [
        "Stripe Payments Europe, Ltd. processes web payments for us. When you start a checkout we send Stripe your account email address (to prefill the checkout and send its own receipt), an internal user ID, what you are buying, and the times you gave the checkout consents. You enter your card or other payment details only on Stripe's page, never on this site. Stripe is also an independent controller for its own legal duties such as fraud prevention and financial regulation; its privacy policy is at https://stripe.com/privacy. Payments are only available to accounts on which an adult has confirmed purchases.",
        "Our hosting and the mail relay are operated by the operator of this site and are described in the section on what we store. Browser vendors' push services receive web push messages if you turn them on.",
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
        'Account and game data are kept until you delete your account. Your collection book and achievements are kept until you delete your account, even after the tanks and fish behind them are gone. Care events older than 90 days are pruned, community feed entries older than 7 days, audit log entries older than 180 days, and tank visit dates older than 14 days.',
        'Pearl ledger entries for in-game activity (purchases, rewards and grants) are deleted with your account. Ledger entries and the payment, refund and dispute records for payments made with real money are kept for 10 years, because Luxembourg accounting law requires it (GDPR Art. 17(3)(b) allows keeping data to meet a legal obligation); on deletion the link to your account is removed from them, so they no longer identify you. Your Aquarist Club subscription is cancelled with the provider on deletion, and its record is kept the same way. Stripe keeps its own records under its own retention rules. Unspent Pearls, bought ones included, are lost when you delete your account.',
        'Deleting your account removes your user record, sessions, sign-in methods, passkeys, reminder settings and push subscriptions, tanks, fish, care history, tank visit dates, reactions, memorials, collection book, achievements, adult confirmation, wallet and in-game Pearl ledger from the database immediately. Backup retention is to be defined before production; until then, deleted data may persist in backups no longer than that period.',
      ],
    },
    {
      id: 'rights',
      title: 'Your rights',
      paragraphs: [
        'You can download all your data as JSON (access and portability, Art. 15 and 20) and delete your account (erasure, Art. 17) yourself from your account settings, using the API endpoints POST /api/me/export and POST /api/me/delete.',
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
