/**
 * step PROD (Hito 5) — the ONE place where "may this deployment write?" is
 * decided.
 *
 * Before this module existed, `ENABLE_WRITE_OPERATIONS` was a single joint
 * switch: flipping it to arm a real booking ALSO armed real cancellation, in
 * the same breath, with no way to have one without the other. That is the
 * defect this module removes.
 *
 * The rule is a strict AND of two independent flags per operation:
 *
 *   create  ⇔  ENABLE_WRITE_OPERATIONS && ENABLE_CREATE_BOOKING
 *   cancel  ⇔  ENABLE_WRITE_OPERATIONS && ENABLE_CANCEL_BOOKING
 *   update  ⇔  never
 *
 * Consequences that are deliberate, and asserted in tests/writePermissions.test.ts:
 *
 * - `ENABLE_WRITE_OPERATIONS` remains a MASTER kill-switch: false there is
 *   sufficient to stop every write, whatever the per-operation flags say. It
 *   is the emergency stop, and it must stay usable as one.
 * - A per-operation flag is never sufficient on its own. Arming the master
 *   switch without a specific permission writes nothing.
 * - Arming creation NEVER arms cancellation, and vice versa. There is no
 *   shared boolean between them any more.
 *
 * Every field defaults to false upstream in `src/config/env.ts`, so the
 * fail-closed direction requires no action; only enabling does.
 */

export interface WritePermissionFlags {
  /** `ENABLE_WRITE_OPERATIONS` — master emergency kill-switch. */
  master: boolean;
  /** `ENABLE_CREATE_BOOKING` — per-operation permission for creation. */
  create: boolean;
  /** `ENABLE_CANCEL_BOOKING` — per-operation permission for cancellation. */
  cancel: boolean;
  /**
   * `ENABLE_UPDATE_BOOKING` — accepted here only so the resolver sees the
   * whole picture. Its value cannot change the outcome: `updateEnabled` is
   * the literal `false`. `src/config/env.ts` additionally refuses to boot if
   * it is set to true.
   */
  update: boolean;
}

export interface WritePermissions {
  /** True only when master AND create are both on. */
  createEnabled: boolean;
  /** True only when master AND cancel are both on. */
  cancelEnabled: boolean;
  /**
   * Typed as the literal `false`, not `boolean`: modifying a booking is not
   * implemented and is permanently out of scope, so the type system itself
   * refuses to represent an enabled update.
   */
  updateEnabled: false;
}

/**
 * Pure function: no env access, no side effects, trivially exhaustible over
 * all 2^3 meaningful flag combinations.
 */
export function resolveWritePermissions(flags: WritePermissionFlags): WritePermissions {
  return {
    createEnabled: flags.master && flags.create,
    cancelEnabled: flags.master && flags.cancel,
    updateEnabled: false,
  };
}

/**
 * step LAT (objective 3) — the boot-time proof that arming CREATION cannot
 * arm cancellation or modification.
 *
 * The property is already structural: `resolveWritePermissions` derives the
 * three permissions from independent ANDs sharing no boolean. But "it is
 * obviously correct by construction" is exactly the claim that stops being
 * true the day someone refactors this file, and the cost of being wrong is a
 * voice agent that can destroy a real customer's appointment. So the invariant
 * is re-established from the ACTUAL configuration at every boot, cheaply, and
 * the process refuses to start if it ever fails to hold.
 *
 * It asks a counterfactual, not just "are the current flags sane": holding the
 * master switch and the create permission at whatever they really are, and
 * turning cancel and update ON, does creation's answer change, and do cancel
 * and update still resolve independently? A future edit that fused the flags
 * into one shared boolean would fail here rather than in production.
 *
 * @throws if the separation between create, cancel and update has been broken.
 */
export function assertWritePermissionsIndependent(flags: WritePermissionFlags): void {
  const actual = resolveWritePermissions(flags);

  // 1. Creation must depend on the create permission ALONE (plus the master
  //    switch) — never on the cancel or update flags.
  const withOthersOn = resolveWritePermissions({ ...flags, cancel: true, update: true });
  if (withOthersOn.createEnabled !== actual.createEnabled) {
    throw new Error(
      "write permission separation broken: ENABLE_CANCEL_BOOKING/ENABLE_UPDATE_BOOKING changed whether CREATION is enabled",
    );
  }

  // 2. Arming creation must never, on its own, arm cancellation or update.
  const creationOnly = resolveWritePermissions({
    master: flags.master,
    create: true,
    cancel: false,
    update: false,
  });
  if (creationOnly.cancelEnabled) {
    throw new Error(
      "write permission separation broken: arming ENABLE_CREATE_BOOKING also armed CANCELLATION",
    );
  }
  if (creationOnly.updateEnabled) {
    throw new Error(
      "write permission separation broken: arming ENABLE_CREATE_BOOKING also armed MODIFICATION",
    );
  }

  // 3. Modification is permanently unavailable, whatever anyone sets.
  const everythingOn = resolveWritePermissions({
    master: true,
    create: true,
    cancel: true,
    update: true,
  });
  if (everythingOn.updateEnabled) {
    throw new Error(
      "write permission separation broken: MODIFICATION resolved to enabled, which no configuration may ever produce",
    );
  }
}
