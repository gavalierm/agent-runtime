// task_fresh.mjs: relácia nečíta komentár úlohy, ktorý vznikol po jej čítaní (úloha 690,
// replay úlohy 689). Živý Tasker sa nevolá: tk je falošný skript, ktorý vypíše JSON úlohy
// zo súboru (test ho medzi krokmi prepisuje) a zapíše volanie do logu. HOME aj
// XDG_CACHE_HOME sú v tmp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sensitiveName, simpleCommands, writeTargets, newRecords, toMs } from "./task_fresh.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "task_fresh.mjs");
const SHOW = "tk task show 689 --json";
const INSTALL = "bash host/server/install_remote.sh";

function sandbox({ current = { n: 689, reportedAt: 0, at: Date.now() - 3_600_000 }, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "task_fresh-"));
  const log = join(dir, "calls.log");
  const json = join(dir, "task.json");
  const fake = join(dir, "fake-tk.sh");
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${log}"\n[ -n "$FAKE_FAIL" ] && exit 3\ncat "${json}"\n`);
  chmodSync(fake, 0o755);
  const cache = join(dir, "cache");
  const base = { PATH: process.env.PATH, HOME: dir, XDG_CACHE_HOME: cache, AGENT_NAME: "adam", TASKER_WORK_CMD: fake, ...env };
  if (current) {
    const f = join(cache, "agentic-workflow", "tasker_work_current", "S1");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(current));
  }
  const sb = {
    dir,
    task: (t) => writeFileSync(json, JSON.stringify(t)),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    marker: () => JSON.parse(readFileSync(join(cache, "agentic-workflow", "task_fresh", "S1"), "utf8")),
    // Relácia čítala úlohu pred minútou: seenAt je minútu dozadu, záznamy v `later()` sú novšie.
    read: () => {
      sb.run(SHOW);
      const f = join(cache, "agentic-workflow", "task_fresh", "S1");
      writeFileSync(f, JSON.stringify({ ...sb.marker(), seenAt: Date.now() - 60_000, checkedAt: 0 }));
    },
    // Značka bez zdržania: test nečaká 20 s.
    unthrottle: () => {
      const f = join(cache, "agentic-workflow", "task_fresh", "S1");
      writeFileSync(f, JSON.stringify({ ...sb.marker(), checkedAt: 0 }));
    },
    run: (command, over = {}) => {
      const r = spawnSync("node", [HOOK], {
        input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "S1", tool_input: { command } }),
        env: { ...base, ...over },
        encoding: "utf8",
      });
      assert.equal(r.status, 0);
      return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
    },
  };
  sb.task({ id: 689, status: "in_progress", comments: [], events: [] });
  return sb;
}

// Čas záznamu: pred chvíľou (30 s dozadu), každý ďalší o 50 ms neskôr.
let tick = Date.now() - 30_000;
const later = () => (tick += 50);
const comment = (author, body, t = later()) => ({ id: t, author, author_kind: "human", body, created_at: t });

test("replay úlohy 689: komentár po čítaní zastaví citlivý príkaz, task show ho pustí", () => {
  const sb = sandbox();
  // (a) čítanie úlohy prejde a nastaví seenAt
  const before = Date.now();
  assert.equal(sb.run(SHOW), null);
  assert.equal(sb.calls().length, 0, "task show hook sám nevolá tk");
  assert.ok(sb.marker().seenAt >= before);
  assert.equal(sb.marker().n, 689);
  // Čítanie bolo pred minútou, komentár vznikol po ňom.
  writeFileSync(join(sb.dir, "cache", "agentic-workflow", "task_fresh", "S1"), JSON.stringify({ ...sb.marker(), seenAt: Date.now() - 60_000 }));
  // (b) komentár iného autora, install sa zamietne s telom komentára
  const body = "Schválená cesta A, sudo nenasadzuj.";
  sb.task({ id: 689, comments: [comment("boris", body)], events: [] });
  const out = sb.run(INSTALL);
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason.includes(body));
  assert.match(out.permissionDecisionReason, /komentár boris/);
  assert.ok(out.permissionDecisionReason.includes("Správny postup:"));
  assert.deepEqual(sb.calls(), ["task show 689 --json"]);
  // (c) ten istý príkaz bez task show sa zamietne znova, značka sa nepohla
  const seen = sb.marker().seenAt;
  assert.ok(seen < Date.now() - 50_000);
  assert.equal(sb.run(INSTALL).permissionDecision, "deny");
  assert.equal(sb.marker().seenAt, seen);
  assert.equal(sb.calls().length, 2, "citlivý príkaz volá tk vždy");
  // (d) task show prejde a install potom prejde bez výstupu
  assert.equal(sb.run(SHOW), null);
  assert.ok(sb.marker().seenAt >= before);
  assert.equal(sb.run(INSTALL), null);
  assert.equal(sb.run("git status"), null);
});

