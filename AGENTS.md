# dsh-plug（仓库根）

公开仓库，推上去即等于公开。本文件管**跨目录通用**的规矩；某个插件自己的
约定写在它目录下的 `AGENTS.md`（目前：`magpie/AGENTS.md` —— 脱敏自查清单、
"归档永不删除"红线、发版流程）。

## 提交前脱敏（全仓库适用）

任何提交/推送前跑一遍，命中即停、先清理再提交：

```sh
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-|Bearer [A-Za-z0-9]|/(Users|vol[0-9])/|192\.168\.|@appdata'
```

这条会命中它自己那一行（正则字面量），属预期；判据是**除这行以外没有别的命中**。
要更干净的判据，把加号开头的行拿出来、去掉本条命令再匹配一遍。

四类不得入库：凭据（API key、token、密码、cookie、sudo 口令）、只属于某台
机器的绝对路径与内网地址、测试探针用的假密钥/邮箱/姓名/session id、运行期
产物（归档、`*.jsonl`、`*.tgz`）。

## npm 发布与权限

**谁能发一个包，有两条彼此独立的通道，收紧权限时两条都要看**：

1. **npm 侧**：访问权挂在 npm 组织的 team 上，不是一个个邀请协作者。
   入口：头像 → Account → Organizations → 组织 → **Teams** → `developers`
   （组织默认 team，新成员自动进）→ **Packages** → 输入包名 →
   **Add Existing Package** → 选 Read and write。
   **公开的 unscoped 包同样能这么归组织管**——别以为它只能属于一个用户。
   生效后 `npm owner ls <pkg>` 会同时列出个人与组织侧账号，
   `GET /-/org/<org>/package` 返回包名到角色的映射。
2. **CI 侧**：包的 trusted publisher 绑定「GitHub 仓库 + workflow 文件名」。
   于是**任何能往本仓库推发版标签的人，都能借 CI 发包**，与 npm 团队权限无关。
   要收口就得同时管仓库的写权限和 npm 的 team 权限。

改权限**只能在网页上做**，CLI 三条路实测都被拒：网页登录的 session token
→ 403（要 2FA）；勾了 bypass 2FA 的 granular token → 在
`GET /-/user/org.couchdb.user:<name>` 上 401（账号类操作已不接受这类 token）；
`npm trust` → 账号没开 2FA 时 403。别在 CLI 上反复试，直接说明要点哪。

其余 npm 规矩（首版不能用 trusted publishing、GAT 要勾 bypass、新 trust 默认
只允许 `npm stage publish`、新包发布后 `latest` 会短暂指向 `0.0.0-stage`）
写在 `magpie/AGENTS.md`，对其他包同样适用。

## 已发布版本不可撤回

`npm unpublish` 是删除。留痕类插件（`magpie/`）明确不许有删除行为，发版前
想清楚；文档改动可以攒着随下一次真实改动一起出版本，不必逐笔发。
