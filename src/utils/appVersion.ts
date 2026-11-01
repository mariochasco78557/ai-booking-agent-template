import { createRequire } from "node:module";

// `resolveJsonModule` cannot be used for `package.json` here: `rootDir` is
// `src`, and a static `import … from "../../package.json"` would sit outside
// it and fail the build. `createRequire` reads it at runtime instead, which
// has no such constraint.
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/**
 * The version tag every response and log line carries, so a support
 * conversation can always answer "which code served this call".
 *
 * `APP_VERSION` is set at image build time from the deployed commit (see
 * `Dockerfile` and `deploy/vps/update.sh` / `deploy.sh`), so a running
 * container always reports the exact SHA it was built from. Locally, where
 * no build step injects it, it falls back to `<package.json version>-dev` —
 * visibly different from a real deploy, so a dev log can never be mistaken
 * for one.
 */
export function resolveAppVersion(): string {
  const fromEnv = process.env.APP_VERSION;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return `${pkg.version}-dev`;
}
