// ADR-032: the request schemas of the `/ai/wa/*` routes live next to the
// service that reads them (block A). Re-exported here, never duplicated, so
// there is exactly one definition.
export {
  waMyReservationsSchema,
  waCancelSchema,
  waNotifyOwnerSchema,
  WA_NOTIFY_REASONS,
} from "../services/waSelfService/waSelfService.js";