test("task show s cestou, premennou a obalom prejde aj pri novom komentári", () => {
  const sb = sandbox();
  sb.read();
  sb.task({ id: 689, comments: [comment("boris", "nový")], events: [] });
  assert.equal(sb.run("TASKER_USER=adam /opt/agentic-workflow/bin/tk task show 689 --json"), null);
  assert.equal(sb.calls().length, 0);
  assert.equal(sb.run("cd /tmp && sudo runuser -u tasker-user -- tk task show 689"), null);
  // Iná úloha nie je čítanie úlohy 689: komentár zo značky ju nezastaví, ale volá sa tk.
  sb.read();
  assert.match(sb.run("tk task show 12 --json").additionalContext, /komentár boris: nový/);
});

test("čítanie spojené s citlivým príkazom nie je výnimka", () => {
  const sb = sandbox();
  sb.read();
  sb.task({ id: 689, comments: [comment("boris", "stoj")], events: [] });
  const out = sb.run(`${SHOW} && ${INSTALL}`);
  assert.equal(out.permissionDecision, "deny");
});

test("(e) necitlivý príkaz: kontext s telom komentára, druhý hneď potom bez výstupu", () => {
  const sb = sandbox();
  sb.read();
  sb.task({ id: 689, comments: [comment("boris", "Použi cestu A.")], events: [] });
  const out = sb.run("git status");
  assert.equal(out.permissionDecision, undefined);
  assert.match(out.additionalContext, /^Úloha 689 má záznamy, ktoré táto relácia nečítala:\n/);
  assert.match(out.additionalContext, /komentár boris: Použi cestu A\./);
  assert.match(out.additionalContext, /Konaj podľa nich, nie podľa stavu úlohy zo štartu\.$/);
  sb.unthrottle();
  assert.equal(sb.run("git status"), null, "záznam sa nezopakuje");
});

test("(f) komentár od samotného agenta nie je nový", () => {
  const sb = sandbox();
  sb.read();
  sb.task({ id: 689, comments: [comment("adam", "Pracujem na tom.")], events: [] });
  assert.equal(sb.run("git status"), null);
  assert.equal(sb.run(INSTALL), null);
});

test("(g) zmena stavu iným aktérom sa ohlási, vlastná nie", () => {
  const sb = sandbox();
  sb.read();
  const ev = (actor, from, to) => ({ at: later(), actor, kind: "status", from_status: from, to_status: to, detail: null });
  sb.task({ id: 689, comments: [], events: [ev("human:adam", "ready", "in_progress"), ev("human:boris", "waiting", "done"), { at: later(), actor: "tasker", kind: "work", detail: "start" }] });
  const out = sb.run("git status");
  assert.match(out.additionalContext, /stav waiting -> done \(human:boris\)/);
  assert.doesNotMatch(out.additionalContext, /ready -> in_progress/);
  assert.doesNotMatch(out.additionalContext, /work/);
});

test("(h) bez úlohy relácie hook mlčí a tk nevolá", () => {
  const sb = sandbox({ current: null });
  sb.task({ id: 1, comments: [comment("boris", "x")], events: [] });
  assert.equal(sb.run(INSTALL), null);
  assert.equal(sb.run("git status"), null);
  assert.equal(sb.calls().length, 0);
  assert.equal(existsSync(join(sb.dir, "cache", "agentic-workflow", "task_fresh")), false);
});

test("(i) beh Taskera: TASKER_TASK_ID bez súboru current, vloží sa len záznam novší ako začiatok", () => {
  const sb = sandbox({ current: null });
  const old = Date.now() - 3_600_000;
  sb.task({ id: 689, comments: [comment("boris", "starý komentár", old), comment("boris", "komentár počas behu", Date.now() + 3_600_000)], events: [] });
  const out = sb.run("git status", { TASKER_TASK_ID: "689" });
  assert.match(out.additionalContext, /komentár počas behu/);
  assert.doesNotMatch(out.additionalContext, /starý komentár/);
});

