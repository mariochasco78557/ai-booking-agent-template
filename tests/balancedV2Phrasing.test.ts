import { describe, it, expect } from "vitest";

import { joinSpokenEs, spokenDateEs, spokenTimeEs } from "../src/utils/spokenTimeEs.js";
import {
  BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
  BALANCED_ALREADY_BOOKED_MESSAGE,
  BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
  BALANCED_BOOKING_FAILED_MESSAGE,
  BALANCED_BOOKING_UNCERTAIN_MESSAGE,
  BALANCED_BOOK_MESSAGE_OVERRIDES,
  BALANCED_NO_AVAILABILITY_MESSAGE,
  BALANCED_WRITE_DISABLED_MESSAGE,
  balancedMoreOptionsMessage,
  balancedNoMoreOptionsMessage,
  balancedOptionsMessage,
  balancedScanMessage,
  balancedScanNoAvailabilityMessage,
  balancedScanNoMoreMessage,
  oppositePeriod,
  periodLabelEs,
} from "../src/utils/balancedPhrasing.js";
import {
  AGENDA_UNAVAILABLE_MESSAGE,
  BOOKING_UNCERTAIN_MESSAGE,
  ESCALATION_MESSAGE,
  GENERIC_ERROR_MESSAGE,
  WRITE_DISABLED_BOOK_MESSAGE,
} from "../src/utils/phrasing.js";

/**
 * BALANCED V2 — the sentences, on their own.
 *
 * The end-to-end suites already assert that the right sentence comes out of the
 * right situation. This one pins the WORDING itself, because the wording was
 * specified literally and because each variant makes a different factual claim:
 * "también tengo otros horarios" is a promise about inventory, and "solo me
 * quedan las diez y las once" is a claim about the whole salon.
 */

describe("balanced v2 · spoken times", () => {
  it("says the hour, not the digits", () => {
    expect(spokenTimeEs("10:00")).toBe("diez");
    expect(spokenTimeEs("12:00")).toBe("doce");
    expect(spokenTimeEs("16:00")).toBe("cuatro");
    expect(spokenTimeEs("18:00")).toBe("seis");
    expect(spokenTimeEs("09:00")).toBe("nueve");
    // Midnight and noon both land on "doce", which is what a person says.
    expect(spokenTimeEs("00:00")).toBe("doce");
  });

  it("says the quarters the way a person does", () => {
    expect(spokenTimeEs("17:30")).toBe("cinco y media");
    expect(spokenTimeEs("10:15")).toBe("diez y cuarto");
    // "menos cuarto" belongs to the NEXT hour.
    expect(spokenTimeEs("16:45")).toBe("cinco menos cuarto");
    expect(spokenTimeEs("12:45")).toBe("una menos cuarto");
  });

  it("degrades to Spanish, not to digits, for an off-grid minute", () => {
    expect(spokenTimeEs("10:20")).toBe("diez y 20");
  });

  it("returns the input unchanged rather than throwing on nonsense", () => {
    expect(spokenTimeEs("99:99")).toBe("99:99");
    expect(spokenTimeEs("")).toBe("");
    expect(spokenTimeEs("mañana")).toBe("mañana");
  });

  it("joins a list with Spanish punctuation and an optional repeated preposition", () => {
    expect(joinSpokenEs([])).toBe("");
    expect(joinSpokenEs(["diez"])).toBe("diez");
    expect(joinSpokenEs(["diez", "once"])).toBe("diez y once");
    expect(joinSpokenEs(["diez", "once", "doce"])).toBe("diez, once y doce");
    expect(joinSpokenEs(["diez", "once", "doce"], "a las ")).toBe(
      "diez, a las once y a las doce",
    );
    expect(joinSpokenEs(["diez", "once"], "las ")).toBe("diez y las once");
  });
});

