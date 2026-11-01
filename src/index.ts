import { loadEnv } from "./config/env.js";
import { resolveWritePermissions } from "./config/writePermissions.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // Fail closed on misconfiguration. No secret values are printed.
    console.error(
      err instanceof Error ? err.message : "Failed to load environment",
    );
    process.exit(1);
  }

  const app = await buildApp(env);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    // step PROD (Hito 5/7): the effective, per-operation write posture is
    // logged at boot so an operator can read it off the container logs
    // without shelling in to inspect env. Booleans only — never a secret.
    const writePermissions = resolveWritePermissions({
      master: env.ENABLE_WRITE_OPERATIONS,
      create: env.ENABLE_CREATE_BOOKING,
      cancel: env.ENABLE_CANCEL_BOOKING,
      update: env.ENABLE_UPDATE_BOOKING,
    });
    app.log.info(
      {
        port: env.PORT,
        writeMasterEnabled: env.ENABLE_WRITE_OPERATIONS,
        createEnabled: writePermissions.createEnabled,
        cancelEnabled: writePermissions.cancelEnabled,
        updateEnabled: writePermissions.updateEnabled,
      },
      "ai-booking-agent listening",
    );
  } catch (err) {
    app.log.error(err, "failed to start server");
    process.exit(1);
  }
}

void main();
