import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export interface KeyRingConfig {
  activeKeyId: string;
  /** base64 encoded 32 byte key of the active key */
  activeKey: string;
  /** previous keys that must still decrypt existing rows: id -> base64 key */
  oldKeys?: Record<string, string>;
}

function parseKey(id: string, b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error(`Encryption key "${id}" must be 32 bytes (base64 encoded); got ${key.length} bytes`);
  }
  return key;
}

/**
 * AES-256-GCM authenticated encryption for secrets stored in the database.
 * Stored format:  v1.<keyId>.<iv>.<tag>.<ciphertext>   (base64url parts)
 * `aad` (additional authenticated data) binds a ciphertext to the row it belongs to, so a secret copied
 * into another row will fail to decrypt.
 */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly cfg: KeyRingConfig) {
    this.keys.set(cfg.activeKeyId, parseKey(cfg.activeKeyId, cfg.activeKey));
    for (const [id, b64] of Object.entries(cfg.oldKeys ?? {})) this.keys.set(id, parseKey(id, b64));
  }

  get activeKeyId(): string {
    return this.cfg.activeKeyId;
  }

  encrypt(plaintext: string, aad: string): { encrypted: string; keyId: string } {
    const key = this.keys.get(this.cfg.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const enc = [VERSION, this.cfg.activeKeyId, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
    return { encrypted: enc, keyId: this.cfg.activeKeyId };
  }

  decrypt(encrypted: string, aad: string): string {
    const parts = encrypted.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('Unsupported secret format');
    const [, keyId, iv, tag, ct] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`Encryption key "${keyId}" is not available`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // Do not leak crypto internals; wrong key / tampered row / wrong AAD all look the same.
      throw new Error('Secret could not be decrypted (wrong key or corrupted data)');
    }
  }
}
