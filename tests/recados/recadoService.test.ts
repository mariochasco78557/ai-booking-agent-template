import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as M from "../../src/services/recados/recadoMessages.js";
import { pickRecadoAppointment, RecadoService, type RecadoServiceConfig } from "../../src/services/recados/recadoService.js";
import { FileRecadoStore, type RecadoStore } from "../../src/services/recados/recadoStore.js";
import { recadoIdOf } from "../../src/services/recados/recadoTypes.js";
import { at, fixedGate, makeLogger, TUE } from "./helpers.js";

let dir: string;
let path: string;
const NOW = at(TUE, "10:42");
const gate = fixedGate({ [TUE]: [570, 1200] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recados-service-"));
  path = join(dir, "recados.jsonl");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const CFG: RecadoServiceConfig = { mode: "live", maxPerPhonePerHour: 2, maxPerHourGlobal: 30, lookupHorizonDays: 60 };

function build(opts: {
  cfg?: Partial<RecadoServiceConfig>;
  rows?: () => Promise<never[]>;
  store?: RecadoStore | undefined;
  noAppointments?: boolean;
  file?: string;
} = {}) {
  const { logger, lines } = makeLogger();
  const store = "store" in opts ? opts.store : new FileRecadoStore(opts.file ?? path, NOW);
  const kicks = { n: 0 };
  const service = new RecadoService(
    { ...CFG, ...opts.cfg },
    store,
    gate,
    opts.noAppointments ? undefined : { readStandingRows: opts.rows ?? (async () => []) },
    logger,
    () => {
      kicks.n += 1;
    },
  );
  return { service, store: store as FileRecadoStore, lines, kicks };
}

const voice = (over: Record<string, unknown> = {}) => ({
  conversation_id: "conv-voice-0001",
  caller_phone: "+34600111222",
  kind: "question",
  summary: "Quiero hablar con Bruno sobre un tinte",
  ...over,
});

describe("RecadoService voice", () => {
  it("21. caller id visible → recado_queued with MSG_RECADO; late → MSG_RECADO_LATE; no wait for the appointment lookup", () => {
    const { service, store, kicks } = build({ rows: () => new Promise(() => {}) });
    const r = service.createFromVoice(voice(), NOW);
    expect(r).toEqual({ outcome: "recado_queued", message: M.MSG_RECADO, external_mutation: false });
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.appointment.status).toBe("pending");
    expect(kicks.n).toBe(1);
    const late = service.createFromVoice(voice({ conversation_id: "conv-voice-0002", caller_phone: "+34600333444", kind: "late", minutes_late: 10 }), NOW);
    expect(late.message).toBe(M.MSG_RECADO_LATE);
  });

  it("22. dedupe by conversation, also after the store restarts", () => {
    const a = build();
    expect(a.service.createFromVoice(voice(), NOW).outcome).toBe("recado_queued");
    const dup = a.service.createFromVoice(voice({ kind: "late" }), NOW);
    expect(dup).toEqual({ outcome: "recado_duplicate", message: M.MSG_RECADO_LATE, external_mutation: false, duplicate: true });
    expect(a.store.all()).toHaveLength(1);
    const b = build();
    expect(b.service.createFromVoice(voice(), NOW).outcome).toBe("recado_duplicate");
    expect(b.store.all()).toHaveLength(1);
  });

  it("23. hidden number without dictation → phone_needed (with/without name); nothing is created", () => {
    const { service, store } = build();
    const noName = service.createFromVoice(voice({ caller_phone: "" }), NOW);
    expect(noName).toMatchObject({ outcome: "phone_needed", message: M.MSG_NAME_AND_PHONE_NEEDED });
    const withName = service.createFromVoice(voice({ caller_phone: undefined, customer_name: "Ana" }), NOW);
    expect(withName).toMatchObject({ outcome: "phone_needed", message: M.MSG_PHONE_NEEDED });
    expect(store.all()).toHaveLength(0);
  });

  it("24. invalid dictated number → dictated_invalid; the second → recado_unavailable with the voice fallback", () => {
    const { service, store } = build();
    const hidden = { caller_phone: "anonymous", dictated_phone: "12345" };
    expect(service.createFromVoice(voice(hidden), NOW)).toMatchObject({ outcome: "dictated_invalid", message: M.MSG_DICTATED_INVALID });
    expect(service.createFromVoice(voice(hidden), NOW)).toMatchObject({
      outcome: "recado_unavailable",
      message: M.FALLBACK_VOICE_OTHER,
    });
    expect(store.all()).toHaveLength(0);
  });

  it("25. valid dictated number → phone_source dictated", () => {
    const { service, store, lines } = build();
    const r = service.createFromVoice(voice({ caller_phone: undefined, dictated_phone: "600 111 222" }), NOW);
    expect(r.outcome).toBe("recado_queued");
    expect(store.all()[0]).toMatchObject({ phoneSource: "dictated", phoneE164: "+34600111222" });
    expect(lines.some((l) => (l.obj as { phone_source?: string }).phone_source === "dictated")).toBe(true);
    // A number given as a JSON number works too.
    const n = service.createFromVoice(voice({ conversation_id: "conv-voice-0003", caller_phone: null, dictated_phone: 611222333 }), NOW);
    expect(n.outcome).toBe("recado_queued");
  });

  it("26. per-phone cap (3rd in an hour → recado_limit) and global cap → recado_unavailable", () => {
    const a = build();
    for (const id of ["conv-cap-00001", "conv-cap-00002"]) {
      expect(a.service.createFromVoice(voice({ conversation_id: id }), NOW).outcome).toBe("recado_queued");
    }
    expect(a.service.createFromVoice(voice({ conversation_id: "conv-cap-00003" }), NOW)).toMatchObject({
      outcome: "recado_limit",
      message: M.MSG_RECADO,
    });
    expect(a.store.all()).toHaveLength(2);

    const g = build({ cfg: { maxPerHourGlobal: 2 } });
    g.service.createFromVoice(voice({ conversation_id: "conv-glo-00001", caller_phone: "+34600000001" }), NOW);
    g.service.createFromVoice(voice({ conversation_id: "conv-glo-00002", caller_phone: "+34600000002" }), NOW);
    const third = g.service.createFromVoice(voice({ conversation_id: "conv-glo-00003", caller_phone: "+34600000003" }), NOW);
    expect(third).toMatchObject({ outcome: "recado_unavailable", message: M.FALLBACK_VOICE_OTHER });
    expect(g.store.all()).toHaveLength(2);
  });

  it("27. dry_run → recado_dry_run with the WhatsApp phrase of V6, and the recado is stored", () => {
    const { service, store } = build({ cfg: { mode: "dry_run" } });
    const r = service.createFromVoice(voice({ kind: "wants_human" }), NOW);
    expect(r).toEqual({
      outcome: "recado_dry_run",
      message: M.FALLBACK_VOICE_WANTS_HUMAN,
      external_mutation: false,
      dry_run: true,
    });
    expect(store.all()).toHaveLength(1);
    const wa = service.createFromWhatsApp({ "x-ai-wa-caller-id": "34600111222" }, wabody({ conversation_id: "conv-wa-dry-01" }), NOW);
    expect(wa).toMatchObject({ outcome: "recado_dry_run", message: M.FALLBACK_WA });
  });

  it("dry_run is invisible: duplicate and recado_limit also return the channel fallback; live is unchanged", () => {
    const d = build({ cfg: { mode: "dry_run", maxPerPhonePerHour: 1 } });
    d.service.createFromVoice(voice({ kind: "late" }), NOW);
    expect(d.service.createFromVoice(voice({ kind: "late" }), NOW)).toMatchObject({ outcome: "recado_duplicate", message: M.FALLBACK_VOICE_LATE });
    expect(d.service.createFromVoice(voice({ conversation_id: "conv-dry-0002" }), NOW)).toMatchObject({
      outcome: "recado_limit",
      message: M.FALLBACK_VOICE_OTHER,
    });
    const h = { "x-ai-wa-caller-id": "34600111222" };
    d.service.createFromWhatsApp(h, wabody({ conversation_id: "conv-dry-wa-01", kind: "complaint" }), at(TUE, "12:00") + 2 * 3_600_000);
    expect(d.service.createFromWhatsApp(h, wabody({ conversation_id: "conv-dry-wa-01" }), NOW)).toMatchObject({ outcome: "recado_duplicate", message: M.FALLBACK_WA });
    const l = build({ file: join(dir, "live.jsonl") });
    l.service.createFromVoice(voice(), NOW);
    expect(l.service.createFromVoice(voice(), NOW).message).toBe(M.MSG_RECADO);
  });

  it("invalid body → invalid_request; unknown fields are ignored; a bad minutes_late is dropped, not fatal", () => {
    const { service, store } = build();
    expect(service.createFromVoice({ kind: "question" }, NOW)).toMatchObject({ outcome: "invalid_request", message: M.MSG_INVALID_RECADO });
    expect(service.createFromVoice("nope", NOW).outcome).toBe("invalid_request");
    expect(service.createFromVoice(voice({ summary: "   " }), NOW).outcome).toBe("invalid_request");
    expect(service.createFromVoice(voice({ kind: "late", minutes_late: 9999, extra: "x", summary: "Llego\u0000  tarde\n\n ya" }), NOW).outcome).toBe(
      "recado_queued",
    );
    expect(store.all()[0]).toMatchObject({ minutesLate: null, summary: "Llego tarde ya" });
  });

  it("29. a store that throws on write → recado_unavailable, no exception", () => {
    const base = new FileRecadoStore(path, NOW);
    const broken: RecadoStore = {
      insert: () => {
        throw new Error("EIO");
      },
      update: base.update.bind(base),
      get: base.get.bind(base),
      all: base.all.bind(base),
      countSince: base.countSince.bind(base),
      summaryDone: base.summaryDone.bind(base),
      markSummary: base.markSummary.bind(base),
    };
    const { service, lines } = build({ store: broken });
    expect(service.createFromVoice(voice(), NOW)).toMatchObject({ outcome: "recado_unavailable", message: M.FALLBACK_VOICE_OTHER });
    expect(lines.some((l) => l.level === "error")).toBe(true);
    // No store at all (it could not be opened): the same answer.
    const none = build({ store: undefined });
    expect(none.service.createFromVoice(voice(), NOW).outcome).toBe("recado_unavailable");
  });
});

const wabody = (over: Record<string, unknown> = {}) => ({
  conversation_id: "conv-wa-00001",
  kind: "complaint",
  summary: "Me han cobrado de más",
  ...over,
});

describe("RecadoService WhatsApp", () => {
  it("28. the phone comes from X-AI-WA-Caller-Id; a body phone is ignored; a foreign number with callback_phone → written", () => {
    const { service, store } = build();
    service.createFromWhatsApp({ "x-ai-wa-caller-id": "34600111222" }, wabody({ phone: "+34699999999", caller_phone: "+34688888888" }), NOW);
    expect(store.all()[0]).toMatchObject({ phoneE164: "+34600111222", phoneSource: "whatsapp", channel: "whatsapp" });

    service.createFromWhatsApp({ "x-ai-wa-caller-id": "447911123456" }, wabody({ conversation_id: "conv-wa-00002", callback_phone: "+44 7911 123457" }), NOW);
    const written = store.get(recadoIdOf("wa:conv-wa-00002"))!;
    expect(written).toMatchObject({ phoneE164: "+447911123457", phoneSource: "written" });
    expect(written.appointment.status).toBe("not_searched");

    const none = service.createFromWhatsApp({}, wabody({ conversation_id: "conv-wa-00003", vocero_conversation_id: "vc_77" }), NOW);
    expect(none.outcome).toBe("recado_queued");
    expect(store.get(recadoIdOf("wa:conv-wa-00003"))).toMatchObject({ phoneSource: "none", phoneE164: null, voceroConversationId: "vc_77" });
  });
});

describe("appointment lookup", () => {
  const row = (startsAt: string, phone = "+34600111222") =>
    ({ id: 1, startsAt, ownerPhoneE164: phone, ownerName: "Ana", ownerSurnames: "Prueba", employeeId: 1, employeeName: "Bruno", typeReservation: 1, state: "active" }) as never;

  it("30. pickRecadoAppointment: started 20 min ago → chosen; 2 h ago → the next one; none → undefined", () => {
    const now = at(TUE, "10:42");
    expect(pickRecadoAppointment([row(`${TUE} 10:22`), row(`${TUE} 12:00`)], "+34600111222", now)?.startsAt).toBe(`${TUE} 10:22`);
    expect(pickRecadoAppointment([row(`${TUE} 08:40`), row(`${TUE} 12:00`)], "+34600111222", now)?.startsAt).toBe(`${TUE} 12:00`);
    expect(pickRecadoAppointment([row(`${TUE} 08:40`), row(`${TUE} 12:00`, "+34699999999")], "+34600111222", now)).toBeUndefined();
  });

  let seq = 0;
  async function enriched(rows: () => Promise<never[]>) {
    seq += 1;
    const { service, store } = build({ rows, file: join(dir, `enrich-${seq}.jsonl`) });
    service.createFromVoice(voice(), NOW);
    return { store, id: recadoIdOf("voz:conv-voice-0001") };
  }

  it("30. found / none / error / time-out", async () => {
    const found = await enriched(async () => [row(`${TUE} 11:00`)] as never[]);
    await vi.waitFor(() => expect(found.store.get(found.id)!.appointment.status).toBe("found"));
    expect(found.store.get(found.id)!.appointment).toMatchObject({ professional: "Bruno", service: "Corte de pelo", bookedName: "Ana Prueba" });

    const none = await enriched(async () => []);
    await vi.waitFor(() => expect(none.store.get(none.id)!.appointment.status).toBe("none"));

    const err = await enriched(async () => {
      throw new Error("panel down");
    });
    await vi.waitFor(() => expect(err.store.get(err.id)!.appointment.status).toBe("error"));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = await enriched(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(6_100);
    expect(slow.store.get(slow.id)!.appointment.status).toBe("error");
  });

  it("without a Spanish phone, or without a dashboard reader, the appointment is not searched", () => {
    const a = build({ noAppointments: true });
    a.service.createFromVoice(voice(), NOW);
    expect(a.store.all()[0]!.appointment.status).toBe("not_searched");
    const b = build();
    b.service.createFromVoice(voice({ conversation_id: "conv-foreign-1", caller_phone: "+447911123456" }), NOW);
    expect(b.store.get(recadoIdOf("voz:conv-foreign-1"))!.appointment.status).toBe("not_searched");
  });

  it("resumeEnrichment redoes the lookup of recados that never got one", async () => {
    const first = build({ rows: () => new Promise(() => {}) });
    first.service.createFromVoice(voice(), NOW);
    const second = build({ rows: async () => [row(`${TUE} 11:00`)] as never[] });
    expect(second.store.all()[0]!.appointment.status).toBe("pending");
    second.service.resumeEnrichment(NOW);
    await vi.waitFor(() => expect(second.store.all()[0]!.appointment.status).toBe("found"));
  });
});

describe("PII", () => {
  it("31. no log line contains the name, the phone (any format) or the summary", async () => {
    const { service, lines } = build({ cfg: { maxPerPhonePerHour: 1 } });
    const secret = { customer_name: "Zacarías Quintanilla", summary: "Mi marido Ernesto está enfermo" };
    service.createFromVoice(voice(secret), NOW);
    service.createFromVoice(voice({ ...secret, conversation_id: "conv-voice-0002" }), NOW); // recado_limit
    service.createFromVoice(voice({ ...secret, conversation_id: "conv-voice-0003", caller_phone: "", dictated_phone: "123" }), NOW);
    service.createFromWhatsApp({ "x-ai-wa-caller-id": "34600111222" }, wabody({ ...secret, conversation_id: "conv-wa-pii-01" }), NOW);
    await new Promise((r) => setTimeout(r, 20));
    const all = JSON.stringify(lines);
    for (const needle of ["Zacar", "Quintanilla", "Ernesto", "600111222", "600 111 222", "+34600", "34600111222", "111 222", "111222"]) {
      expect(all).not.toContain(needle);
    }
    expect(lines.length).toBeGreaterThan(0);
    const entry = lines.map((l) => l.obj as Record<string, unknown>).find((o) => o.outcome === "recado_queued")!;
    expect(Object.keys(entry).sort()).toEqual(["channel", "held", "kind", "outcome", "phone_source", "recado_id"]);
  });
});
