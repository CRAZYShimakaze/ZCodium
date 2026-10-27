#!/usr/bin/env -S pnpm exec tsx
// 基线是实际迁移产物；校验旧列/主键/索引兼容，并要求 schema 变更显式更新可审阅基线。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { TaskIndexRepo } from "../packages/services/src/session/taskIndexRepo.js";
import { AutomationRepo } from "../packages/services/src/session/automationRepo.js";
import { OffPeakTaskRepo } from "../packages/services/src/session/offPeakTaskRepo.js";
import { getTasksIndexDatabasePath, setDataBaseDir } from "../packages/services/src/paths.js";
import { SQLITE_MIGRATIONS } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.js";
import { sqliteMigrations } from "../packages/shared/src/sqlite-migrations/index.js";
import { assertAdditiveSchema, dumpSqliteSchema } from "./sqlite-schema-contract.mjs";

const exec = promisify(execFile);

async function hasCommit(ref: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * schema 只增约束必须和“目标分支”比较，不能用 HEAD 或当前分支的远端 SHA：
 * - pre-push 在提交之后运行，HEAD 已经包含新的 baseline，删除列/表会互相抵消；
 * - 当前分支的远端 SHA 是上一次推送，可能已经包含 destructive baseline。
 * 因此优先显式变量 / CI 目标分支变量，其次 origin/HEAD、origin/main 等目标分支的 merge-base。
 */
async function resolveSchemaBase(): Promise<{ base: string; label: string }> {
  const explicit = process.env.SQLITE_SCHEMA_BASE_REF?.trim();
  if (explicit) return { base: explicit, label: `explicit ${explicit}` };

  const ciBase = process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA?.trim();
  if (ciBase) {
    if (await hasCommit(ciBase)) return { base: ciBase, label: `CI ${ciBase}` };
    console.warn(`[db:schema:check] ignore invalid CI_MERGE_REQUEST_DIFF_BASE_SHA=${ciBase}`);
  }

  const originHead = await exec("git", [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ])
    .then((result) => result.stdout.trim())
    .catch(() => "");
  const githubBase = process.env.GITHUB_BASE_REF?.trim();
  for (const ref of [
    originHead,
    githubBase ? `origin/${githubBase}` : "",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ]) {
    if (!ref || !(await hasCommit(ref))) continue;
    const mergeBase = await exec("git", ["merge-base", "HEAD", ref])
      .then((result) => result.stdout.trim())
      .catch(() => "");
    if (mergeBase) return { base: mergeBase, label: `merge-base ${ref}` };
  }
  return { base: "HEAD", label: "HEAD (未找到目标分支，仅比较工作树)" };
}

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
const update = process.argv.includes("--update");
const { base, label: baseLabel } = await resolveSchemaBase();
if (base === "HEAD") {
  console.warn(
    `[db:schema:check] base is HEAD (${baseLabel}); destructive schema changes cannot be detected`,
  );
}
console.log(`SQLite schema base: ${base} (${baseLabel})`);
await exec("git", ["rev-parse", "--verify", `${base}^{commit}`]);
const directory = await mkdtemp(join(tmpdir(), "zcode-schema-check-"));
const cli = new DatabaseSync(":memory:");
setDataBaseDir(directory);
const repos = [new AutomationRepo(), new OffPeakTaskRepo(), new TaskIndexRepo()];
try {
  for (const repo of repos) await repo.ensureReady();
  const app = new DatabaseSync(getTasksIndexDatabasePath(), { readOnly: true });
  let appSql: string;
  try {
    appSql = dumpSqliteSchema(app);
  } finally {
    app.close();
  }
  await sqliteMigrations.migrate(cli, SQLITE_MIGRATIONS, {
    database: "cli",
    backupDirectories: [directory],
    appliedAtColumn: "time_applied",
  });
  const schemas = [
    ["packages/services/src/project-storage/schema.baseline.sql", appSql],
    [
      "apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql",
      dumpSqliteSchema(cli),
    ],
  ];
  for (const [path, current] of schemas) {
    // 旧基线来自目标 git 状态；修改本地基线不能绕过只增约束。
    let previous: string | undefined;
    try {
      previous = (await exec("git", ["show", `${base}:${path}`])).stdout;
    } catch {
      /* 首次引入该库的基线时没有历史文件。 */
    }
    if (previous) assertAdditiveSchema(previous, current);
    if (update) await writeFile(path, current);
    else {
      const baseline = await readFile(path, "utf8");
      assertAdditiveSchema(baseline, current);
      assertAdditiveSchema(current, baseline);
      if (baseline !== current)
        throw new Error(`Schema baseline differs: ${path}; review then run pnpm db:schema:update`);
    }
    console.log(`SQLite schema compatible: ${path}`);
  }
} finally {
  for (const repo of repos.toReversed()) repo.close();
  cli.close();
  setDataBaseDir(null);
  await rm(directory, { recursive: true, force: true });
}
