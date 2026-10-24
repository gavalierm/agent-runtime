#!/usr/bin/env node
// Vypne automatické odkladanie vlákna T3 (príkaz thread.auto-settle.set,
// T3 0.1.2), nástroje MCP ho nemajú. Token a adresu berie z runtime.env agenta.
// Použitie: node t3_autosettle.mjs <id vlákna> [true|false]
import { config, stableId, T3Client } from "./lib.mjs";

const [threadId, value = "false"] = process.argv.slice(2);
if (!threadId || !["true", "false"].includes(value)) {
  console.error("Použitie: t3_autosettle.mjs <id vlákna> [true|false]");
  process.exit(2);
}
const client = T3Client.fromConfig(config());
await client.dispatch({ type: "thread.auto-settle.set", commandId: stableId("autosettle", threadId, value, String(Date.now())), threadId, enabled: value === "true" });
console.log(`auto-settle ${value}: ${threadId}`);
process.exit(0);
