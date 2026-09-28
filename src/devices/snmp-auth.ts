import { z } from 'zod';

// Strong protocols are supported alongside the legacy MD5/DES some older gear still requires.
export const AUTH_PROTOCOLS = ['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'] as const;
export const PRIV_PROTOCOLS = ['DES', 'AES', 'AES256B', 'AES256R'] as const;

const community = (version: 'v1' | 'v2c') =>
  z.object({ version: z.literal(version), community: z.string().min(1).max(255) }).strict();

const v3 = z
  .object({
    version: z.literal('v3'),
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

/** SNMP authentication as typed in when the device is added. Stored on the device row as-is (not encrypted). */
export const snmpAuthSchema = z.discriminatedUnion('version', [community('v1'), community('v2c'), v3]);

export type SnmpAuth = z.infer<typeof snmpAuthSchema>;
