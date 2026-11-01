import { VoiceManageService } from "./voiceManage/voiceManageService.js";
import {
  bookingDisplayPrefix,
  parseWaAllowlist,
  resolveWaEmployeeCredentials,
  type Env,
} from "../config/env.js";
import { createOwnerNotifier, type OwnerNotifier } from "./ownerNotify/ownerNotifier.js";
import { WaSelfService } from "./waSelfService/waSelfService.js";
import { SlotHoldRegistry } from "./slotHolds.js";
import { ServiceChangeAlerts } from "./recados/serviceChangeAlerts.js";
import { ServiceChangeAgendaAlerts } from "./ownerNotify/serviceChangeAgendaAlerts.js";
import { shortProfessional } from "./ownerNotify/agendaLines.js";
import type { ServiceChangeAlertPort } from "./waSelfService/serviceChange.js";
import type { AgendaBookingPort } from "../routes/balancedV2.js";
import { CALENDAR_LINK_TOKEN_GRACE_MS, WaCalendarLinkService } from "./waSelfService/waCalendarLinkService.js";
import { OpeningHoursGate } from "./recados/openingHoursGate.js";
import { FileRecadoStore, type RecadoStore } from "./recados/recadoStore.js";
import { RecadoService } from "./recados/recadoService.js";
import { RecadoWorker } from "./recados/recadoWorker.js";
import { TelegramUpdates } from "./recados/telegramUpdates.js";
import { TelegramClient } from "./ownerNotify/telegramClient.js";
import {
  assertWritePermissionsIndependent,
  resolveWritePermissions,
} from "../config/writePermissions.js";
import { UpstreamError } from "../core/calendar/errors.js";
import type { CalendarBackOffice, CalendarProvider } from "../core/calendar/CalendarProvider.js";
import { createCalendarBackOffice, createCalendarProvider } from "../adapters/calendar/index.js";
import type { Logger } from "./authTokenService.js";
import { AvailabilityService } from "./availabilityService.js";
import { BookingService } from "./bookingService.js";
import { CancellationService } from "./cancellationService.js";
import { LookupService } from "./lookupService.js";
import { VoiceBookingService, wallMinute, type VoiceBookResult } from "./voiceBookingService.js";
import { SlotAuthorizationService } from "./slotAuthorization.js";
import { MemoryVoiceOfferStore, type VoiceOfferStore } from "./voiceOfferStore.js";
import { BalancedAvailabilityService } from "./balanced/balancedAvailabilityService.js";
import {
  MemoryBalancedOptionStore,
  type BalancedOptionStore,
} from "./balanced/balancedOptionStore.js";
import { ConversationSerializer } from "../utils/conversationSerializer.js";
import { deriveBalancedV2SlotSecret } from "./balanced/balancedV2Secret.js";
import {
  FileBookingIdempotencyStore,
  MemoryBookingIdempotencyStore,
} from "./bookingIdempotencyStore.js";
import { createCallerIdentityResolver, type CallerIdentityResolver } from "../callerIdentity/resolver.js";
import { PriorityLimiter } from "../utils/concurrency.js";
import { AgendaSource } from "./agenda/agendaSource.js";
import { AgendaCache } from "./agenda/agendaCache.js";
import { AgendaRefresher } from "./agenda/agendaRefresher.js";
import { DirectAgendaReader, type AgendaReader } from "./agenda/agendaReader.js";
import { AgentProfileResolver } from "./balanced/agentProfile.js";
import { createSessionPinStore } from "../callerIdentity/sessionPin.js";
import { CALLER_ID_MAX_LIFETIME_MS } from "../types/callerIdentity.js";
import { MemoryEmployeeNameDirectory } from "./employeeNameDirectory.js";
import { defaultEmployee, getClientConfig } from "../core/config/clientConfig.js";
import { PhoneBookingLimit } from "./bookingLimit/phoneBookingLimit.js";
import {
  createWhatsAppNotifier,
  parseAllowedRecipients,
  type WhatsAppNotifier,
} from "./whatsapp/whatsappNotifier.js";

/**
 * Bound on the first-touch session-pin store (design §4.2: "bounded: max
 * entries and TTL ≤ maximum call length, so it is not an unbounded memory
 * sink"). Generous for a lab-scale deployment while staying trivially
 * bounded; not exposed as an env var because sizing it is not a security
 * decision the way the trust-mode flags are.
 */
const SESSION_PIN_MAX_ENTRIES = 1000;
/**
 * TTL for a pinned (or poisoned) session entry. Reuses
 * `CALLER_ID_MAX_LIFETIME_MS` (design §4.2's own "≤ 15 min" identity
 * lifetime ceiling) rather than inventing a second, independent constant: a
 * single call cannot plausibly outlive its own identity's maximum lifetime,
 * so the same ceiling already bounds both.
 */
const SESSION_PIN_TTL_MS = CALLER_ID_MAX_LIFETIME_MS;