test("(j) chyba tk, neplatný JSON a chýbajúce polia: bez výstupu", () => {
  const sb = sandbox();
  sb.read();
  sb.task({ id: 689, comments: [comment("boris", "x")], events: [] });
  assert.equal(sb.run(INSTALL, { FAKE_FAIL: "1" }), null);
  writeFileSync(join(sb.dir, "task.json"), "nie je json");
  assert.equal(sb.run(INSTALL), null);
  sb.task({ id: 689 });
  assert.equal(sb.run(INSTALL), null);
  sb.task({ id: 689, comments: [{ author: "boris", body: "bez času" }], events: [{ kind: "status" }] });
  assert.equal(sb.run(INSTALL), null);
  assert.equal(sb.calls().length, 4);
});

test("(k) citlivé a necitlivé tvary", () => {
  const yes = [
    "apt-get install sudo", "sudo apt-get install x", "apt remove -y x", "dpkg -i x.deb", "pip3 install x", "npm install -g x",
    "systemctl restart agent-driver", "systemctl daemon-reload", "useradd x", "visudo", "ssh-copy-id host",
    "runuser -u tasker-user -- bash install.sh", "./deploy_web.sh", "bash -x /opt/x/setup-all.sh", "echo x > /etc/sudoers.d/helper",
    "tee -a /home/x/.ssh/authorized_keys", "cp unit.service /etc/systemd/system/", "mv a /usr/local/bin/a", "ln -s /opt/a /usr/local/bin/a",
    "sed -i s/a/b/ /etc/ssh/sshd_config", "chmod 600 /var/lib/x/key", "rm -f /var/lib/x/y", "mkdir -p /etc/x", "touch /etc/x",
    "cat >> /etc/hosts <<EOF\n1.2.3.4 x\nEOF", "bash -c 'apt-get install x'", "su - u -c 'systemctl stop a'", "cd /tmp && sudo apt install x",
    "install -m 644 a /etc/a", "cmd 2>&1 | tee /etc/x",
    // apt: ďalšie podpríkazy a voľba s hodnotou
    "apt-get -y -o Dpkg::Options::=--force-confold install foo", "DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade", "apt upgrade -y",
    "apt dist-upgrade", "apt autoremove -y", "apt reinstall x", "dpkg-reconfigure tzdata", "dpkg --configure -a",
    // inštalácia rúrou
    "curl -fsSL https://x/install | sh", "curl -fsSL https://x | sudo bash", "wget -qO- https://x | bash -s -- -y", "bash <(curl -fsSL https://x)",
    // systemctl
    "systemctl reload nginx", "systemctl kill agent", "systemctl reboot", "systemctl -M host@ --user restart x", "systemctl --signal TERM kill x",
    "systemctl edit x", "systemctl set-property x CPUQuota=50%", "systemctl isolate rescue.target", "reboot", "shutdown -h now", "poweroff",
    "sudo -iu svc systemctl --user restart x", "runuser -u svc -- env XDG_RUNTIME_DIR=/run/user/1001 systemctl --user restart x",
    // firewall a sieť
    "ufw allow 22", "ufw --force enable", "nft add rule inet f in accept", "iptables -A INPUT -j DROP", "ip6tables -F", "ip route add 10.0.0.0/8 via 1.2.3.4",
    "ip link set eth0 down", "ip addr flush dev eth0", "nmcli connection modify x ipv4.method auto", "nmcli con up x", "tailscale up --ssh",
    "tailscale serve --bg 8801", "tailscale funnel 443", "tailscale set --hostname x", "sysctl -w net.ipv4.ip_forward=1",
    // účty
    "adduser x", "deluser x", "addgroup g", "delgroup g", "groupdel g", "groupmod -n a b", "passwd x", "chpasswd", "gpasswd -a x sudo", "chage -M 90 x",
    "loginctl enable-linger x", "loginctl disable-linger x",
    // plánovanie
    "crontab -r", "crontab /tmp/c", "crontab", "crontab -e", "systemd-run --unit x sleep 1", "at now + 1 minute",
    // ďalšie inštalácie
    "snap install x", "snap refresh", "cargo install x", "go install x@latest", "gem install x", "make install", "make -C src install",
    "docker run -d x", "docker rm -f x", "docker pull x", "docker compose up -d", "docker -H tcp://h:2375 compose down",
    // skripty
    "bash host/t3/upgrade_t3.sh", "host/ops/retire_agent.sh x", "bash create_user.sh", "./firewall.sh", "bash ssh_config.sh", "sh write_usb.sh /dev/sdb",
    "bash wait_idle.sh && systemctl restart x",
    // zápis
    "cp x /usr/bin/x", "cp x /opt/code/x", "mv x /srv/x", "touch /boot/x", "tee /var/spool/cron/crontabs/root", "tee /root/.ssh/config",
    "cp k /home/user/.ssh/authorized_keys", "echo k >> /home/user/.ssh/config", "dd if=x of=/etc/x", "rsync -a x/ /etc/x/", "tar -xzf a.tgz -C /etc",
    "tar --extract --file a.tgz --directory=/usr/local", "unzip -o a.zip -d /opt/x", "chgrp g /etc/x", "truncate -s 0 /var/lib/x/log",
    "cat <<E > /etc/x\nfoo\nE", "find /etc -name x -exec rm {} +", "find /etc/x -delete", "xargs -a list.txt systemctl restart", "find . -name x -exec systemctl restart x \\;",
    // obaly
    "timeout -s KILL 10 systemctl restart x", "nice -n 5 apt install x", "ionice -c 3 apt-get install x", "sudo -u svc -- apt install x", "sudo -uroot apt install x",
  ];
  const no = [
    "apt-get --help", "apt list", "systemctl status x", "cat /etc/hosts", "git commit -m 'apt install x'", "tk task show 1 --json",
    "echo install.sh", "cp /etc/hosts /tmp/x", "ls /var/lib/x", "echo x > $HOME/etc/x", "rm /tmp/$(date)/x", "npm install x", "pip list",
    "tk comment 1 --body 'sudo apt-get install x'", "tasker task add --title 'systemctl restart x'", "cat <<EOF\napt install x\nEOF",
    "sed -n '/etc/p' /etc/hosts", "touch /tmp/a", "echo > /dev/null",
    // bežná práca
    "cat /etc/passwd", "grep -n deny -A80 /root/.claude/settings.json", "journalctl -u x -n 50", "cp /etc/x /tmp/x", "sed -n 1,5p /etc/fstab",
    "ls /var/lib/x/inbox 2>/dev/null", "./test/run.sh", "bash tests/run.sh", "G=$(X=y host/tests/commit_push.sh \"m\" a) || exit 1", "node check.mjs > /tmp/out",
    "ufw status", "ufw status verbose", "crontab -l", "crontab -u x -l", "tailscale status", "tailscale serve status", "ip addr", "ip route get 1.1.1.1", "ip -br link",
    "docker ps", "docker logs x", "nft list ruleset", "iptables -L -n", "iptables -S", "nmcli device status", "sysctl net.ipv4.ip_forward", "passwd -S x", "chage -l x",
    "systemctl list-units", "systemctl is-active x", "dpkg -l", "dpkg -s x", "apt list --upgradable", "apt-get --help", "curl -fsSL https://x | jq .", "curl https://x | bash -c 'cat'",
    "tar -czf /tmp/a.tgz -C /etc .", "tar -tzf a.tgz", "unzip a.zip -d /tmp/x", "rsync -a /etc/x /tmp/x/", "find /etc -name x -exec grep y {} +", "find /var/lib -name x",
    "xargs -a list.txt cat", "timeout 10 ls", "nice -n 5 ls", "sudo -u svc ls /etc", "bash create-nothing.txt", "git status", "AGENT_NAME=x /opt/code/reply.sh a <<'E'\nVýsledok: rm /etc/x\nE",
  ];
  for (const c of yes) assert.ok(sensitiveName(c), `má byť citlivé: ${c}`);
  for (const c of no) assert.equal(sensitiveName(c), null, `nemá byť citlivé: ${c}`);
});

