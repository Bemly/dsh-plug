# magpie 插件（本目录）

本目录存放 magpie 的网关钩子插件源码，与 npm 包 `magpie-unsafe-archive` 同源。

## 命名与运行时（改之前先读）

后缀决定 magpie 用哪个运行时加载，**不能混**：

| 后缀 / 字段 | 运行时 | 能否落盘 |
| --- | --- | --- |
| `*.hooks.{js,mjs,ts,mts}`、`magpie.hooks` | Bun 插件宿主 | 能（完整 `node:fs`） |
| `*.gateway.js`、`*.middleware.js`、`magpie.middleware`/`magpie.gateway` | moejs | **不能**（只有 `console`） |

本插件走 `.hooks.js` 这条路，因为它需要 `node:fs`。

## magpie 读哪些字段（缺了就不显示或装不上）

`package.json` 里这些字段各有用途，改动时不要漏：

- `magpie.hooks` —— **入口**，缺了插件根本不被识别为钩子。
- `description` —— npm 与包管理页的描述。
- `magpie.summary` `{en, zh, …}` —— Discover → Unofficial 卡片上那行话，
  按语言取，每种语言最多 300 字节，只写一行。
- `magpie.icon` —— 卡片和「已安装」行的图标。**必须是图片直链**
  （`https://` 或 `data:image/…`，最大 1 MB）。
  GitHub 的 `blob/` 页面地址不是图片，要用 `raw.githubusercontent.com`。
- `magpie.options` —— 选项编辑器的示例值；实际值来自 `plugins.json` 的
  `options`，所以代码里必须自带默认值。
- `files` —— npm 打包白名单。**运行期归档产物绝不能进这个列表**，
  也不要出现在 tarball 里。

## 提交规则（强制）

**每次修改本目录下的任何文件，在 `git commit` / `git push` 之前必须先脱敏。**
本目录属于公开仓库，推上去即等于公开。脱敏自查四项：

1. **无密钥与凭据**：API key、token、密码、cookie、网关密钥、同步口令，一律不得出现。
   需要配置的值走环境变量或 magpie 的插件选项，不写进源码与注释。
2. **无主机专属绝对路径**：不得出现只属于某台机器的路径——用户主目录、
   飞牛卷目录、内网 IP、主机名。路径一律用 `import.meta.url` 相对推导、
   `os.homedir()` 或插件选项/环境变量。
3. **无测试探针与真实对话内容**：测试用的假密钥串、邮箱、姓名、项目代号、
   session id 等不得留在源码、注释或示例里。
4. **无运行期产物**：`archive/`、`*.jsonl`、`*.tgz` 不得入库（见 `.gitignore`）。

提交前跑一遍自查，命中即停、先清理再提交：

```sh
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-|Bearer [A-Za-z0-9]|/(Users|vol[0-9])/|192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+'
```

发布前额外一步：`npm pack` 后解开 tarball，对**包内文件**再跑一遍同样的自查。
`.github/workflows/publish-magpie-unsafe-archive.yml` 里已经把这两步写成 CI 门禁，
本地漏了也会在 CI 上被拒。

## 发布

走 npm 可信发布（GitHub Actions OIDC），**仓库里没有 npm token**：

```
npm version 0.1.1 --no-git-tag-version      # 在 magpie/ 里改版本
git commit -am 'magpie: 0.1.1 …' && git push
git tag magpie-unsafe-archive-v0.1.1 && git push --tags
```

推 `magpie-unsafe-archive-v*` 标签即触发发布。npm 侧的放行规则绑定
「包名 + 仓库 `Bemly/dsh-plug` + workflow 文件名」，**改 workflow 文件名必须
同步去 npm 改 trusted publisher**，否则 CI 会 403。

首发（0.1.0，2026-11-23 已发）踩到的三条 npm 规矩，记下来免得再撞：

1. **trusted publisher 只能绑已存在的包**，所以第一个版本必须由人带一次
   交互式认证发出去（2FA + OTP，或勾了 bypass 的 granular token）。
2. **CLI 网页登录的 token 发不了包**：`npm publish` 会 403 要 2FA 或
   bypass token。
3. **`npm trust` 命令要求账号开了 2FA**（没开会 403），所以可信发布者
   只能在 npm 网页上配：包 → Settings → Trusted publishing → GitHub Actions，
   `Organization or user` / `Repository` / `Workflow filename`（只填文件名，
   带 `.yml`）/ Environment 留空，并把 **allow `npm publish`** 勾上——
   2026-09-03 之后新建的 trust 默认只允许 `npm stage publish`。
4. 新建包发布后，`latest` 会先指向占位版本 `0.0.0-stage`（"Temporary package
   placeholder for staged publishing"），几十秒后才切到真实版本；别看到
   `0.0.0-stage` 就以为发失败了。

发布出去的版本会自动到达 npm 安装的用户：magpie 的插件更新循环会拉新版。
所以发之前想清楚，**没有"撤回已发布版本"这种安全操作**——`npm unpublish`
是删除，与本插件"永不删除"的红线相反，不要用。

## 谁能发这个包

访问权挂在 npm 组织的 team 上，不是靠一个个邀请协作者：
头像 → Account → Organizations → 组织 → **Teams** → `developers`（组织默认
team，成员自动进）→ **Packages** → 输入包名 → **Add Existing Package** →
选 Read and write。公开 unscoped 包同样能这么归组织管，别以为它只能属于一个
用户。

改这些**只能在网页上做**：CLI 三条路都实测被拒——网页登录的 session token
403（要 2FA）、勾了 bypass 的 granular token 在 `GET /-/user/…` 上 401（账号
类操作不再接受它）、`npm trust` 在没有账号 2FA 时 403。所以别在 CLI 上反复
试权限，直接告诉用户去点哪。

## 设计红线：不得引入删除

本插件是**审计留痕**，归档只追加。任何轮转、保留期、总量上限、"清理旧文件"
之类的想法都不要加——删一条就少一条，而且按天整删在单日体量超过上限时
会把当天全部记录删光。磁盘不够是运维问题，交给用户自己监控与加密备份。

## 写 plugins.json 的习惯

magpie 自己会重写 `plugins.json`（插件更新循环等）。手工改它时：

1. 用「写临时文件 + rename」，不要 truncate + 原地重写——非原子写遇到中断
   会留下半截文件，magpie 只能从 `.bak` 恢复，之后的改动就丢了。
2. **rename 会换 inode，所以临时文件的属主和权限必须和目标文件一致**。
   用 root 写临时文件再 rename，会把 magpie 自己的配置文件变成 root 所有，
   magpie 用户读不到插件表（CLI 会报 "No plugins"），运行中的进程靠内存里的
   旧列表撑着，一旦重启就全丢。正确做法：以目标文件的属主身份写
   （例如 `sudo -u magpie …`），或写完立刻 `chown --reference` 回原归属。
3. 只改 `plugins.json` 不会让 Bun 插件宿主重载钩子——那需要 CLI 或界面触发。
   换插件路径后要发一条探针请求，确认写入落在新目录、旧目录 mtime 不再变化。
