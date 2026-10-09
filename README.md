# 班级名册

Cloudflare Worker + D1 名册管理应用。浏览器使用密码派生 AES-GCM 密钥，D1 中的名册字段、状态和统计源数据均以密文保存。Worker 通过 `ROSTER_PASSWORD` Secret 校验访问密码，不把密码写入数据库。

## GitHub 自动部署到 Cloudflare

推送到 `main` 分支或在 GitHub Actions 手动运行 `Deploy to Cloudflare Workers`，会自动构建、应用 D1 迁移并部署 Worker。

1. 在 Cloudflare 控制台的 `Storage & databases > D1 SQL Database` 创建 `class-roster-vault`，或安装依赖后运行 `npx wrangler d1 create class-roster-vault`。
2. 将 D1 数据库 ID 填入 `wrangler.jsonc` 的 `database_id`，然后提交该配置。
3. 在 Cloudflare 创建 API Token，给目标账号授予 `Workers Scripts: Edit` 和 `D1: Edit` 权限，并将资源范围限制在目标账号。
4. 在 GitHub 仓库打开 `Settings > Secrets and variables > Actions`，添加以下 Repository secrets：

   - `CLOUDFLARE_API_TOKEN`：上一步创建的 API Token。
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID。
   - `ROSTER_PASSWORD`：名册访问密码，建议使用至少 16 位的随机密码。

5. 推送到 `main`，或在仓库的 `Actions` 页面手动运行工作流。工作流会先部署 Worker，再设置 `ROSTER_PASSWORD` Secret；首次运行期间应用可能短暂显示密码未配置。

部署后使用 Cloudflare 输出的 `workers.dev` 地址访问。自定义域名可在 Cloudflare 控制台的 Worker 设置中绑定。若仓库默认分支不是 `main`，需同步修改 `.github/workflows/deploy.yml` 的分支名。

`ROSTER_PASSWORD` 同时用于 Worker 访问校验和浏览器端数据加密。修改 GitHub 中这个 Secret 会使现有名册无法解密；不要直接轮换，除非已完成数据迁移和备份。

## 本地运行

1. 安装依赖：`npm install`
2. 在 `.dev.vars` 中设置本地密码，例如 `ROSTER_PASSWORD="替换为本地强密码"`。
3. 初始化本地 D1：`npx wrangler d1 migrations apply class-roster-vault --local`
4. 构建前端：`npm run build`
5. 启动：`npm run dev`

本地访问 Wrangler 输出的地址。`.dev.vars` 不应提交到版本控制。

## 数据与密码

- 密码通过 HTTPS 发给 Worker 做访问校验，不会写入 D1；浏览器再用该密码和 D1 返回的随机盐值派生加密密钥。Worker 运行时会收到密码用于校验，因此应保护 Cloudflare 账号和 Worker 部署权限。
- Worker 与 D1 只保存盐值、随机 IV、密文和更新时间。学生、家长、地址、电话、班级及签到状态都在加密 JSON 内。
- 加密使用 PBKDF2-HMAC-SHA-256（600,000 次迭代）派生 AES-256-GCM 密钥。
- 忘记密码或直接更换 `ROSTER_PASSWORD` 会导致原数据无法解密。当前应用不提供密码更换流程；更换前需先完成独立的数据迁移和备份。
- D1 中每次保存都会替换单份加密名册，建议使用 Cloudflare D1 的备份能力保留恢复点。

## Excel 导入

导入首个工作表，表头支持“学生姓名、班级、家长姓名、家长电话、地址、状态”等中文名称及常见别名。学生姓名和班级为必填列；导入前会预览可导入行数，默认追加到现有名册。
