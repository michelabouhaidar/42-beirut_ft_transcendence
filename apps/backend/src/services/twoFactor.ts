import crypto from "crypto";
import { generateSecret, generateURI, verifySync } from "otplib";
import qrcode from "qrcode";

const rawKey = process.env.TOTP_ENCRYPTION_KEY;
if (!rawKey) throw new Error("[2FA] TOTP_ENCRYPTION_KEY is not set in .env");
let ENCRYPTION_KEY: Buffer;
try {
  const b64 = Buffer.from(rawKey, "base64");
  if (b64.length === 32) {
    ENCRYPTION_KEY = b64;
  } else {
    ENCRYPTION_KEY = Buffer.from(rawKey.padEnd(32, "0").slice(0, 32), "utf8");
  }
} catch {
  ENCRYPTION_KEY = Buffer.from(rawKey.padEnd(32, "0").slice(0, 32), "utf8");
}
const ALGORITHM = "aes-256-gcm";

/**
 * Encrypt a plain TOTP secret using AES-256-GCM.
 * Packed format: IV (12 bytes) + Auth Tag (16 bytes) + Ciphertext.
 */
export function encryptSecret(secret: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt an AES-256-GCM encrypted TOTP secret buffer.
 */
export function decryptSecret(encryptedBuffer: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(encryptedBuffer) ? encryptedBuffer : Buffer.from(encryptedBuffer);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encryptedText = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encryptedText) + decipher.final("utf8");
}

/**
 * Generates a new TOTP secret and otpauth URI.
 */
export function generateTOTPDetails(email: string): { secret: string; otpauthUrl: string } {
  const secret = generateSecret();
  const otpauthUrl = generateURI({
    secret,
    label: email,
    issuer: "Trenno",
  });
  return { secret, otpauthUrl };
}

/**
 * Generates a local QR code Data URL from an otpauth URI.
 * Generates strictly in-process with local qrcode library (no external calls).
 */
export async function generateQRCodeDataUrl(otpauthUrl: string): Promise<string> {
  return qrcode.toDataURL(otpauthUrl, {
    width: 220,
    margin: 1,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });
}

/**
 * Verifies a 6-digit TOTP token against a decrypted base32 secret.
 * Acceptance criteria 2FA-03: accepts TOTP with ±1 step (window: 1).
 */
export function verifyTOTPCode(secret: string, token: string): boolean {
  try {
    const cleanToken = token.trim();
    const res = verifySync({ token: cleanToken, secret, epochTolerance: 30 });
    return res.valid;
  } catch {
    return false;
  }
}

/**
 * Generates 10 single-use recovery codes in formatted uppercase format (XXXX-XXXX).
 * Acceptance criteria 2FA-02: 10 single-use codes, shown once, stored hashed.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = crypto.randomBytes(4).toString("hex").toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  }
  return codes;
}