describe("balanced v2 · the offer sentence", () => {
  const morning = { requested: "morning", offered: "morning" } as const;

  it("promises more horarios only when more exist", () => {
    expect(
      balancedOptionsMessage(["10:00", "11:00", "12:00"], { ...morning, hasMore: true }),
    ).toBe(
      "Te puedo ofrecer a las diez, a las once y a las doce. También tengo otros horarios disponibles. ¿Cuál prefieres?",
    );
    expect(
      balancedOptionsMessage(["10:00", "11:00", "12:00"], { ...morning, hasMore: false }),
    ).toBe("Ese día me quedan las diez, las once y las doce. ¿Cuál prefieres?");
  });

  it("says «solo» for two and «un hueco» for one", () => {
    expect(balancedOptionsMessage(["10:00", "11:00"], { ...morning, hasMore: false })).toBe(
      "Ese día solo me quedan las diez y las once. ¿Cuál prefieres?",
    );
    expect(balancedOptionsMessage(["10:00"], { ...morning, hasMore: false })).toBe(
      "Ese día solo me queda un hueco a las diez. ¿Te viene bien?",
    );
  });

  it("names both halves of the day when the band was flipped", () => {
    expect(
      balancedOptionsMessage(["16:00", "17:30", "18:00"], {
        requested: "morning",
        offered: "afternoon",
        hasMore: false,
      }),
    ).toBe(
      "Ese día no me queda ningún hueco por la mañana, pero por la tarde tengo a las cuatro, cinco y media y seis. ¿Cuál prefieres?",
    );
  });

  it("falls back to the empty-day sentence rather than speaking an empty list", () => {
    expect(balancedOptionsMessage([], { ...morning, hasMore: false })).toBe(
      BALANCED_NO_AVAILABILITY_MESSAGE,
    );
    expect(BALANCED_NO_AVAILABILITY_MESSAGE).toBe(
      "Ese día no me queda ningún hueco disponible. ¿Quieres que mire otro día?",
    );
  });

  it("never names a professional, whatever it is asked", () => {
    // Structural, not a string check: the builder takes no employee at all.
    expect(balancedOptionsMessage.length).toBe(2);
    for (const times of [["10:00"], ["10:00", "11:00"], ["10:00", "11:00", "12:00"]]) {
      const sentence = balancedOptionsMessage(times, { ...morning, hasMore: true });
      expect(sentence.toLowerCase()).not.toContain("bruno");
      expect(sentence.toLowerCase()).not.toContain("olga");
      expect(sentence.toLowerCase()).not.toContain("jes");
      expect(sentence.toLowerCase()).not.toContain("profesional");
    }
  });

  it("names the bands the way they appear mid-sentence", () => {
    expect(periodLabelEs("morning")).toBe("mañana");
    expect(periodLabelEs("afternoon")).toBe("tarde");
    expect(oppositePeriod("morning")).toBe("afternoon");
    expect(oppositePeriod("afternoon")).toBe("morning");
  });
});

/**
 * BALANCED V2 — the sentences that answer «otros horarios».
 *
 * The wording is a contract with the ElevenLabs prompt
 * (`tests/balancedV2Contract.test.ts` asserts the prompt carries these strings
 * verbatim), and each variant makes a different factual claim:
 *
 * - "también" says the caller has heard part of this list already;
 * - "y aún tengo alguna más" is a promise about inventory, true only while a
 *   further page really exists;
 * - "después de esas solo me quedan" is a claim about the WHOLE remainder of
 *   the band, which is only honest because the ranking was frozen once.
 */
describe("balanced v2 · the continuation sentence", () => {
  it("continues the list, and promises more only while more exist", () => {
    expect(balancedMoreOptionsMessage(["10:00", "11:00", "12:00"], { hasMore: true })).toBe(
      "Te puedo ofrecer también a las diez, a las once y a las doce. Y aún tengo alguna más. ¿Cuál prefieres?",
    );
    expect(balancedMoreOptionsMessage(["10:00", "11:00", "12:00"], { hasMore: false })).toBe(
      "Después de esas solo me quedan las diez, las once y las doce. ¿Cuál prefieres?",
    );
  });

  it("says «solo me quedan» for a two-hour tail and «una» for a single one", () => {
    expect(balancedMoreOptionsMessage(["10:00", "11:00"], { hasMore: false })).toBe(
      "Después de esas solo me quedan las diez y las once. ¿Cuál prefieres?",
    );
    expect(balancedMoreOptionsMessage(["10:00"], { hasMore: false })).toBe(
      "Después de esas solo me queda una a las diez. ¿Te viene bien?",
    );
  });

  it("speaks the quarters of a continuation the way a person does", () => {
    expect(balancedMoreOptionsMessage(["10:30", "11:00", "11:30"], { hasMore: true })).toBe(
      "Te puedo ofrecer también a las diez y media, a las once y a las once y media. Y aún tengo alguna más. ¿Cuál prefieres?",
    );
  });

  it("never speaks an empty list, whatever it is handed", () => {
    // Defensive: the service answers `no_more_options` for an empty page, so
    // this branch is unreachable in production — and must still be Spanish.
    expect(balancedMoreOptionsMessage([], { hasMore: false })).toBe(
      BALANCED_NO_AVAILABILITY_MESSAGE,
    );
    expect(balancedMoreOptionsMessage([], { hasMore: true })).toBe(
      BALANCED_NO_AVAILABILITY_MESSAGE,
    );
  });

  it("never names a professional, whatever it is asked", () => {
    // Structural: like the offer builder, it takes no employee at all.
    expect(balancedMoreOptionsMessage.length).toBe(2);
    expect(balancedNoMoreOptionsMessage.length).toBe(2);
    for (const hasMore of [true, false]) {
      const sentence = balancedMoreOptionsMessage(["10:00", "11:00"], { hasMore });
      expect(sentence.toLowerCase()).not.toContain("bruno");
      expect(sentence.toLowerCase()).not.toContain("olga");
      expect(sentence.toLowerCase()).not.toContain("profesional");
    }
  });
});

