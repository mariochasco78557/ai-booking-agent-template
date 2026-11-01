import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * *** SLOT AUTHORIZATION — a hueco the middleware itself issued. ***
 *
 * The 2026-08-30 controlled test failed in a way no amount of schema
 * tightening would have caught. The agent never called
 * `/ai/voice/availability` at all: it reconstructed a `reservation_date` from
 * the conversation, sent `employee_id: "Bruno"`, and filled the customer's
 * identity with `"Cliente" / "Desconocido" / "000000000"`. The request died in
 * Zod — but only because the invented phone did not have the shape of a
 * Spanish number and the invented employee id was a string. A model that had
 * fabricated `612345678` and `40` instead would have passed every check the
 * middleware had, and only the (disarmed) write gate would have stood between
 * it and a real appointment in Bruno's diary.
 *
 * The lesson is not "validate harder". Format validation can only ask *does
 * this look like a slot*; it can never ask *did this middleware ever offer
 * this slot, in this call*. That second question needs the answer to carry
 * proof of its own origin, and that is what this module mints.
 *
 * `POST /ai/voice/availability` attaches a `slot_token` to every slot it
 * returns. `POST /ai/voice/book` accepts nothing else: the date, the barber
 * and the service are READ OUT OF THE TOKEN, never off the request body, so
 * there is no longer a field for a model to reconstruct. Fabricating a
 * booking now requires forging an AEAD tag, not guessing a plausible string.
 *
 * ── Why AES-256-GCM and not a plain HMAC envelope ────────────────────────
 *
 * An HMAC-signed, base64-encoded payload is the obvious construction and it
 * would be tamper-evident, which is most of what is needed here. It is not
 * OPAQUE, and opacity is doing real work in this specific threat model: the
 * failure being defended against is an LLM that reconstructs structured
 * values it can see. A token whose payload decodes to a readable
 * `2026-09-11 10:00:00` invites exactly that — decode, adjust, re-encode,
 * fail the signature, retry. A ciphertext offers nothing to pattern-match on,
 * so the only behaviour available to the model is to echo the string it was
 * given, which is precisely the behaviour required.
 *
 * AES-256-GCM is an AEAD: the 16-byte tag IS the message authentication code,
 * and OpenSSL verifies it in constant time inside `decipher.final()`, which
 * throws on any single flipped bit. So "HMAC-SHA256 or an equivalent
 * appropriate construction" is satisfied by the AEAD, and HMAC-SHA256 is
 * still used below — for the conversation binding, where a short, comparable
 * tag is what is wanted.
 *
 * IV reuse is the one way to destroy GCM, so note where the IV comes from: a
 * fresh `randomBytes(12)` per token, never a counter, never derived from the
 * payload. At three slots per availability call, the 96-bit birthday bound is
 * not a quantity this system can approach.
 *
 * ── What the token is NOT ────────────────────────────────────────────────
 *
 * It is not a confirmation, and it is not a reservation. It authorizes the
 * middleware to CONSIDER a write for that hueco; the fresh, cache-bypassing
 * availability re-check immediately before `POST /reservation`
 * ((internal doc, not included in the template) ADR-010) is untouched and still decides whether the hour
 * is actually free. A token that is ten minutes old and a slot that was taken
 * nine minutes ago still ends in `slot_taken`.
 */

/**
 * The cleartext marker every token starts with. Version lives here AND inside
 * the encrypted payload: the outer copy lets a malformed string be rejected
 * without touching a key, and the inner copy is the one that is
 * cryptographically bound, so a future `tk2.` cannot be relabelled `tk1.`
 * and accepted.
 */
export const SLOT_TOKEN_PREFIX = "tk1";

/** The version byte carried INSIDE the sealed payload. */
const FORMAT_VERSION = 1;

/**
 * HKDF domain separation. The operator configures ONE secret; these two
 * labels turn it into two keys that cannot be substituted for one another,
 * so the conversation tag can never be replayed as key material and vice
 * versa.
 */
const HKDF_SALT = "demo-salon/slot-token/2026-08-30";
const SEAL_KEY_INFO = "demo-salon/slot-token/v1/aes-256-gcm";
const CONVERSATION_KEY_INFO = "demo-salon/slot-token/v1/conversation-tag";

/**
 * Additional authenticated data. Not secret — it is a constant — but it is
 * covered by the GCM tag, so a ciphertext minted by some other feature that
 * happened to share this key could not be presented here as a slot token.
 */
const AAD = Buffer.from("demo-salon/slot-token/v1", "utf8");

