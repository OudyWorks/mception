import crypto from 'node:crypto';

export function verifyPkce(
  verifier: string,
  challenge: string,
  method: string
): boolean {
  if (method !== 'S256') {
    return false;
  }

  if (!verifier || !challenge) {
    return false;
  }

  const computedChallenge = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');

  const bufA = Buffer.from(computedChallenge, 'utf8');
  const bufB = Buffer.from(challenge, 'utf8');

  if (bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

export function createPkcePair(): {
  verifier: string;
  challenge: string;
  method: 'S256';
} {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}