describe("balanced v2 · the exhausted-band sentence", () => {
  /**
   * *** THE SENTENCE THE PRODUCTION AGENT COULD NOT SAY. ***
   *
   * It said «no puedo mostrarte más opciones directamente» and the caller hung
   * up. Every variant below names a way forward, because a dead end is the one
   * thing this answer may never be.
   */
  it("offers the other half of the day when that half has not been tried", () => {
    expect(
      balancedNoMoreOptionsMessage("morning", { fallbackAlreadyHappened: false }),
    ).toBe(
      "Ya no me quedan más horas esa mañana. ¿Quieres que mire por la tarde o que pruebe otro día?",
    );
    expect(
      balancedNoMoreOptionsMessage("afternoon", { fallbackAlreadyHappened: false }),
    ).toBe(
      "Ya no me quedan más horas esa tarde. ¿Quieres que mire por la mañana o que pruebe otro día?",
    );
  });

  it("offers another day, never the band it already declined, after a fallback", () => {
    const expected = "Ya no me quedan más horas ese día. ¿Quieres que mire otro día?";
    expect(balancedNoMoreOptionsMessage("morning", { fallbackAlreadyHappened: true })).toBe(
      expected,
    );
    expect(
      balancedNoMoreOptionsMessage("afternoon", { fallbackAlreadyHappened: true }),
    ).toBe(expected);
    // The band that was already empty is not named again, in either direction.
    expect(expected).not.toContain("mañana");
    expect(expected).not.toContain("tarde");
  });

  it("always leaves a way forward", () => {
    for (const period of ["morning", "afternoon"] as const) {
      for (const fallbackAlreadyHappened of [true, false]) {
        const sentence = balancedNoMoreOptionsMessage(period, { fallbackAlreadyHappened });
        expect(sentence).toContain("¿Quieres que mire");
        expect(sentence.endsWith("?")).toBe(true);
      }
    }
  });
});

/**
 * BALANCED V2 — the failure sentences, word for word.
 *
 * These six are a CONTRACT with the ElevenLabs prompt: the agent is told,
 * literally, which sentences the middleware can produce and what each of them
 * means, so a single changed accent here is a prompt that no longer matches
 * production. They are pinned as literals rather than derived, because deriving
 * them from the code under test would assert nothing at all.
 *
 * The second property is the one the mission actually turns on: none of them
 * may promise that a human will make contact. The V1 constants they replace all
 * do, and V1 keeps them — the production agent is speaking those sentences
 * right now and this work may not touch it.
 */
describe("balanced v2 · the failure sentences", () => {
  /** The four promises a V2 answer may never make. See the route test. */
  const NO_CONTACT_PROMISE_RE =
    /te llamen|se pondr[áa] en contacto|llamar (?:directamente )?a la peluquer[ií]a|confirmarla directamente|la peluquer[ií]a te (?:responder|llamar)/i;

  it("says exactly the six sentences the prompt is written against", () => {
    expect(BALANCED_AGENDA_UNAVAILABLE_MESSAGE).toBe(
      "Ahora mismo no puedo consultar la agenda.",
    );
    expect(BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE).toBe(
      "Ahora mismo no puedo dejar esa hora apartada.",
    );
    expect(BALANCED_BOOKING_UNCERTAIN_MESSAGE).toBe(
      "No he podido confirmar si la cita ha quedado hecha. Por mi parte no está confirmada.",
    );
    expect(BALANCED_WRITE_DISABLED_MESSAGE).toBe(
      "Ahora mismo no puedo dejar la cita hecha. No ha quedado confirmada.",
    );
    expect(BALANCED_ALREADY_BOOKED_MESSAGE).toBe(
      "En esta llamada ya hay una cita hecha. No puedo hacer otra desde aquí.",
    );
    expect(BALANCED_BOOKING_FAILED_MESSAGE).toBe(
      "No he podido hacer la cita. No ha quedado confirmada.",
    );
  });

  it("promises no call back, no message and no human follow-up", () => {
    for (const sentence of [
      BALANCED_AGENDA_UNAVAILABLE_MESSAGE,
      BALANCED_AUTHORIZATION_UNAVAILABLE_MESSAGE,
      BALANCED_BOOKING_UNCERTAIN_MESSAGE,
      BALANCED_WRITE_DISABLED_MESSAGE,
      BALANCED_ALREADY_BOOKED_MESSAGE,
      BALANCED_BOOKING_FAILED_MESSAGE,
    ]) {
      expect(NO_CONTACT_PROMISE_RE.test(sentence), sentence).toBe(false);
      // The WhatsApp exit is the PROMPT's sentence, not the middleware's: when
      // to say it depends on the conversation, not on one tool's outcome.
      expect(sentence.toLowerCase()).not.toContain("whatsapp");
    }
  });

  /** *** AND THEY REALLY ARE NEW SENTENCES, NOT THE V1 ONES RENAMED. *** */
  it("says something different from the V1 constants it replaces", () => {
    expect(BALANCED_AGENDA_UNAVAILABLE_MESSAGE).not.toBe(AGENDA_UNAVAILABLE_MESSAGE);
    expect(BALANCED_BOOKING_UNCERTAIN_MESSAGE).not.toBe(BOOKING_UNCERTAIN_MESSAGE);
    expect(BALANCED_WRITE_DISABLED_MESSAGE).not.toBe(WRITE_DISABLED_BOOK_MESSAGE);
    expect(BALANCED_BOOKING_FAILED_MESSAGE).not.toBe(GENERIC_ERROR_MESSAGE);
    expect(BALANCED_BOOKING_FAILED_MESSAGE).not.toBe(ESCALATION_MESSAGE);
    // And the V1 ones are left exactly as the production agent speaks them:
    // every one of these still carries the promise V2 is not allowed to make.
    for (const v1 of [
      AGENDA_UNAVAILABLE_MESSAGE,
      BOOKING_UNCERTAIN_MESSAGE,
      WRITE_DISABLED_BOOK_MESSAGE,
      ESCALATION_MESSAGE,
    ]) {
      expect(NO_CONTACT_PROMISE_RE.test(v1), v1).toBe(true);
    }
  });

  it("overrides exactly the five booking outcomes whose V1 wording promises contact", () => {
    expect(Object.keys(BALANCED_BOOK_MESSAGE_OVERRIDES).sort()).toEqual([
      "already_booked_in_call",
      "misconfigured_owner",
      "uncertain",
      "upstream_error",
      "write_disabled",
    ]);
    // A deterministic failure and an unknown one are both "not confirmed", but
    // only one of them forbids a retry — so they may not share a sentence.
    expect(BALANCED_BOOKING_UNCERTAIN_MESSAGE).not.toBe(BALANCED_BOOKING_FAILED_MESSAGE);
    // Every override states, in so many words, that nothing is confirmed.
    for (const outcome of ["uncertain", "write_disabled", "upstream_error"]) {
      expect(BALANCED_BOOK_MESSAGE_OVERRIDES[outcome]).toMatch(/no est[áa] confirmada|no ha quedado confirmada/i);
    }
  });
});

