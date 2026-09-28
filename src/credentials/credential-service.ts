import { randomUUID } from 'node:crypto';
import type { Database } from '../database/db.js';
import { AppError, badRequest, conflict, notFound } from '../util/errors.js';
import { CREDENTIAL_TYPES, secretSchemas, type CredentialType } from './schemas.js';
import type { SecretBox } from './secret-box.js';

/** What the API is allowed to show about a credential. There is intentionally no secret field. */
export interface CredentialMetadata {
  id: string;
  name: string;
  type: CredentialType;
  keyId: string;
  hasSecret: true;
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  name: string;
  type: CredentialType;
  key_id: string;
  secret_encrypted: string;
  created_at: Date;
  updated_at: Date;
}

const toMeta = (r: Row): CredentialMetadata => ({
  id: r.id,
  name: r.name,
  type: r.type,
  keyId: r.key_id,
  hasSecret: true,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class CredentialService {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
  ) {}

  private validate(type: CredentialType, secret: unknown): Record<string, unknown> {
    if (!CREDENTIAL_TYPES.includes(type)) throw badRequest(`Unknown credential type "${type}"`);
    const parsed = secretSchemas[type].safeParse(secret);
    if (!parsed.success) {
      // Report which fields are wrong but never echo the submitted values back.
      throw new AppError(
        'INVALID_SECRET',
        'Secret does not match the credential type',
        400,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return parsed.data as Record<string, unknown>;
  }

  async create(input: { name: string; type: CredentialType; secret: unknown }): Promise<CredentialMetadata> {
    const secret = this.validate(input.type, input.secret);
    const id = randomUUID();
    const { encrypted, keyId } = this.box.encrypt(JSON.stringify(secret), id);
    try {
      const r = await this.db.query<Row>(
        `insert into credentials (id, name, type, secret_encrypted, key_id) values ($1, $2, $3, $4, $5) returning *`,
        [id, input.name, input.type, encrypted, keyId],
      );
      return toMeta(r.rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict(`A credential named "${input.name}" already exists`);
      throw err;
    }
  }

  async list(ids?: string[]): Promise<CredentialMetadata[]> {
    const r = ids === undefined
      ? await this.db.query<Row>('select * from credentials order by name')
      : await this.db.query<Row>('select * from credentials where id = any($1::uuid[]) order by name', [ids]);
    return r.rows.map(toMeta);
  }

  async get(id: string): Promise<CredentialMetadata> {
    const r = await this.db.query<Row>('select * from credentials where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Credential', id);
    return toMeta(r.rows[0]!);
  }

  async rotateSecret(id: string, secret: unknown): Promise<CredentialMetadata> {
    const current = await this.get(id);
    const valid = this.validate(current.type, secret);
    const { encrypted, keyId } = this.box.encrypt(JSON.stringify(valid), id);
    const r = await this.db.query<Row>(
      `update credentials set secret_encrypted = $2, key_id = $3, updated_at = now() where id = $1 returning *`,
      [id, encrypted, keyId],
    );
    return toMeta(r.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    try {
      const r = await this.db.query('delete from credentials where id = $1', [id]);
      if (r.rowCount === 0) throw notFound('Credential', id);
    } catch (err) {
      // 23001 = restrict_violation (ON DELETE RESTRICT), 23503 = foreign_key_violation (NO ACTION)
      const code = (err as { code?: string }).code;
      if (code === '23001' || code === '23503') {
        throw conflict('Credential is still used by a notification channel');
      }
      throw err;
    }
  }

  /** Internal use only: decrypt the secret payload. Never expose the result through the API. */
  async getSecret<T extends CredentialType>(id: string, expected?: T): Promise<Record<string, unknown>> {
    const r = await this.db.query<Row>('select * from credentials where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Credential', id);
    const row = r.rows[0]!;
    if (expected && row.type !== expected) {
      throw badRequest(`Credential ${id} is of type "${row.type}", expected "${expected}"`);
    }
    return JSON.parse(this.box.decrypt(row.secret_encrypted, row.id)) as Record<string, unknown>;
  }

  /** Re-encrypt every secret with the currently active key (after adding a new key to the ring). */
  async reencryptAll(): Promise<number> {
    const r = await this.db.query<Row>('select * from credentials where key_id <> $1', [this.box.activeKeyId]);
    for (const row of r.rows) {
      const plain = this.box.decrypt(row.secret_encrypted, row.id);
      const { encrypted, keyId } = this.box.encrypt(plain, row.id);
      await this.db.query('update credentials set secret_encrypted = $2, key_id = $3, updated_at = now() where id = $1', [
        row.id,
        encrypted,
        keyId,
      ]);
    }
    return r.rowCount;
  }
}
