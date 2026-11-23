# 扩展 UI 卡片（ext-ui）

给扩展一个**声明式 UI 入口** —— 不用改主包任何文件，就能往面板上加自己的卡片。

> 起因：以前扩展想加界面，只能按字符串锚点往 `client/qqbot-settings.js`（535KB 手写 bundle）
> 里塞代码。版本一换锚点就失效，而且只对写补丁的那台机器有效。

---

## 放哪儿

任选其一（同名时**数据根优先**）：

```
{dataRoot}/.qqbot-extensions/ui/<extId>/card.html
{dataRoot}/extension-packs/<包名>/ui/<extId>/card.html
```

`<extId>` 只能用 `[A-Za-z0-9_-]`，最长 64，且必须有 `card.html` 才会被扫到。

三个文件（后两个可选）：

```
card.html   结构（必填，元信息写在这个文件的头部注释里）
card.css    样式（可选，自动加进 Shadow DOM）
card.js     逻辑（可选，ESM 风格的 IIFE 更稳）
```

---

## 元信息

`card.html` 的**前 2KB 内**放：

```html
<!-- qqbot-ui: { "slot": "settings", "title": "本地代答", "order": 10 } -->
```

| 字段 | 说明 |
|---|---|
| `slot` | `settings`（设置页底部卡片条）或 `dock`（悬浮台页签）。缺省 `settings` |
| `title` | 卡片/页签标题。缺省用目录名 |
| `order` | 排序，小的靠前。缺省 100 |

---

## 运行环境

`card.js` 以 `new Function('qqbotExt', 'shadowRoot', 源码)` 执行，两个变量直接可用：

```js
qqbotExt.extId            自己的 id
qqbotExt.api(path, opts)  调 /api/ext/<extId>/… （扩展自己注册的路由）
qqbotExt.toast(msg)       轻提示
shadowRoot                本卡片的 ShadowRoot
```

**注意事项**：

- 用 `shadowRoot.getElementById()`，**不要**用 `document.getElementById()` —— 那查到的是外面页面。
- 脚本抛错只让这张卡显示一行红字，不会影响设置页本体（外面套了 try/catch）。
- CSS 完全隔离：你写 `button{...}` 碰不到面板，面板的样式也进不来。

---

## 横向滑动

卡片条本身就是横向可滑的（`overflow-x:auto` + `scroll-snap` + 手机惯性滚动）。
单卡默认宽 `220~320px`，挂多少张都不会挤爆布局。

想控制宽度，在 `card.css` 里改 `:host`：

```css
:host { width: 300px; }   /* 固定宽；不给就跟随面板的 min/max */
```

---

## 最小可用示例

本目录就是 —— `local-llm/` 三个文件抄过去改改就能跑。

测试（不用重启宿主，直接跑扫描器）：

```bash
node -e 'import("./dist/features/ext-ui.js").then(m=>console.log(m.listExtUi("你的数据根")))'
```

---

## 相关

- 扫描与安全校验：`src/features/ext-ui.ts`
- 后端路由：`settings-host.js` 的 `/api/qqbot-settings/ext-ui/list` 与 `/ext-ui/file`
- 设计稿：`参考文档/扩展UI挂载点_设计稿_20261026.md`
