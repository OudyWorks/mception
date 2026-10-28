import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type CredentialPayload =
  | { type: 'none' }
  | {
      type: 'bearer';
      token: string;
      refreshToken?: string;
      tokenEndpoint?: string;
      clientId?: string;
      expiresAt?: number;
    }
  | {
      type: 'upstream_oauth';
      token: string;
      refreshToken?: string;
      tokenEndpoint?: string;
      clientId?: string;
      expiresAt?: number;
    }
  | { type: 'api_key_header'; headerName: string; apiKey: string }
  | { type: 'api_key_query'; paramName: string; apiKey: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'custom_headers'; headers: Record<string, string> };

export interface EncryptedResult {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function parseMasterKey(rawKey: string): Buffer {
  let keyBuf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    keyBuf = Buffer.from(rawKey, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(rawKey)) {
    keyBuf = Buffer.from(rawKey, 'base64');
  } else {
    keyBuf = Buffer.from(rawKey, 'utf-8');
  }

  if (keyBuf.length !== 32) {
    throw new Error(
      `Master key must resolve to exactly 32 bytes (received ${keyBuf.length} bytes)`
    );
  }
  return keyBuf;
}

export function resolveMasterKey(
  configuredKey?: string,
  dataDir: string = './data'
): Buffer {
  if (configuredKey) {
    return parseMasterKey(configuredKey);
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const devKeyPath = path.join(dataDir, '.dev_master_key');
  if (fs.existsSync(devKeyPath)) {
    const raw = fs.readFileSync(devKeyPath);
    if (raw.length === 32) {
      return raw;
    }
  }

  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(devKeyPath, newKey, { mode: 0o600 });
  return newKey;
}

export function encryptCredential(
  payload: CredentialPayload,
  masterKey: Buffer
): EncryptedResult {
  if (masterKey.length !== 32) {
    throw new Error('Master key must be exactly 32 bytes for AES-256-GCM');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

  const jsonStr = JSON.stringify(payload);
  const ciphertext = Buffer.concat([
    cipher.update(jsonStr, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return { ciphertext, iv, tag };
}

export function decryptCredential(
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  masterKey: Buffer
): CredentialPayload {
  if (masterKey.length !== 32) {
    throw new Error('Master key must be exactly 32 bytes for AES-256-GCM');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8')) as CredentialPayload;
}
