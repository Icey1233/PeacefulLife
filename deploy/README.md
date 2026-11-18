# 在阿里云北京地域部署

本项目已按你的 Bucket 配置：`peaceful-life-data`，地域 `oss-cn-beijing`，外网 Endpoint `https://oss-cn-beijing.aliyuncs.com`。`peaceful-life-data.oss-cn-beijing.aliyuncs.com` 是带 Bucket 名的访问域名；SDK 的 Endpoint 使用上面的地域地址。

目前只有本地开发验证，尚未在你的阿里云账号创建函数或写入 Bucket。下面的包与配置用于完成上线，不代表已经上线。

## 1. 准备部署包

在项目根目录执行：

```sh
npm ci
npm test
npm run package:fc
```

得到 `dist/peaceful-life-fc.zip`。包内已带官方 Node.js 22 LTS 的 Linux x64 可执行文件，并按官方 SHA256 校验；只复制程序需要的文件，不包含 `.env`、本地测试账号或截图。无需在函数计算中再安装 Node.js 或 npm。

## 2. 准备 OSS 访问权限

将 Bucket 的读写权限保持为**私有**，不要添加允许公众读取 `UserData/*` 的 Bucket Policy。程序给用户对象设置 private ACL，前端通过账号接口获取自己的存档，不直接访问 OSS。

为此后端建立专用 RAM 用户，只赋予本目录 `oss-userdata-policy.json` 的权限，范围限定在 `peaceful-life-data/UserData/*`。将这个 RAM 用户的 AccessKey ID 和 Secret 保存到函数环境变量，不放进代码、网页、部署包或聊天里。本方案使用服务端 RAM 用户凭证，暂不接入函数角色自动轮转。

## 3. 创建函数计算 Web 函数

进入阿里云函数计算 FC 控制台，选择**华北 2（北京）**，新建 Web 函数（函数名可用 `peaceful-life`），上传 ZIP 包。设置：

| 配置 | 值 |
| --- | --- |
| 运行时 | 自定义运行时 `custom.debian12` |
| CPU 架构 | x86_64 |
| 启动命令 | `/code/runtime/bin/node` |
| 启动参数 | `/code/server/index.mjs` |
| 监听端口 | `9000` |
| 内存 | `512 MB` |
| CPU | `0.5 vCPU` |
| 超时 | `60 秒` |
| 允许访问公网 | 开启（后端访问 OSS） |
| 单实例并发 | `16` |
| 函数弹性实例配额 / 实例数上限 | **`1`** |
| 最小实例数 | `0`，不要求常驻实例 |

**这一版必须只有一个后端实例、一个 Node 进程。** 每账号的写入队列和版本检查在该进程内执行；OSS PutObject 不支持 If-Match 条件覆盖。不要同时部署第二个可写后端、设置多实例或做灰度流量分流。更新版本时先停写 / 暂停触发器，更新完成并确认旧实例退出后再开放访问。未来需要多实例时，应先接入数据库或共享的分布式锁。

创建 HTTP 触发器，允许 `GET, HEAD, POST, PUT`，认证方式为无需 FC 身份认证；游戏内部会校验账号和登录会话。全站页面和 `/api/*` 使用同一个函数和域名，不需要为用户数据配置 OSS CORS。

## 4. 配置环境变量和网址

先创建触发器获得 HTTPS 访问域名，再配置 `APP_ORIGIN`。如果当前默认域名会强制下载 HTML，请在 FC 中绑定自己的 HTTPS 网站域名。不要把 OSS 对象域名当作后端网址。

| 环境变量 | 值 |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | `9000` |
| `APP_ORIGIN` | 实际打开游戏的网址的 Origin，例如 `https://life.example.com`，不带路径 |
| `OSS_BUCKET` | `peaceful-life-data` |
| `OSS_REGION` | `oss-cn-beijing` |
| `OSS_ENDPOINT` | `https://oss-cn-beijing.aliyuncs.com` |
| `OSS_ACCESS_KEY_ID` | 专用 RAM 用户的 AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | 专用 RAM 用户的 AccessKey Secret |

生产模式缺少 OSS 凭证或 `APP_ORIGIN` 不是 HTTPS 时，程序会拒绝启动，避免误用本地存储。第一次创建函数时可以先配置好启动设置和触发器，在填齐环境变量后启动/更新函数。日志不会打印密码、Cookie 或完整 OSS 签名请求。

如果使用 Serverless Devs CLI，可以参考同目录 `s.yaml.example`。先完成本地打包，并在 CLI 环境配置 `APP_ORIGIN`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 以及阿里云部署凭证，再从项目根目录执行模板顶部的命令。模板不会帮你创建 Bucket、RAM 用户或域名。

## 5. 上线验收

### 没有域名时，在本机连接云端测试

FC 默认测试域名会强制下载 HTML，下载的单个文件缺少脚本，不能用于注册。尚未绑定域名时，在项目根目录运行 `npm run preview:cloud`，用 Chrome 打开 `http://localhost:5175`（使用 localhost，不要替换成 IP）。本机入口只监听 127.0.0.1，移除测试域名响应中的下载标记，页面、注册、登录和存档均转发给现有 FC 函数；不会启动第二个存档后端，也不需要本机保存 AccessKey。

此方式仅供本机联调，进程需保持运行；其他设备不能访问。云端 `APP_ORIGIN` 继续使用 FC 测试域名。公开上线仍需配置正式 HTTPS 网站入口。`npm run dev` 是另一套本地账号开发模式，不要与这个云端联调入口混淆。

1. 打开实际游戏 HTTPS 网址，进入「登录 / 注册」，注册一个验收账号。
2. 在 OSS 控制台确认自动出现 `UserData/账号名/user.json` 和 `sessions/`；不需要手动创建文件夹。
3. 切换人物活动，点击「立即保存」，确认页面显示「已保存到云端」。
4. 退出后重新登录，确认进度恢复；用另一个浏览器登录同账号，检查读取的进度一致。
5. 注册另一个账号，确认两者目录和进度独立。未登录时 `/api/save` 应返回 401。
6. 在两个浏览器修改同账号的进度，检查出现存档选择，较旧存档不会直接覆盖新存档。

账号目录结构：

```text
peaceful-life-data/
└── UserData/
    ├── alice/
    │   ├── user.json       # 账号资料、加盐密码哈希、游戏状态和版本
    │   └── sessions/
    │       └── <会话令牌的SHA256>.json
    └── bob/
        ├── user.json
        └── sessions/
```

`user.json` 中不保存明文密码，也不会作为公开 URL 提供给浏览器。账号名限定为 3–24 位字母、数字或下划线，并统一为小写；密码为 10–128 字符。暂不提供找回密码、邮箱验证或后台管理。

官方配置依据：[FC 自定义运行时](https://help.aliyun.com/zh/functioncompute/custom-runtime/)、[函数实例数上限](https://help.aliyun.com/zh/functioncompute/overview-of-configuring-the-maximum-number-of-on-demand-instances)、[Serverless Devs FC3 配置](https://docs.serverless-devs.com/user-guide/aliyun/fc3/spec/)、[OSS PutObject](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)、[OSS 不支持 PutObject 条件请求](https://www.alibabacloud.com/help/en/oss/user-guide/0017-00000245)。