/**
 * *** BALANCED V2 — THE WINDOW SENTENCES (`action: "scan"`). ***
 *
 * Same rule as every block above: the wording was specified literally, so it is
 * pinned literally. What is new is WHICH claims these sentences make, because a
 * window answer can be false in ways a one-day answer cannot:
 *
 * - It names DAYS out loud, so «el jueves» has to mean the Thursday the agenda
 *   means. `spokenDateEs` says «hoy» and «mañana» near, and adds the day number
 *   from a week out, which is the whole point of the boundary tests below.
 * - It can never say «solo»: `scan` offers a SELECTION out of a window it may
 *   not even have finished reading (`partial`), so an inventory claim would be
 *   unverifiable. That is asserted as a lock, over every rendering, at the end.
 * - Its empty answer must repeat the condition back and still leave two doors
 *   open — the other band and further ahead — because a dead end here is the
 *   exact failure this whole flow exists to remove.
 *
 * Every date below is anchored to Friday 2026-09-11, the day the flow shipped:
 * lunes = 09-14, martes = 09-15, jueves = 09-17.
 */
describe("balanced v2 · spoken calendar days", () => {
  const TODAY = "2026-09-11"; // viernes

  it("says «hoy» and «mañana» rather than a weekday", () => {
    expect(spokenDateEs("2026-09-11", TODAY)).toBe("hoy, viernes once,");
    expect(spokenDateEs("2026-09-12", TODAY)).toBe("mañana, sábado doce,");
  });

  it("2026-10-10: says the weekday AND the number for the rest of the coming week too", () => {
    expect(spokenDateEs("2026-09-13", TODAY)).toBe("el domingo trece"); // +2
    expect(spokenDateEs("2026-09-14", TODAY)).toBe("el lunes catorce"); // +3
    expect(spokenDateEs("2026-09-17", TODAY)).toBe("el jueves diecisiete"); // +6, the last
  });

  /**
   * *** THE AMBIGUITY BOUNDARY, AT SEVEN DAYS. ***
   *
   * On day +7 the weekday repeats, so «el viernes» stops identifying a day and
   * the number has to come with it. A caller who books the wrong Friday only
   * discovers it at the door.
   */
  it("adds the day number from a week out, where a weekday stops being unique", () => {
    expect(spokenDateEs("2026-09-18", TODAY)).toBe("el viernes dieciocho"); // +7
    expect(spokenDateEs("2026-09-30", TODAY)).toBe("el miércoles treinta");
    // Both sides of the boundary, so an off-by-one cannot pass:
    expect(spokenDateEs("2026-09-17", TODAY)).toBe("el jueves diecisiete");
  });

  it("never says «hoy» or «mañana» about a day that has passed", () => {
    // Unreachable through a scan, and if a bug ever produced it the qualified
    // form is merely odd where «mañana» would be false.
    expect(spokenDateEs("2026-09-10", TODAY)).toBe("el jueves diez");
  });

  it("returns the input unchanged rather than throwing on nonsense", () => {
    expect(spokenDateEs("mañana por la tarde", TODAY)).toBe("mañana por la tarde");
    expect(spokenDateEs("", TODAY)).toBe("");
    // An unreadable «today» loses the distance, so it falls back to the one
    // rendering that is still true without it.
    expect(spokenDateEs("2026-09-17", "no es una fecha")).toBe("el jueves diecisiete");
  });

  it("is pure: no clock, and the same answer every time", () => {
    expect(spokenDateEs.length).toBe(2);
    expect(spokenDateEs("2026-09-14", TODAY)).toBe(spokenDateEs("2026-09-14", TODAY));
  });
});

