// Skúška runtime/agent_vlakno.sh bez živého systému: všetky cesty majú
// predponu AV_ROOT v dočasnom priečinku a príkazy curl, git (clone, fetch),
// ssh-keygen, systemctl, systemd-tmpfiles, runuser, t3 a tasker sú podstavené.
// Skript sám odmietne bežať s AV_ROOT, keď niektorý z nich nie je z AV_STUBS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "agent_vlakno.sh");
const NAME = "tst";
const GH_TOKEN = "ghp_tajny_token_strojoveho_uctu";
const T3_TOKEN = "t3tajnytokenagenta";

function stub(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "agent-vlakno-"));
  const R = join(base, "root");
  const stubs = join(base, "stubs");
  const state = join(base, "state");
  for (const d of [stubs, state, R]) mkdirSync(d, { recursive: true });
  const log = join(base, "log");
  writeFileSync(log, "");
  mkdirSync(join(R, "root/.config/adam"), { recursive: true });
  writeFileSync(join(R, "root/.config/adam/github_agent_token"), GH_TOKEN + "\n", { mode: 0o600 });
  writeFileSync(join(R, "root/.config/adam/runtime.env"), "AGENT_REPLY_ROUTE_boris=/var/lib/boris/inbox\nAGENT_OPERATOR_NAME=Oskar\nTASKER_WEB_URL=https://host.example.ts.net:8801\n", { mode: 0o600 });
  mkdirSync(join(R, "root/.ssh"), { recursive: true });
  mkdirSync(join(R, "etc/systemd/system"), { recursive: true });
  writeFileSync(join(R, "etc/systemd/system/agent-driver@.service"), "[Service]\n");
  mkdirSync(join(R, "home/tasker-svc/.ssh"), { recursive: true });

  const mut = `echo "MUT $(basename "$0") $*" >> "$AV_LOG"`;
  stub(stubs, "curl", `
echo "curl $*" >> "$AV_LOG"
url="\${@: -1}"
if [[ " $* " == *" -X POST "* ]]; then
  ${mut}
  prev=""; out=""; body=""
  for a in "$@"; do [ "$prev" = -o ] && out=$a; [ "$prev" = -d ] && body=$a; prev=$a; done
  echo "$body" >> "$AV_STATE/keys"
  [ -n "$out" ] && echo '{}' > "$out"
  printf 201; exit 0
fi
cat "$AV_STATE/keys" 2>/dev/null || echo '[]'`);
  stub(stubs, "git", `
args=("$@"); i=0
[ "\${args[0]}" = -C ] && i=2
sub=\${args[$i]}
case $sub in
  clone) ${mut}; dest="\${@: -1}"; url="\${@: -2:1}"
         /usr/bin/git init -q -b main "$dest"; /usr/bin/git -C "$dest" remote add origin "$url" ;;
  fetch|rebase|ls-remote) echo "git $*" >> "$AV_LOG" ;;
  *) exec /usr/bin/git "$@" ;;
esac`);
  stub(stubs, "ssh-keygen", `${mut}; exec /usr/bin/ssh-keygen "$@"`);
  stub(stubs, "systemctl", `
case $1 in
  is-enabled|is-active) [ "$1" = is-active ] && [ "$2" != --quiet ] && { cat "$AV_STATE/svc" 2>/dev/null || echo inactive; exit 0; }
                        [ -f "$AV_STATE/svc" ] ;;
  enable) ${mut}; echo active > "$AV_STATE/svc" ;;
esac`);
  stub(stubs, "systemd-tmpfiles", `${mut}; awk '$1=="d"{print $2}' "$2" | while read -r p; do mkdir -p "$AV_ROOT$p"; done`);
  stub(stubs, "runuser", `shift 3; exec "$@"`);
  stub(stubs, "t3", `
if [ "$1 $2 $3" = "auth session issue" ]; then ${mut}; touch "$AV_STATE/t3issued"; echo ${T3_TOKEN}; echo; exit 0; fi
if [ "$1 $2 $3" = "auth session list" ]; then [ -f "$AV_STATE/t3issued" ] && echo "  client: ${NAME}-driver | bot"; exit 0; fi`);
  stub(stubs, "tasker", `
case "$1 $2" in
  "agent show") [ -f "$AV_STATE/agent" ] || exit 1; echo "{\\"name\\":\\"${NAME}\\",\\"enabled\\":1,\\"workdir\\":\\"$(cat "$AV_STATE/agent")\\"}" ;;
  "agent add") ${mut}; prev=""; echo enabled > "$AV_STATE/agent_state"; for a in "$@"; do [ "$prev" = --workdir ] && echo "$a" > "$AV_STATE/agent"; [ "$a" = --disabled ] && echo disabled > "$AV_STATE/agent_state"; prev=$a; done ;;
  "agent edit") ${mut}; prev=""; for a in "$@"; do [ "$prev" = --workdir ] && echo "$a" > "$AV_STATE/agent"; prev=$a; done ;;
  "agent list") [ -f "$AV_STATE/agent" ] && printf '${NAME}\\t%s\\t%s\\n' "$(cat "$AV_STATE/agent_state" 2>/dev/null || echo enabled)" "$(cat "$AV_STATE/agent")" ;;
esac`);
  stub(stubs, "github_repo.sh", `
if [ -f "$AV_STATE/invited" ]; then echo "repo existuje: example-org/$1 (200)"; echo "example-agent už je v repe"
else ${mut}; touch "$AV_STATE/invited"; echo "repo existuje: example-org/$1 (200)"; echo "pozvánka pre example-agent poslaná"; echo "pozvánka prijatá"; fi
echo "overené: kľúč účtu example-agent má prístup"`);

  writeFileSync(join(stubs, "t3_autosettle.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.AV_LOG, "autosettle " + process.argv.slice(2).join(" ") + "\\n");\n`);
  const hooks = join(base, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "commit-msg"), "#!/bin/bash\n");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/bash\n");
  const env = {
    PATH: `${stubs}:/usr/bin:/bin`,
    HOME: base,
    AV_ROOT: R,
    AV_STUBS: stubs,
    AV_LOG: log,
    AV_STATE: state,
    AV_GITHUB_REPO: join(stubs, "github_repo.sh"),
    AV_AUTOSETTLE: join(stubs, "t3_autosettle.mjs"),
    AV_HOOKS_SRC: hooks,
    AGENT_MANAGER: "adam", AGENT_GH_OWNER: "example-org", AGENT_GH_MACHINE: "example-agent", AGENT_GH_EMAIL: "agent@example.org",
    AGENT_HOST: "examplehost", AGENT_TASKER_USER: "tasker-svc", AGENT_RESERVED: "boris",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const run = (args = [NAME, "Tst"], over = {}) => {
    writeFileSync(log, "");
    const r = spawnSync("bash", [SCRIPT, ...args], { env: { ...env, ...over }, encoding: "utf8" });
    return { ...r, out: `${r.stdout}\n${r.stderr}`, log: readFileSync(log, "utf8") };
  };
  return { R, run, state, base, env };
}

const mode = (p) => (statSync(p).mode & 0o777).toString(8);

test("prvý beh zriadi všetko, druhý nič nezmení", () => {
  const { R, run, state } = setup();
  const a = run();
  assert.equal(a.status, 0, a.out);

  const key = join(R, `root/.ssh/example-agent_${NAME}`);
  assert.equal(mode(key), "600");
  assert.match(readFileSync(key + ".pub", "utf8"), /tst-examplehost/);
  assert.match(readFileSync(join(state, "keys"), "utf8"), /"title":"tst-examplehost"/);

  assert.equal(mode(join(R, `root/.config/${NAME}/runtime.env`)), "600");
  assert.equal(readFileSync(join(R, `root/.config/${NAME}/runtime.env`), "utf8"), [
    "AGENT_RUNTIME=/root/agent-runtime",
    "AGENT_WORKDIR=/root/tst",
    "AGENT_BOX=/var/lib/tst",
    "AGENT_MODEL=claude-opus-5-5",
    "T3_URL=http://127.0.0.1:3773",
    "T3_TOKEN_FILE=/root/.config/tst/t3_token",
    'AGENT_REPLY_CMD="AGENT_NAME=tst /root/agent-runtime/reply.sh"',
    "AGENT_REPLY_ROUTE_adam=/var/lib/adam/inbox",
    "AGENT_RUNTIME_MODE=full-access",
    `TASKER_HOME=${join("/home", "tasker-svc", ".tasker")}`,
    "AGENT_TASKER_USER=tasker-svc",
    "AGENT_OPERATOR_NAME=Oskar",
    "TASKER_WEB_URL=https://host.example.ts.net:8801",
    "",
  ].join("\n"));
  assert.equal(mode(join(R, `root/.config/${NAME}/t3_token`)), "600");
  // skutočné t3 vypíše za tokenom prázdny riadok, v súbore má byť jediný riadok
  assert.equal(readFileSync(join(R, `root/.config/${NAME}/t3_token`), "utf8"), T3_TOKEN + "\n");
  assert.deepEqual(readdirSync(join(R, `root/.config/${NAME}`)).sort(), ["runtime.env", "t3_token"]);

  const conf = readFileSync(join(R, `etc/tmpfiles.d/${NAME}-inbox.conf`), "utf8");
  assert.match(conf, /^d \/var\/lib\/tst {11}0710 root agent-inbox -$/m);
  assert.match(conf, /^d \/var\/lib\/tst\/inbox {5}2770 root agent-inbox -$/m);
  assert.match(conf, /^d \/var\/lib\/tst\/processed 2770 root agent-inbox m:30d$/m);
  for (const d of ["inbox", "outbox", "processed"]) assert.ok(existsSync(join(R, `var/lib/${NAME}/${d}`)));

  const adamEnv = readFileSync(join(R, "root/.config/adam/runtime.env"), "utf8");
  assert.match(adamEnv, /^AGENT_REPLY_ROUTE_tst=\/var\/lib\/tst\/inbox$/m);
  assert.match(adamEnv, /^AGENT_REPLY_ROUTE_boris=/m);

  const cfg = spawnSync("/usr/bin/git", ["-C", join(R, "root", NAME), "config", "--local", "-l"], { encoding: "utf8" }).stdout;
  assert.match(cfg, /core.sshcommand=ssh -F \/dev\/null -i \/root\/.ssh\/example-agent_tst -o IdentitiesOnly=yes/);
  assert.match(cfg, /core.hookspath=.githooks/);
  assert.match(cfg, /user.name=Tst \(examplehost\)/);
  assert.match(cfg, /user.email=agent\@example.org/);
  assert.match(cfg, /remote.origin.url=git@github.com:example-org\/agent-tst.git/);
  assert.ok(existsSync(join(R, "root", NAME, ".githooks/pre-commit")));

  const tcfg = spawnSync("/usr/bin/git", ["-C", join(R, "home/tasker-svc/agenti", NAME), "config", "--local", "-l"], { encoding: "utf8" }).stdout;
  assert.match(tcfg, /core.sshcommand=ssh -F \/dev\/null -i \/home\/tasker-svc\/.ssh\/example-agent_tasker/);
  assert.match(tcfg, /user.name=Tst \(examplehost\)/);

  assert.equal(readFileSync(join(state, "agent"), "utf8").trim(), "/home/tasker-svc/agenti/tst");
  assert.match(a.out, /budič: active/);
  assert.match(a.out, /== Zostáva ==[\s\S]*t3_thread_launch/);

  // tajomstvá nie sú na výstupe ani v zázname volaní
  for (const s of [GH_TOKEN, T3_TOKEN]) {
    assert.ok(!a.out.includes(s), "tajomstvo na výstupe");
    assert.ok(!a.log.includes(s), "tajomstvo v argumentoch");
  }

  const b = run();
  assert.equal(b.status, 0, b.out);
  assert.match(b.out, /zmien v tomto behu: 0/);
  assert.equal(b.log.split("\n").filter((l) => l.startsWith("MUT")).length, 0, b.log);
  assert.equal(readFileSync(join(R, "root/.config/adam/runtime.env"), "utf8"), adamEnv);
});

test("--thread zapíše id vlákna a zostáva už len obsah repa", () => {
  const { R, run } = setup();
  assert.equal(run().status, 0);
  const id = "thread:project:aaaa-1:bbbb-2";
  const a = run([NAME, "Tst", "--thread", id]);
  assert.equal(a.status, 0, a.out);
  assert.equal(readFileSync(join(R, `root/.local/state/${NAME}/thread_id`), "utf8"), id + "\n");
  assert.equal(mode(join(R, `root/.local/state/${NAME}/thread_id`)), "600");
  assert.ok(!/t3_thread_launch/.test(a.out));
  const b = run([NAME, "Tst", "--thread", id]);
  assert.match(b.out, /zmien v tomto behu: 0/);
  const settles = (r) => r.log.split("\n").filter((l) => l.startsWith("autosettle "));
  assert.deepEqual(settles(a), [`autosettle ${id} false`]);
  assert.deepEqual(settles(b), []);
});

test("--bez-behov: bez klonu behov, agent v Taskeri vypnutý, druhý beh nič nezmení", () => {
  const { R, run, state } = setup();
  const a = run([NAME, "Tst", "--bez-behov"]);
  assert.equal(a.status, 0, a.out);
  assert.ok(!existsSync(join(R, "home/tasker-svc/agenti", NAME)), "klon behov vznikol");
  assert.ok(existsSync(join(R, "root", NAME, ".git")), "chýba hlavný klon");
  assert.ok(!/clone .*tasker-svc\/agenti/.test(a.log), a.log);
  assert.match(a.log, /MUT tasker agent add tst --workdir \/root\/tst --disabled/);
  assert.equal(readFileSync(join(state, "agent_state"), "utf8").trim(), "disabled");
  assert.match(a.out, /Tasker: tst\tdisabled\t\/root\/tst/);
  assert.ok(!/POZOR/.test(a.out), a.out);
  const b = run([NAME, "Tst", "--bez-behov"]);
  assert.equal(b.status, 0, b.out);
  assert.match(b.out, /zmien v tomto behu: 0/);
  assert.equal(b.log.split("\n").filter((l) => l.startsWith("MUT")).length, 0, b.log);
  assert.ok(!existsSync(join(R, "home/tasker-svc/agenti", NAME)));
});

test("--bez-behov upozorní na už existujúci klon behov", () => {
  const { R, run } = setup();
  mkdirSync(join(R, "home/tasker-svc/agenti", NAME), { recursive: true });
  const a = run([NAME, "Tst", "--bez-behov"]);
  assert.equal(a.status, 0, a.out);
  assert.match(a.out, /POZOR: bez behov, ale .* existuje/);
});

test("agent v Taskeri s iným workdir dostane len workdir", () => {
  const { run, state } = setup();
  writeFileSync(join(state, "agent"), "/home/tasker-svc/projekty/x/x-web\n");
  const a = run();
  assert.equal(a.status, 0, a.out);
  assert.match(a.log, /MUT tasker agent edit tst --workdir \/home\/tasker-svc\/agenti\/tst/);
  assert.ok(!/agent add/.test(a.log));
  assert.equal(readFileSync(join(state, "agent"), "utf8").trim(), "/home/tasker-svc/agenti/tst");
});

test("existujúci runtime.env, t3_token a kľúč sa neprepíšu", () => {
  const { R, run } = setup();
  mkdirSync(join(R, `root/.config/${NAME}`), { recursive: true });
  writeFileSync(join(R, `root/.config/${NAME}/runtime.env`), "AGENT_MODEL=ine\n", { mode: 0o600 });
  writeFileSync(join(R, `root/.config/${NAME}/t3_token`), "stary\n", { mode: 0o600 });
  const a = run();
  assert.equal(a.status, 0, a.out);
  assert.equal(readFileSync(join(R, `root/.config/${NAME}/runtime.env`), "utf8"), "AGENT_MODEL=ine\n");
  assert.equal(readFileSync(join(R, `root/.config/${NAME}/t3_token`), "utf8"), "stary\n");
  assert.ok(!/MUT t3 /.test(a.log));
});

test("ochrana skúšky: bez podstavených príkazov skript nič nezapíše", () => {
  const { R, run, base } = setup();
  const empty = join(base, "prazdne");
  mkdirSync(empty);
  const r = run([NAME, "Tst"], { PATH: "/usr/bin:/bin", AV_STUBS: empty });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /ochrana skúšky/);
  assert.ok(!existsSync(join(R, `root/.ssh/example-agent_${NAME}`)));
  const r2 = run([NAME, "Tst"], { AV_STUBS: "" });
  assert.equal(r2.status, 3, r2.out);
});

test("vstupy: zlé meno, adam a boris, chýbajúce zobrazované meno", () => {
  const { run } = setup();
  assert.equal(run(["Emil", "Emil"]).status, 2);
  assert.equal(run(["adam", "Adam"]).status, 2);
  assert.equal(run(["boris", "Boris"]).status, 2);
  assert.equal(run([NAME]).status, 2);
  assert.equal(run([NAME, "Tst", "--thread", "a b"]).status, 2);
});

test("skúška sa nedotkla živých ciest", () => {
  setup().run();
  for (const p of [`/var/lib/${NAME}`, `/root/${NAME}`, `/etc/tmpfiles.d/${NAME}-inbox.conf`, `/root/.config/${NAME}`,
    `/root/.ssh/example-agent_${NAME}`, `/root/.local/state/${NAME}`, `/home/tasker-svc/agenti/${NAME}`]) {
    assert.ok(!existsSync(p), `${p} existuje`);
  }
  const live = "/root/.config/adam/runtime.env";
  assert.ok(!existsSync(live) || !/AGENT_REPLY_ROUTE_tst/.test(readFileSync(live, "utf8")));
});