export interface Services {
  /** The calendar adapter selected by CALENDAR_PROVIDER (phase 1). */
  calendar: CalendarProvider;
  availability: AvailabilityService;
  booking: BookingService;
  cancellation: CancellationService;
  lookup: LookupService;
  voiceBooking: VoiceBookingService;
  /**
   * step OFFER — the per-conversation memory of the hueco currently offered
   * (`src/services/voiceOfferStore.ts`). Exposed for diagnostics and for
   * `src/app.ts` to hand to nothing but tests; no route reads it.
   */
  voiceOffers: VoiceOfferStore;
  /**
   * BALANCED V2 ((internal doc, not included in the template) ADR-020) — discovery and locking for the
   * duplicated ElevenLabs agent. Reads the agenda; never writes.
   */
  balancedV2: BalancedAvailabilityService;
  /**
   * The V2 write path. A SEPARATE `VoiceBookingService` instance from
   * `voiceBooking` above, and separate in exactly three ways and no others: a
   * different slot-token domain, a different offer store, and a different
   * write permission. It shares the durable idempotency journal and the
   * per-conversation serializer with the stable path, so "one appointment per
   * call" is a property of the CALL rather than of the endpoint.
   */
  voiceBookingBalancedV2: VoiceBookingService;
  /** 2026-10-09 — absent when MAX_FUTURE_BOOKINGS_PER_PHONE=0 or no agenda reader. */
  phoneBookingLimit?: PhoneBookingLimit;
  /**
   * V5 ((internal doc, not included in the template) ADR-025) — decides, per request, whether a V2 call
   * is served as V4 or as V5, from its `agent_profile` field and
   * `BALANCED_V5_ENABLED`.
   */
  balancedAgentProfiles: AgentProfileResolver;
  /** The V2 offer memory (locked tokens). Diagnostics and tests only. */
  balancedV2Offers: VoiceOfferStore;
  /** The V2 option memory (numbered hours). Diagnostics and tests only. */
  balancedV2Options: BalancedOptionStore;
  /**
   * Exposed (not merely an internal detail of `lookup`) so `src/app.ts` can
   * key the `/ai/*` rate limiter on the SAME resolved identity `lookup`
   * itself will use (design §10.1), instead of building a second resolver
   * instance from env — one resolver, one source of truth for "is there a
   * caller identity on this request".
   */
  callerIdentityResolver: CallerIdentityResolver;
  /**
   * Present only when `ENABLE_AGENDA_CACHE=true`. Exposed so `/health` can
   * report cache state and so `src/app.ts` can stop the refresher cleanly on
   * shutdown — nothing else should reach into it.
   */
  agendaCache?: AgendaCache;
  agendaRefresher?: AgendaRefresher;
  /**
   * Present ONLY when `WHATSAPP_NOTIFICATIONS_MODE` is `dry_run` or `live`
   * (and the queue file could be opened). `src/app.ts` starts its worker after
   * the routes are registered and stops it through `onClose`, exactly as it
   * does with the agenda refresher — an interval nobody tears down is a test
   * suite that does not exit.
   *
   * With the feature off this key is simply absent, no queue file exists, and
   * every booking answer is byte for byte what it was before.
   */
  whatsapp?: WhatsAppNotifier;
  /**
   * ADR-032. Present only when `TELEGRAM_NOTIFY_MODE` != off (and the queue
   * opened). `src/app.ts` starts/stops it like `whatsapp`.
   */
  ownerNotifier?: OwnerNotifier;
  /** AVISOS_AGENDA: present only with `TELEGRAM_NOTIFY_AGENDA_LINES` working. */
  agendaBookings?: AgendaBookingPort;
  /**
   * ADR-032. Present only when `WA_SELF_SERVICE_SECRET` is configured; the
   * `/ai/wa/*` routes are registered only then.
   */
  waSelfService?: WaSelfService;
  /**
   * 2026-10-11 — `POST /ai/wa/calendar-link`. Always built; it answers
   * `calendar_unavailable` when the calendar env vars are missing.
   */
  waCalendarLink?: WaCalendarLinkService;
  /**
   * Recados para Bruno (internal doc, not included in the template). Present only when
   * `RECADOS_MODE` != off. `worker`/`updates` are absent when the store could
   * not be opened (the routes then answer `recado_unavailable`) or, for
   * `updates`, outside `live`.
   */
  recados?: {
    gate: OpeningHoursGate;
    service: RecadoService;
    worker?: RecadoWorker;
    updates?: TelegramUpdates;
  };
  /** 2026-10-10 — voice consults / cancels / changes existing bookings (VOICE_MANAGE_BOOKINGS_ENABLED). */
  voiceManage: VoiceManageService;
}

/**
 * Wires all services from validated env + a logger. Single composition root,
 * making handlers thin and everything trivially unit-testable.
 */
