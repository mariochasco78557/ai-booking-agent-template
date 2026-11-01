import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testEnv } from "../helpers/testApp.js";
import { CHAT, TOKEN } from "./helpers.js";

export const TG_SECRET = "telegram-webhook-secret-0123456789abcdef";
export const WA_SECRET = "wa-self-service-secret-0123456789abcdef";

/** Env for an app with recados on. Returns the state dir. */
export function recadosEnv(overrides: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "recados-app-"));
  testEnv({
    RECADOS_MODE: "live",
    RECADOS_BOT_TOKEN: TOKEN,
    RECADOS_CHAT_ID: CHAT,
    RECADOS_WEBHOOK_SECRET: TG_SECRET,
    RECADOS_STATE_DIR: join(dir, "recados"),
    WA_SELF_SERVICE_SECRET: WA_SECRET,
    ...overrides,
  });
  return join(dir, "recados");
}
