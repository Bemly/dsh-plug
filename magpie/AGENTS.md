# magpie 插件（本目录）

本目录存放 magpie 的网关钩子插件源码（`*.hooks.js`，跑在 Bun 插件宿主）。
命名后缀决定运行时：`.hooks.*` = Bun 网关钩子（有 `node:fs`）；
`.gateway.js` / `.middleware.js` = moejs 中间件（无 fs），不要混用。

## 提交规则（强制）

**每次修改本目录下的任何文件，在 `git commit` / `git push` 之前必须先脱敏。**
本目录属于公开仓库，推上去即等于公开。脱敏自查四项：

1. **无密钥与凭据**：API key、token、密码、cookie、网关密钥、同步口令，一律不得出现。
   需要配置的值走环境变量或 magpie 自己的设置文件，不写进源码与注释。
2. **无主机专属绝对路径**：不得出现只属于某台机器的路径——用户主目录、
   飞牛卷目录、内网 IP、主机名。
   路径一律用 `import.meta.url` 相对推导或环境变量
   （参照 `plain-archive.hooks.js` 的 `MAGPIE_PLAIN_DIR`）。
3. **无测试探针与真实对话内容**：测试用的假密钥串、邮箱、姓名、项目代号、
   session id 等不得留在源码、注释或示例里。
4. **无运行期产物**：`archive/`、`*.jsonl` 等归档输出不得入库（见本目录 `.gitignore`）。

提交前跑一遍自查，命中即停、先清理再提交：

```sh
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[baprs]-|Bearer [A-Za-z0-9]|/(Users|vol[0-9])/|192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+'
```

## 部署

插件以路径方式安装：`magpie plugin add <本目录>/plain-archive.hooks.js`。
Bun 运行时只在 magpie 进程存活时下载；`plugins.json` 或插件文件变动约 1 秒内热加载。
归档落在 `MAGPIE_PLAIN_DIR`（未设时为插件旁的 `archive/`），**含密钥明文**，
不要指向任何会被共享/同步（WebDAV、S3、备份）的目录。
