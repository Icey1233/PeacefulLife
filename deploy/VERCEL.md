# 免费 Vercel 网址与现有阿里云账号服务

页面在 Vercel；`/api/*` 由 Vercel 服务端通过官方 FC 3.0 InvokeFunction API 调用北京地域的 `peaceful-life`。账号和存档仍只由原 FC 单实例写入 `peaceful-life-data/UserData/`。不将默认 `fcapp.run` 测试域名作为公开网站的生产源站；Vercel 不直接写 OSS。

## 1. 上传代码并创建 Vercel 项目

GitHub 仓库需包含当前版本的 `vercel.json`、`api/`、`server/`、`scripts/`、`package.json`、`package-lock.json`、四个游戏文件及 `.gitignore`。不上传 `.env`、`.deployment/`、`.local-data/`、`dist/` 或预览截图。

Vercel 新建项目：

| 项目项 | 值 |
| --- | --- |
| Team | 个人 Hobby |
| Project Name | `peaceful-life`，被占用时用其他小写名字 |
| Root Directory | `./` |
| Application Preset | Other |
| Build Command | `npm run build:web` |
| Output Directory | `public` |
| Install Command | `npm ci` |

这些构建设置也已写入 `vercel.json`。只有四个游戏文件进入 `public/`。第一次可以不填环境变量，先部署获得固定的项目生产网址；此时访客游戏可玩，注册暂不可用。不要用每次构建生成的临时预览地址作为 APP_ORIGIN。

## 2. 更新现有 FC 函数

本地 `npm run package:fc` 生成最新 `dist/peaceful-life-fc.zip`，新增 `/invoke` 入口只在设置了连接密钥后启用。

在本地终端运行 `openssl rand -hex 32`，生成随机的 `FC_BRIDGE_SECRET`。只保存到 FC 和 Vercel 的服务端环境变量，不提交 GitHub、不发到聊天里。

先停止游戏写入、暂停 HTTP 触发器并确认旧实例退出，再替换原 `peaceful-life` 函数的代码包并增加 `FC_BRIDGE_SECRET`。保持原有 OSS 环境变量和原 FC `APP_ORIGIN` 不变，保持弹性实例上限 1、不启用多个版本分流。更新结束再恢复访问。

FC 的 `APP_ORIGIN` 和 Vercel 的 `APP_ORIGIN` 是两个服务的设置：FC 可继续使用已有测试网址；Vercel 必须使用实际 `.vercel.app` 正式网址。连接层在验证浏览器来源后，将请求转交原账号处理程序。

## 3. 创建专门用于 Vercel 的 RAM 用户

创建 `peaceful-life-vercel` 程序用户并生成 AccessKey，绑定 `vercel-invoke-policy.json`。FC 3.0 当前 InvokeFunction 文档要求 Resource 为 `*`：该策略可以调用账号内的函数，但不允许修改函数、管理云资源或直接访问 OSS。若账号中还有其他敏感函数，需要再制定隔离方案，不能把这份策略当成单函数范围授权。

不要把原来用于 OSS 的密钥放到 Vercel。这里使用新用户的调用凭证；OSS 凭证继续仅留在 FC。

## 4. 填写 Vercel 服务端环境变量

在项目 Settings → Environment Variables 中添加，仅选择 Production，然后重新部署：

| 变量 | 值 |
| --- | --- |
| APP_ORIGIN | 实际固定生产网址，例如 `https://peaceful-life-xxx.vercel.app`，无路径、无末尾斜杠 |
| FC_ACCESS_KEY_ID | 专用调用用户的 AccessKey ID |
| FC_ACCESS_KEY_SECRET | 同一用户的 AccessKey Secret |
| FC_BRIDGE_SECRET | 第 2 步生成的相同随机字符串 |

代码固定调用 `fcv3.cn-beijing.aliyuncs.com`、函数 `peaceful-life`、版本 `LATEST`。无需填写 OSS 配置。

## 5. 验证

打开固定 Vercel 网址，确认页面直接显示；注册测试账号，保存、退出后登录、刷新后检查会话与状态；在 OSS 控制台检查新账号目录。之后用手机网络测试实际访问效果。

本地测试覆盖连接层的注册、会话、登录、退出、版本冲突、来源校验和未配置状态，使用隔离的本地存储。它不等于已完成 Vercel → FC → OSS 的真实部署验收。

Vercel Hobby 适用于个人非商业用途，受免费额度限制；阿里云 FC / OSS 原有用量费用不变。不要将 FC 默认 HTTP 测试域名改成正式生产入口。

依据：[Vercel Node.js 函数](https://vercel.com/docs/functions/runtimes/node-js)、[Vercel 配置](https://vercel.com/docs/project-configuration/vercel-json)、[FC Web 函数 API 映射](https://help.aliyun.com/zh/functioncompute/web-functions)、[FC InvokeFunction](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-invokefunction)。
