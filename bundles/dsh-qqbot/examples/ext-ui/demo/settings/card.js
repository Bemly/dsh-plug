/* 扩展示例 · 设置页卡片逻辑
 *
 * ★ 核心演示（2026-10-27 主人要求）：**一张全局 UI，两种作用域**
 *   · profile 级 → 所有机器人共用（getConfig() / setConfig(p)）
 *   · data 级    → 只改上面账号下拉框选中的那个（getConfig('data') / setConfig(p,'data')）
 *   卡片自己不用知道路径，qqbotExt.acct 里就有当前选中的账号。
 */
(function () {
  var $ = function (id) { return shadowRoot.getElementById(id) };
  var t1 = $('t1');
  var st = $('st');
  var dot = $('dot');
  var acctName = $('acctName');
  var fieldLbl = $('fieldLbl');
  var scopeHint = $('scopeHint');

  var acct = qqbotExt.acct || null;
  var scope = 'profile';   // profile | data

  function show(ok, msg) {
    if (st) { st.textContent = msg; st.style.color = ok ? '#2f9e44' : '#c33' }
    if (dot) dot.className = 'dot ' + (ok ? 'on' : 'err')
  }

  // 显示当前选中的账号名（没账号时提示去「账号与预设」加）
  if (acctName) acctName.textContent = acct && acct.ns ? acct.ns : '（还没选账号）'
  var hasAcct = !!(acct && acct.ns)

  function syncLabels() {
    var isData = scope === 'data'
    if (fieldLbl) fieldLbl.textContent = isData ? ('文本1（账号：' + (acct.ns || '?') + '）') : '文本1（全局）'
    if (scopeHint) {
      scopeHint.textContent = isData
        ? '只影响「' + (acct.ns || '?') + '」这个机器人；改完去群里敲 /扩展示例 看效果。'
        : '改动影响所有机器人；改完去群里敲 /扩展示例 看效果。'
    }
  }

  function load() {
    show(true, '读取中…')
    // 第二参数不传 = 用卡片上下文里的当前账号
    qqbotExt.getConfig(scope).then(function (c) {
      if (t1) t1.value = c.text1 || ''
      var where = scope === 'data' ? ('账号 ' + (acct.ns || '?')) : '全局'
      show(true, (c.text1 ? ('当前（' + where + '）：' + c.text1) : ('当前（' + where + '）：还没设置')))
    })
  }

  // ── 作用域切换 ──────────────────────────────────────────
  shadowRoot.querySelectorAll('input[name="dscope"]').forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return
      if (r.value === 'data' && !hasAcct) {
        show(false, '上面还没选账号 —— 先去「账号与预设」加一个')
        var p = shadowRoot.querySelector('input[name="dscope"][value="profile"]')
        if (p) p.checked = true
        return
      }
      scope = r.value
      syncLabels()
      load()
    })
  })

  // ── 保存 / 重读 ─────────────────────────────────────────
  var save = $('save');
  if (save) {
    save.addEventListener('click', function () {
      if (scope === 'data' && !hasAcct) return show(false, '没有可写的账号')
      save.disabled = true
      qqbotExt.setConfig({ text1: t1 ? t1.value : '' }, scope).then(function (r) {
        save.disabled = false
        if (r && r.ok) {
          var where = scope === 'data' ? ('账号 ' + (acct.ns || '?')) : '全局'
          show(true, '已保存到' + where + '：' + ((r.config && r.config.text1) || ''))
        } else {
          show(false, '保存失败：' + ((r && r.reason) || '未知'))
        }
      }).catch(function () { save.disabled = false; show(false, '保存异常') })
    })
  }
  var re = $('load');
  if (re) re.addEventListener('click', load)

  syncLabels()
  load()
})();