const IV_BYTES = 12;
const TAG_BYTES = 16;
const CONVERSATION_TAG_BYTES = 8;
/** `version(1) + conversationTag(8) + employeeId(4) + serviceId(1) + expiry(4)`. */
const HEADER_BYTES = 18;
/** `"YYYY-MM-DD HH:mm:ss"` — a fixed 19 characters, enforced on both sides. */
const RESERVATION_DATE_BYTES = 19;
const SEALED_BYTES = IV_BYTES + HEADER_BYTES + RESERVATION_DATE_BYTES + TAG_BYTES;

const RESERVATION_DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** Base64url alphabet only; length is checked after decoding, not here. */
const SEALED_SHAPE_RE = /^[A-Za-z0-9_-]{40,200}$/;

/**
 * The bounds this service enforces ON ITSELF.
 *
 * `src/config/env.ts` checks all three too, and that is not redundancy worth
 * removing: this class is EXPORTED, so `new SlotAuthorizationService(...)` is
 * reachable from any future call site — a script, a test, a second
 * composition root — that never passes through the env schema. A key of the
 * wrong length is not a configuration preference, it is a broken key, and a
 * class that silently accepted one would hand out tokens whose security is a
 * fiction.
 *
 * `env.ts` imports these constants rather than repeating the literals, so the
 * two layers cannot disagree about what a valid key is.
 */
export const SLOT_TOKEN_SECRET_MIN_LENGTH = 32;
export const SLOT_TOKEN_TTL_MIN_SECONDS = 60;
export const SLOT_TOKEN_TTL_MAX_SECONDS = 3600;

/**
 * Why a verification failed. Every value maps to a refusal that performs ZERO
 * upstream calls and writes NOTHING to the idempotency journal — see
 * `VoiceBookingService.book()`.
 */
export type SlotAuthorizationFailure =
  /** No secret is configured, so no token could ever have been issued. */
  | "unconfigured"
  /** Absent, wrong prefix, wrong alphabet, wrong length — never decrypted. */
  | "malformed"
  /** Decryption or tag verification failed, or the sealed payload is not v1. */
  | "forged"
  /** Authentic, but issued for a different conversation. */
  | "wrong_conversation"
  /** Authentic and for this conversation, but past its expiry. */
  | "expired";

/** What a slot token authorizes, once opened. */
export interface SlotGrant {
  /** `"YYYY-MM-DD HH:mm:ss"`, exactly as the availability answer stated it. */
  reservationDate: string;
  /** Absent when availability offered the hueco without naming a barber. */
  employeeId?: number;
  serviceId: number;
  expiresAtMs: number;
}

export type SlotVerification =
  | { ok: true; grant: SlotGrant }
  | { ok: false; failure: SlotAuthorizationFailure };

export interface SlotAuthorizationConfig {
  /**
   * `VOICE_SLOT_TOKEN_SECRET`. When `undefined` the service is DISABLED:
   * availability returns slots with no token and booking refuses everything.
   * That is fail-closed on purpose — a deployment that forgot the secret must
   * not be able to book, and `src/config/env.ts` refuses to boot a production
   * process that has creation armed without one.
   */
  secret?: string;
  /** How long an offered hueco stays bookable. */
  ttlSeconds: number;
}

/**
 * The RESERVATION DATE is carried as its literal 19-character string, not as
 * an epoch. That is deliberate and it is not an optimization left on the
 * table: `reservation_date` is a LOCAL WALL-CLOCK string with no timezone,
 * and it is sent verbatim to the salon's API. Round-tripping it through an
 * epoch would require assuming Europe/Madrid and would be genuinely ambiguous
 * across the October DST fold — a one-hour error, on a write path, in the
 * exactly-once week of the year nobody tests. A string that is never
 * transformed cannot be transformed wrongly.
 */
function sealPayload(
  conversationTag: Buffer,
  grant: SlotGrant,
): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(FORMAT_VERSION, 0);
  conversationTag.copy(header, 1, 0, CONVERSATION_TAG_BYTES);
  // 0 means "availability named no barber" — the same thing an omitted
  // `employee_id` used to mean, so `BookingService` keeps its existing
  // fallback to the configured default without a new branch.
  header.writeUInt32BE(grant.employeeId ?? 0, 9);
  header.writeUInt8(grant.serviceId, 13);
  header.writeUInt32BE(Math.floor(grant.expiresAtMs / 1000), 14);
  return Buffer.concat([header, Buffer.from(grant.reservationDate, "ascii")]);
}

