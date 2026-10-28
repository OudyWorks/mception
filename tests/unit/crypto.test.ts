import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptCredential,
  encryptCredential,
  parseMasterKey,
  type CredentialPayload,
} from '../../src/crypto/encryption.js';
import { createPkcePair, hashSecret, verifyPkce } from '../../src/crypto/pkce.js';
import { createTestDatabase } from '../helpers/test-db.js';

describe('Cryptographic & Database Unit Tests', () => {
  const masterKey = crypto.randomBytes(32);

  describe('Credential Encryption (AES-256-GCM)', () => {
    const testPayloads: CredentialPayload[] = [
      { type: 'none' },
      { type: 'bearer', token: 'sk-test-token-12345' },
      {
        type: 'api_key_header',
        headerName: 'X-API-Key',
        apiKey: 'secret-key-value',
      },
      {
        type: 'api_key_query',
        paramName: 'api_key',
        apiKey: 'query-secret-value',
      },
      { type: 'basic', username: 'admin', password: 'supersecretpassword' },
      {
        type: 'custom_headers',
        headers: {
          'X-Client-Id': 'client-99',
          'X-Secret': 'top-secret',
        },
      },
    ];

    it.each(testPayloads)(
      'encrypts and decrypts payload type $type',
      (payload) => {
        const encrypted = encryptCredential(payload, masterKey);
        expect(encrypted.ciphertext).toBeInstanceOf(Buffer);
        expect(encrypted.iv.length).toBe(12);
        expect(encrypted.tag.length).toBe(16);

        const decrypted = decryptCredential(
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          masterKey
        );
        expect(decrypted).toEqual(payload);
      }
    );

    it('generates distinct IVs for identical payloads', () => {
      const payload: CredentialPayload = { type: 'bearer', token: 'token' };
      const enc1 = encryptCredential(payload, masterKey);
      const enc2 = encryptCredential(payload, masterKey);
      expect(enc1.iv.equals(enc2.iv)).toBe(false);
      expect(enc1.ciphertext.equals(enc2.ciphertext)).toBe(false);
    });

    it('throws error when ciphertext or tag is tampered', () => {
      const payload: CredentialPayload = { type: 'bearer', token: 'secret' };
      const enc = encryptCredential(payload, masterKey);

      // Tamper ciphertext byte
      enc.ciphertext[0] ^= 0xff;
      expect(() =>
        decryptCredential(enc.ciphertext, enc.iv, enc.tag, masterKey)
      ).toThrow();
    });

    it('throws error when decrypted with wrong key', () => {
      const payload: CredentialPayload = { type: 'bearer', token: 'secret' };
      const enc = encryptCredential(payload, masterKey);
      const wrongKey = crypto.randomBytes(32);

      expect(() =>
        decryptCredential(enc.ciphertext, enc.iv, enc.tag, wrongKey)
      ).toThrow();
    });

    it('parses valid master keys in hex, base64, and raw format', () => {
      const raw32 = crypto.randomBytes(32);
      const hex = raw32.toString('hex');
      const b64 = raw32.toString('base64');

      expect(parseMasterKey(hex)).toEqual(raw32);
      expect(parseMasterKey(b64)).toEqual(raw32);

      const rawUtf8 = '12345678901234567890123456789012'; // 32 chars
      expect(parseMasterKey(rawUtf8).length).toBe(32);

      expect(() => parseMasterKey('too-short')).toThrow(/exactly 32 bytes/);
    });
  });

  describe('OAuth 2.1 PKCE (RFC 7636)', () => {
    it('verifies valid verifier and challenge pair', () => {
      const { verifier, challenge, method } = createPkcePair();
      expect(verifyPkce(verifier, challenge, method)).toBe(true);
    });

    it('rejects incorrect verifier', () => {
      const { challenge, method } = createPkcePair();
      expect(verifyPkce('wrong-verifier-123', challenge, method)).toBe(false);
    });

    it('rejects unsupported challenge methods (e.g., plain)', () => {
      const { verifier, challenge } = createPkcePair();
      expect(verifyPkce(verifier, challenge, 'plain')).toBe(false);
    });

    it('does not throw on length mismatch and returns false', () => {
      expect(verifyPkce('short', 'different_length_challenge', 'S256')).toBe(
        false
      );
    });

    it('hashes secrets deterministically with SHA-256', () => {
      const secret = 'test-token-value';
      const hash1 = hashSecret(secret);
      const hash2 = hashSecret(secret);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // 256 bits = 64 hex chars
    });
  });

  describe('Database Schema & Migrations', () => {
    it('initializes schema and allows CRUD operations on registered_mcps and credentials', async () => {
      const { db, cleanup } = createTestDatabase();

      try {
        const now = Date.now();
        await db
          .insertInto('registered_mcps')
          .values({
            id: 'mcp-1',
            identifier: 'weather',
            name: 'Weather MCP',
            upstream_url: 'http://localhost:8080/sse',
            created_at: now,
            updated_at: now,
          })
          .execute();

        const enc = encryptCredential(
          { type: 'api_key_header', headerName: 'X-API-Key', apiKey: 'val' },
          masterKey
        );

        await db
          .insertInto('credentials')
          .values({
            id: 'cred-1',
            mcp_id: 'mcp-1',
            auth_type: 'api_key_header',
            encrypted_payload: enc.ciphertext,
            iv: enc.iv,
            tag: enc.tag,
            key_version: 1,
            created_at: now,
            updated_at: now,
          })
          .execute();

        const record = await db
          .selectFrom('registered_mcps')
          .selectAll()
          .where('identifier', '=', 'weather')
          .executeTakeFirst();

        expect(record).toBeDefined();
        expect(record?.name).toBe('Weather MCP');

        const cred = await db
          .selectFrom('credentials')
          .selectAll()
          .where('mcp_id', '=', 'mcp-1')
          .executeTakeFirst();

        expect(cred).toBeDefined();
        const decrypted = decryptCredential(
          cred!.encrypted_payload,
          cred!.iv,
          cred!.tag,
          masterKey
        );
        expect(decrypted).toEqual({
          type: 'api_key_header',
          headerName: 'X-API-Key',
          apiKey: 'val',
        });
      } finally {
        cleanup();
      }
    });
  });
});
