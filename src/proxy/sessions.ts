import type { CredentialPayload } from '../crypto/encryption.js';

export interface UpstreamSessionInfo {
  upstreamMessageUrl: string;
  mcpId: string;
  credentials: CredentialPayload;
  createdAt: number;
}

export class SessionRegistry {
  private sessions = new Map<string, UpstreamSessionInfo>();

  set(sessionId: string, info: UpstreamSessionInfo): void {
    this.sessions.set(sessionId, info);
  }

  get(sessionId: string): UpstreamSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const globalSessionRegistry = new SessionRegistry();
