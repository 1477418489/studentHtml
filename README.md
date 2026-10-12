# 班级名册

Cloudflare Workers + D1 名册管理应用。学生信息在浏览器中加密后保存到 D1。

## 版本号

登录页和主界面左上角显示 `vX.Y.Z`，用于确认当前打开的页面版本。版本号统一来自 `package.json` 的 `version`，构建时写入页面资源。

每轮修改完成后递增一次补丁号，并在 [CHANGELOG.md](CHANGELOG.md) 记录改动：

```sh
npm version patch --no-git-tag-version
```

该命令只更新项目版本，不创建提交或 Git 标签。单纯测试、构建和重复部署不自动递增版本；修改版本后需重新构建、部署并刷新页面。协作规则见 [AGENTS.md](AGENTS.md)。

## 部署到 Cloudflare

推荐使用 Cloudflare Workers Builds。首次部署会自动创建或复用 D1、应用迁移并发布 Worker；访问应用后，再用部署日志中的设置码创建自己的访问密码。

1. 将仓库 Fork 到自己的 GitHub 账号。
2. 在 Cloudflare 控制台打开 `Workers & Pages > Create application > Import a repository`，授权并选择该仓库。Worker 名称需与 `wrangler.jsonc` 中的 `name` 一致，默认是 `class-roster-vault`。
3. 配置 Workers Builds：生产分支选择 `main`，根目录留空，Build command 留空，Deploy command 填 `npm run deploy`，Node.js 版本设为 `22`。
4. 创建 Cloudflare API Token 并在 Builds 中选择它。Token 需要目标账号的 `Workers Scripts: Edit`、`D1: Edit` 和账号读取权限。
5. 点击 `Save and Deploy`。首次部署成功后，在构建日志里复制“首次设置码（SETUP_TOKEN）”。
6. 打开部署日志中的 `workers.dev` 地址，输入设置码，然后自行设置名册访问密码。

`npm run deploy` 会先构建页面，再按 `wrangler.jsonc` 中的数据库名称查找或创建 D1，应用 `migrations/` 中未执行的迁移并部署 Worker。Cloudflare Builds 每次都从 GitHub 获取代码，数据库 ID 占位值可以保留在仓库中；脚本会复用账号里同名的数据库。

设置访问密码前，每次成功部署都会签发新的设置码，旧设置码随即失效，请始终使用最近一次成功部署日志中的码。设置密码后，设置码失效，后续代码部署会保留现有密码和名册数据。

Workers Builds 会在生产分支有新提交时自动部署。自定义域名可在 Cloudflare Worker 设置中绑定。若生产分支不是 `main`，在 Builds 配置中选择实际分支即可。

静态资源配置了 `assets.run_worker_first: true`，页面和 API 都经过 Worker，以应用 CSP、防嵌入等响应头；静态资源请求也会执行 Worker。

### 本地首次部署

在项目目录执行：

```sh
npm install
npx wrangler login
npm run deploy
```

首次部署成功后，终端会显示设置码。打开 Wrangler 输出的 Worker 地址并创建访问密码。脚本会把找到的 D1 数据库 ID 写入本地 `wrangler.jsonc`；该 ID 不是凭据。

## 本地运行

1. 使用 Node.js 22.13 或更新版本，安装依赖：`npm install`
2. 在 `.dev.vars` 中设置本地初始化码，例如 `SETUP_TOKEN="local-setup-code"`。
3. 运行 `npm run dev`。命令会先构建页面，再将迁移应用到本地 D1，然后启动 Wrangler。
4. 打开 Wrangler 输出的地址，输入 `local-setup-code` 并创建本地访问密码。

`.dev.vars` 不应提交到版本控制。旧版本地配置仍可使用 `ROSTER_PASSWORD="本地密码"` 登录。

前端使用构建后的 `dist/`，修改页面后需重新运行 `npm run build` 并刷新，或重启 `npm run dev`。手机访问需要 HTTPS；普通局域网 HTTP 地址无法使用浏览器加密接口，页面会明确提示。

## 验证

- `npm test`：使用 Node.js 内置测试运行器和内存 SQLite，覆盖密码初始化、加密数据往返、并发保存、旧版本兼容和请求校验，无需 Cloudflare 账号。
- `npm run build`：检查生产资源构建。
- 页面回归重点：320–430px 手机宽度下的中文输入、长姓名/班级/地址、筛选和排序文字、拨号链接、签到、编辑/删除、翻页，以及断网后保留输入和重试；结合截图检查文字实际显示，不能仅以无横向滚动判定通过。
- 页头回归重点：完整保存日期和秒、跨日/跨年/午夜及设备时区、空值/无效时间、保存中/成功/失败重试；320px 窄屏下版本、时间和锁定按钮均完整可见，切换统计或重新进入后时间一致。

