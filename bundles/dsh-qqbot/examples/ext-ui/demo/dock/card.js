/* 扩展示例 · dock 卡片逻辑
   dock 卡片的 getConfig()/setConfig() 默认走 **数据根**（每实例一份）；
   另外能用 qqbotExt.dock.* 读当前实例 / 会话的真实数据 —— 这是 dock 独有的。 */
(function () {
  var $ = function (id) { return shadowRoot.getElementById(id) };
  var dot = $('dot');
  var t2 = $('t2');
  var st2 = $('st2');
  var info = $('info');

  function show(ok, msg) {
    if (st2) { st2.textContent = msg; st2.style.color = ok ? '#2f9e44' : '#c33' }
    if (dot) dot.className = 'dot ' + (ok ? 'on' : 'err')
  }
  function setInfo(o) {
    if (!info) return
    try { info.textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2) } catch (e) { info.textContent = String(o) }
  }

  // ── 子标签切换 ──────────────────────────────────────────
  shadowRoot.querySelectorAll('.subtabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var p = btn.getAttribute('data-p')
      shadowRoot.querySelectorAll('.subtabs button').forEach(function (b) { b.className = (b === btn ? 'on' : '') })
      shadowRoot.querySelectorAll('.pane').forEach(function (el) {
        el.className = 'pane' + (el.getAttribute('data-pane') === p ? ' on' : '')
      })
    })
  })

  // ── 子标签 1：文本2（数据根级） ─────────────────────────
  function load2() {
    show(true, '读取中…')
    qqbotExt.getConfig().then(function (c) {
      if (t2) t2.value = c.text2 || ''
      show(true, c.text2 ? ('当前：' + c.text2) : '还没设置')
    })
  }
  var save2 = $('save2');
  if (save2) {
    save2.addEventListener('click', function () {
      save2.disabled = true
      qqbotExt.setConfig({ text2: t2 ? t2.value : '' }).then(function (r) {
        save2.disabled = false
        if (r && r.ok) show(true, '已保存到本实例：' + ((r.config && r.config.text2) || ''))
        else show(false, '保存失败：' + ((r && r.reason) || '未知'))
      }).catch(function () { save2.disabled = false; show(false, '保存异常') })
    })
  }
  var reload2 = $('reload2');
  if (reload2) reload2.addEventListener('click', load2)

  // ── 子标签 2：dock 独有能力 ─────────────────────────────
  var ctxBtn = $('ctxBtn');
  if (ctxBtn) {
    ctxBtn.addEventListener('click', function () {
      if (!qqbotExt.dock) return setInfo('这个卡片没有 dock 上下文（不是 dock 源？）')
      setInfo('读取中…')
      qqbotExt.dock.context().then(function (r) { setInfo(r || '(空)') })
    })
  }
  var hisBtn = $('hisBtn');
  if (hisBtn) {
    hisBtn.addEventListener('click', function () {
      if (!qqbotExt.dock) return setInfo('这个卡片没有 dock 上下文')
      setInfo('读取中…')
      // ★ 2026-10-27（主人要求）：读 **AI 最后一个正文块**，不是 QQ 消息流水。
      //   实现抄 session_watch_lib.mjs 的 lastAssistantText()：
      //   宿主 kernel.get('sessions').get(sid).deriveMessages() 从后往前找 assistant。
      qqbotExt.dock.lastAssistantText().then(function (r) {
        if (!r) return setInfo('没有响应')
        if (!r.ok) return setInfo('读不到：' + (r.reason || r.via || '未知') + (r.sid ? ('\nsid=' + r.sid) : ''))
        setInfo('（AI 最后一段正文，' + r.text.length + ' 字符）\n\n' + r.text)
      })
    })
  }

  // ── 子标签 3：自有存储（走 hooks 注册的 /store 路由）─────────────
  var storeInfo = $('storeInfo');
  var sk = $('sk');
  var sv = $('sv');
  function setStoreInfo(o) {
    if (!storeInfo) return
    try { storeInfo.textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2) } catch (e) { storeInfo.textContent = String(o) }
  }
  function loadStore() {
    setStoreInfo('读取中…')
    qqbotExt.api('/store').then(function (r) {
      if (!r) return setStoreInfo('没有响应（hooks 里的 demo-store.mjs 没跑？）')
      if (!r.ok) return setStoreInfo('失败：' + (r.reason || '未知'))
      setStoreInfo('存储文件：' + (r.file || '?') + '\n\n' + JSON.stringify(r.data || {}, null, 2))
    })
  }
  var storeLoad = $('storeLoad');
  if (storeLoad) storeLoad.addEventListener('click', loadStore)
  var storeSave = $('storeSave');
  if (storeSave) {
    storeSave.addEventListener('click', function () {
      var key = (sk && sk.value ? sk.value : 'note').trim() || 'note'
      var val = sv ? sv.value : ''
      var patch = {}
      patch[key] = val
      storeSave.disabled = true
      qqbotExt.api('/store', { method: 'POST', body: JSON.stringify(patch) }).then(function (r) {
        storeSave.disabled = false
        if (!r) return setStoreInfo('没有响应')
        if (!r.ok) return setStoreInfo('失败：' + (r.reason || '未知'))
        setStoreInfo('已写入 ' + key + ' = ' + val + '\n\n' + JSON.stringify(r.data || {}, null, 2))
      }).catch(function () { storeSave.disabled = false; setStoreInfo('请求异常') })
    })
  }

  // ── 子标签 4：静默注入（appendSilent，不唤醒 AI）──────────────
  var silentInfo = $('silentInfo');
  var silentText = $('silentText');
  function setSilent(o) {
    if (!silentInfo) return
    try { silentInfo.textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2) } catch (e) { silentInfo.textContent = String(o) }
  }
  var silentBtn = $('silentBtn');
  if (silentBtn) {
    silentBtn.addEventListener('click', function () {
      var t = silentText && silentText.value ? silentText.value.trim() : ''
      if (!t) return setSilent('先填要注入的文本')
      if (!qqbotExt.dock || !qqbotExt.dock.peer) {
        return setSilent('当前没选中会话 —— 先在「聊天」里选一个目标')
      }
      silentBtn.disabled = true
      // appendSilent 需要会话的 agent，后端会按 peer 去找
      Promise.resolve(qqbotExt.cap('appendSilent', t)).then(function (r) {
        silentBtn.disabled = false
        setSilent(r === true
          ? ('已静默注入（AI 不会立刻回复，下轮才看到）：' + t)
          : ('没注入成功：' + JSON.stringify(r)))
      }).catch(function (e) { silentBtn.disabled = false; setSilent('异常: ' + e) })
    })
  }

  // ── 子标签 5：读写任意文本文件（fs.read / fs.write）────────────
  var filePath = $('filePath');
  var fileText = $('fileText');
  var fileInfo = $('fileInfo');
  function setFileInfo(o) {
    if (!fileInfo) return
    try { fileInfo.textContent = typeof o === 'string' ? o : JSON.stringify(o, null, 2) } catch (e) { fileInfo.textContent = String(o) }
  }
  // ── 文件选择器（2026-10-27 主人要求）──
  //   Electron（DSH 桌面版）的 File 对象上有 **path** 属性 → 能直接拿到真实路径，
  //   填进输入框后就能走 fs.read / fs.write（可改可存）。
  //   纯浏览器（web 版）出于安全拿不到路径，只能读内容做预览；
  //   这种情况退回"预览模式"：显示内容 + 提示去桌面版改。
  var filePick = $('filePick');
  var fileInput = $('fileInput');
  if (filePick && fileInput) {
    filePick.addEventListener('click', function () { fileInput.click() })
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]
      if (!f) return
      // Electron 专有属性；浏览器里是 undefined
      var realPath = (typeof f.path === 'string' && f.path) || ''
      if (realPath) {
        if (filePath) filePath.value = realPath
        setFileInfo('已选中：' + realPath + '，正在读取…')
        if (fileRead) fileRead.click()
      } else {
        // 浏览器：拿不到路径，只能预览内容
        var rd = new FileReader()
        rd.onload = function () {
          if (fileText) fileText.value = String(rd.result || '')
          setFileInfo('已读取内容（浏览器拿不到真实路径，只能预览）\n文件名：' + f.name + '\n如果要修改并保存，请用桌面版，或手动把完整路径填进上面的输入框。')
        }
        rd.readAsText(f)
      }
      try { fileInput.value = '' } catch (e) { /* 允许重复选同一个 */ }
    })
  }

  // ── 系统选择器（File System Access API，2026-10-27）─────────────
  //   纯浏览器（Edge/Chrome 113+，localhost 算安全上下文）能弹**系统对话框**，
  //   返回的是 FileSystemFileHandle —— **没有路径字符串**（浏览器安全模型就不给），
  //   但 handle 本身可以直接读、直接写：
  //     getFile().text()       读
  //     createWritable().write() 写（用户授权过这个 handle）
  //   所以这条路根本不需要路径，比填路径还省事，而且不会写错位置。
  var filePicker2 = $('filePicker2');
  var _pickedHandle = null;
  if (filePicker2) {
    filePicker2.addEventListener('click', function () {
      if (typeof window.showOpenFilePicker !== 'function') {
        return setFileInfo('这个浏览器不支持 File System Access API（需要 Edge/Chrome 113+，且是 localhost 或 https）')
      }
      window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: '文本文件',
          accept: { 'text/plain': ['.txt', '.md', '.json', '.log', '.yml', '.yaml', '.csv', '.ini', '.conf', '.js', '.ts', '.html', '.css'] },
        }],
      }).then(function (handles) {
        var h = handles && handles[0]
        if (!h) return
        _pickedHandle = h
        if (filePath) filePath.value = '(系统选择器) ' + h.name   // 只有名字，没有路径
        return h.getFile().then(function (f) {
          if (f.size > 2 * 1024 * 1024) return setFileInfo('文件太大（>2MB）')
          return f.text().then(function (txt) {
            if (fileText) fileText.value = txt
            setFileInfo('已通过系统选择器打开：' + h.name + '（' + f.size + ' 字节）\n现在点「保存修改」会直接写回这个文件（handle 已授权，不需要路径）。')
          })
        })
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return setFileInfo('已取消选择')
        setFileInfo('选择失败：' + (e && e.message ? e.message : e))
      })
    })
  }

  var fileRead = $('fileRead');
  if (fileRead) {
    fileRead.addEventListener('click', function () {
      var p = filePath && filePath.value ? filePath.value.trim() : ''
      if (!p) return setFileInfo('先填文件路径')
      setFileInfo('读取中…')
      qqbotExt.cap('fs.read', p).then(function (r) {
        if (!r) return setFileInfo('没有响应（后端白名单里没有 fs.read？）')
        if (!r.ok) return setFileInfo('读取失败：' + (r.reason || '未知'))
        if (fileText) fileText.value = r.text || ''
        setFileInfo('已读取：' + r.path + '（' + r.size + ' 字节）')
      }).catch(function (e) { setFileInfo('异常: ' + e) })
    })
  }
  var fileSave = $('fileSave');
  if (fileSave) {
    fileSave.addEventListener('click', function () {
      var t = fileText ? fileText.value : ''
      // ★ 优先用系统选择器拿到的 handle：直接写回原文件，不需要路径
      if (_pickedHandle && typeof _pickedHandle.createWritable === 'function') {
        fileSave.disabled = true
        _pickedHandle.createWritable().then(function (w) {
          return w.write(t).then(function () { return w.close() })
        }).then(function () {
          fileSave.disabled = false
          setFileInfo('已写回：' + _pickedHandle.name + '（' + t.length + ' 字符，通过系统选择器授权）')
        }).catch(function (e) {
          fileSave.disabled = false
          setFileInfo('写回失败：' + (e && e.message ? e.message : e))
        })
        return
      }
      var p = filePath && filePath.value ? filePath.value.trim() : ''
      if (!p) return setFileInfo('先填文件路径，或用「系统选择器」选一个')
      fileSave.disabled = true
      qqbotExt.cap('fs.write', p, t).then(function (r) {
        fileSave.disabled = false
        if (!r) return setFileInfo('没有响应')
        if (!r.ok) return setFileInfo('保存失败：' + (r.reason || '未知'))
        setFileInfo('已保存：' + r.path + '（' + r.size + ' 字节）\n原文件已备份为 *.bak-时间戳')
      }).catch(function (e) { fileSave.disabled = false; setFileInfo('异常: ' + e) })
    })
  }

  load2()
})();