export class SlotAuthorizationService {
  private readonly sealKey?: Buffer;
  private readonly conversationKey?: Buffer;
  private readonly ttlMs: number;

  /**
   * *** THE CONSTRUCTOR REFUSES TO BUILD A SERVICE THAT ONLY LOOKS ARMED. ***
   *
   * Two failure modes, and they are treated differently on purpose:
   *
   * - **No secret at all** is a legitimate posture — the deployment has not
   *   turned the feature on. It yields a DISABLED service that issues nothing
   *   and accepts nothing, which is fail-closed and is what
   *   `src/services/container.ts` warns about at boot.
   * - **A secret that is present but too short**, or a TTL outside the range
   *   a phone call can justify, is a PROGRAMMING OR CONFIGURATION ERROR. It
   *   throws. Constructing a disabled service instead would be worse than
   *   useless: every booking would be refused with `invalid_slot_token` and
   *   the operator would have no signal distinguishing "the key is wrong"
   *   from "the agent never calls availability" — the two most different
   *   diagnoses this system has.
   *
   * Throwing here also refuses to build the app, because `createServices()`
   * runs at boot. A process that cannot authorize slots correctly must not
   * be a process that answers requests.
   */
  constructor(config: SlotAuthorizationConfig) {
    if (
      config.ttlSeconds < SLOT_TOKEN_TTL_MIN_SECONDS ||
      config.ttlSeconds > SLOT_TOKEN_TTL_MAX_SECONDS ||
      !Number.isInteger(config.ttlSeconds)
    ) {
      // The VALUE is safe to name: a TTL is not a secret.
      throw new Error(
        `SlotAuthorizationService: ttlSeconds must be an integer between ` +
          `${SLOT_TOKEN_TTL_MIN_SECONDS} and ${SLOT_TOKEN_TTL_MAX_SECONDS} ` +
          `(got ${config.ttlSeconds})`,
      );
    }
    // An EMPTY secret means "not configured" — `blankAsUnset` in
    // `src/config/env.ts` already normalizes a bare `VOICE_SLOT_TOKEN_SECRET=`
    // line to `undefined`, and a direct caller passing `""` means the same
    // thing. A NON-EMPTY short one is the error: somebody meant to configure a
    // key and configured a broken one.
    const secret = config.secret === "" ? undefined : config.secret;
    if (secret !== undefined && secret.length < SLOT_TOKEN_SECRET_MIN_LENGTH) {
      // NEVER the value, and never the actual length either — a length is a
      // real hint when someone is trying to guess a key.
      throw new Error(
        "SlotAuthorizationService: the configured slot-token secret is shorter than " +
          `${SLOT_TOKEN_SECRET_MIN_LENGTH} characters. Refusing to build a service ` +
          "whose tokens would only look authenticated. Leave VOICE_SLOT_TOKEN_SECRET " +
          "unset to run disabled, or configure a real key.",
      );
    }

    if (secret !== undefined) {
      const ikm = Buffer.from(secret, "utf8");
      const salt = Buffer.from(HKDF_SALT, "utf8");
      this.sealKey = Buffer.from(
        hkdfSync("sha256", ikm, salt, Buffer.from(SEAL_KEY_INFO, "utf8"), 32),
      );
      this.conversationKey = Buffer.from(
        hkdfSync("sha256", ikm, salt, Buffer.from(CONVERSATION_KEY_INFO, "utf8"), 32),
      );
    }
    this.ttlMs = config.ttlSeconds * 1000;
  }

  /** False when no secret is configured; nothing can be issued or accepted. */
  get enabled(): boolean {
    return this.sealKey !== undefined;
  }

  /**
   * Mints the authorization for ONE hueco of ONE availability answer.
   *
   * Returns `undefined` — rather than throwing — when the service is
   * disabled, so `/ai/voice/availability` keeps answering normally (it is a
   * read; a missing secret must not take the agenda offline). The
   * consequence is visible where it matters: booking then refuses, because
   * there is no token to present.
   */
  issue(
    input: {
      conversationId: string;
      reservationDate: string;
      employeeId?: number;
      serviceId: number;
    },
    nowMs: number,
  ): string | undefined {
    if (this.sealKey === undefined || this.conversationKey === undefined) return undefined;
    // A date this service cannot represent exactly must not be sealed into a
    // token that would later decode to something else. Refusing to issue is
    // the safe half of the failure: the slot is still spoken, it just cannot
    // be booked without a fresh availability call.
    if (!RESERVATION_DATE_RE.test(input.reservationDate)) return undefined;

    const grant: SlotGrant = {
      reservationDate: input.reservationDate,
      ...(input.employeeId !== undefined ? { employeeId: input.employeeId } : {}),
      serviceId: input.serviceId,
      expiresAtMs: nowMs + this.ttlMs,
    };
    const payload = sealPayload(this.conversationTag(input.conversationId), grant);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.sealKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const sealed = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
    return `${SLOT_TOKEN_PREFIX}.${sealed.toString("base64url")}`;
  }

