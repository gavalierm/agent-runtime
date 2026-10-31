// Falošný proces claude pre testy: príkazový riadok nesie dané prepínače (T3 0.1.5 ide s --session-id, --resume).
// Po udalosti "spawn" môže byť /proc/<pid>/cmdline ešte prázdny (okno jadra medzi exec a zápisom argv, úloha 716), preto sa čaká, kým prepínače v cmdline sú.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export async function fakeClaude(...flags) {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)", "--", ...flags], { stdio: "ignore" });
  await new Promise((r) => child.once("spawn", r));
  const deadline = Date.now() + 5000;
  for (;;) {
    let cmd = "";
    try { cmd = readFileSync(`/proc/${child.pid}/cmdline`, "utf8"); } catch {}
    if (flags.every((f) => cmd.includes(f))) return child;
    if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`cmdline procesu ${child.pid} nenesie ${flags.join(" ")}: ${JSON.stringify(cmd)}`); }
    await new Promise((r) => setTimeout(r, 5));
  }
}
