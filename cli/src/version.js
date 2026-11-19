// The version printed by --version and reported by the MCP server: always the one in package.json.
import fs from "node:fs";

export const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
