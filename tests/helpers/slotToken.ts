import type { FastifyInstance } from "fastify";

import { SlotAuthorizationService } from "../../src/services/slotAuthorization.js";
import type { VoiceOfferStore } from "../../src/services/voiceOfferStore.js";
import { SLOT_TOKEN_SECRET } from "./testApp.js";

/**
 * step SLOT — minting real slot tokens for tests.
 *
 * These helpers use the PRODUCTION `SlotAuthorizationService` with the same
 * secret `testEnv()` puts in the environment, so a token built here is
 * indistinguishable from one `/ai/voice/availability` would have issued. That
 * is deliberate: a test double that minted "valid-looking" tokens would assert
 * that the tests agree with themselves, not that the middleware accepts what
 * it issues.
 *
 * A test that wants an INVALID token should tamper with a real one (see
 * `tamperSlotToken`) or mint one for a different conversation — never
 * hand-write a string, which only ever exercises the `malformed` branch.
 */

/** The slot fields a token seals. Mirrors what availability offers. */
export interface SlotTokenFields {
  conversationId: string;
  reservationDate: string;
  employeeId?: number;
  serviceId: number;
}

function service(ttlSeconds: number): SlotAuthorizationService {
  return new SlotAuthorizationService({ secret: SLOT_TOKEN_SECRET, ttlSeconds });
}

/**
 * A token that is valid right now for the given hueco and conversation.
 *
 * `ttlSeconds` defaults to the schema default (900). Pass a small value with
 * a back-dated `nowMs` to produce an expired token without waiting.
 */
export function mintSlotToken(
  fields: SlotTokenFields,
  nowMs: number = Date.now(),
  ttlSeconds = 900,
): string {
  const token = service(ttlSeconds).issue(
    {
      conversationId: fields.conversationId,
      reservationDate: fields.reservationDate,
      ...(fields.employeeId !== undefined ? { employeeId: fields.employeeId } : {}),
      serviceId: fields.serviceId,
    },
    nowMs,
  );
  if (token === undefined) {
    throw new Error("mintSlotToken: the authorization service refused to issue");
  }
  return token;
}

/**
 * A structurally identical token whose sealed bytes have one bit flipped.
 *
 * The flip lands in the CIPHERTEXT, not in the prefix and not in the length,
 * so the result reaches the AEAD tag check rather than being turned away by
 * the shape guard. That is the branch worth testing: "a forged token is
 * rejected" is only interesting if the forgery was well-formed.
 */
/**
 * Turns the flat "hueco + customer" shape the suite has always written into
 * the request body `/ai/voice/book` accepts today.
 *
 * The three hueco fields — `reservation_date`, `employee_id`, `service_id` —
 * are no longer part of that body (see `voiceBookSchema`); they are sealed
 * into a token instead. Rather than rewrite ~50 call sites to build tokens by
 * hand, this helper keeps the readable flat shape at the call site and does
 * the conversion, so a test still says "book 10:00 with barber 1" and the
 * middleware still receives only what it is willing to accept.
 *
 * `slot_token` may be supplied explicitly to override the minting — that is
 * how the tampered, expired and wrong-conversation cases are expressed.
 */
export function voiceBookBody(
  shape: Record<string, unknown>,
  options: {
    /** Clock used to mint. Back-date it to produce an expired token. */
    nowMs?: number;
    ttlSeconds?: number;
    /** Seal the token for a DIFFERENT conversation than the body states. */
    tokenConversationId?: string;
  } = {},
): Record<string, unknown> {
  const {
    reservation_date: reservationDate,
    employee_id: employeeId,
    service_id: serviceId,
    slot_token: explicitToken,
    ...rest
  } = shape;

  const token =
    explicitToken !== undefined
      ? explicitToken
      : mintSlotToken(
          {
            conversationId:
              options.tokenConversationId ?? (rest["conversation_id"] as string),
            reservationDate: reservationDate as string,
            ...(employeeId !== undefined ? { employeeId: employeeId as number } : {}),
            serviceId: serviceId as number,
          },
          options.nowMs ?? Date.now(),
          options.ttlSeconds ?? 900,
        );

  return { ...rest, slot_token: token };
}

export function tamperSlotToken(token: string): string {
  const separator = token.indexOf(".");
  const prefix = token.slice(0, separator);
  const sealed = Buffer.from(token.slice(separator + 1), "base64url");
  // Byte 20 is inside the ciphertext: past the 12-byte IV, well before the
  // trailing 16-byte tag.
  sealed[20] = sealed[20]! ^ 0x01;
  return `${prefix}.${sealed.toString("base64url")}`;
}

/**
 * step OFFER — puts the offer store into the state a real
 * `/ai/voice/availability` call would have left.
 *
 * `POST /ai/voice/book` now needs TWO things: a token that verifies
 * cryptographically, and a token that is the one the conversation is
 * currently being offered (`src/services/voiceOfferStore.ts`). The suite has
 * always minted the first half with the production service instead of going
 * through the agenda; this does the same for the second half, through the
 * store's own public API — `beginRefresh` + `publishOffered`, exactly the two
 * calls `findAvailability()` makes.
 *
 * It arranges a PRECONDITION; it does not bypass a check. Every booking that
 * goes through it still passes the same gate a live call does, in the same
 * order, and a test that wants the refusal simply does not call this.
 *
 * A body with no usable `slot_token`/`conversation_id` is left alone, so the
 * "no token at all" and "pre-migration body" cases keep reaching the real
 * refusal rather than being quietly repaired here.
 */
const OFFERED_BY_APP = new WeakMap<FastifyInstance, Map<string, Set<string>>>();

export function offered<T extends Record<string, unknown>>(
  app: FastifyInstance,
  body: T,
  nowMs: number = Date.now(),
): T {
  const conversationId = body["conversation_id"];
  const token = body["slot_token"];
  if (typeof conversationId !== "string" || typeof token !== "string") return body;

  // Every token this conversation has been handed SO FAR, republished
  // together. A real availability answer offers up to three huecos in ONE
  // generation, so publishing them one at a time — which is what a naive
  // helper would do — would make each call invalidate the last and turn the
  // suite's concurrency cases into refusals for a reason that has nothing to
  // do with what they test. Accumulating per (app, conversation) reproduces
  // the real shape: one generation, several bookable huecos.
  let perApp = OFFERED_BY_APP.get(app);
  if (perApp === undefined) {
    perApp = new Map();
    OFFERED_BY_APP.set(app, perApp);
  }
  let tokens = perApp.get(conversationId);
  if (tokens === undefined) {
    tokens = new Set();
    perApp.set(conversationId, tokens);
  }
  tokens.add(token);

  const store = (app as unknown as { voiceOffers: VoiceOfferStore }).voiceOffers;
  const generation = store.beginRefresh(conversationId, nowMs);
  store.publishOffered(conversationId, generation, [...tokens], nowMs);
  return body;
}
