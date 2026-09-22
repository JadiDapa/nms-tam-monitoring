import { z } from 'zod';
import type { CredentialService } from '../credentials/credential-service.js';
import type { Database } from '../database/db.js';
import { badRequest, conflict, notFound } from '../util/errors.js';
import type { ChannelType } from './provider.js';

const telegramConfig = z.object({ chatId: z.string().min(1).max(100) }).strict();
const webhookConfig = z
  .object({ url: z.url({ protocol: /^https?$/ }) })
  .strict();
const emailConfig = z.object({ recipients: z.array(z.email()).min(1).max(50) }).strict();

const configSchemas = { telegram: telegramConfig, webhook: webhookConfig, email: emailConfig } as const;

export const createChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(['telegram', 'webhook', 'email']),
    config: z.record(z.string(), z.unknown()),
    credentialId: z.uuid().nullish(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const updateChannelSchema = createChannelSchema.partial().omit({ type: true }).strict();

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

export interface ChannelView {
  id: string;
  name: string;
  type: ChannelType;
  config: Record<string, unknown>;
  credentialId: string | null;
  hasCredential: boolean;
  enabled: boolean;
  /** false for email in this version: deliveries will be recorded as FAILED / NOT_IMPLEMENTED */
  implemented: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  name: string;
  type: ChannelType;
  config: Record<string, unknown>;
  credential_id: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const map = (r: Row): ChannelView => ({
  id: r.id,
  name: r.name,
  type: r.type,
  config: r.config ?? {},
  credentialId: r.credential_id,
  hasCredential: r.credential_id !== null,
  enabled: r.enabled,
  implemented: r.type !== 'email',
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

export class ChannelService {
  constructor(
    private readonly db: Database,
    private readonly credentials: CredentialService,
  ) {}

  private validate(type: ChannelType, config: unknown): Record<string, unknown> {
    const parsed = configSchemas[type].safeParse(config);
    if (!parsed.success) {
      throw badRequest(`Invalid ${type} channel config`, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return parsed.data as Record<string, unknown>;
  }

  private async checkCredential(type: ChannelType, credentialId: string | null | undefined): Promise<void> {
    if (type === 'telegram' && !credentialId) throw badRequest('A telegram channel needs credentialId (type telegram_bot)');
    if (!credentialId) return;
    const meta = await this.credentials.get(credentialId).catch(() => null);
    if (!meta) throw badRequest(`credentialId ${credentialId} does not exist`);
    const expected = type === 'telegram' ? 'telegram_bot' : type === 'webhook' ? 'webhook_secret' : null;
    if (!expected) throw badRequest(`${type} channels do not use a credential`);
    if (meta.type !== expected) throw badRequest(`A ${type} channel needs a ${expected} credential, got ${meta.type}`);
  }

  async create(input: CreateChannelInput): Promise<ChannelView> {
    const config = this.validate(input.type, input.config);
    await this.checkCredential(input.type, input.credentialId);
    try {
      const r = await this.db.query<Row>(
        `insert into notification_channels (name, type, config, credential_id, enabled) values ($1, $2, $3, $4, $5) returning *`,
        [input.name, input.type, JSON.stringify(config), input.credentialId ?? null, input.enabled],
      );
      return map(r.rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict(`A channel named "${input.name}" already exists`);
      throw err;
    }
  }

  async get(id: string): Promise<ChannelView> {
    const r = await this.db.query<Row>('select * from notification_channels where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Notification channel', id);
    return map(r.rows[0]!);
  }

  async list(ids?: string[]): Promise<ChannelView[]> {
    const r = ids === undefined
      ? await this.db.query<Row>('select * from notification_channels order by name')
      : await this.db.query<Row>('select * from notification_channels where id = any($1::uuid[]) order by name', [ids]);
    return r.rows.map(map);
  }

  async update(id: string, patch: UpdateChannelInput): Promise<ChannelView> {
    const current = await this.get(id);
    const config = patch.config !== undefined ? this.validate(current.type, patch.config) : current.config;
    const credentialId = patch.credentialId === undefined ? current.credentialId : (patch.credentialId ?? null);
    await this.checkCredential(current.type, credentialId);
    const r = await this.db.query<Row>(
      `update notification_channels set name = $2, config = $3, credential_id = $4, enabled = $5, updated_at = now()
       where id = $1 returning *`,
      [id, patch.name ?? current.name, JSON.stringify(config), credentialId, patch.enabled ?? current.enabled],
    );
    return map(r.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    const r = await this.db.query('delete from notification_channels where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Notification channel', id);
  }
}
