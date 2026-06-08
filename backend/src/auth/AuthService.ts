import { randomBytes, timingSafeEqual } from "node:crypto";

type Session = {
  token: string;
  expiresAt: number;
};

export class AuthService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly password: string,
    private readonly ttlSeconds: number
  ) {}

  required() {
    return this.password.length > 0;
  }

  login(password: string) {
    if (!this.required()) return this.issueToken();
    if (!safeEqual(password, this.password)) return null;
    return this.issueToken();
  }

  verify(token?: string) {
    if (!this.required()) return true;
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  sweep() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  private issueToken() {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + Math.max(this.ttlSeconds, 60) * 1000;
    const session = { token, expiresAt };
    this.sessions.set(token, session);
    return session;
  }
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
