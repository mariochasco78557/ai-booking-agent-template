import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * Opaque reservation reference (ADR-032, DESIGN §4): AES-256-GCM, so the real
 * reservation id is never readable by the LLM. The caller's E.164 phone is the
 * AAD: the same token under another phone fails authentication.
 *
 * Plaintext (13 bytes): 0x01 | reservationId u32BE | startsAtMinutes u32BE | expEpochSec u32BE.
 * Token = "r1." + base64url(iv(12) | ciphertext(13) | tag(16)) = 3 + 55 = 58 chars.
 */
export const RESERVATION_REF_PREFIX = "r1.";
const REF_LENGTH = 58;
const IV_LEN = 12;
const PLAIN_LEN = 13;
const TAG_LEN = 16;
const U32_MAX = 0xffff_ffff;

function deriveKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("demo-salon-wa-ref-v1").digest();
}

function aad(phoneE164: string): Buffer {
  return Buffer.from(`wa-ref|${phoneE164}`, "utf8");
}

const STARTS_AT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

function startsAtToMinutes(startsAt: string): number {
  const m = STARTS_AT_RE.exec(startsAt);
  if (!m) throw new Error("startsAt must be YYYY-MM-DD HH:mm");
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const minutes = ms / 60_000;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > U32_MAX) {
    throw new Error("startsAt out of range");
  }
  return minutes;
}

function minutesToStartsAt(minutes: number): string {
  const iso = new Date(minutes * 60_000).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function mintReservationRef(
  input: { reservationId: number; startsAt: string; phoneE164: string; nowMs: number },
  cfg: { secret: string; ttlMinutes: number },
): string {
  if (
    !Number.isInteger(input.reservationId) ||
    input.reservationId <= 0 ||
    input.reservationId > U32_MAX
  ) {
    throw new Error("reservationId out of range");
  }
  const exp = Math.floor(input.nowMs / 1000) + cfg.ttlMinutes * 60;
  if (!Number.isInteger(exp) || exp < 0 || exp > U32_MAX) throw new Error("expiry out of range");

  const plain = Buffer.alloc(PLAIN_LEN);
  plain.writeUInt8(1, 0);
  plain.writeUInt32BE(input.reservationId, 1);
  plain.writeUInt32BE(startsAtToMinutes(input.startsAt), 5);
  plain.writeUInt32BE(exp, 9);

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(cfg.secret), iv);
  cipher.setAAD(aad(input.phoneE164));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return RESERVATION_REF_PREFIX + Buffer.concat([iv, ct, tag]).toString("base64url");
}

export type RefCheck =
  | { ok: true; reservationId: number; startsAt: string }
  | { ok: false; reason: "malformed" | "invalid" | "expired" };

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function openReservationRef(
  ref: string,
  phoneE164: string,
  nowMs: number,
  cfg: { secret: string },
): RefCheck {
  try {
    if (typeof ref !== "string" || !ref.startsWith(RESERVATION_REF_PREFIX) || ref.length !== REF_LENGTH) {
      return { ok: false, reason: "malformed" };
    }
    const body = ref.slice(RESERVATION_REF_PREFIX.length);
    if (!B64URL_RE.test(body)) return { ok: false, reason: "malformed" };
    const raw = Buffer.from(body, "base64url");
    if (raw.length !== IV_LEN + PLAIN_LEN + TAG_LEN) return { ok: false, reason: "malformed" };

    const iv = raw.subarray(0, IV_LEN);
    const ct = raw.subarray(IV_LEN, IV_LEN + PLAIN_LEN);
    const tag = raw.subarray(IV_LEN + PLAIN_LEN);
    let plain: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(cfg.secret), iv);
      decipher.setAAD(aad(phoneE164));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (plain.length !== PLAIN_LEN || plain.readUInt8(0) !== 1) {
      return { ok: false, reason: "invalid" };
    }
    const reservationId = plain.readUInt32BE(1);
    const startsAt = minutesToStartsAt(plain.readUInt32BE(5));
    const exp = plain.readUInt32BE(9);
    if (Math.floor(nowMs / 1000) >= exp) return { ok: false, reason: "expired" };
    return { ok: true, reservationId, startsAt };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
