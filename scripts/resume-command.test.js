const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resumeCommandForThread } = require("../public/phone-ui-utils");

const hosts = { air: "Example-MacBook-Air.local", mini: "Example-Mac-mini.local" };

// Run the actual generated shell syntax, but replace the AI and network
// executables. No conversation is resumed and no SSH connection is made.
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-command-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const cwd = path.join(directory, "owner's 日本語 $(not-a-command)");
  fs.mkdirSync(bin);
  fs.mkdirSync(cwd);
  const executable = (name, body) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  executable("hostname", 'process.stdout.write(process.env.RESUME_TEST_HOST + "\\n");');
  for (const provider of ["codex", "claude"]) {
    executable(provider, `console.log(JSON.stringify({provider:${JSON.stringify(provider)}, host:process.env.RESUME_TEST_HOST, cwd:process.cwd(), args:process.argv.slice(2)}));`);
  }
  executable("zsh", `
    const assert = require('node:assert/strict');
    assert.equal(process.argv[2], '-lic');
    const result = require('node:child_process').spawnSync('/bin/sh', ['-c', process.argv[3]], {stdio:'inherit'});
    process.exit(result.status ?? 1);
  `);
  executable("ssh", `
    const assert = require('node:assert/strict');
    const args = process.argv.slice(2);
    assert.equal(args[0], '-t');
    assert.equal(args.length, 3);
    if (process.env.RESUME_TEST_SSH_FAIL) process.exit(255);
    const host = process.env.RESUME_TEST_WRONG_HOST || ${JSON.stringify(hosts)}[args[1]];
    assert.ok(host, 'must use the owning Mac alias');
    const result = require('node:child_process').spawnSync('/bin/sh', ['-c', args[2]], {
      stdio:'inherit', env:{...process.env, RESUME_TEST_HOST:host}
    });
    process.exit(result.status ?? 1);
  `);
  return { cwd, run(command, source, extra = {}) {
    return spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, RESUME_TEST_HOST: hosts[source], ...extra },
    });
  } };
}

for (const provider of ["codex", "claude"]) {
  for (const target of ["air", "mini"]) {
    test(`${provider}: ${target} session resumes on its owner from either Mac`, (t) => {
      const f = fixture(t);
      const id = "01234567-89ab-cdef-0123-456789abcdef";
      const command = resumeCommandForThread({ provider, id, cwd: f.cwd }, { hostName: hosts[target] });
      assert.match(command, /ssh -t /);
      for (const source of ["air", "mini"]) {
        const result = f.run(command, source);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
          provider, host: hosts[target], cwd: fs.realpathSync(f.cwd), args: [provider === "codex" ? "resume" : "--resume", id],
        });
      }
    });
  }
}

test("wrong SSH destination and failed connections never fall back to the local AI", (t) => {
  const f = fixture(t);
  const command = resumeCommandForThread({ provider: "codex", id: "saved-id", cwd: f.cwd }, { hostName: hosts.air });
  for (const extra of [{ RESUME_TEST_WRONG_HOST: hosts.mini }, { RESUME_TEST_SSH_FAIL: "1" }]) {
    const result = f.run(command, "mini", extra);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("unknown ownership, missing cwd, placeholders and option-like IDs yield no command", () => {
  const thread = { provider: "codex", id: "saved-id", cwd: "/tmp/project" };
  assert.equal(resumeCommandForThread(thread), "");
  assert.equal(resumeCommandForThread(thread, { hostName: "" }), "");
  for (const changes of [{ cwd: "" }, { cwd: "relative" }, { id: "" }, { id: "claude:pending" }, { id: "--last" }, { id: "x; echo injected" }, { provider: "unknown" }]) {
    assert.equal(resumeCommandForThread({ ...thread, ...changes }, { hostName: hosts.air }), "");
  }
});
