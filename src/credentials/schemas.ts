import { z } from 'zod';

// Only notification-channel secrets are stored as credentials. Device SNMP auth lives on the device itself.
export const CREDENTIAL_TYPES = ['telegram_bot', 'webhook_secret'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const secretSchemas = {
  telegram_bot: z.object({ botToken: z.string().min(10).max(255) }).strict(),
  webhook_secret: z.object({ secret: z.string().min(8).max(255) }).strict(),
} satisfies Record<CredentialType, z.ZodTypeAny>;