  /**
   * Opens a token and confirms it authorizes THIS conversation, right now.
   *
   * Failure order is chosen for diagnosis, not for security — every branch
   * refuses — but "this token belongs to another call" and "this token has
   * expired" are very different operator stories, so the conversation check
   * runs before the clock check.
   */
  verify(token: string, conversationId: string, nowMs: number): SlotVerification {
    return this.open(token, conversationId, nowMs, 0);
  }

  /**
   * 2026-10-11 — like {@link verify}, but a token that expired up to `graceMs`
   * ago still opens. For READ-ONLY uses of the grant (the date, professional
   * and service the token carries), never for authorizing a write.
   */
  open(token: string, conversationId: string, nowMs: number, graceMs: number): SlotVerification {
    if (this.sealKey === undefined || this.conversationKey === undefined) {
      return { ok: false, failure: "unconfigured" };
    }

    const trimmed = token.trim();
    const separator = trimmed.indexOf(".");
    if (separator === -1) return { ok: false, failure: "malformed" };
    if (trimmed.slice(0, separator) !== SLOT_TOKEN_PREFIX) {
      return { ok: false, failure: "malformed" };
    }
    const encoded = trimmed.slice(separator + 1);
    if (!SEALED_SHAPE_RE.test(encoded)) return { ok: false, failure: "malformed" };

    const sealed = Buffer.from(encoded, "base64url");
    if (sealed.length !== SEALED_BYTES) return { ok: false, failure: "malformed" };

    const iv = sealed.subarray(0, IV_BYTES);
    const ciphertext = sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);

    let payload: Buffer;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.sealKey, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      // The constant-time authentication happens here, in OpenSSL: `final()`
      // throws if the tag does not verify. There is no plaintext to inspect
      // before that check, which is what makes this an encrypt-then-MAC
      // construction rather than a hand-rolled one.
      payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return { ok: false, failure: "forged" };
    }

    if (payload.length !== HEADER_BYTES + RESERVATION_DATE_BYTES) {
      return { ok: false, failure: "forged" };
    }
    if (payload.readUInt8(0) !== FORMAT_VERSION) return { ok: false, failure: "forged" };

    const reservationDate = payload
      .subarray(HEADER_BYTES, HEADER_BYTES + RESERVATION_DATE_BYTES)
      .toString("ascii");
    if (!RESERVATION_DATE_RE.test(reservationDate)) return { ok: false, failure: "forged" };

    const sealedConversationTag = payload.subarray(1, 1 + CONVERSATION_TAG_BYTES);
    const expectedConversationTag = this.conversationTag(conversationId);
    // `timingSafeEqual` on a value that is not itself a secret: the
    // conversation id is known to both sides. It costs nothing and it removes
    // the question from a reviewer's mind, which is worth more than the
    // microseconds.
    if (!timingSafeEqual(sealedConversationTag, expectedConversationTag)) {
      return { ok: false, failure: "wrong_conversation" };
    }

    const expiresAtMs = payload.readUInt32BE(14) * 1000;
    if (nowMs >= expiresAtMs + graceMs) return { ok: false, failure: "expired" };

    const employeeId = payload.readUInt32BE(9);
    return {
      ok: true,
      grant: {
        reservationDate,
        ...(employeeId !== 0 ? { employeeId } : {}),
        serviceId: payload.readUInt8(13),
        expiresAtMs,
      },
    };
  }

  /**
   * HMAC-SHA256 of the conversation id, truncated to 8 bytes.
   *
   * Truncation is safe here because this tag is not a signature — the GCM tag
   * already authenticated the whole payload before this value is ever read.
   * Its only job is to say WHICH conversation an already-authentic token was
   * minted for, and 64 bits of keyed output makes a collision between two
   * live ElevenLabs conversation ids something this system will not see.
   *
   * Keyed rather than a plain hash, and truncated rather than stored raw, so
   * a token cannot be used to test a guessed conversation id offline.
   */
  private conversationTag(conversationId: string): Buffer {
    return createHmac("sha256", this.conversationKey!)
      .update(conversationId, "utf8")
      .digest()
      .subarray(0, CONVERSATION_TAG_BYTES);
  }
}
