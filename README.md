# 班级名册

Cloudflare Workers + D1 名册管理应用。学生信息在浏览器中加密后保存到 D1。

## 部署到 Cloudflare

推荐使用 Cloudflare Workers Builds。首次部署会自动创建或复用 D1、应用迁移并发布 Worker；访问应用后，再用部署日志中的设置码创建自己的访问密码。

1. 将仓库 Fork 到自己的 GitHub 账号。
2. 在 Cloudflare 控制台打开 `Workers & Pages > Create application > Import a repository`，授权并选择该仓库。Worker 名称需与 `wrangler.jsonc` 中的 `name` 一致，默认是 `class-roster-vault`。
3. 配置 Workers Builds：生产分支选择 `main`，根目录留空，Build command 留空，Deploy command 填 `npm run deploy`，Node.js 版本设为 `22`。
4. 创建 Cloudflare API Token 并在 Builds 中选择它。Token 需要目标账号的 `Workers Scripts: Edit`、`D1: Edit` 和账号读取权限。
5. 点击 `Save and Deploy`。首次部署成功后，在构建日志里复制“首次设置码（SETUP_TOKEN）”。
6. 打开部署日志中的 `workers.dev` 地址，输入设置码，然后自行设置名册访问密码。

`npm run deploy` 会按 `wrangler.jsonc` 中的数据库名称查找或创建 D1，应用 `migrations/` 中未执行的迁移，然后构建并部署 Worker。Cloudflare Builds 每次都从 GitHub 获取代码，数据库 ID 占位值可以保留在仓库中；脚本会复用账号里同名的数据库。

设置访问密码前，每次成功部署都会签发新的设置码，旧设置码随即失效，请始终使用最近一次成功部署日志中的码。设置密码后，设置码失效，后续代码部署会保留现有密码和名册数据。

Workers Builds 会在生产分支有新提交时自动部署。自定义域名可在 Cloudflare Worker 设置中绑定。若生产分支不是 `main`，在 Builds 配置中选择实际分支即可。

### 本地首次部署

在项目目录执行：

```sh
npm install
npx wrangler login
npm run deploy
```

首次部署成功后，终端会显示设置码。打开 Wrangler 输出的 Worker 地址并创建访问密码。脚本会把找到的 D1 数据库 ID 写入本地 `wrangler.jsonc`；该 ID 不是凭据。

## 本地运行

1. 安装依赖：`npm install`
2. 在 `.dev.vars` 中设置本地初始化码，例如 `SETUP_TOKEN="local-setup-code"`。
3. 运行 `npm run dev`。命令会先将迁移应用到本地 D1。
4. 打开 Wrangler 输出的地址，输入 `local-setup-code` 并创建本地访问密码。

`.dev.vars` 不应提交到版本控制。旧版本地配置仍可使用 `ROSTER_PASSWORD="本地密码"` 登录。

## 数据与密码

- 首次访问密码由用户自行设置，不会在部署时生成；除不能为空外，不限制长度或字符组合。D1 的 `roster_auth` 表只保存 PBKDF2 派生的校验值和随机盐，不保存密码明文。
- 同一密码用于浏览器端 AES-256-GCM 加密名册数据。密码会通过 HTTPS 发给 Worker 做校验；Worker 运行时会收到密码，因此应保护 Cloudflare 账号和部署权限。
- 学生、家长、电话、地址、班级及签到状态都在加密 JSON 内。D1 另保存随机盐、随机 IV 和更新时间。
- 首次设置码是单独的一次性凭据，只用于防止他人在初始化前抢先设置密码。拥有 Cloudflare 构建日志访问权限的人可以看到它；创建密码后该码不能再次使用。
- 忘记访问密码无法恢复已有名册。当前应用不提供密码更换流程；换密码会导致已有数据无法解密。更换前需先完成数据迁移和备份。
- 升级旧部署时，`ROSTER_PASSWORD` Cloudflare Secret 仍可用于登录，不要求重置现有密码。不要在确认迁移和备份前删除或更换该 Secret。
- 每次保存会替换 D1 中的单份加密名册，建议使用 Cloudflare D1 的备份能力保留恢复点。

## Excel 导入

导入首个工作表，表头支持“学生姓名、班级、家长姓名、家长电话、地址、状态”等中文名称及常见别名。学生姓名和班级为必填列。默认按学生姓名和班级匹配，更新已有记录并追加新记录；Excel 未包含的可选列会保留原值。也可选择清空全部名册后导入，执行前会再次确认。

桌面名册可拖动表头分隔线调整列宽，宽度保存在当前浏览器中。移动端列表显示当前视图序号、姓名、班级和地址，并突出签到状态；可按班级或地址升降序，过长地址会截断。
