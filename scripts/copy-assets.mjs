/**
 * Post-build step.
 *
 * tsc emits JavaScript for the TypeScript sources, but the HTML and CSS are
 * not TypeScript and must be copied into dist/ by hand. Doing it here keeps
 * the build to a single command with no bundler and no extra dependencies.
 */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const from = join(root, "src", "ui");
const to = join(root, "dist", "ui");

mkdirSync(to, { recursive: true });
cpSync(join(from, "index.html"), join(to, "index.html"));
cpSync(join(from, "widget.css"), join(to, "widget.css"));

console.log(`copied ui assets -> ${to}`);
