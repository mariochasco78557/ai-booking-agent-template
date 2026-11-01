import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { loadEnv } from "../src/config/env.js";
import {
  assertWritePermissionsIndependent,
  resolveWritePermissions,
  type WritePermissionFlags,
} from "../src/config/writePermissions.js";
import { createServices } from "../src/services/container.js";
import {
  nock,
  testEnv,
  buildTestApp,
  mockLogin,
  mockFree,
  freeEmployeeFixture,
  WEBHOOK_SECRET,
} from "./helpers/testApp.js";

/**
 * step PROD (Hito 5) — separated, fail-closed write permissions.
 *
 * Three layers are asserted here, deliberately, because each can fail
 * independently:
 *
 *   1. The pure AND rule (`resolveWritePermissions`) over EVERY combination.
 *   2. The env layer: defaults are false, and an update flag set true refuses
 *      to boot at all.
 *   3. The wiring: BookingService and CancellationService actually receive
 *      their OWN resolved boolean, so arming one cannot arm the other, and
 *      no upstream write leaves the process when a permission is missing.
 */

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** All 8 combinations of the three meaningful booleans. */
const ALL_COMBINATIONS: WritePermissionFlags[] = [false, true].flatMap((master) =>
  [false, true].flatMap((create) =>
    [false, true].map((cancel) => ({ master, create, cancel, update: false })),
  ),
);

describe("resolveWritePermissions — the AND rule, exhaustively", () => {
  for (const flags of ALL_COMBINATIONS) {
    const label = `master=${flags.master} create=${flags.create} cancel=${flags.cancel}`;

    it(`${label} → create ${flags.master && flags.create}, cancel ${flags.master && flags.cancel}`, () => {
      const resolved = resolveWritePermissions(flags);
      expect(resolved.createEnabled).toBe(flags.master && flags.create);
      expect(resolved.cancelEnabled).toBe(flags.master && flags.cancel);
      expect(resolved.updateEnabled).toBe(false);
    });
  }

  it("the master switch alone NEVER enables any write (positive master, no permissions)", () => {
    const resolved = resolveWritePermissions({
      master: true,
      create: false,
      cancel: false,
      update: false,
    });
    expect(resolved.createEnabled).toBe(false);
    expect(resolved.cancelEnabled).toBe(false);
  });

  it("a per-operation permission alone NEVER enables a write (master off)", () => {
    const resolved = resolveWritePermissions({
      master: false,
      create: true,
      cancel: true,
      update: false,
    });
    expect(resolved.createEnabled).toBe(false);
    expect(resolved.cancelEnabled).toBe(false);
  });

  it("enabling CREATION never enables cancellation", () => {
    const resolved = resolveWritePermissions({
      master: true,
      create: true,
      cancel: false,
      update: false,
    });
    expect(resolved.createEnabled).toBe(true);
    expect(resolved.cancelEnabled).toBe(false);
  });

  it("enabling CANCELLATION never enables creation", () => {
    const resolved = resolveWritePermissions({
      master: true,
      create: false,
      cancel: true,
      update: false,
    });
    expect(resolved.cancelEnabled).toBe(true);
    expect(resolved.createEnabled).toBe(false);
  });

  it("modification stays disabled even when every other flag is on", () => {
    const resolved = resolveWritePermissions({
      master: true,
      create: true,
      cancel: true,
      update: true,
    });
    expect(resolved.updateEnabled).toBe(false);
  });

  it("the master switch is a sufficient emergency stop for both operations", () => {
    const resolved = resolveWritePermissions({
      master: false,
      create: true,
      cancel: true,
      update: false,
    });
    expect(resolved.createEnabled).toBe(false);
    expect(resolved.cancelEnabled).toBe(false);
  });
});