## 数据与密码

- 首次访问密码由用户自行设置，不会在部署时生成；除不能为空外，不限制长度或字符组合。D1 的 `roster_auth` 表只保存 PBKDF2 派生的校验值和随机盐，不保存密码明文。
- 同一密码用于浏览器端 AES-256-GCM 加密名册数据。密码会通过 HTTPS 发给 Worker 做校验；Worker 运行时会收到密码，因此应保护 Cloudflare 账号和部署权限。
- 学生、家长、电话、地址、班级及签到状态都在加密 JSON 内。D1 另保存随机盐、随机 IV 和更新时间。
- 首次设置码是单独的一次性凭据，只用于防止他人在初始化前抢先设置密码。拥有 Cloudflare 构建日志访问权限的人可以看到它；创建密码后该码不能再次使用。
- 忘记访问密码无法恢复已有名册。当前应用不提供密码更换流程；换密码会导致已有数据无法解密。更换前需先完成数据迁移和备份。
- 升级旧部署时，`ROSTER_PASSWORD` Cloudflare Secret 仍可用于登录，不要求重置现有密码。不要在确认迁移和备份前删除或更换该 Secret。
- 每次保存会替换 D1 中的单份加密名册，建议使用 Cloudflare D1 的备份能力保留恢复点。
- 右上角显示上次成功保存的完整时间，例如 `2026/10/12 14:30:05`，按当前设备时区显示。手机端将状态和时间分为两行；保存期间显示“保存中…”，失败后保留上次成功保存的时间。无保存时间时显示“已解锁”，时间无效时显示“已保存 / 时间未知”。
- 保存会校验进入名册时取得的版本。其他页面或设备已保存时，本次写入会被拒绝，避免覆盖新数据；请保留当前输入，锁定后重新进入，再应用修改。目前不自动合并多设备修改。
- 保存期间暂停编辑、导入和锁定。失败时列表恢复到保存前，编辑表单和导入预览保留，便于修正或重试。请求超过 20 秒会结束等待；超时可能发生在服务端已保存之后，需恢复网络后重新进入确认结果。
- 当前不支持离线签到和离线保存，未保存输入只保留在当前页面内存中；刷新或关闭页面不会保留这些输入。

### 保存接口

`PUT /api/vault` 的 JSON 包含 `password`、`iv`、`ciphertext` 和 `baseUpdatedAt`。`baseUpdatedAt` 必须使用 `/api/unlock` 或上次保存返回的 `updatedAt`，首次空名册为 `null`。保存成功返回新的 `updatedAt`；版本不符返回 `409 vault_conflict`，缺少版本字段返回 `428 client_update_required`。旧页面升级后需刷新再保存，不需要数据库迁移。

请求体上限为 1,900,000 字节，Base64 密文上限为 1,800,000 字符，超限返回 `413 payload_too_large`。服务端检查实际读取的字节数，不依赖 `Content-Length`。

## Excel 导入

导入首个工作表，表头支持“学生姓名、班级、家长姓名、家长电话、地址、状态”等中文名称及常见别名。学生姓名和班级为必填列。默认按学生姓名和班级匹配，更新已有记录并追加新记录；Excel 未包含的可选列会保留原值。也可选择清空全部名册后导入，执行前会再次确认。

支持 `.xlsx`、`.xls`、`.csv`，单文件不超过 10 MB，首个工作表最多 5001 行（通常为 1 行表头和 5000 行数据，空行也计入）。超过限制需拆分文件；合并后的名册仍受保存接口容量限制。Excel 解析库仅在选择文件后加载，读取中会禁用导入按钮，重新选文件不会导入旧预览。

SheetJS 固定使用官方 CDN 发布的 0.20.3。npm 公共仓库中的 `xlsx` 停留在 0.18.5，存在 [原型污染](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) 和 [正则表达式拒绝服务](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) 公告；安装方式见 [SheetJS 官方文档](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)。CDN 只用于安装依赖，部署后的浏览器从本站按需加载解析库。

## 手机与桌面操作

桌面名册可拖动表头分隔线调整列宽，宽度保存在当前浏览器中。名册工具栏可在确认后将全体学生的签到状态重置为未签到。

手机列表显示序号、姓名、班级、家长和签到状态；点击家长电话可拨号，点击地址可展开全文。删除入口在编辑弹窗内，需要确认。列表可按班级或地址升降序，320px 窄屏下四种排序选项文字均完整显示；翻页后回到列表顶部，无匹配结果时可一键清除筛选。

搜索等待中文输入完成后再筛选，只更新结果列表，保留输入框焦点。手机输入框字号至少 16px，主要操作触控区域至少 44px；页面处理屏幕安全区域，弹窗使用动态视口高度并保留底部操作栏。