describe("balanced v2 · the window offer sentence", () => {
  const TODAY = "2026-09-11"; // viernes
  const option = (date: string, time: string, optionIndex: number) => ({
    date,
    time,
    optionIndex,
  });
  /** The diagnostics the answer carries and the sentence must never speak. */
  const summaryFor = (date: string, weekday_es: string) => ({
    date,
    weekday_es,
    count: 4,
    first_time: "09:00",
    last_time: "20:00",
    matching_count: 2,
  });
  const SUMMARY = [
    summaryFor("2026-09-14", "lunes"),
    summaryFor("2026-09-15", "martes"),
    summaryFor("2026-09-17", "jueves"),
  ];

  it("offers one hour on each of three days", () => {
    expect(
      balancedScanMessage(
        [
          option("2026-09-14", "17:30", 1),
          option("2026-09-15", "17:00", 2),
          option("2026-09-17", "19:00", 3),
        ],
        SUMMARY,
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe(
      "Tengo el lunes catorce a las cinco y media, el martes quince a las cinco y el jueves diecisiete a las siete. ¿Cuál te viene mejor?",
    );
  });

  /** One day, three hours: the day is said ONCE and the hours are alternatives. */
  it("puts the day first when every hour is on the same day", () => {
    expect(
      balancedScanMessage(
        [
          option("2026-09-15", "17:00", 1),
          option("2026-09-15", "18:00", 2),
          option("2026-09-15", "19:00", 3),
        ],
        [summaryFor("2026-09-15", "martes")],
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe("El martes quince tengo a las cinco, a las seis o a las siete. ¿Cuál te viene mejor?");
  });

  it("joins hours inside a day with «o» and days with «y»", () => {
    expect(
      balancedScanMessage(
        [
          option("2026-09-14", "17:00", 1),
          option("2026-09-14", "18:00", 2),
          option("2026-09-17", "19:00", 3),
        ],
        SUMMARY,
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe("Tengo el lunes catorce a las cinco o a las seis y el jueves diecisiete a las siete. ¿Cuál te viene mejor?");
  });

  it("offers two hours on two days", () => {
    expect(
      balancedScanMessage(
        [option("2026-09-14", "17:30", 1), option("2026-09-17", "19:00", 2)],
        SUMMARY,
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe("Tengo el lunes catorce a las cinco y media y el jueves diecisiete a las siete. ¿Cuál te viene mejor?");
  });

  /** One option is a yes/no question, not a choice. */
  it("asks «¿Te viene bien?» for a single option", () => {
    expect(
      balancedScanMessage([option("2026-09-17", "19:00", 1)], SUMMARY, {
        hasMore: false,
        todayIso: TODAY,
      }),
    ).toBe("Tengo el jueves diecisiete a las siete. ¿Te viene bien?");
  });

  it("promises more only when more really exist, and before the question", () => {
    const page = [
      option("2026-09-14", "17:30", 1),
      option("2026-09-15", "17:00", 2),
      option("2026-09-17", "19:00", 3),
    ];
    expect(balancedScanMessage(page, SUMMARY, { hasMore: true, todayIso: TODAY })).toBe(
      "Tengo el lunes catorce a las cinco y media, el martes quince a las cinco y el jueves diecisiete a las siete. Y tengo alguna más. ¿Cuál te viene mejor?",
    );
    expect(balancedScanMessage(page, SUMMARY, { hasMore: false, todayIso: TODAY })).not.toContain(
      "alguna más",
    );
  });

  it("says «mañana» instead of the weekday when the day is tomorrow", () => {
    expect(
      balancedScanMessage(
        [option("2026-09-12", "17:00", 1), option("2026-09-17", "19:00", 2)],
        SUMMARY,
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe("Tengo mañana, sábado doce, a las cinco y el jueves diecisiete a las siete. ¿Cuál te viene mejor?");
    // …and capitalized when it opens the sentence.
    expect(
      balancedScanMessage(
        [option("2026-09-12", "17:00", 1), option("2026-09-12", "18:00", 2)],
        SUMMARY,
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe("Mañana, sábado doce, tengo a las cinco o a las seis. ¿Cuál te viene mejor?");
  });

  /**
   * *** THE SENTENCE SPEAKS THE PAGE'S ORDER, BECAUSE THE NUMBERS ARE ITS ORDER. ***
   *
   * `option_index` is positional. A sentence that sorted the hours to read
   * better would make «la segunda» select a different hueco from the one the
   * caller heard second.
   */
  it("never reorders the page", () => {
    expect(
      balancedScanMessage(
        [
          option("2026-09-17", "19:00", 1),
          option("2026-09-14", "17:00", 2),
          option("2026-09-17", "09:00", 3),
        ],
        SUMMARY,
        { hasMore: false, todayIso: TODAY },
      ),
    ).toBe("Tengo el jueves diecisiete a las siete o a las nueve y el lunes catorce a las cinco. ¿Cuál te viene mejor?");
  });

  it("never speaks the diagnostics it is handed", () => {
    const sentence = balancedScanMessage(
      [option("2026-09-14", "17:30", 1)],
      SUMMARY,
      { hasMore: true, todayIso: TODAY },
    );
    for (const leak of ["days_summary", "matching_count", "count", "09:00", "20:00", "2026"]) {
      expect(sentence, `scan sentence leaks "${leak}"`).not.toContain(leak);
    }
  });

  it("never speaks an empty list, whatever it is handed", () => {
    // Defensive: the service answers `no_availability` for an empty window.
    expect(balancedScanMessage([], SUMMARY, { hasMore: false, todayIso: TODAY })).toBe(
      "No tengo nada en los próximos tres días. ¿Te busco los días siguientes?",
    );
    expect(balancedScanMessage([], [], { hasMore: false, todayIso: TODAY })).toBe(
      "No tengo nada ese día. ¿Quieres que mire más adelante?",
    );
  });

  it("never names a professional: there is no parameter through which one could arrive", () => {
    expect(balancedScanMessage.length).toBe(3);
    const sentence = balancedScanMessage(
      [option("2026-09-14", "17:30", 1), option("2026-09-17", "19:00", 2)],
      SUMMARY,
      { hasMore: true, todayIso: TODAY },
    );
    for (const name of ["bruno", "olga", "jes", "profesional"]) {
      expect(sentence.toLowerCase()).not.toContain(name);
    }
  });
});

/*
 * 2026-09-15 (look-ahead change): a MULTI-DAY empty window now ends on a
 * concrete offer — «¿Te busco la semana siguiente…?» (seven days) or «¿Te busco
 * los días siguientes…?» (two to six) — instead of the vague «¿Quieres que mire
 * más adelante?», which callers answered «no» to and the agent then treated as
 * a rejection of every alternative. One-day wording is unchanged.
 */
describe("balanced v2 · the empty-window sentence", () => {
  it("repeats an «a partir de» condition back and offers no band, only the next week or another hour", () => {
    expect(
      balancedScanNoAvailabilityMessage({ afterTime: "17:00", days: 7, partial: false }),
    ).toBe(
      "No tengo nada a partir de las cinco en los próximos siete días. ¿Te busco la semana siguiente, o te va bien a otra hora?",
    );
  });

  it("repeats an «antes de» condition back and offers no band, only the next week or another hour", () => {
    expect(
      balancedScanNoAvailabilityMessage({ beforeTime: "10:00", days: 7, partial: false }),
    ).toBe(
      "No tengo nada antes de las diez en los próximos siete días. ¿Te busco la semana siguiente, o te va bien a otra hora?",
    );
  });

  /** Two hours bound a slice, not a band, so no single band is the way out. */
  it("says «entre las … y las …» for both, and asks for another franja", () => {
    expect(
      balancedScanNoAvailabilityMessage({
        afterTime: "17:00",
        beforeTime: "19:00",
        days: 7,
        partial: false,
      }),
    ).toBe(
      "No tengo nada entre las cinco y las siete en los próximos siete días. ¿Te busco la semana siguiente, o te va bien en otra franja?",
    );
  });

  it("names the band when the caller only gave a band", () => {
    expect(
      balancedScanNoAvailabilityMessage({ period: "afternoon", days: 7, partial: false }),
    ).toBe(
      "No tengo nada por la tarde en los próximos siete días. ¿Te busco la semana siguiente, o te va bien por la mañana?",
    );
    expect(
      balancedScanNoAvailabilityMessage({ period: "morning", days: 7, partial: false }),
    ).toBe(
      "No tengo nada por la mañana en los próximos siete días. ¿Te busco la semana siguiente, o te va bien por la tarde?",
    );
  });

  it("offers only the next week when there was no condition to repeat", () => {
    expect(balancedScanNoAvailabilityMessage({ days: 7, partial: false })).toBe(
      "No tengo nada en los próximos siete días. ¿Te busco la semana siguiente?",
    );
  });

  it("keeps the one-day wording unchanged when no single boundary applies", () => {
    expect(balancedScanNoAvailabilityMessage({ period: "afternoon", days: 1, partial: false })).toBe(
      "No tengo nada por la tarde ese día. ¿Quieres que mire por la mañana o más adelante?",
    );
  });

  it("says «ese día» for a one-day window, never «en el próximo un día»", () => {
    // No `nearestOutsideConstraint`: the day has no free hour at all, so the
    // sentence stays short and keeps the SAME boundary for the next try.
    expect(
      balancedScanNoAvailabilityMessage({ afterTime: "17:00", days: 1, partial: false }),
    ).toBe("No tengo nada a partir de las cinco ese día. ¿Miro a partir de las cinco otro día?");
  });

  /**
   * *** THE ONE-DAY, ONE-BOUNDARY ANSWER NAMES A REAL HOUR, NEVER A BAND. ***
   *
   * The production incident: «a partir de las seis», nothing that day, the OLD
   * sentence offered the morning, and the caller was read hours it never asked
   * for. A single day has been read in full, so it can say the true nearest
   * hour and keep offering to search the SAME boundary elsewhere.
   */
  it("names the real nearest hour on a fully-read single day, and keeps the boundary", () => {
    expect(
      balancedScanNoAvailabilityMessage({
        afterTime: "18:00",
        days: 1,
        partial: false,
        nearestOutsideConstraint: "16:30",
      }),
    ).toBe(
      "No tengo nada a partir de las seis ese día; lo más cercano es a las cuatro y media. " +
        "¿Te sirve, o miro a partir de las seis otro día?",
    );
    expect(
      balancedScanNoAvailabilityMessage({
        beforeTime: "10:00",
        days: 1,
        partial: false,
        nearestOutsideConstraint: "10:30",
      }),
    ).toBe(
      "No tengo nada antes de las diez ese día; lo más cercano es a las diez y media. " +
        "¿Te sirve, o miro antes de las diez otro día?",
    );
  });

  /**
   * *** `partial` IS A CLAIM THE SENTENCE MAY NOT MAKE. ***
   *
   * The window was not fully read, so «en los próximos siete días» would assert
   * seven days of emptiness the middleware never verified.
   */
  it("does not claim seven days when it only managed some of them", () => {
    expect(
      balancedScanNoAvailabilityMessage({ afterTime: "17:00", days: 7, partial: true }),
    ).toBe(
      "No tengo nada a partir de las cinco en los días que he podido mirar. ¿Te busco la semana siguiente, o te va bien a otra hora?",
    );
    expect(
      balancedScanNoAvailabilityMessage({ afterTime: "17:00", days: 7, partial: true }),
    ).not.toContain("siete días");
  });

  it("counts the days in words, not in digits", () => {
    for (const [days, word] of [
      [2, "dos"],
      [3, "tres"],
      [4, "cuatro"],
      [5, "cinco"],
      [6, "seis"],
      [7, "siete"],
    ] as const) {
      const further = days === 7 ? "la semana siguiente" : "los días siguientes";
      expect(balancedScanNoAvailabilityMessage({ days, partial: false })).toBe(
        `No tengo nada en los próximos ${word} días. ¿Te busco ${further}?`,
      );
    }
  });

  /**
   * *** AN HOUR CONSTRAINT NEVER OFFERS A BAND, WHATEVER THE HOUR. ***
   *
   * This used to derive a band from the 14:00 boundary `periodOf` in
   * `balancedAvailabilityService.ts` applies — the exact mechanism behind the
   * production incident: «a partir de las seis» read back as an invitation to
   * try the morning, and the caller was given hours it never constrained away.
   * A single sentence must never name a band for an hour constraint, at any
   * hour on either side of that boundary.
   */
  it("never offers a band for an hour constraint, on either side of 14:00", () => {
    const alternative = (afterTime: string): string =>
      balancedScanNoAvailabilityMessage({ afterTime, days: 7, partial: false });
    for (const afterTime of ["13:59", "14:00", "09:00", "19:00"]) {
      const sentence = alternative(afterTime);
      expect(sentence).not.toMatch(/por la mañana|por la tarde/);
      expect(sentence).toContain("¿Te busco la semana siguiente, o te va bien a otra hora?");
    }
  });

  it("still offers no band for an unreadable hour, but keeps the hour-constraint question", () => {
    expect(
      balancedScanNoAvailabilityMessage({ afterTime: "no sé", days: 7, partial: false }),
    ).toBe(
      "No tengo nada a partir de las no sé en los próximos siete días. ¿Te busco la semana siguiente, o te va bien a otra hora?",
    );
  });

  it("treats a blank condition as no condition", () => {
    expect(balancedScanNoAvailabilityMessage({ afterTime: "  ", days: 7, partial: false })).toBe(
      balancedScanNoAvailabilityMessage({ days: 7, partial: false }),
    );
  });
});

describe("balanced v2 · the walked-out window sentence", () => {
  /**
   * The window twin of `balancedNoMoreOptionsMessage`, and it makes a SMALLER
   * claim on purpose: everything found has been said, not everything that
   * exists. The window was searched under a condition and within a budget.
   */
  it("says everything found has been offered, and leaves two doors open", () => {
    expect(balancedScanNoMoreMessage()).toBe(
      "Ya te he dicho todas las que tengo en esos días. ¿Quieres que mire más adelante o en otra franja?",
    );
  });

  it("is not the one-day sentence in disguise", () => {
    expect(balancedScanNoMoreMessage()).not.toBe(
      balancedNoMoreOptionsMessage("morning", { fallbackAlreadyHappened: true }),
    );
    expect(balancedScanNoMoreMessage()).not.toContain("Ya no me quedan");
  });
});

/**
 * *** THE LOCK: WHAT A WINDOW ANSWER MAY NEVER SAY. ***
 *
 * One sweep over EVERY scan rendering, asserting the words that would make one
 * of them false or unkeepable:
 *
 * - «solo» — an inventory claim about a window the middleware may not have
 *   finished reading. `discover` may say it; `scan` may not.
 * - «ya no me quedan» — the same claim in the other tense.
 * - a transfer, a wait («dame un segundo»), a promise that someone will make
 *   contact, or WhatsApp: the first two are things the agent cannot do, the
 *   third is a promise about people, and the fourth is the PROMPT's sentence
 *   for a dead end, never the middleware's.
 */
describe("balanced v2 · the scan sentences promise nothing they cannot keep", () => {
  const TODAY = "2026-09-11";
  const option = (date: string, time: string, optionIndex: number) => ({
    date,
    time,
    optionIndex,
  });
  const summary = [
    {
      date: "2026-09-14",
      weekday_es: "lunes",
      count: 4,
      first_time: "09:00",
      last_time: "20:00",
      matching_count: 2,
    },
  ];

  const EVERY_SCAN_RENDERING: string[] = [
    ...[true, false].flatMap((hasMore) => [
      balancedScanMessage([option("2026-09-14", "17:30", 1)], summary, {
        hasMore,
        todayIso: TODAY,
      }),
      balancedScanMessage(
        [option("2026-09-14", "17:00", 1), option("2026-09-14", "18:00", 2)],
        summary,
        { hasMore, todayIso: TODAY },
      ),
      balancedScanMessage(
        [
          option("2026-09-14", "17:30", 1),
          option("2026-09-15", "17:00", 2),
          option("2026-09-17", "19:00", 3),
        ],
        summary,
        { hasMore, todayIso: TODAY },
      ),
      balancedScanMessage(
        [option("2026-09-11", "17:00", 1), option("2026-09-12", "18:00", 2)],
        summary,
        { hasMore, todayIso: TODAY },
      ),
    ]),
    ...[true, false].flatMap((partial) =>
      [1, 7].flatMap((days) => [
        balancedScanNoAvailabilityMessage({ afterTime: "17:00", days, partial }),
        balancedScanNoAvailabilityMessage({ beforeTime: "10:00", days, partial }),
        balancedScanNoAvailabilityMessage({
          afterTime: "17:00",
          beforeTime: "19:00",
          days,
          partial,
        }),
        balancedScanNoAvailabilityMessage({ period: "morning", days, partial }),
        balancedScanNoAvailabilityMessage({ period: "afternoon", days, partial }),
        balancedScanNoAvailabilityMessage({ days, partial }),
      ]),
    ),
    balancedScanNoMoreMessage(),
  ];

  const BANNED_TRANSFER_RE =
    /te paso con|le paso con|te transfiero|paso la llamada|te comunico con/i;
  const TIME_PROMISE_RE =
    /(dame|d[eé]jame|espera|esp[eé]rame|aguarda)\s+(un|unos|una|unas)\s+(segundo|segundito|momento|momentito|instante|minuto|ratito)/i;
  const NO_CONTACT_PROMISE_RE =
    /te llamen|se pondr[áa] en contacto|llamar (?:directamente )?a la peluquer[ií]a|confirmarla directamente|la peluquer[ií]a te (?:responder|llamar)/i;

  it("covers every rendering the two builders can produce", () => {
    // 8 offer sentences + 24 empty-window sentences + 1 walked-out sentence.
    expect(EVERY_SCAN_RENDERING.length).toBe(33);
    expect(EVERY_SCAN_RENDERING.every((sentence) => sentence.endsWith("?"))).toBe(true);
  });

  it("never says «solo»: a window page is a selection, not an inventory", () => {
    for (const sentence of EVERY_SCAN_RENDERING) {
      expect(/\bsolo\b/i.test(sentence), sentence).toBe(false);
      expect(sentence.toLowerCase(), sentence).not.toContain("ya no me quedan");
    }
  });

  it("never promises a transfer, a wait, a call back or a WhatsApp", () => {
    for (const sentence of EVERY_SCAN_RENDERING) {
      expect(BANNED_TRANSFER_RE.test(sentence), sentence).toBe(false);
      expect(TIME_PROMISE_RE.test(sentence), sentence).toBe(false);
      expect(NO_CONTACT_PROMISE_RE.test(sentence), sentence).toBe(false);
      expect(sentence.toLowerCase(), sentence).not.toContain("whatsapp");
    }
  });

  /** A dead end is the one thing these answers may never be. */
  it("always leaves a way forward", () => {
    // «¿Miro…?» and «¿Te sirve, o miro…?» are the one-day, one-boundary
    // answer's own way of asking to search again — see change 1a.
    for (const sentence of EVERY_SCAN_RENDERING) {
      expect(sentence, sentence).toMatch(
        /¿Cuál te viene mejor\?|¿Te viene bien\?|¿Quieres que mire|¿Miro |¿Te sirve|¿Te busco (la semana siguiente|los días siguientes)/,
      );
    }
  });
});
