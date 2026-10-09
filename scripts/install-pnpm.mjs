// Downloads the standalone pnpm release from GitHub and unpacks it.
// Wolfi-based images have no curl/wget, so we fetch via node's https.
// Wolfi is musl-based -> use the linux-*-musl build.
// The tarball ships a top-level `pnpm` binary plus its dist/ payload —
// extract the whole thing to <install-dir> and symlink the binary into PATH.
// Usage: node scripts/install-pnpm.mjs <version> <install-dir> <bin-link>
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, symlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const [version, installDir, binLink] = process.argv.slice(2);
if (!version || !installDir || !binLink) {
  console.error("usage: node install-pnpm.mjs <version> <install-dir> <bin-link>");
  process.exit(1);
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
const url = `https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-linux-${arch}-musl.tar.gz`;

const res = await fetch(url);
if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} (${url})`);

const tarball = "/tmp/pnpm.tar.gz";
await pipeline(Readable.fromWeb(res.body), createWriteStream(tarball));
mkdirSync(installDir, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "-C", installDir]);
symlinkSync(`${installDir}/pnpm`, binLink);
console.log(`pnpm ${version} (linux-${arch}-musl) -> ${installDir}, linked at ${binLink}`);
