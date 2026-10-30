#!/usr/bin/env node
// Testy server_work.mjs. Prvý prípad je príkaz, ktorým Cyril 18. 10. 2026
// spustil službu správcu úloh namiesto Rona.

process.env.SERVER_WORK_AGENTS = "adam,boris";
const { verdict } = await import("./server_work.mjs");

const S = `PATH="$PWD/scratch/bin:$PATH" ssh root@example.org`;
const cases = [
  [`${S} 'su - appdev -c "cd ~/app && git pull -q && XDG_RUNTIME_DIR=/run/user/\\$(id -u) systemctl --user start app-loop.service"'`, true],
  [`${S} 'systemctl restart nginx'`, true],
  [`${S} 'systemctl --user -M appdev@ start app-loop.service'`, true],
  [`${S} 'systemctl restart boris-autoclear.timer'`, false],
  [`${S} 'systemctl restart adam-driver.service'`, false],
  [`${S} 'systemctl is-active app-loop.service; systemctl status nginx'`, false],
  [`systemctl --user start x.service`, false],
  [`${S} 'systemctl daemon-reload && systemctl restart t3code.service'`, false],
];
let bad = 0;
for (const [cmd, want] of cases) {
  const got = Boolean(verdict(cmd));
  if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}: ${cmd}`); }
}
// Zamietnutie posiela správcovi agentov, oprava povolení nie je práca
// zástupcu na Macu (audit 19. 10. 2026, bod 2).
{
  const v = verdict(`${S} 'systemctl restart nginx'`) || "";
  if (!/správcovi agentov/.test(v) || /autoMode\.allow/.test(v)) { bad++; console.log(`✗ správa má posielať správcovi agentov: ${v}`); }
}
console.log(bad ? `${bad}/${cases.length + 1} zlyhalo` : `${cases.length + 1} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