export function createServices(env: Env, logger: Logger): Services {
  // Nombre/apellidos del empleado por defecto tal y como los guarda la agenda
  // (`calendario.empleado_por_defecto` de cliente.yaml, D-007). Demo Salon: "Bruno" / "Demo".
  const defaultEmployeeCfg = defaultEmployee(getClientConfig());
  const DEFAULT_EMPLOYEE_DISPLAY = {
    name: defaultEmployeeCfg?.nombre_agenda ?? defaultEmployeeCfg?.nombre ?? "",
    surnames: defaultEmployeeCfg?.apellidos_agenda ?? "",
  };
  // step PROD (Hito 5): resolved ONCE, here, and handed to each service as
  // its own independent boolean. BookingService and CancellationService no
  // longer read the same `ENABLE_WRITE_OPERATIONS` value — arming one can no
  // longer arm the other. See src/config/writePermissions.ts for the rule.
  const flags = {
    master: env.ENABLE_WRITE_OPERATIONS,
    create: env.ENABLE_CREATE_BOOKING,
    cancel: env.ENABLE_CANCEL_BOOKING,
    update: env.ENABLE_UPDATE_BOOKING,
  };
  // step LAT (objective 3): throws — and so refuses to build the app — if the
  // separation between create, cancel and update has been broken. Checked
  // before any service exists, so a process that could arm the wrong write
  // never reaches the point of having a client to arm it with.
  assertWritePermissionsIndependent(flags);
  const writePermissions = resolveWritePermissions(flags);

  // Phase 1 (internal doc, not included in the template): the ONLY calendar access of the
  // booking account (`memory` or `google-calendar`; see adapters/calendar/index.ts).
  // Credential-based adapters would take BOOKING_REMEMBER_ME from env here.
  const calendar = createCalendarProvider(env, logger);

  const defaults = {
    employeeId: env.BOOKING_DEFAULT_EMPLOYEE_ID,
    typeReservation: env.BOOKING_DEFAULT_TYPE_RESERVATION,
    maxSlots: env.DEFAULT_MAX_SLOTS,
    multiBarber: env.ENABLE_MULTI_BARBER,
    upstreamMode: env.BOOKING_UPSTREAM_MODE,
  };

  // step LAT. The limiter is created HERE, once, and shared by the live read
  // path and the background refresher alike. That sharing is the point: it is
  // what makes "never more than N simultaneous requests against the salon's
  // API" true of the process as a whole rather than of each caller separately.
  // Live requests take the `interactive` lane and always overtake refresh work.
  const upstreamLimiter = new PriorityLimiter(env.UPSTREAM_MAX_CONCURRENCY);
  const agendaSource = new AgendaSource(calendar, upstreamLimiter);

  const agendaCache = env.ENABLE_AGENDA_CACHE
    ? new AgendaCache(
        agendaSource,
        {
          nearTtlMs: env.AGENDA_CACHE_NEAR_TTL_MS,
          farTtlMs: env.AGENDA_CACHE_FAR_TTL_MS,
          nearHorizonDays: env.AGENDA_CACHE_NEAR_DAYS,
          negativeTtlMs: env.AGENDA_CACHE_NEGATIVE_TTL_MS,
          jitterRatio: env.AGENDA_CACHE_JITTER_RATIO,
          staleCeilingMs: env.AGENDA_CACHE_STALE_CEILING_MS,
          maxEntries: env.AGENDA_CACHE_MAX_ENTRIES,
          maxSnapshotBytes: env.AGENDA_CACHE_MAX_SNAPSHOT_BYTES,
          ...(env.AGENDA_CACHE_SNAPSHOT_PATH
            ? { snapshotPath: env.AGENDA_CACHE_SNAPSHOT_PATH }
            : {}),
        },
        logger,
      )
    : undefined;

  const agendaReader: AgendaReader = agendaCache ?? new DirectAgendaReader(agendaSource);

  const agendaRefresher =
    agendaCache !== undefined
      ? new AgendaRefresher(
          agendaCache,
          {
            horizonDays: env.AGENDA_CACHE_HORIZON_DAYS,
            serviceIds: parseServiceIds(env.AGENDA_CACHE_SERVICE_IDS),
            nearIntervalMs: env.AGENDA_CACHE_NEAR_TTL_MS,
            farIntervalMs: env.AGENDA_CACHE_FAR_TTL_MS,
            nearHorizonDays: env.AGENDA_CACHE_NEAR_DAYS,
            tickMs: env.AGENDA_CACHE_TICK_MS,
            maxKeysPerTick: env.AGENDA_CACHE_MAX_KEYS_PER_TICK,
            refreshConcurrency: env.UPSTREAM_MAX_CONCURRENCY,
            quietFromHour: env.AGENDA_CACHE_QUIET_FROM_HOUR,
            quietToHour: env.AGENDA_CACHE_QUIET_TO_HOUR,
            quietFactor: env.AGENDA_CACHE_QUIET_FACTOR,
            maxBackoffFactor: 32,
            snapshotIntervalMs: 60_000,
          },
          logger,
        )
      : undefined;

  const availability = new AvailabilityService(calendar, defaults, agendaReader);

  // step 10C ((internal doc, not included in the template)
  // §4): the resolver's trust mode defaults to "none" (AI_CALLER_ID_TRUST_MODE),
  // under which no caller identity is ever resolved — lookup and
  // cancellation both stay fail-closed at "identity_missing" regardless of
  // anything else here. Construction can throw for `synthetic_test` outside
  // NODE_ENV=test or `signed_envelope` without an HMAC secret — both
  // deliberate, fail-closed boot-time guards (see
  // src/callerIdentity/resolver.ts), on top of src/config/env.ts's own
  // superRefine.
  //
  // Constructed here, BEFORE `booking` below (moved up from its previous
  // position after `booking`): design §10.2/§13 (senior finding B8) needs
  // this SAME resolver instance wired into `BookingService` too, so
  // "is there a caller identity on this request" is answered identically
  // for booking as it already is for lookup and cancellation.
  const callerIdentityResolver = createCallerIdentityResolver({
    trustMode: env.AI_CALLER_ID_TRUST_MODE,
    providerAttested: env.AI_CALLER_ID_PROVIDER_ATTESTED,
    hmacSecret: env.AI_CALLER_ID_HMAC_SECRET,
  });

  // 2026-10-11 (internal doc, not included in the template): slots held by a service
  // change in flight; every BookingService below refuses them as `slot_taken`.
  const slotHolds = new SlotHoldRegistry();

  const booking = new BookingService(
    calendar,
    availability,
    callerIdentityResolver,
    {
      employeeId: env.BOOKING_DEFAULT_EMPLOYEE_ID,
      typeReservation: env.BOOKING_DEFAULT_TYPE_RESERVATION,
      writeEnabled: writePermissions.createEnabled,
      multiBarber: env.ENABLE_MULTI_BARBER,
      upstreamMode: env.BOOKING_UPSTREAM_MODE,
      ownerMode: env.BOOKING_BOOKING_OWNER_MODE,
      owner: {
        id: env.BOOKING_DEFAULT_OWNER_ID,
        name: env.BOOKING_DEFAULT_OWNER_NAME,
        surnames: env.BOOKING_DEFAULT_OWNER_SURNAMES,
      },
      // Display fields for the reservation payload's employee ref.
      employee: DEFAULT_EMPLOYEE_DISPLAY,
      // Incident 2026-09-18: never write an hour of today that has started.
      minLeadMinutes: env.BALANCED_MIN_LEAD_MINUTES,
      earlyClose: env.BALANCED_EARLY_CLOSE,
    },
    logger,
    slotHolds,
  );

  // ONE shared instance, passed into BOTH LookupService and
  // CancellationService below — design §4.2 pins a call session "for
  // lookup and cancel alike": a conflict first observed on one endpoint
  // must be visible to the other within the same call, which only holds if
  // both share this exact store rather than each holding an independent
  // one. `booking` above deliberately does NOT get a session-pin store: the
  // B8 mitigation only ever reads the identity's already-verified
  // `phoneE164`, so there is nothing for a booking-side pin conflict to
  // protect that isn't already covered by lookup's/cancel's own pinning.
  const sessionPins = createSessionPinStore({
    maxEntries: SESSION_PIN_MAX_ENTRIES,
    ttlMs: SESSION_PIN_TTL_MS,
  });

  const cancellation = new CancellationService(
    calendar,
    callerIdentityResolver,
    sessionPins,
    { writeEnabled: writePermissions.cancelEnabled, upstreamMode: env.BOOKING_UPSTREAM_MODE },
    logger,
  );

  const lookup = new LookupService(
    calendar,
    callerIdentityResolver,
    sessionPins,
    { upstreamMode: env.BOOKING_UPSTREAM_MODE },
    logger,
  );

  // step PROD (Hito 6). Two deliberate choices here:
  //
  // - The store is durable only when BOOKING_IDEMPOTENCY_PATH is configured.
  //   `src/config/env.ts` refuses to boot a production process that has
  //   creation armed without it, so "creation is on" and "a restart cannot
  //   double-book" cannot come apart.
  // - The fingerprint key is AI_WEBHOOK_SECRET rather than a fresh random
  //   value, because a durable store is only durable if the fingerprints it
  //   holds still match after a restart. Reusing the webhook secret keeps that
  //   property without introducing a second secret to manage; the secret is
  //   never stored, only used as an HMAC key.
  const idempotencyStore = env.BOOKING_IDEMPOTENCY_PATH
    ? new FileBookingIdempotencyStore<VoiceBookResult>(
        env.BOOKING_IDEMPOTENCY_PATH,
        Date.now(),
        (message, detail) => logger.warn(detail, message),
      )
    : new MemoryBookingIdempotencyStore<VoiceBookResult>();

  // step SLOT. Constructed here, from configuration alone, and handed to the
  // voice service as its ONLY way of minting or opening a slot token. Nothing
  // else in the container holds a reference: `POST /ai/book` and the console
  // must not be able to issue an authorization for a hueco.
  //
  // A missing `VOICE_SLOT_TOKEN_SECRET` produces a DISABLED instance rather
  // than a throw. Availability keeps working (a read must not go dark for a
  // missing secret) and every booking is refused; `src/config/env.ts` is what
  // refuses to boot a production process that has creation armed in that
  // state.
  const slotAuthorization = new SlotAuthorizationService({
    ...(env.VOICE_SLOT_TOKEN_SECRET ? { secret: env.VOICE_SLOT_TOKEN_SECRET } : {}),
    ttlSeconds: env.VOICE_SLOT_TOKEN_TTL_SECONDS,
  });

  // step OFFER. One store for the process, wired ONLY into the voice service
  // — the same reasoning as `slotAuthorization` above: nothing else may
  // publish or consume an offer.
  //
  // The digest key is `AI_WEBHOOK_SECRET` rather than a fresh random value for
  // consistency with the idempotency fingerprint, not for durability: this
  // store is in-memory and a restart empties it on purpose (a pending offer
  // whose memory is gone must fail closed, never be reconstructed).
  const voiceOffers = new MemoryVoiceOfferStore({
    ttlSeconds: env.VOICE_OFFER_TTL_SECONDS,
    maxEntries: env.VOICE_OFFER_MAX_ENTRIES,
    digestKey: env.AI_WEBHOOK_SECRET,
  });

  // ONE queue for BOTH booking services (they share the journal above, and a
  // write gate is only atomic if a single queue guards it). See
  // `src/utils/conversationSerializer.ts`.
  const bookingSerializer = new ConversationSerializer();

  // ══ WhatsApp confirmations (src/services/whatsapp/) ══════════════════════
  //
  // ADDITIVE AND OFF BY DEFAULT. With `WHATSAPP_NOTIFICATIONS_MODE` unset,
  // `createWhatsAppNotifier` returns `undefined`, no file is opened, no worker
  // exists, and the two booking services below receive exactly the deps they
  // received before this feature was written.
  //
  // The directory is created unconditionally because it is a bare `Map` that
  // costs nothing and holds no secret; keeping it independent of the flag
  // means the name is already there the day the flag is turned on, without a
  // second wiring path to reason about.
  const employeeNames = new MemoryEmployeeNameDirectory();
  const whatsappAllowedRecipients = parseAllowedRecipients(env.WHATSAPP_ALLOWED_RECIPIENTS);
  const whatsapp = createWhatsAppNotifier({
    mode: env.WHATSAPP_NOTIFICATIONS_MODE,
    ...(env.WHATSAPP_QUEUE_PATH ? { queuePath: env.WHATSAPP_QUEUE_PATH } : {}),
    ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
    ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
    templateName: env.WHATSAPP_TEMPLATE_NAME,
    templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
    sendTimeoutMs: env.WHATSAPP_SEND_TIMEOUT_MS,
    ...(whatsappAllowedRecipients !== undefined
      ? { allowedRecipients: whatsappAllowedRecipients }
      : {}),
    ...(env.WHATSAPP_CALENDAR_LINK_SECRET
      ? { calendarLinkSecret: env.WHATSAPP_CALENDAR_LINK_SECRET }
      : {}),
    ...(env.WHATSAPP_CALENDAR_BASE_URL ? { calendarBaseUrl: env.WHATSAPP_CALENDAR_BASE_URL } : {}),
    logger,
    employeeNames,
  });

  // ADR-031 addendum (2026-10-08): the `calendar_url` of a booking answer,
  // for the WhatsApp «cerebro» only (header `x-ai-channel: whatsapp`). Needs
  // BOTH calendar env vars and nothing else — in particular NOT
  // `WHATSAPP_NOTIFICATIONS_MODE`, which stays `off` in production. Same
  // employee-name directory as the notifier, so both mint the same link.
  const calendarLink =
    env.WHATSAPP_CALENDAR_LINK_SECRET && env.WHATSAPP_CALENDAR_BASE_URL
      ? {
          config: {
            secret: env.WHATSAPP_CALENDAR_LINK_SECRET,
            baseUrl: env.WHATSAPP_CALENDAR_BASE_URL.replace(/\/+$/, ""),
          },
          employeeNames,
        }
      : undefined;

  const voiceBooking = new VoiceBookingService(availability, booking, {
    store: idempotencyStore,
    serializer: bookingSerializer,
    offerStore: voiceOffers,
    fingerprintKey: env.AI_WEBHOOK_SECRET,
    // step CTL ((internal doc, not included in the template) ADR-012). Wired ONLY here, into the voice
    // service. `booking` above is the same instance `POST /ai/book` uses and
    // knows nothing about the marker — it receives it per call, from this
    // service, or not at all.
    displayPrefix: bookingDisplayPrefix(env),
    slotAuthorization,
    logger,
    // A confirmed appointment is a confirmed appointment whichever voice route
    // created it, so the stable path gets the same notifier rather than a
    // second policy about who deserves a WhatsApp. `undefined` when the
    // feature is off, which is the default.
    ...(whatsapp ? { whatsapp } : {}),
    ...(calendarLink ? { calendarLink } : {}),
  });

  // ══ BALANCED V2 ((internal doc, not included in the template) ADR-020) ═══════════════════════════════
  //
  // Everything below is ADDITIVE. Not one line above it changes behaviour, and
  // `availability`, `booking`, `voiceBooking`, `slotAuthorization` and
  // `voiceOffers` are handed to the V2 objects only where sharing is the point
  // (the agenda, the journal, the queue) and never where isolation is (the
  // token domain, the offer memory, the write permission).

  // *** THE TOKEN DOMAIN. ***
  //
  // A key DERIVED from the same configured secret, so an operator still manages
  // exactly one secret, but a key that is cryptographically unrelated to the V1
  // one. The consequence is the property the whole V2 write gate rests on: a
  // token minted by `/ai/voice/availability` fails the V2 AEAD tag and a token
  // minted by a V2 `lock` fails V1's. Neither flow can spend the other's
  // authorization, so `ENABLE_BALANCED_V2_CREATE` cannot be sidestepped by
  // pointing a V2 token at the stable route — which it could be, trivially, if
  // the two shared a key.
  const balancedV2Secret = deriveBalancedV2SlotSecret(env.VOICE_SLOT_TOKEN_SECRET);
  const balancedV2SlotAuthorization = new SlotAuthorizationService({
    ...(balancedV2Secret ? { secret: balancedV2Secret } : {}),
    ttlSeconds: env.VOICE_SLOT_TOKEN_TTL_SECONDS,
  });

  // Its OWN offer memory. A lock publishes here and nowhere else, so a V2 token
  // is never "the hueco on the table" for the stable route, and vice versa.
  const balancedV2Offers = new MemoryVoiceOfferStore({
    ttlSeconds: env.VOICE_OFFER_TTL_SECONDS,
    maxEntries: env.VOICE_OFFER_MAX_ENTRIES,
    digestKey: balancedV2Secret ?? env.AI_WEBHOOK_SECRET,
  });

  // The numbered hours a discovery published. Bounded on the same dials as the
  // offer store — they hold one record per live conversation each, so sizing
  // them separately would be two numbers describing one thing.
  const balancedV2Options = new MemoryBalancedOptionStore({
    ttlSeconds: env.VOICE_OFFER_TTL_SECONDS,
    maxEntries: env.VOICE_OFFER_MAX_ENTRIES,
  });

  const balancedV2 = new BalancedAvailabilityService({
    // The SAME agenda reader — and therefore the same cache, the same
    // concurrency limiter and the same `readFresh` bypass — as the stable path.
    // Two views of one snapshot cannot contradict each other about which hours
    // are free; two independent readers could.
    agenda: agendaReader,
    options: balancedV2Options,
    slotAuthorization: balancedV2SlotAuthorization,
    offerStore: balancedV2Offers,
    logger,
    upstreamMaxConcurrency: env.UPSTREAM_MAX_CONCURRENCY,
    closedWeekdays: env.BALANCED_CLOSED_WEEKDAYS,
    minLeadMinutes: env.BALANCED_MIN_LEAD_MINUTES,
    earlyClose: env.BALANCED_EARLY_CLOSE,
    // 2026-10-08: page size of a request carrying `x-ai-channel: whatsapp`.
    // Voice requests never use it (pages of 3).
    whatsAppMaxOptions: env.BALANCED_WA_MAX_OPTIONS,
    // 2026-10-11 (own_booking_at_time): reads the standing rows through the WA
    // self-service dashboard reader (assigned later; read lazily). Fails open:
    // any error, a missing reader or a slow dashboard (> 1.5 s) = no guard.
    ownBookingAt: async (phoneE164, date, time, employeeId) => {
      const reader = waSelfService;
      if (reader === undefined) return undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        const rows = await Promise.race([
          reader.readStandingRows({ fromDate: date, toDate: date }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), 1500);
          }),
        ]);
        const hit = rows?.find(
          (row) =>
            row.ownerPhoneE164 === phoneE164 &&
            row.startsAt === `${date} ${time}` &&
            employeeId !== undefined &&
            row.employeeId === employeeId,
        );
        return hit === undefined ? undefined : { employeeName: hit.employeeName };
      } catch {
        return undefined;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    // Write-only from the lock's point of view: it records the roster it
    // already read, so the write path can name the barber without asking
    // upstream again. See `src/services/employeeNameDirectory.ts`.
    employeeNames,
  });

  // *** THE V2 WRITE PERMISSION — a THREE-way AND. ***
  //
  // `writePermissions.createEnabled` is already `master && create`. Requiring
  // `ENABLE_BALANCED_V2_CREATE` on top of it is what makes the experiment's
  // write flag real: on a deployment with creation fully armed, this stays
  // false until somebody sets it, and `/ai/voice/v2/book` answers
  // `write_disabled` with no upstream call and no mutation.
  const balancedV2CreateEnabled =
    writePermissions.createEnabled && env.ENABLE_BALANCED_V2_CREATE;

  // A second `BookingService` differing from the first in ONE field. Sharing
  // the instance and passing the flag per call was the alternative and it is
  // worse: `writeEnabled` would then be something a call site could get wrong,
  // instead of something the object cannot represent incorrectly.
  const balancedV2Booking = new BookingService(
    calendar,
    availability,
    callerIdentityResolver,
    {
      employeeId: env.BOOKING_DEFAULT_EMPLOYEE_ID,
      typeReservation: env.BOOKING_DEFAULT_TYPE_RESERVATION,
      writeEnabled: balancedV2CreateEnabled,
      multiBarber: env.ENABLE_MULTI_BARBER,
      upstreamMode: env.BOOKING_UPSTREAM_MODE,
      ownerMode: env.BOOKING_BOOKING_OWNER_MODE,
      owner: {
        id: env.BOOKING_DEFAULT_OWNER_ID,
        name: env.BOOKING_DEFAULT_OWNER_NAME,
        surnames: env.BOOKING_DEFAULT_OWNER_SURNAMES,
      },
      employee: DEFAULT_EMPLOYEE_DISPLAY,
      // Incident 2026-09-18: never write an hour of today that has started.
      minLeadMinutes: env.BALANCED_MIN_LEAD_MINUTES,
      earlyClose: env.BALANCED_EARLY_CLOSE,
      // ADR-032: ONLY this instance (never the V1 `booking` above). Inert for
      // any request without a valid X-AI-WA-Caller-Id header.
      waCallerPin: env.WA_BOOKING_PIN_CALLER_PHONE,
    },
    logger,
    slotHolds,
  );

  // ══ WhatsApp self-service + Telegram owner notices (ADR-032) ══════════════
  //
  // ADDITIVE AND OFF BY DEFAULT: with every WA_/TELEGRAM_ variable unset none
  // of this is constructed (no second login, no queue file, no worker).
  // Recados para Bruno: the opening-hours gate exists first because the owner
  // notifier is held by it when recados are on. `waSelfService` is read lazily
  // (it is built just below).
  let waSelfService: WaSelfService | undefined;
  const recadosOn = env.RECADOS_MODE !== "off" && env.RECADOS_STATE_DIR !== undefined;
  const recadosGate = recadosOn
    ? new OpeningHoursGate({
        reader: agendaReader,
        ...(env.WA_SELF_SERVICE_MODE !== "off"
          ? { standingRows: (range) => waSelfService!.readStandingRows(range) }
          : {}),
        serviceId: env.RECADOS_HOURS_SERVICE_ID,
        appointmentMinutes: env.RECADOS_APPOINTMENT_MINUTES,
        statePath: `${env.RECADOS_STATE_DIR}/horario.json`,
        logger,
      })
    : undefined;

  // (internal doc, not included in the template) §2.7: one-line notices + digest need the
  // gate (recados), the panel read (WA self-service) and the queue. If one is
  // missing: log an error and behave as with the flag off (never block the boot).
  const agendaLinesWanted = env.TELEGRAM_NOTIFY_AGENDA_LINES;
  const agendaLinesOk = agendaLinesWanted && recadosGate !== undefined && env.WA_SELF_SERVICE_MODE !== "off";
  if (agendaLinesWanted && !agendaLinesOk) {
    logger.error(
      { recados_on: recadosGate !== undefined, wa_mode: env.WA_SELF_SERVICE_MODE },
      "owner agenda lines DISABLED for this process: they need RECADOS_MODE and WA_SELF_SERVICE_MODE on",
    );
  }

  const ownerNotifier = createOwnerNotifier({
    ...(agendaLinesOk
      ? {
          agenda: {
            namePrefix: bookingDisplayPrefix(env),
            countDay: async (date: string): Promise<number> => {
              if (waSelfService === undefined) throw new Error("wa_self_service_unavailable");
              const rows = await waSelfService.readStandingRows({ fromDate: date, toDate: date });
              return rows.filter((r) => r.startsAt.slice(0, 10) === date).length;
            },
          },
        }
      : {}),
    mode: env.TELEGRAM_NOTIFY_MODE,
    ...(env.TELEGRAM_QUEUE_PATH ? { queuePath: env.TELEGRAM_QUEUE_PATH } : {}),
    // With recados on, the owner notices use the recados bot and its gate.
    ...(recadosGate !== undefined
      ? {
          ...(env.RECADOS_BOT_TOKEN ? { botToken: env.RECADOS_BOT_TOKEN } : {}),
          ...(env.RECADOS_CHAT_ID ? { chatId: env.RECADOS_CHAT_ID } : {}),
          gate: recadosGate,
        }
      : {
          ...(env.TELEGRAM_BOT_TOKEN ? { botToken: env.TELEGRAM_BOT_TOKEN } : {}),
          ...(env.TELEGRAM_CHAT_ID ? { chatId: env.TELEGRAM_CHAT_ID } : {}),
        }),
    sendTimeoutMs: env.TELEGRAM_SEND_TIMEOUT_MS,
    logger,
  });

  // §3.10: with the agenda lines on, `service_changed` becomes a line; otherwise exactly d03c78f.
  const wrapServiceChangeAlerts = (base: ServiceChangeAlertPort): ServiceChangeAlertPort =>
    agendaLinesOk && ownerNotifier !== undefined ? new ServiceChangeAgendaAlerts(base, ownerNotifier) : base;

  // §3.7: every NEW confirmed booking is counted for the digest. Never throws.
  const agendaBookings: AgendaBookingPort | undefined =
    agendaLinesOk && ownerNotifier !== undefined
      ? {
          noteBooking: (b, nowMs) => {
            try {
              const opened = balancedV2SlotAuthorization.open(
                b.slotToken,
                b.conversationId,
                nowMs,
                CALENDAR_LINK_TOKEN_GRACE_MS,
              );
              ownerNotifier.enqueueAgendaBooked(
                {
                  channel: b.channel,
                  conversationId: b.conversationId,
                  slotToken: b.slotToken,
                  startsAt: opened.ok ? wallMinute(opened.grant.reservationDate) : null,
                  professional: shortProfessional(b.employeeName),
                },
                nowMs,
              );
            } catch {
              // A hook may never touch a booking.
            }
          },
        }
      : undefined;

  const waAllowlist = parseWaAllowlist(env.WA_SELF_SERVICE_ALLOWLIST);
  if (env.WA_SELF_SERVICE_SECRET !== undefined) {
    // The employee credential exists only if the mode needs it. env.ts already
    // guarantees credentials and ref secret are present when mode != off.
    let employeeClient: CalendarBackOffice | undefined;
    const employeeCreds =
      env.WA_SELF_SERVICE_MODE !== "off" ? resolveWaEmployeeCredentials(env) : undefined;
    if (employeeCreds !== undefined) {
      // A SECOND login client + token service: never shared with the booking
      // account's `client`/`auth`, and never rememberMe. Kept separate EVEN
      // when the employee identity is the service account itself
      // (WA_EMPLOYEE_USES_SERVICE_ACCOUNT): two independent JWTs of the same
      // user are fine upstream (stateless Lexik tokens), a 401/403 on the
      // WhatsApp path then invalidates only its own token and never the one
      // the voice agent is booking with, and this path is the same code in
      // both modes.
      employeeClient = createCalendarBackOffice(env, employeeCreds, logger);
    }
    waSelfService = new WaSelfService(
      {
        mode: env.WA_SELF_SERVICE_MODE,
        allowlist: waAllowlist,
        // Empty string only when mode is "off" (the service never uses it then).
        refSecret: env.WA_REF_SECRET ?? "",
        refTtlMinutes: env.WA_REF_TTL_MINUTES,
        cancelMinLeadMinutes: env.WA_CANCEL_MIN_LEAD_MINUTES,
        lateCancelThresholdMinutes: env.WA_LATE_CANCEL_THRESHOLD_MINUTES,
        lookupHorizonDays: env.WA_LOOKUP_HORIZON_DAYS,
        telegramLive: env.TELEGRAM_NOTIFY_MODE === "live",
      },
      employeeClient,
      ownerNotifier,
      logger,
      env.SERVICE_CHANGE_MODE === "off"
        ? undefined
        : {
            mode: env.SERVICE_CHANGE_MODE,
            writeEnabled: env.ENABLE_WRITE_OPERATIONS,
            minLeadMinutes: env.SERVICE_CHANGE_MIN_LEAD_MINUTES,
            // The reservations account's token, one retry after a 401.
            createReservation: async (body) => {
              try {
                await calendar.createBooking(body);
              } catch (err) {
                if (!(err instanceof UpstreamError) || err.status !== 401) throw err;
                calendar.resetSession();
                await calendar.createBooking(body);
              }
            },
            employeesDay: async (date) => {
              try {
                return await calendar.listResourcesForDay(date);
              } catch (err) {
                if (!(err instanceof UpstreamError) || err.status !== 401) throw err;
                calendar.resetSession();
                return calendar.listResourcesForDay(date);
              }
            },
            slotHolds,
            // The recados bot, not TELEGRAM_NOTIFY_MODE; urgent notices skip the opening-hours gate.
            ...(env.RECADOS_MODE !== "off" && env.RECADOS_CHAT_ID !== undefined
              ? {
                  alerts: wrapServiceChangeAlerts(new ServiceChangeAlerts({
                    mode: env.RECADOS_MODE,
                    ...(env.RECADOS_MODE === "live" && env.RECADOS_BOT_TOKEN !== undefined
                      ? {
                          client: new TelegramClient({
                            botToken: env.RECADOS_BOT_TOKEN,
                            sendTimeoutMs: env.TELEGRAM_SEND_TIMEOUT_MS,
                          }),
                        }
                      : {}),
                    chatId: env.RECADOS_CHAT_ID,
                    logger,
                  })),
                }
              : {}),
          },
    );
  }
  // 2026-10-08 — a REAL change by voice of a booking made in the same call:
  // create the new one, then cancel the old one through `waSelfService` (the
  // ADR-032 cancel path, constructed just above for that reason). Dark unless
  // VOICE_CHANGE_BOOKING_ENABLED, V2 creation and WA live are ALL armed.
  const voiceChangeEnabled =
    env.VOICE_CHANGE_BOOKING_ENABLED &&
    balancedV2CreateEnabled &&
    env.WA_SELF_SERVICE_MODE === "live" &&
    waSelfService !== undefined;
  if (env.VOICE_CHANGE_BOOKING_ENABLED) {
    logger.warn(
      { voice_change_effective: voiceChangeEnabled, wa_mode: env.WA_SELF_SERVICE_MODE },
      voiceChangeEnabled
        ? "VOICE_CHANGE_BOOKING_ENABLED is armed: a voice call can cancel a booking it made earlier in the same call (change)"
        : "VOICE_CHANGE_BOOKING_ENABLED=true but V2 creation or WA_SELF_SERVICE_MODE=live is missing: voice changes stay refused",
    );
  }

  // 2026-10-09 (internal doc, not included in the template) — at most N
  // pending appointments per phone, counted with the «mis citas» agenda read.
  let phoneBookingLimit: PhoneBookingLimit | undefined;
  if (env.MAX_FUTURE_BOOKINGS_PER_PHONE > 0) {
    if (waSelfService !== undefined && env.WA_SELF_SERVICE_MODE !== "off") {
      const reader = waSelfService;
      phoneBookingLimit = new PhoneBookingLimit(
        {
          max: env.MAX_FUTURE_BOOKINGS_PER_PHONE,
          horizonDays: env.WA_LOOKUP_HORIZON_DAYS,
          readBudgetMs: env.MAX_FUTURE_BOOKINGS_READ_BUDGET_MS,
        },
        { readStandingRows: (range) => reader.readStandingRows(range) },
        logger,
      );
      const limiter = phoneBookingLimit;
      reader.onBookingsChanged = (phoneE164) => limiter.markChanged(phoneE164);
      logger.info(
        {
          max_future_bookings_per_phone: env.MAX_FUTURE_BOOKINGS_PER_PHONE,
          horizon_days: env.WA_LOOKUP_HORIZON_DAYS,
          read_budget_ms: env.MAX_FUTURE_BOOKINGS_READ_BUDGET_MS,
        },
        "booking limit per phone armed (fail-open)",
      );
    } else {
      logger.warn(
        { max_future_bookings_per_phone: env.MAX_FUTURE_BOOKINGS_PER_PHONE },
        "MAX_FUTURE_BOOKINGS_PER_PHONE is set but WA_SELF_SERVICE_MODE is off (no agenda reader): no limit per phone",
      );
    }
  }

  // 2026-10-10 — voice consults / cancels / changes the caller's existing
  // bookings (internal doc, not included in the template). Dark unless
  // VOICE_MANAGE_BOOKINGS_ENABLED and an agenda reader exist.
  const voiceManage = new VoiceManageService(
    {
      enabled:
        env.VOICE_MANAGE_BOOKINGS_ENABLED &&
        waSelfService !== undefined &&
        env.WA_SELF_SERVICE_MODE !== "off",
      dictatedEnabled: env.VOICE_MANAGE_DICTATED_PHONE_ENABLED,
      changeServiceEnabled: env.VOICE_CHANGE_SERVICE_ENABLED,
    },
    waSelfService,
    logger,
  );
  if (env.VOICE_MANAGE_DICTATED_PHONE_ENABLED) {
    logger.warn(
      { voice_manage_dictated_effective: voiceManage.dictatedEnabled },
      "VOICE_MANAGE_DICTATED_PHONE_ENABLED is armed: a dictated phone plus the booking's first name can read, cancel and change bookings",
    );
  }
  if (env.VOICE_MANAGE_BOOKINGS_ENABLED) {
    logger.warn(
      { voice_manage_effective: voiceManage.enabled, wa_mode: env.WA_SELF_SERVICE_MODE },
      voiceManage.enabled
        ? "VOICE_MANAGE_BOOKINGS_ENABLED is armed: a voice call can read, cancel and change the caller's existing bookings"
        : "VOICE_MANAGE_BOOKINGS_ENABLED=true but WA self-service is off: voice keeps sending existing bookings to WhatsApp",
    );
  }

  const voiceBookingBalancedV2 = new VoiceBookingService(availability, balancedV2Booking, {
    // *** THE SAME JOURNAL AND THE SAME QUEUE. ***
    //
    // One appointment per CALL, not one per endpoint. A conversation that has
    // already booked through either path finds the other one closed, with the
    // outcome that actually describes the situation
    // (`already_booked_in_call`), and the shared serializer means the gate is
    // still atomic when a request from each path arrives together.
    store: idempotencyStore,
    serializer: bookingSerializer,
    fingerprintKey: env.AI_WEBHOOK_SECRET,
    // Isolated: the V2 domain and the V2 offer memory.
    slotAuthorization: balancedV2SlotAuthorization,
    offerStore: balancedV2Offers,
    // The agenda marker is a property of the CHANNEL, and V2 is the same
    // channel: a machine took the appointment over the phone. Same marker.
    displayPrefix: bookingDisplayPrefix(env),
    logger,
    // V2 ONLY. `voiceBooking` (V1, above) does not receive this, so
    // `/ai/voice/book` is unaffected — see `VoiceBookingDeps.bookDeadlineMs`.
    bookDeadlineMs: env.BALANCED_BOOK_DEADLINE_MS,
    // The SAME notifier instance as the stable path: one queue file, one
    // worker, one job per appointment whichever route created it.
    ...(whatsapp ? { whatsapp } : {}),
    // The «cerebro» books through THIS route; header-gated per request.
    ...(calendarLink ? { calendarLink } : {}),
    // 2026-10-10: the barber named in the closing sentence (`employee_name`).
    employeeNames,
    changeEnabled: voiceChangeEnabled,
    // 2026-10-09 — dark unless VOICE_CALLER_ID_PHONE_ENABLED=true.
    callerIdPhoneEnabled: env.VOICE_CALLER_ID_PHONE_ENABLED,
    ...(waSelfService ? { changeCanceller: waSelfService } : {}),
    ...(phoneBookingLimit ? { phoneBookingLimit } : {}),
    ...(voiceManage.enabled ? { existingBookings: voiceManage } : {}),
  });

  // V5 ((internal doc, not included in the template) ADR-025) — activated PER REQUEST by the V5 agent's
  // constant `agent_profile: "v5"`, never globally. A request without it is a
  // V4 request: one booking per call, seven-day look-ahead, no new field.
  // `BALANCED_V5_ENABLED=false` is the emergency brake that serves V5 requests
  // as V4 too.
  const balancedAgentProfiles = new AgentProfileResolver({
    v5Enabled: env.BALANCED_V5_ENABLED,
    v5MaxBookingsPerCall: env.BALANCED_V5_MAX_BOOKINGS_PER_CALL,
    logger,
  });

  logger.info(
    {
      balanced_v5_enabled: env.BALANCED_V5_ENABLED,
      balanced_v5_max_bookings_per_call: env.BALANCED_V5_MAX_BOOKINGS_PER_CALL,
    },
    env.BALANCED_V5_ENABLED
      ? 'balanced v2: requests with agent_profile="v5" get the V5 capabilities; every other request is served as V4'
      : 'BALANCED_V5_ENABLED=false: requests with agent_profile="v5" are served as V4',
  );

  if (balancedV2CreateEnabled) {
    // Said out loud at boot, because this is the one flag whose whole purpose
    // is to be noticed: it is the difference between an experiment and a real
    // appointment in a real diary.
    logger.warn(
      {},
      "ENABLE_BALANCED_V2_CREATE is armed: /ai/voice/v2/book can create real appointments",
    );
  }

  // ══ Recados para Bruno ((internal doc, not included in the template) §A.11) ═════════════
  //
  // OFF BY DEFAULT: with RECADOS_MODE=off none of this exists. If the store
  // cannot be opened, recados are disabled in this process (the routes answer
  // `recado_unavailable`) and the boot goes on, as with the owner notifier.
  let recados: Services["recados"];
  if (recadosGate !== undefined && env.RECADOS_MODE !== "off") {
    const mode = env.RECADOS_MODE;
    let store: RecadoStore | undefined;
    try {
      store = new FileRecadoStore(
        `${env.RECADOS_STATE_DIR}/recados.jsonl`,
        Date.now(),
        (message, detail) => logger.warn(detail, message),
      );
    } catch (error) {
      logger.error(
        { reason: error instanceof Error ? error.name : "unknown_error", mode },
        "recados DISABLED for this process (everything else is unaffected): the store could not be opened",
      );
    }
    const client =
      mode === "live" && env.RECADOS_BOT_TOKEN !== undefined
        ? new TelegramClient({ botToken: env.RECADOS_BOT_TOKEN, sendTimeoutMs: env.TELEGRAM_SEND_TIMEOUT_MS })
        : undefined;
    const worker =
      store !== undefined
        ? new RecadoWorker(
            {
              mode,
              chatId: env.RECADOS_CHAT_ID ?? "",
              reminderOpenMinutes: env.RECADOS_REMINDER_OPEN_MINUTES,
              summaryBeforeCloseMinutes: env.RECADOS_SUMMARY_BEFORE_CLOSE_MINUTES,
              voceroUrlTemplate: env.RECADOS_VOCERO_URL_TEMPLATE,
            },
            store,
            recadosGate,
            client,
            logger,
            // AVISOS_AGENDA: the «📅 Hoy…» digest goes before the «📋» header.
            agendaLinesOk && ownerNotifier !== undefined ? ownerNotifier : undefined,
          )
        : undefined;
    const service = new RecadoService(
      {
        mode,
        maxPerPhonePerHour: env.RECADOS_MAX_PER_PHONE_PER_HOUR,
        maxPerHourGlobal: env.RECADOS_MAX_PER_HOUR_GLOBAL,
        lookupHorizonDays: env.WA_LOOKUP_HORIZON_DAYS,
      },
      store,
      recadosGate,
      env.WA_SELF_SERVICE_MODE !== "off"
        ? { readStandingRows: (range) => waSelfService!.readStandingRows(range) }
        : undefined,
      logger,
      () => worker?.kick(),
    );
    const updates =
      mode === "live" && store !== undefined && client !== undefined && env.RECADOS_CHAT_ID !== undefined
        ? new TelegramUpdates(
            { chatId: env.RECADOS_CHAT_ID, voceroUrlTemplate: env.RECADOS_VOCERO_URL_TEMPLATE },
            store,
            client,
            logger,
          )
        : undefined;
    recados = {
      gate: recadosGate,
      service,
      ...(worker ? { worker } : {}),
      ...(updates ? { updates } : {}),
    };
    // Mode only; never a token, a chat id or a path.
    logger.warn({ recados_mode: mode, store_open: store !== undefined }, "recados configured");
  }

  // 2026-10-11: the calendar link of a booking, from its V2 slot token. Opens
  // tokens in the SAME domain the WhatsApp booking path mints in. Logs only
  // whether the link is configured (never the URL).
  const waCalendarLink = new WaCalendarLinkService({
    slotAuthorization: balancedV2SlotAuthorization,
    ...(calendarLink ? { calendar: calendarLink } : {}),
    logger,
  });

  if (env.WA_SELF_SERVICE_MODE !== "off" || env.TELEGRAM_NOTIFY_MODE !== "off") {
    // Counts and modes only; never a value.
    logger.warn(
      {
        wa_mode: env.WA_SELF_SERVICE_MODE,
        telegram_mode: env.TELEGRAM_NOTIFY_MODE,
        allowlist_size: waAllowlist.size,
        owner_notifier_active: ownerNotifier !== undefined,
        agenda_lines: agendaLinesOk,
        // Which identity, never which user: "service_account" | "dedicated_account" | null.
        wa_employee_identity:
          env.WA_SELF_SERVICE_MODE !== "off" ? (resolveWaEmployeeCredentials(env)?.source ?? null) : null,
      },
      "whatsapp self-service / owner notices configured (ADR-032)",
    );
  }

  if (whatsapp !== undefined) {
    // Said out loud at boot for the same reason the V2 create flag is: `live`
    // means this process will message real customers. The allow list is
    // reported as a COUNT — the numbers themselves never reach a log.
    logger.info(
      {
        whatsapp_mode: whatsapp.mode,
        whatsapp_allowed_recipients: whatsappAllowedRecipients?.size ?? null,
        // The Meta template's URL button must be registered as exactly
        // `<this>/{{1}}`. Printed so the two can be compared; no secret in it.
        whatsapp_calendar_link: `${env.WHATSAPP_CALENDAR_BASE_URL ?? ""}/cal/{{1}}`,
      },
      whatsapp.mode === "live"
        ? "whatsapp confirmations are LIVE: a confirmed appointment queues a real message to the customer"
        : "whatsapp confirmations are in dry run: jobs are queued and logged, never sent",
    );
  }

  if (writePermissions.createEnabled && !idempotencyStore.durable) {
    logger.warn(
      {},
      "booking creation is armed with in-memory idempotency only: a restart between a booking and its retry could double-book",
    );
  }

  // step SLOT: the fail-closed posture, said out loud at boot. Without this
  // line the symptom of a missing key is a live call in which every booking is
  // refused, and the operator has nothing to correlate it with.
  if (!slotAuthorization.enabled) {
    logger.warn(
      {},
      "VOICE_SLOT_TOKEN_SECRET is not configured: /ai/voice/availability will return slots without slot_token and /ai/voice/book will refuse every request",
    );
  }

  return {
    calendar,
    availability,
    booking,
    cancellation,
    lookup,
    voiceBooking,
    voiceOffers,
    balancedV2,
    voiceBookingBalancedV2,
    ...(phoneBookingLimit ? { phoneBookingLimit } : {}),
    balancedAgentProfiles,
    balancedV2Offers,
    balancedV2Options,
    callerIdentityResolver,
    ...(agendaCache ? { agendaCache } : {}),
    ...(agendaRefresher ? { agendaRefresher } : {}),
    ...(whatsapp ? { whatsapp } : {}),
    ...(ownerNotifier ? { ownerNotifier } : {}),
    ...(agendaBookings ? { agendaBookings } : {}),
    ...(waSelfService ? { waSelfService } : {}),
    waCalendarLink,
    ...(recados ? { recados } : {}),
    voiceManage,
  };
}

/** `"0,1,2"` -> `["0","1","2"]`. Shape already validated in `src/config/env.ts`. */
function parseServiceIds(raw: string): string[] {
  return [...new Set(raw.split(",").map((part) => part.trim()).filter((part) => part !== ""))];
}
