// deploy_keys.mjs — kľúč so zápisom do repa agenta patrí žijúcemu agentovi.
// 16. 10. 2026 mali dva repá agentov ešte kľúče so zápisom od
// agenta prepusteného v ten istý deň, prepustenie ich nezrušilo.
// Účet GitHubu s repami agentov je AGENT_GH_OWNER, bez neho kontrola nič nerobí.
import { execSync } from "node:child_process";

// Kľúč so zápisom, ktorého názov nemenuje repo ani žijúceho agenta.
export function staleKeys(repo, keys, living) {
  const own = repo.replace(/^agent-/, "").toLowerCase();
  const names = [own, ...living.map((n) => n.toLowerCase())];
  return keys.filter((k) => !k.read_only && !names.some((n) => new RegExp(`\\b${n}\\b`).test(k.title.toLowerCase())));
}

// Problémy pre check.mjs. Bez gh alebo siete vráti jednu poznámku, nie chybu.
export function deployKeyProblems(owner = process.env.AGENT_GH_OWNER) {
  if (!owner) return { note: "deploy kľúče sa nekontrolujú, AGENT_GH_OWNER nie je nastavený" };
  const gh = (a) => JSON.parse(execSync(`gh ${a}`, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }));
  let repos;
  try {
    repos = gh(`repo list ${owner} --limit 200 --json name`).map((r) => r.name).filter((n) => n.startsWith("agent-"));
  } catch {
    return { note: "deploy kľúče agentov sa nedali prečítať cez gh" };
  }
  const living = repos.map((n) => n.replace(/^agent-/, ""));
  const problems = [];
  for (const repo of repos) {
    let keys = [];
    try { keys = gh(`api repos/${owner}/${repo}/keys`); } catch { continue; }
    for (const k of staleKeys(repo, keys, living))
      problems.push(`deploy kľúč ${k.id} "${k.title}" má zápis do ${owner}/${repo} a nemenuje žijúceho agenta, zruš ho (gh api -X DELETE repos/${owner}/${repo}/keys/${k.id})`);
  }
  return { problems };
}