test("rozklad: obaly a vnorené shelly, ciele zápisu", () => {
  assert.deepEqual(simpleCommands("sudo -u x env A=1 bash -c 'apt install y; ls'"), [["apt", "install", "y"], ["ls"]]);
  assert.deepEqual(simpleCommands("runuser -u x -- tk task show 1"), [["tk", "task", "show", "1"]]);
  assert.deepEqual(writeTargets(["cp", "-r", "a", "b", "/etc/x"]), ["/etc/x"]);
  assert.deepEqual(writeTargets(["echo", "x", ">", "/etc/a"]), ["/etc/a"]);
  assert.deepEqual(writeTargets(["echo", "x", ">", "$F"]), []);
  // zlúčené voľby s hodnotou, voľba s hodnotou pred príkazom
  assert.deepEqual(simpleCommands("sudo -iu svc systemctl restart x"), [["systemctl", "restart", "x"]]);
  assert.deepEqual(simpleCommands("sudo -uroot ls"), [["ls"]]);
  assert.deepEqual(simpleCommands("timeout -s KILL 10 ls /a"), [["ls", "/a"]]);
  assert.deepEqual(simpleCommands("nice -n 5 ls"), [["ls"]]);
  assert.deepEqual(simpleCommands("xargs -I {} -P 4 cp {} /tmp"), [["cp", "{}", "/tmp"]]);
  assert.deepEqual(simpleCommands("find /etc -name x -exec rm {} +"), [["rm", "/etc"], ["find", "/etc", "-name", "x", "-exec", "rm", "{}", "+"]]);
  assert.deepEqual(simpleCommands("cat <<E > /etc/x\nbody\nE"), [["cat", "<<heredoc", ">", "/etc/x"]]);
  assert.deepEqual(writeTargets(["dd", "if=a", "of=/etc/b"]), ["/etc/b"]);
  assert.deepEqual(writeTargets(["tar", "-xf", "a", "-C", "/opt"]), ["/opt"]);
  assert.deepEqual(writeTargets(["tar", "-cf", "a", "-C", "/opt", "."]), []);
});

