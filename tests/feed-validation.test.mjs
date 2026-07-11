import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const execute = promisify(execFile);
const root = resolve(".");
const validator = resolve("dist/feed-validate.cjs");

async function validate(name) {
  return execute(process.execPath, [validator, "--feed-root", resolve("fixtures", name), "--contract-root", root, "--json"], { cwd: root });
}

for (const name of ["bootstrap-empty", "one-english-blog", "one-korean-blog", "translated-blog-pair", "partial-blog-pair", "translated-paper-pair", "one-paper-multiple-sessions", "one-simple-public-review", "one-rich-review", "one-implementation", "valid-graph"]) {
  test(`${name} is a valid contract fixture`, async () => {
    const result = await validate(name);
    assert.equal(JSON.parse(result.stdout).valid, true);
  });
}

for (const [name, code] of [["invalid-dangling-graph-edge", "dangling-graph-edge"], ["invalid-manifest-count", "manifest-count"], ["invalid-activity-mismatch", "activity-mismatch"], ["invalid-build-note-metric", "build-note-eligibility"], ["private-leak", "local-user-path"], ["unhashed-asset", "undeclared-asset"]]) {
  test(`${name} fails with ${code}`, async () => {
    await assert.rejects(validate(name), (error) => `${error.stdout}\n${error.stderr}`.includes(code));
  });
}
