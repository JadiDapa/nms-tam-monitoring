import { z } from 'zod';

export const CREDENTIAL_TYPES = ['snmp_v1', 'snmp_v2c', 'snmp_v3', 'telegram_bot', 'webhook_secret'] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

const community = z.object({ community: z.string().min(1).max(255) }).strict();

// Strong protocols are supported alongside the legacy MD5/DES some older gear still requires.
export const AUTH_PROTOCOLS = ['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'] as const;
export const PRIV_PROTOCOLS = ['DES', 'AES', 'AES256B', 'AES256R'] as const;

const v3 = z
  .object({
    username: z.string().min(1).max(255),
    authProtocol: z.enum(AUTH_PROTOCOLS).optional(),
    authKey: z.string().min(8, 'SNMPv3 auth key must be at least 8 characters').max(255).optional(),
    privProtocol: z.enum(PRIV_PROTOCOLS).optional(),
    privKey: z.string().min(8, 'SNMPv3 privacy key must be at least 8 characters').max(255).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Boolean(v.authProtocol) !== Boolean(v.authKey)) {
      ctx.addIssue({ code: 'custom', message: 'authProtocol and authKey must be provided together', path: ['authKey'] });
    }
    if (Boolean(v.privProtocol) !== Boolean(v.privKey)) {
      ctx.addIssue({ code: 'custom', message: 'privProtocol and privKey must be provided together', path: ['privKey'] });
    }
    if (v.privKey && !v.authKey) {
      ctx.addIssue({ code: 'custom', message: 'SNMPv3 privacy requires authentication', path: ['privKey'] });
    }
  });

export const secretSchemas = {
  snmp_v1: community,
  snmp_v2c: community,
  snmp_v3: v3,
  telegram_bot: z.object({ botToken: z.string().min(10).max(255) }).strict(),
  webhook_secret: z.object({ secret: z.string().min(8).max(255) }).strict(),
} satisfies Record<CredentialType, z.ZodTypeAny>;

/** Resolved (decrypted) SNMP authentication. Exists only in memory for the duration of a poll/test. */
export type SnmpAuth =
  | { version: 'v1' | 'v2c'; community: string }
  | {
      version: 'v3';
      username: string;
      authProtocol?: (typeof AUTH_PROTOCOLS)[number];
      authKey?: string;
      privProtocol?: (typeof PRIV_PROTOCOLS)[number];
      privKey?: string;
    };