test("(l) necitlivé príkazy volajú tk najviac raz za 20 s, citlivý vždy", () => {
  const sb = sandbox();
  sb.run("git status");
  sb.run("ls");
  assert.equal(sb.calls().length, 1);
  sb.run(INSTALL);
  sb.run(INSTALL);
  assert.equal(sb.calls().length, 3);
  sb.run("ls");
  assert.equal(sb.calls().length, 3, "citlivé volanie obnovilo checkedAt");
});

test("najviac 8 záznamov, telo skrátené na 600 znakov, zvyšok jedným riadkom", () => {
  const sb = sandbox();
  sb.read();
  const many = Array.from({ length: 11 }, (_, i) => comment("boris", i === 10 ? "x".repeat(900) : `k${i}`));
  sb.task({ id: 689, comments: many, events: [] });
  const out = sb.run("git status").additionalContext;
  assert.equal(out.split("\n").filter((l) => /komentár boris/.test(l)).length, 8);
  assert.match(out, /a ešte 3 starších, pozri `tk task show 689 --json`/);
  assert.ok(out.includes("x".repeat(600) + "…"));
  assert.ok(!out.includes("x".repeat(601)));
});

test("bez značky seenAt z `at` súboru current: starší záznam sa nehlási", () => {
  const at = Date.now() - 60_000;
  const sb = sandbox({ current: { n: 689, reportedAt: 0, at } });
  sb.task({ id: 689, comments: [comment("boris", "pred štartom", at - 5000), comment("boris", "po štarte", at + 5000)], events: [] });
  const out = sb.run("git status").additionalContext;
  assert.match(out, /po štarte/);
  assert.doesNotMatch(out, /pred štartom/);
  assert.equal(sb.marker().n, 689);
});

test("iné číslo úlohy zahodí starú značku", () => {
  const sb = sandbox();
  sb.read();
  const f = join(sb.dir, "cache", "agentic-workflow", "tasker_work_current", "S1");
  writeFileSync(f, JSON.stringify({ n: 700, reportedAt: 0, at: Date.now() - 1000 }));
  sb.run("ls");
  assert.equal(sb.marker().n, 700);
});

test("newRecords a toMs: tvary času a vlastné záznamy", () => {
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMs("2026-10-30T19:30:00.000Z"), Date.parse("2026-10-30T19:30:00.000Z"));
  assert.ok(Number.isNaN(toMs(undefined)));
  const t = { comments: [{ author: "adam", body: "b", created_at: 5000 }, { author: "boris", body: "c", created_at: "2026-10-30T19:30:00.000Z" }], events: [] };
  assert.equal(newRecords(t, "adam", 0).length, 1);
  assert.throws(() => newRecords({}, "adam", 0));
});
