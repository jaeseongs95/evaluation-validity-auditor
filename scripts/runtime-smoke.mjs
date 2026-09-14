import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "evaluation-validity-runtime-"));
const cleanRoot = path.join(temporary, "package");
const suiteRoot = path.join(temporary, "suite");
const installedSkill = path.join(suiteRoot, "skills", "evaluation-validity-auditor");

try {
  await cp(root, cleanRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      const first = relative.split(path.sep)[0];
      return first !== ".git" && first !== "node_modules";
    },
  });
  const result = await execute(process.execPath, ["--test", "test/core.test.mjs"], {
    cwd: cleanRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  await mkdir(path.join(suiteRoot, "runtime"), { recursive: true });
  await mkdir(path.dirname(installedSkill), { recursive: true });
  await cp(path.join(root, "runtime", "schema-validation.mjs"), path.join(suiteRoot, "runtime", "schema-validation.mjs"), { recursive: true });
  await cp(root, installedSkill, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      const first = relative.split(path.sep)[0];
      return ![".git", "node_modules", "runtime", "test"].includes(first);
    },
  });
  await execute(process.execPath, ["--input-type=module", "--eval", "await import('./scripts/core.mjs');"], {
    cwd: installedSkill,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write("node_modules-free runtime check passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