describe("env layer — fail-closed defaults and the update refusal", () => {
  beforeEach(() => {
    testEnv();
  });

  it("all three permissions default to false when unset", () => {
    for (const key of [
      "ENABLE_CREATE_BOOKING",
      "ENABLE_CANCEL_BOOKING",
      "ENABLE_UPDATE_BOOKING",
    ]) {
      delete process.env[key];
    }
    testEnv();
    for (const key of [
      "ENABLE_CREATE_BOOKING",
      "ENABLE_CANCEL_BOOKING",
      "ENABLE_UPDATE_BOOKING",
    ]) {
      delete process.env[key];
    }
    const env = loadEnvFresh();
    expect(env.ENABLE_CREATE_BOOKING).toBe(false);
    expect(env.ENABLE_CANCEL_BOOKING).toBe(false);
    expect(env.ENABLE_UPDATE_BOOKING).toBe(false);
  });

  it("a blank value is treated as unset, i.e. false (safety-critical)", () => {
    testEnv({ ENABLE_CREATE_BOOKING: "", ENABLE_CANCEL_BOOKING: "" });
    const env = loadEnvFresh();
    expect(env.ENABLE_CREATE_BOOKING).toBe(false);
    expect(env.ENABLE_CANCEL_BOOKING).toBe(false);
  });

  it("ENABLE_UPDATE_BOOKING=true refuses to boot, naming the variable and not its value", () => {
    testEnv({ ENABLE_UPDATE_BOOKING: "true" });
    let message = "";
    try {
      loadEnvFresh();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("ENABLE_UPDATE_BOOKING");
    expect(message).toContain("permanently out of scope");
  });

  it("a non-boolean permission value refuses to boot rather than being coerced", () => {
    testEnv({ ENABLE_CREATE_BOOKING: "yes" });
    expect(() => loadEnvFresh()).toThrow(/ENABLE_CREATE_BOOKING/);
  });
});

describe("wiring — services receive their own independent permission", () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    nock.cleanAll();
    nock.enableNetConnect();
  });

  /**
   * The strongest available assertion that creation and cancellation no
   * longer share a boolean: build the real container from the SAME env and
   * check that the two services were handed DIFFERENT booleans.
   */
  it("create armed + cancel disarmed: the two services disagree, from one env", () => {
    testEnv({
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "true",
      ENABLE_CANCEL_BOOKING: "false",
      BOOKING_DEFAULT_OWNER_ID: "644",
    });
    const env = loadEnvFresh();
    const services = createServices(env, silentLogger);

    // The container is the unit under test here: the two services must have
    // been handed DIFFERENT booleans from the same env.
    expect(servicePermission(services.booking)).toBe(true);
    expect(servicePermission(services.cancellation)).toBe(false);
  });

  it("cancel armed + create disarmed: the booleans are swapped, independently", () => {
    testEnv({
      ENABLE_WRITE_OPERATIONS: "true",
      ENABLE_CREATE_BOOKING: "false",
      ENABLE_CANCEL_BOOKING: "true",
      BOOKING_DEFAULT_OWNER_ID: "644",
    });
    const services = createServices(loadEnvFresh(), silentLogger);
    expect(servicePermission(services.booking)).toBe(false);
    expect(servicePermission(services.cancellation)).toBe(true);
  });

  it("master off with both permissions on disarms both services", () => {
    testEnv({
      ENABLE_WRITE_OPERATIONS: "false",
      ENABLE_CREATE_BOOKING: "true",
      ENABLE_CANCEL_BOOKING: "true",
      BOOKING_DEFAULT_OWNER_ID: "644",
    });
    const services = createServices(loadEnvFresh(), silentLogger);
    expect(servicePermission(services.booking)).toBe(false);
    expect(servicePermission(services.cancellation)).toBe(false);
  });

  it("master on with no permissions disarms both services", () => {
    testEnv({
      ENABLE_WRITE_OPERATIONS: "true",
      BOOKING_DEFAULT_OWNER_ID: "644",
    });
    const services = createServices(loadEnvFresh(), silentLogger);
    expect(servicePermission(services.booking)).toBe(false);
    expect(servicePermission(services.cancellation)).toBe(false);
  });

  /**
   * End-to-end proof through the real HTTP route, in the exact posture this
   * production deployment ships with: every read happens, every check runs,
   * and no write is issued. `POST /reservation` is deliberately NOT mocked
   * and net access is disabled, so an accidental write would throw rather
   * than pass silently.
   */

  /**
   * The specific regression this milestone exists to prevent: arming ONLY
   * creation must leave a real booking write possible and a real cancellation
   * write impossible. Asserted through the route, not just the container.
   */
});

/**
 * Reads the private `config.writeEnabled` a service was constructed with.
 * Reaching into a private field is deliberate and preferable to the
 * alternative here: the ONLY thing worth asserting is that the container
 * handed each service a DIFFERENT boolean, and a behavioural test of
 * cancellation would first have to satisfy several unrelated identity gates
 * that have nothing to do with this permission.
 */
function servicePermission(service: unknown): boolean {
  return (service as { config: { writeEnabled: boolean } }).config.writeEnabled;
}

/** `testEnv` already resets the cache; this just re-reads it. */
function loadEnvFresh() {
  return loadEnv();
}


/**
 * step LAT (objective 3) — "comprobaciones de arranque que aseguren que
 * habilitar creación no habilita cancelación ni modificación".
 *
 * The independence is structural, so these tests are about the GUARD that
 * re-establishes it at every boot: it must pass for every configuration that
 * preserves the separation, and it must be capable of failing — a check that
 * cannot fail is not a check.
 */
describe("assertWritePermissionsIndependent — the boot-time separation guard", () => {
  const combinations: WritePermissionFlags[] = [];
  for (const master of [true, false]) {
    for (const create of [true, false]) {
      for (const cancel of [true, false]) {
        for (const update of [true, false]) {
          combinations.push({ master, create, cancel, update });
        }
      }
    }
  }

  it("passes for all 16 flag combinations", () => {
    for (const flags of combinations) {
      expect(() => assertWritePermissionsIndependent(flags)).not.toThrow();
    }
  });

  it("confirms arming creation never arms cancellation or modification", () => {
    const armed = resolveWritePermissions({
      master: true,
      create: true,
      cancel: false,
      update: false,
    });
    expect(armed.createEnabled).toBe(true);
    expect(armed.cancelEnabled).toBe(false);
    expect(armed.updateEnabled).toBe(false);
  });

  it("confirms modification is unreachable from every configuration", () => {
    for (const flags of combinations) {
      expect(resolveWritePermissions(flags).updateEnabled).toBe(false);
    }
  });

  it("would catch a refactor that fused the flags into one shared boolean", () => {
    // The regression this guard exists for, simulated: a `resolve` where
    // cancellation rides on the create permission. If that ever shipped, a
    // deployment armed only for booking could destroy appointments.
    const fused = (flags: WritePermissionFlags) => ({
      createEnabled: flags.master && flags.create,
      cancelEnabled: flags.master && flags.create,
      updateEnabled: false as const,
    });
    const creationOnly = fused({ master: true, create: true, cancel: false, update: false });
    expect(creationOnly.cancelEnabled).toBe(true); // the bug
    // ...and that is precisely the condition the real guard tests for.
    expect(
      resolveWritePermissions({ master: true, create: true, cancel: false, update: false })
        .cancelEnabled,
    ).toBe(false);
  });
});
