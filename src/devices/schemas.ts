import { z } from 'zod';
import { isValidTarget } from '../collectors/icmp/system-ping.js';
import { snmpAuthSchema } from './snmp-auth.js';
import { DEVICE_TYPES } from './types.js';

export const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(isValidTarget, 'host must be an IP address or a valid hostname');

const tcpPorts = z.array(z.number().int().min(1).max(65535)).max(20).refine((a) => new Set(a).size === a.length, 'duplicate ports');

export const pollingSchema = z
  .object({
    pollIntervalSec: z.number().int().min(5).max(86400),
    timeoutMs: z.number().int().min(200).max(60000),
    retryCount: z.number().int().min(0).max(5),
    failureThreshold: z.number().int().min(1).max(100),
    recoveryThreshold: z.number().int().min(1).max(100),
    snmpFailureThreshold: z.number().int().min(1).max(100),
    snmpRecoveryThreshold: z.number().int().min(1).max(100),
    icmpCount: z.number().int().min(1).max(10),
  })
  .partial();

export const createDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    host: hostSchema,
    deviceType: z.enum(DEVICE_TYPES).default('unknown'),
    vendor: z.string().max(100).nullish(),
    model: z.string().max(100).nullish(),
    location: z.string().max(200).nullish(),
    enabled: z.boolean().default(true),
    icmpEnabled: z.boolean().default(true),
    tcpPorts: tcpPorts.default([]),
    snmpEnabled: z.boolean().default(false),
    snmpAuth: snmpAuthSchema.nullish(),
    snmpPort: z.number().int().min(1).max(65535).default(161),
    polling: pollingSchema.default({}),
  })
  .strict();

export const updateDeviceSchema = createDeviceSchema
  .omit({ polling: true })
  .partial()
  .extend({ polling: pollingSchema.optional() })
  .strict();

export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;
