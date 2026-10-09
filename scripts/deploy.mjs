import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const INITIALIZATION_QUERY = "SELECT (SELECT COUNT(*) FROM roster_auth WHERE id = 1) AS auth_count, (SELECT COUNT(*) FROM roster_vault WHERE id = 1) AS vault_count";

function databaseBinding(config) {
  const bindings = config.d1_databases?.filter((binding) => binding.binding === "DB") ?? [];
  if (!config.name || bindings.length !== 1) throw new Error("wrangler.jsonc 必须配置 Worker 名称和唯一的 D1 DB 绑定。");
  const binding = bindings[0];
  if (typeof binding.database_name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(binding.database_name)) {
    throw new Error("DB.database_name 只能包含字母、数字、下划线或连字符。");
  }
  if (!UUID.test(binding.database_id ?? "")) throw new Error("DB.database_id 格式无效。");
  return binding;
}

function parseJson(output, command) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} 未返回有效 JSON，部署已停止。`);
  }
}

function createWranglerRunner(root, configPath) {
  const executable = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  return (args, { capture = false, input } = {}) => new Promise((complete, reject) => {
    const hasPrivateInput = input !== undefined;
    const child = spawn(process.execPath, [executable, ...args, "--config", configPath], {
      cwd: root,
      shell: false,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
      stdio: [hasPrivateInput ? "pipe" : "ignore", "pipe", "pipe"]
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        if (!capture && output) process.stdout.write(output);
        if (!capture && errors) process.stderr.write(errors);
        complete(output);
        return;
      }
      const detail = !hasPrivateInput && errors.trim() ? `\n${errors.trim()}` : "";
      reject(new Error(`wrangler ${args.slice(0, 3).join(" ")} 执行失败（退出码 ${code}）。${detail}`));
    });
    if (hasPrivateInput) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

async function listDatabases(run) {
  const databases = parseJson(await run(["d1", "list", "--json"], { capture: true }), "wrangler d1 list");
  if (!Array.isArray(databases) || databases.some((database) => !database || typeof database.name !== "string" || !UUID.test(database.uuid))) {
    throw new Error("Cloudflare 返回的数据库列表格式无法识别。");
  }
  return databases;
}

async function bindDatabase(binding, run, saveConfig, config) {
  if (binding.database_id !== PLACEHOLDER_DATABASE_ID) return;

  let database = (await listDatabases(run)).find((item) => item.name === binding.database_name);
  if (!database) {
    console.log(`创建 D1 数据库：${binding.database_name}`);
    await run(["d1", "create", binding.database_name, "--update-config=false"]);
    database = (await listDatabases(run)).find((item) => item.name === binding.database_name);
  }
  if (!database) throw new Error("找不到刚创建的 D1 数据库，请稍后重新运行 npm run deploy。");
  binding.database_id = database.uuid;
  await saveConfig(config);
  console.log("D1 数据库 ID 已写入 wrangler.jsonc。");
}

async function readInitializationState(run) {
  const response = parseJson(await run([
    "d1", "execute", "DB", "--remote", "--command", INITIALIZATION_QUERY, "--json"
  ], { capture: true }), "wrangler d1 execute");
  const row = response?.[0]?.results?.[0];
  if (!Array.isArray(response) || response.length !== 1 || response[0].success === false || !row
    || ![0, 1].includes(row.auth_count) || ![0, 1].includes(row.vault_count)) {
    throw new Error("无法确认数据库初始化状态，部署已停止。");
  }
  return { initialized: row.auth_count === 1, vaultExists: row.vault_count === 1 };
}

async function listSecrets(run) {
  const secrets = parseJson(await run(["secret", "list", "--format", "json"], { capture: true }), "wrangler secret list");
  if (!Array.isArray(secrets) || secrets.some((secret) => !secret || typeof secret.name !== "string")) {
    throw new Error("Cloudflare 返回的 Secret 列表格式无法识别。");
  }
  return new Set(secrets.map((secret) => secret.name));
}

async function issueSetupToken(run) {
  const setupToken = randomBytes(32).toString("hex");
  await run(["secret", "put", "SETUP_TOKEN"], { input: `${setupToken}\n` });
  console.log([
    "",
    "========== 首次设置码（SETUP_TOKEN） ==========",
    setupToken,
    "打开 Worker 地址后输入此设置码，再自行设置名册访问密码。",
    "设置完成后此码失效；未完成设置前，后续部署会签发新码。",
    "==============================================",
    ""
  ].join("\n"));
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const configPath = resolve(root, "wrangler.jsonc");
  const wranglerPath = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  try {
    await access(wranglerPath);
  } catch {
    throw new Error("缺少 Wrangler，请先运行 npm install。");
  }

  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("wrangler.jsonc 格式错误或无法读取。");
  }
  const binding = databaseBinding(config);
  const run = createWranglerRunner(root, configPath);
  const saveConfig = (value) => writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);

  await bindDatabase(binding, run, saveConfig, config);
  await run(["d1", "migrations", "apply", "DB", "--remote", "--yes"]);

  const initialization = await readInitializationState(run);
  let secrets = null;
  if (!initialization.initialized && initialization.vaultExists) {
    secrets = await listSecrets(run);
    if (!secrets.has("ROSTER_PASSWORD")) {
      throw new Error("数据库已有名册，但未找到旧版 ROSTER_PASSWORD Secret。请恢复原密码 Secret 后再部署，避免无法解密现有数据。");
    }
  }

  await run(["deploy", "--yes"]);
  if (initialization.initialized) {
    console.log("部署完成，已有访问密码和名册数据已保留。");
    return;
  }
  if (!secrets) secrets = await listSecrets(run);
  if (secrets.has("ROSTER_PASSWORD")) {
    console.log("部署完成，已有访问密码和名册数据已保留。");
    return;
  }

  await issueSetupToken(run);
  console.log("部署完成。使用上方设置码打开 Worker，并创建自己的名册访问密码。");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
