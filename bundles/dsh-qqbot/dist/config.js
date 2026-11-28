/**
 * dsh-im-qqbot 插件配置 Schema
 *
 * 配置入口: profile 的 cordis.patch.yml → im-qqbot config(改动热重载, 无需重启)。
 * Web 可视化设置: 注册 im-qqbot settings 命名空间(可编辑项 = EditableConfigSchema:
 * behavior / sticker.gates / injectRules), 用户层存 ~/.dsh/settings.yaml, live 生效。
 * ⚠️ 本地手改功能(配置化改造, 2026-09-03)。
 */
import Schema from '@deepseek-ai/schemastery';
/**
 * 数学公式 / 彩色字提示（2026-11-20 主人要，配置项 `latexHint` 控制，默认关）。
 *
 * **内容固定**，所以跟群守则同频、共用同一套去重（拼进 rules，指纹自然跟着变）。
 * 只有清空上下文 / 开关切换时才重注 —— 不是小传那种"每轮都可能变"的东西。
 */
export const LATEX_HINT_BLOCK = [
    '【LaTeX】QQ 支持 LaTeX 渲染，需要的时候可以这样写：',
    '- 行内公式：$E=mc^2$（跟正文排在一起，不另起一行）',
    '- 独占行居中：$$\\frac{a}{b}$$',
    '- 彩色字：$\\textcolor{#E74C3C}{\\text{重点}}$',
    '只在写公式、列关键数据、需要视觉强调时用；日常闲聊别用。',
    '有些客户端（旧版 QQ）不渲染，会把它显示成源码。',
].join('\n');
// ── 共享字段子 schema(主 ConfigSchema 与 EditableConfigSchema 复用) ──
/** 智能回复: 复用 conan RAG 的 OVMS 语义服务; OVMS 故障时本次跳过，不做本地兜底 */
const localModelSchema = Schema.object({
    enabled: Schema.boolean().default(true).description('智能回复(省 token): 开=用 conan RAG/OVMS 做价值评分与语义检索; OVMS 故障时跳过'),
    // ★ 2026-11-26: conanRag 服务挂在预设子作用域, 根作用域取不到 ⇒ 支持直接打 OVMS HTTP。
    //   留空 = 内置默认(本机 8765 的 conan-embedding-v1), 与 dsh-chat-loli 的 RAG 配置同源。
    ovmsEndpoint: Schema.string().default('').description('OVMS 嵌入端点(留空=默认 http://127.0.0.1:8765/v3/embeddings); conanRag 服务不可用时按此直连'),
    ovmsModel: Schema.string().default('').description('OVMS 嵌入模型名(留空=默认 conan-embedding-v1)'),
    ovmsTimeoutMs: Schema.number().default(15000).description('单次嵌入请求超时(毫秒, 默认 15000): 超时只跳过本次语义判定, 不拦消息'),
    valueGate: Schema.union(['off', 'log', 'block']).default('log').description('价值评分模式(账号默认): off=不评分 / log=只记录分数 / block=低分不唤醒AI(消息仍进上下文)'),
    valueMinScore: Schema.number().min(0).max(1).default(0.5).description('价值评分门槛(0~1, 越高越安静): 近邻相似度低于此值视为不值得回应'),
    // 附件唤醒开关（2026-09-15 主人："视频和文件不算是图片，为什么也默认唤醒了"）
    //   ⚠️ 必须在这里声明 —— settings 走 Schema 校验，**未声明的字段会被直接丢掉**，
    //      表现就是"面板勾了保存、重载又跳回默认"（跟上次漏返回 valueGate 是同一类坑）。
    attachmentPassthrough: Schema.object({
        image: Schema.boolean().default(true).description('图片: 勾上=无视分数直接唤醒(默认开, 群友发图常是给她看的)'),
        video: Schema.boolean().default(false).description('视频: 勾上=无视分数直接唤醒(默认关, 走评分)'),
        voice: Schema.boolean().default(false).description('语音: 勾上=无视分数直接唤醒(默认关; 有转录文字就按文字评)'),
        file: Schema.boolean().default(false).description('文件: 勾上=无视分数直接唤醒(默认关, 走评分)'),
    }).description('附件唤醒开关: 勾上的类型不管分数都唤醒她; 没勾的交给评分(没文字就没分 → 不唤醒)'),
    // 单会话覆盖(2026-09-13 主人要求: "单会话设置"就得能按会话单独设):
    // key = "group:<群openid>" 或 "c2c:<私聊openid>"; 未覆盖的键自动继承账号级默认。
    overrides: Schema.any().default({}).description('单会话覆盖(dock「单会话设置」保存到这里)'),
}).default({
    enabled: true,
    ovmsEndpoint: '',
    ovmsModel: '',
    ovmsTimeoutMs: 15000,
    valueGate: 'log',
    valueMinScore: 0.5,
    attachmentPassthrough: { image: true, video: false, voice: false, file: false },
    overrides: {},
});
const debounceSchema = Schema.object({
    enabled: Schema.boolean().default(true).description('延迟聚合总开关(防"连发N句只回第一句": 消息先攒窗口, 人停口或攒够条数才一次综合回)'),
    silenceSec: Schema.number().min(0).default(3).description('最近说话者停止发言几秒后开口(默认3; 0=不停顿)'),
    maxMsgs: Schema.number().min(1).default(10).description('窗口攒满几条立即开口(默认10), 不等对方停'),
    mentionDelayed: Schema.boolean().default(true).description('@bot 消息是否也走延迟(默认是; 不勾=@到秒回)'),
    busySendMode: Schema.union(['queue', 'interject']).default('queue').description('回合进行中(她正在思考/输出)群友新消息怎么办: 排队=攒着等这轮回完再整批看(默认, 现状); 插话=照样先聚合, 但不等回合结束, 直接在回合内的轮次之间插进去(每次插话都带一句"先做完当前任务"的轻提示)'),
    debug: Schema.boolean().default(false).description('调试日志(排查"插话退化成排队"用): 开启后把每条消息走了哪条分支、为什么没插进去写到 数据目录/.qqbot/debounce-dbg.log（超过 2MB 自动清空）'),
}).default({
    enabled: true,
    silenceSec: 3,
    maxMsgs: 10,
    mentionDelayed: true,
    busySendMode: 'queue',
    debug: false,
}).description('延迟聚合(独立于冷却的另一套机制)');
const behaviorSchema = Schema.object({
    freeIntervalSec: Schema.number().min(0).default(60).description('群普通消息回复间隔(秒),0=不限制'),
    mentionIntervalSec: Schema.number().min(0).default(0).description('@bot回复间隔(秒),0=立即回'),
    directIntervalSec: Schema.number().min(0).default(0).description('私聊回复间隔(秒),0=不限制'),
    debounce: debounceSchema,
}).default({
    freeIntervalSec: 60,
    mentionIntervalSec: 0,
    directIntervalSec: 0,
    debounce: {
        enabled: true,
        silenceSec: 3,
        maxMsgs: 10,
        mentionDelayed: true,
        busySendMode: 'queue',
    },
}).description('回复调度');
const stickerGatesSchema = Schema.object({
    enabled: Schema.boolean().default(false).description('闸门总开关,false=不限制'),
    perTurnMax: Schema.number().min(0).default(0).description('每轮最多发送张数,0=不限'),
    perWindowSec: Schema.number().min(0).default(600).description('频率窗口(秒)'),
    maxPerWindow: Schema.number().min(0).default(0).description('每窗口每群最多张数,0=不限'),
    dailyBudgetPerGroup: Schema.number().min(0).default(0).description('每群每日预算,0=不限'),
    dupTTLHours: Schema.number().min(0).default(0).description('同图去重(小时),0=关'),
    activityWindowSec: Schema.number().min(0).default(3600).description('活性窗口(秒)'),
    activityMinMsgs: Schema.number().min(0).default(0).description('活性窗口消息下限,0=不要求'),
    bannedGroups: Schema.array(Schema.string()).default([]).description('禁发群group_openid'),
    libRoots: Schema.array(Schema.string()).default([]).description('表情包路径白名单(追加)'),
}).default({
    enabled: false,
    perTurnMax: 0,
    perWindowSec: 600,
    maxPerWindow: 0,
    dailyBudgetPerGroup: 0,
    dupTTLHours: 0,
    activityWindowSec: 3600,
    activityMinMsgs: 0,
    bannedGroups: [],
    libRoots: [],
}).description('表情包主动发送闸门(默认不限制)');
const injectRuleItemSchema = Schema.object({
    id: Schema.string().required().description('规则ID'),
    name: Schema.string().description('规则名'),
    enabled: Schema.boolean().default(true).description('开关'),
    conditions: Schema.object({
        hasImage: Schema.boolean().default(false).description('消息含图片'),
        hasLink: Schema.boolean().default(false).description('消息含链接'),
        contentRegex: Schema.string().default('').description('正文正则,空=不启用'),
        contentKeywords: Schema.array(Schema.string()).default([]).description('关键词(任一命中)'),
        matchScope: Schema.union(['any', 'all']).default('any').description('any=任一命中;all=全部满足'),
    }),
    prompt: Schema.string().required().max(400).description('注入的系统提示文本(≤400字)'),
});
/** 一条时刻任务(挂在某个目标分组下) */
const scheduleTaskSchema = Schema.object({
    id: Schema.string().required().description('任务ID(唯一)'),
    time: Schema.string().required().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).description('每天触发时刻(24h本地时区 HH:MM)'),
    enabled: Schema.boolean().default(true).description('启用'),
    prompt: Schema.string().description('可选: 想让她聊的方向(空=自由发挥)'),
}).default({
    id: '',
    time: '09:00',
    enabled: true,
    prompt: '',
}).description('定时时刻');
/** 一个目标(群/人), 号码填一次, 下面挂多个时刻 */
const scheduleTargetSchema = Schema.object({
    id: Schema.string().required().description('目标ID(唯一)'),
    name: Schema.string().description('备注名(可选,帮认这个群/人)'),
    scope: Schema.union(['group', 'c2c']).default('group').description('group=群 / c2c=私聊'),
    targetId: Schema.string().required().description('目标: 群group_openid 或 用户openid'),
    tasks: Schema.array(scheduleTaskSchema).default([]).description('该目标下的定时时刻列表'),
}).default({
    id: '',
    name: '',
    scope: 'group',
    targetId: '',
    tasks: [],
}).description('定时目标(群/人)');
const scheduleSchema = Schema.object({
    targets: Schema.array(scheduleTargetSchema).default([]).description('定时目标列表(每个群/人一组,下面挂时刻)'),
}).default({ targets: [] }).description('定时唤醒(M3): 每天固定时刻主动找聊天');
// ── botplay 互动事件(schema, 2026-09-08) ──
const botplayActionSchema = Schema.object({
    type: Schema.union(['reply_text', 'jump_url', 'callback', 'command']).default('reply_text').description('行为类型: reply_text=回指定文本 / jump_url=跳转 / callback=仅结算 / command=点击执行斜杠命令(如 bot-status)'),
    text: Schema.string().default('').description('reply_text: 回复文本; command: 斜杠命令名(不带/, 如 bot-status)'),
    url: Schema.string().default('').description('jump_url: 跳转链接'),
}).default({ type: 'reply_text', text: '', url: '' }).description('按钮 bot(非LLM)动作');
const botplayEffectSchema = Schema.object({
    mode: Schema.union(['no_append', 'append_silent', 'append_wake']).default('no_append').description('LLM 三档影响: no_append=纯bot行为AI不知 / append_silent=记录进上下文不唤醒 / append_wake=记录并唤醒AI'),
    contextText: Schema.string().default('').description('自定义记录文本(支持 {label} 占位); 空=默认「bot 发送了卡片, 用户点击了按钮」'),
}).default({ mode: 'no_append', contextText: '' }).description('点击对 LLM 的影响');
const botplayButtonSchema = Schema.object({
    id: Schema.string().required().description('按钮 id(回调 data 编码 事件id::按钮id; 建议 [a-zA-Z0-9_-])'),
    label: Schema.string().required().description('按钮显示文字'),
    visitedLabel: Schema.string().description('点击后显示文字, 留空=label'),
    style: Schema.number().default(1).description('0灰 1蓝'),
    botAction: botplayActionSchema,
    llmEffect: botplayEffectSchema,
}).default({
    id: '', label: '', visitedLabel: '', style: 1,
    botAction: { type: 'reply_text', text: '', url: '' },
    llmEffect: { mode: 'no_append', contextText: '' },
}).description('按钮');
const botplayPermSchema = Schema.object({
    type: Schema.union(['all', 'triggerer', 'owner', 'users']).default('all').description('权限: all=所有人 / triggerer=仅触发者本人 / owner=主人白名单 / users=指定openid'),
    userIds: Schema.array(Schema.string()).default([]).description('users 时填 openid 列表'),
}).default({ type: 'all', userIds: [] }).description('权限');
const botplayEventSchema = Schema.object({
    id: Schema.string().required().description('事件唯一 id(斜杠 /botplay 触发用; 建议 [a-zA-Z0-9_-])'),
    name: Schema.string().required().description('事件显示名(/botplay 列表显示)'),
    contentText: Schema.string().default('').description('卡片正文 markdown 模板(空=默认模板; 支持 {name} 占位; 可嵌网络图 ![text #宽px #高px](url))'),
    maxClicks: Schema.number().default(0).description('接受点击数: 0=不限; N=单次触发最多点N次(点满失效)'),
    expireSec: Schema.number().default(600).description('发卡后有效期(秒), 超时按钮失效'),
    perm: botplayPermSchema,
    buttonsPerRow: Schema.number().min(1).max(5).default(1).description('每行几个按钮(1~5, 默认1竖排; QQ 上限 5行×5钮)'),
    // 自定义事件模块(2026-10-05): 填了就走 {dataRoot}/.qqbot-extensions/botplay/<file> 的模块钩子
    file: Schema.string().default('').description('自定义事件模块文件名(放 {dataRoot}/.qqbot-extensions/botplay/, 如 checkin-stats.mjs); 空=普通事件'),
    buttons: Schema.array(botplayButtonSchema).default([]).description('按钮列表(QQ限制: 最多5行)'),
}).default({
    id: '', name: '', contentText: '', maxClicks: 0, expireSec: 600,
    perm: { type: 'all', userIds: [] },
    buttonsPerRow: 1,
    file: '',
    buttons: [],
}).description('botplay 互动事件');
/** Phase1 内置演示事件(仅当用户从未配置时生效; 保存后以用户配置为准) */
const DEMO_BOTPLAY_EVENTS = [
    {
        id: 'checkin',
        name: '签到',
        maxClicks: 0,
        expireSec: 600,
        perm: { type: 'triggerer', userIds: [] },
        buttons: [{
                id: 'b1',
                label: '✅ 签到',
                visitedLabel: '已签到',
                style: 1,
                botAction: { type: 'reply_text', text: '✅ 签到成功 +1 🎉', url: '' },
                llmEffect: { mode: 'no_append', contextText: '' },
            }],
    },
    {
        id: 'fortune',
        name: '今日运势',
        maxClicks: 0,
        expireSec: 600,
        perm: { type: 'triggerer', userIds: [] },
        buttons: [{
                id: 'b1',
                label: '🔮 抽一签',
                visitedLabel: '已抽取',
                style: 1,
                botAction: { type: 'callback', text: '', url: '' },
                llmEffect: { mode: 'append_wake', contextText: '用户点击了「{name}」的抽签按钮, 想看看今天的运势' },
            }],
    },
];
const groupAdminSchema = Schema.object({
    enabled: Schema.boolean().default(false).description('QQ 群管理总开关(入群审批/禁言等; 需机器人为群管理员)'),
    owners: Schema.array(Schema.string()).default([]).description('允许操作的主人 openid 白名单(空=不校验; 群管理操作仅建议主人使用)'),
    manageGroup: Schema.string().default('').description('对话内默认管理群 group_openid(web/非群会话时群工具用它; QQ 群会话自动用当前群)'),
    watchJoinRequests: Schema.boolean().default(false).description('订阅"入群申请"实时事件(GROUP_JOIN_REQUEST)并自动提醒(改后需重启生效)'),
    peopleMemoInWeb: Schema.boolean().default(false).description('纯 web 会话（未绑定任何 QQ 会话）也注入主人小传；默认关 —— 小传是 QQ 群里的记忆，不该漫到无关会话'),
    notifyInGroup: Schema.boolean().default(true).description('收到入群申请事件时, 在该群内发一条 bot 提醒(需机器人=群管理员)'),
    hubSessionId: Schema.string().default('').description('群组管理器会话 id: 各群群事件(入群申请/新成员加入/被拉群)汇总注入此会话(dock 群组管理 tab 一键设置; 须绑定某 QQ 群/私聊)'),
    hubNotify: Schema.boolean().default(true).description('群事件转发到群组管理器(默认开; 注入成功则不再群内提醒)'),
    pollJoinRequests: Schema.object({
        enabled: Schema.boolean().default(false).description('轮询入群申请总开关(事件驱动失效时的兜底: 定时拉取各群审批列表)'),
        intervalMin: Schema.number().min(1).default(5).description('每隔几分钟拉取一次审批列表(最小1分钟)'),
        minCount: Schema.number().min(1).default(2).description('待审批人数≥此值才唤醒 LLM 处理(攒够一批再报, 防打扰)'),
        wakeLlm: Schema.boolean().default(true).description('唤醒【群管会话】AI(注入群组管理器会话并唤醒, AI 起来处理审批)'),
        hubNotify: Schema.boolean().default(true).description('注入群管会话(web 可见, 不唤醒 AI; 与 wakeLlm 互斥——唤醒优先)'),
        notifyGroup: Schema.boolean().default(false).description('通知普通群(申请所在群会话 append 一条, web 可见, 不唤醒 AI)。默认关=普通群不打扰(2026-09-11 修: 原来写死 true 与注释矛盾)'),
        wakeGroup: Schema.boolean().default(false).description('唤醒【普通群】AI(申请所在群会话的 AI 起来处理审批; 2026-09-11 主人要求与唤醒群管 AI 分开设置)'),
    }).default({
        enabled: false,
        intervalMin: 5,
        minCount: 2,
        wakeLlm: true,
        hubNotify: true,
        notifyGroup: false,
        wakeGroup: false,
    }).description('入群申请轮询(事件兜底)'),
    autoRecall: Schema.object({
        enabled: Schema.boolean().default(false).description('自动撤回总开关(命中关键词/附件类型就立刻撤, 不走 AI)'),
        mode: Schema.union(['keep', 'drop']).default('keep')
            .description('keep=消息仍进 AI 上下文(只从聊天记录里消失); drop=连 AI 都不看(在入站扩展之后拦截, 不影响扩展契约)'),
        keywords: Schema.array(Schema.string()).default([]).description('关键词: 子串匹配正文, 命中任一即撤回(一行一个)'),
        kinds: Schema.array(Schema.union(['text', 'image', 'voice', 'video', 'file'])).default([])
            .description('按附件类型命中(图片/语音/视频/文件; 空=不按类型筛)'),
        muteSeconds: Schema.number().min(0).default(0).description('同时禁言发送者秒数(0=不禁言; 需机器人为群管理员)'),
        dryRun: Schema.boolean().default(false).description('演练模式: 只记日志不真撤'),
    }).default({ enabled: false, mode: 'keep', keywords: [], kinds: [], muteSeconds: 0, dryRun: false }).description('自动撤回'),
}).default({
    enabled: false,
    owners: [],
    manageGroup: '',
    watchJoinRequests: false,
    peopleMemoInWeb: false,
    notifyInGroup: true,
    hubSessionId: '',
    hubNotify: true,
    pollJoinRequests: { enabled: false, intervalMin: 5, minCount: 2, wakeLlm: true, hubNotify: true, notifyGroup: false, wakeGroup: false },
    autoRecall: { enabled: false, mode: 'keep', keywords: [], kinds: [], muteSeconds: 0, dryRun: false },
}).description('QQ 群管理');
/** Web 设置页可编辑项的 schema(behavior/sticker.gates/injectRules/schedule) */
export const EditableConfigSchema = Schema.object({
    dataRoot: Schema.string().description('插件数据根目录(可选; 缺省=cwd): 表情包/.qqbot/.qqbot-extensions 统一挂其下, 与工作区其他文件分离'),
    behavior: behaviorSchema,
    groupAdmin: groupAdminSchema,
    sticker: Schema.object({
        gates: stickerGatesSchema,
        autoTagEnabled: Schema.boolean().default(false).description('新图后台自动识图打标(耗视觉额度,默认关)'),
        visionCli: Schema.string().default('').description('视觉引擎命令模板(留空自动探测)'),
        visionProvider: Schema.string().default('https://ai.bemly.moe').description('视觉 HTTP 端点(base URL)'),
        visionModel: Schema.string().default('Qwen/Qwen3.6-27B-FP8').description('视觉模型 ID'),
        visionApiKeyEnv: Schema.string().default('KFC_API_KEY').description('视觉密钥环境变量名'),
    }).description('表情包图库'),
    injectRules: Schema.array(injectRuleItemSchema).default([]).description('条件注入规则'),
    imageHint: Schema.boolean().default(true).description('图片消息自动追加「看图」内置提示(默认开; 关掉=不再注入那条「把 URL 传给识图工具」)'),
    stripTimeHead: Schema.boolean().default(false).description('出站洗掉行首时间头(默认开, issue #72): 入站给每回合首条盖了 [YYYY-MM-DD 周四 HH:MM], 模型会内化并在回复里自己披一个; 开=发送前剔除(正则含 HH:MM 才删, 正常引用不误伤)'),
    stripFacePlaceholder: Schema.boolean().default(false).description('出站洗掉「【表情: XX】」占位符(默认开, issue #72): 官方 API 发不了 face, 入站只能转写成可读文本, 模型会照抄成裸文字'),
    turnErrorMode: Schema.union(['notify', 'friendly', 'silent', 'regex']).default('notify').description('回合异常时往群里发什么(issue #73): notify=照常发原文 / friendly=发一句人话(细节只进日志) / silent=完全不发 / regex=按 turnErrorSilentPattern 拦截, 命中的静默、其余照常'),
    latexHint: Schema.boolean().default(false).description('数学公式提示(默认关, 2026-11-20): 勾上后系统提示词里提醒模型「QQ 支持 LaTeX, 可以输出 $…$ 行内公式或 $…$ 居中公式, 也能用 \\textcolor{#hex}{…} 上色」。⚠️ 只在支持 LaTeX 的客户端生效, 旧版 QQ 会显示成源码'),
    sessionKindHint: Schema.boolean().default(true).description('会话类型标注(issue #79, 默认开): 每个会话首次注入一条「渠道=QQ 群聊/私聊 + 群名或对方昵称」。群名走 GET /v2/groups/{openid}/info、昵称走 GET /v2/users/{openid}/info（带缓存），取不到只写渠道'),
    turnErrorSilentPattern: Schema.string().default('').description('turnErrorMode=regex 时的匹配式(不区分大小写, 匹配 code+message)。例: 400|10013|INVALID_REQUEST|内容违规。留空=不拦截'),
    turnErrorModeByScope: Schema.object({ group: Schema.string().default(''), c2c: Schema.string().default('') }).description('按渠道覆盖回合异常策略(issue #77): { group: silent, c2c: notify }；空串=不覆盖'),
    toolErrorMode: Schema.union(['notify', 'friendly', 'silent', 'regex']).default('notify').description('工具报错时发什么(issue #77): notify=照常发原文 / friendly=一句人话 / silent=不发 / regex=按下面正则拦截'),
    toolErrorSilentPattern: Schema.string().default('').description('toolErrorMode=regex 时的匹配式(不区分大小写, 匹配渲染后的 ❌ 文本)。例: TOOL_TIMEOUT|执行失败。留空=不拦截'),
    toolErrorModeByScope: Schema.object({ group: Schema.string().default(''), c2c: Schema.string().default('') }).description('按渠道覆盖工具报错策略(issue #77): 群聊 silent + 私聊 notify 是常见组合；空串=不覆盖'),
    outboundLastCtxFallback: Schema.boolean().default(false).description('出站扩展未指定 target 时是否回落到最近活跃会话(issue #78, 默认关=拒发)。开启=旧行为, 多会话并发会串台'),
    imageOffload: Schema.boolean().default(false).description('历史图片不重发(默认关): 开启后会在 DSH 会话历史里删图；当前由 Magpie image-slim 在出站时处理，避免丢元数据导致缓存重建'),
    imageAggregate: Schema.object({
        enabled: Schema.boolean().default(false).description('图片聚合(默认关): 2~100 张图片合成一张，随唤醒消息一起进上下文(只对支持读图的模型生效)'),
    }).description('图片聚合(issue #40): 2~100 张图 → 一张长图, 省 token 又让 AI 一次看全'),
    messageReference: Schema.boolean().default(true).description('引用消息(默认开): 入站消息带短消息号 + 引用消息附原文 + 注入引用指令; 出站支持 [rf:短号] 标签引用对方消息'),
    localModel: localModelSchema,
    schedule: scheduleSchema,
    enableApprovals: Schema.boolean().default(false).description('QQ 远程审批: dsh 权限申请发到 QQ, 用 /approve CODE 放行(保存后对新请求生效)'),
    extMetaTool: Schema.boolean().default(true).description('扩展工具按需取用(默认开): 全局只挂一个 gain_qq_tools 元工具, 非 QQ 会话需要时自己领取(省 token); 关掉=所有 expose:all 扩展工具全量全局注册(老行为)'),
    approvalTimeoutMs: Schema.number().default(120000).description('QQ 权限申请等待时长(ms), 超时自动拒绝'),
    outboundMode: Schema.union(['adaptive', 'detail', 'active', 'passive', 'silent', 'nothink']).default('adaptive').description('出站模式: 适配主动(默认)=收到新消息后前5次带msg_id被动回复, 超出/无新消息自动转主动(保连发); 详细主动=与适配主动相同 + 额外把工具调用/工具结果也推到QQ(看进度用, 会更啰嗦); 被动=全程带回复id(连发受QQ上限); 完全不出站=思考但不发(静默); 完全不思考=QQ入站不唤醒LLM(仅记录, 仅设置页可配)'),
    webTurnSilent: Schema.boolean().default(false).description('web 回合静默(出站模式的附加开关): 勾上后, 在 DSH 界面里发起的回合其正文块不发到 QQ(留在 DSH); 该回合中途 QQ 有人插话则从此全部放行; 图片/文件/工具调用不受影响'),
    archiveOnNewSession: Schema.boolean().default(true).description('开新档自动归档旧会话(默认开): /new、/bot-new、换模型 fork 出新档时, 把被取代的旧会话写进宿主「已归档」集合, 侧边栏不再堆僵尸档; 旧档仍可被 QQ 消息拉回'),
    botplayEvents: Schema.array(botplayEventSchema).default(DEMO_BOTPLAY_EVENTS).description('botplay 互动事件(dock🎮装配器编辑, 保存即热更; /botplay 触发发卡)'),
});
const ConfigSchemaRaw = Schema.object({
    appId: Schema.string().default('').description('QQ Bot AppID'),
    appSecret: Schema.string().default('').description('QQ Bot AppSecret'),
    provider: Schema.string().description('LLM provider name'),
    model: Schema.string().description('Model name'),
    preset: Schema.string().description('Agent preset id'),
    // ⚠️ 2026-10-02 修 issue #7：手机/POSIX 下反斜杠相对路径会让会话创建必失败 ⇒ 统一走规范化
    cwd: Schema.string().description('Agent working directory'),
    dataRoot: Schema.string().description('插件数据根目录(可选; 缺省=cwd): 表情包/.qqbot/.qqbot-extensions 统一挂其下, 与工作区其他文件分离'),
    settingsNs: Schema.string().description('Web 设置命名空间(多账号时每实例唯一, 默认 im-qqbot)'),
    requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
    directPrompt: Schema.string().description('私聊额外system prompt'),
    textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
    c2cShowBotAvatar: Schema.boolean().default(false).description('私聊出站首行显示机器人头像（官方私聊没有头像，群里才有；默认关）'),
    streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）'),
    sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
    archiveOnNewSession: Schema.boolean().default(true).description('开新档自动归档旧会话(默认开): /new、/bot-new、换模型 fork 出新档时, 把被取代的旧会话写进宿主「已归档」集合, 侧边栏不再堆僵尸档; 旧档仍可被 QQ 消息拉回'),
    maxQueue: Schema.number().default(20).description('并发队列最大长度'),
    processingTimeoutMs: Schema.number().default(120000).description('处理超时(ms)'),
    historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
    contextlessMode: Schema.boolean().default(false).description('无上下文模式: 每轮不继承历史(只带「@ 之前 N 条群消息」+ 系统规则)'),
    contextlessWindow: Schema.number().default(5).description('无上下文模式下携带的「@ 之前」群消息条数(0=完全不带)'),
    contextlessSmart: Schema.boolean().default(false)
        .description('无上下文模式·智能判断(与 contextlessWindow 互斥): 让 AI 自己判断话题并自主压缩/丢弃上下文，只留它自己的备忘'),
    contextMemoMaxItems: Schema.number().default(20).description('备忘条数上限(超出自动丢最旧)'),
    access: Schema.object({
        c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
        c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
        groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
        groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
        groupBlockedUsers: Schema.array(Schema.string()).default([]).description('群聊成员屏蔽名单(member openid；对所有群生效，主人白名单优先)'),
    }).default({
        c2cMode: 'open',
        c2cAllow: [],
        groupMode: 'open',
        groupAllow: [],
        groupBlockedUsers: [],
    }).description('访问控制'),
    behavior: behaviorSchema,
    sticker: Schema.object({
        collectEnabled: Schema.boolean().default(true).description('自动下载群图到候选区(只存本地; ⚠️ 这是"采集"不等于"收藏" —— 收藏指打标/挑进正式库)'),
        dataDir: Schema.string().default('').description('图库数据根目录(默认 {agent cwd}/表情包)'),
        gates: stickerGatesSchema,
        autoTagEnabled: Schema.boolean().default(false).description('新图后台自动识图打标(耗视觉额度,默认关;开需可用视觉CLI)'),
        visionCli: Schema.string().default('').description('视觉CLI命令模板(含{img}占位), 空=自动探测本机视觉CLI'),
        visionProvider: Schema.string().default('https://ai.bemly.moe').description('视觉 HTTP 端点(base URL)'),
        visionModel: Schema.string().default('Qwen/Qwen3.6-27B-FP8').description('视觉模型 ID'),
        visionApiKeyEnv: Schema.string().default('KFC_API_KEY').description('视觉密钥环境变量名'),
    }).default({
        collectEnabled: true,
        dataDir: '',
        gates: {
            enabled: false,
            perTurnMax: 0,
            perWindowSec: 600,
            maxPerWindow: 0,
            dailyBudgetPerGroup: 0,
            dupTTLHours: 0,
            activityWindowSec: 3600,
            activityMinMsgs: 0,
            bannedGroups: [],
            libRoots: [],
        },
        autoTagEnabled: false,
        visionCli: '',
        visionProvider: 'https://ai.bemly.moe',
        visionModel: 'Qwen/Qwen3.6-27B-FP8',
        visionApiKeyEnv: 'KFC_API_KEY',
    }).description('表情包图库'),
    injectRules: Schema.array(injectRuleItemSchema).default([]).description('条件注入规则:消息含图片/链接/自定义文本时自动插入系统提示'),
    imageHint: Schema.boolean().default(true).description('图片消息自动追加「看图」内置提示(默认开; 关掉=不再注入那条「把 URL 传给识图工具」)'),
    stripTimeHead: Schema.boolean().default(false).description('出站洗掉行首时间头(默认开, issue #72): 入站给每回合首条盖了 [YYYY-MM-DD 周四 HH:MM], 模型会内化并在回复里自己披一个; 开=发送前剔除(正则含 HH:MM 才删, 正常引用不误伤)'),
    stripFacePlaceholder: Schema.boolean().default(false).description('出站洗掉「【表情: XX】」占位符(默认开, issue #72): 官方 API 发不了 face, 入站只能转写成可读文本, 模型会照抄成裸文字'),
    turnErrorMode: Schema.union(['notify', 'friendly', 'silent', 'regex']).default('notify').description('回合异常时往群里发什么(issue #73): notify=照常发原文 / friendly=发一句人话(细节只进日志) / silent=完全不发 / regex=按 turnErrorSilentPattern 拦截, 命中的静默、其余照常'),
    latexHint: Schema.boolean().default(false).description('数学公式提示(默认关, 2026-11-20): 勾上后系统提示词里提醒模型「QQ 支持 LaTeX」, 可输出 $…$ 行内公式 / $$…$$ 居中公式 / \\textcolor{#hex}{…} 彩色字。⚠️ 只在支持 LaTeX 的客户端生效, 旧版 QQ 会显示成源码'),
    sessionKindHint: Schema.boolean().default(true).description('会话类型标注(issue #79, 默认开): 每个会话首次注入一条「渠道=QQ 群聊/私聊 + 群名或对方昵称」。群名走 GET /v2/groups/{openid}/info、昵称走 GET /v2/users/{openid}/info（带缓存），取不到只写渠道'),
    turnErrorSilentPattern: Schema.string().default('').description('turnErrorMode=regex 时的匹配式(不区分大小写, 匹配 code+message)。例: 400|10013|INVALID_REQUEST|内容违规。留空=不拦截'),
    turnErrorModeByScope: Schema.object({ group: Schema.string().default(''), c2c: Schema.string().default('') }).description('按渠道覆盖回合异常策略(issue #77): { group: silent, c2c: notify }；空串=不覆盖'),
    toolErrorMode: Schema.union(['notify', 'friendly', 'silent', 'regex']).default('notify').description('工具报错时发什么(issue #77): notify=照常发原文 / friendly=一句人话 / silent=不发 / regex=按下面正则拦截'),
    toolErrorSilentPattern: Schema.string().default('').description('toolErrorMode=regex 时的匹配式(不区分大小写, 匹配渲染后的 ❌ 文本)。例: TOOL_TIMEOUT|执行失败。留空=不拦截'),
    toolErrorModeByScope: Schema.object({ group: Schema.string().default(''), c2c: Schema.string().default('') }).description('按渠道覆盖工具报错策略(issue #77): 群聊 silent + 私聊 notify 是常见组合；空串=不覆盖'),
    outboundLastCtxFallback: Schema.boolean().default(false).description('出站扩展未指定 target 时是否回落到最近活跃会话(issue #78, 默认关=拒发)。开启=旧行为, 多会话并发会串台'),
    imageOffload: Schema.boolean().default(false).description('历史图片不重发(默认关): 开启后会在 DSH 会话历史里删图；当前由 Magpie image-slim 在出站时处理，避免丢元数据导致缓存重建'),
    imageAggregate: Schema.object({
        enabled: Schema.boolean().default(false).description('图片聚合(默认关): 2~100 张图片合成一张，随唤醒消息一起进上下文(只对支持读图的模型生效)'),
    }).description('图片聚合(issue #40): 2~100 张图 → 一张长图, 省 token 又让 AI 一次看全'),
    messageReference: Schema.boolean().default(true).description('引用消息(默认开): 入站消息带短消息号 + 引用消息附原文 + 注入引用指令; 出站支持 [rf:短号] 标签引用对方消息'),
    localModel: localModelSchema,
    schedule: scheduleSchema,
    groupAdmin: groupAdminSchema,
    showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（工具错误始终展示）'),
    sendFile: Schema.object({
        maxFiles: Schema.number().default(4).description('交付文件直发: 单轮最多投递几个 present 声明的文件(超出只提示不发)'),
    }).description('交付文件直发(2026-10-27): 宿主 present 工具声明的文件在轮末自动发到当前 QQ 会话'),
    debug: Schema.boolean().default(false),
    diagLog: Schema.boolean().default(false).description('诊断日志落盘(默认关): 开=把排查用的诊断日志写进 {DSH_HOME|~/.dsh}/*.log, 单文件 2MB 自动轮转(只留 1 份旧档); 平时别开, 会持续占盘'),
    enableApprovals: Schema.boolean().default(false).description('通过 QQ 接收并处理 dsh 一次性权限申请(远程审批: 发起者用 /approve CODE 放行)'),
    extMetaTool: Schema.boolean().default(true).description('扩展工具按需取用(默认开): 全局只挂一个 gain_qq_tools 元工具, 非 QQ 会话需要时自己领取(省 token); 关掉=所有 expose:all 扩展工具全量全局注册(老行为)'),
    approvalTimeoutMs: Schema.number().default(120000).description('QQ 权限申请超时(ms), 超时自动拒绝'),
    questionsMode: Schema.union(['async', 'blocking']).default('async').description('提问卡片怎么等答案: 后台(async, 默认)=卡片发出后工具立刻返回, 她能继续聊天/干活, 对方答完的答案会自动作为一条回执消息送回来(她忙就插进当前回合、空闲就唤醒她处理); 阻塞(blocking)=旧行为, 工具一直挂到对方作答或超时才继续(期间她动不了)'),
    outboundMode: Schema.union(['adaptive', 'detail', 'active', 'passive', 'silent', 'nothink']).default('adaptive').description('出站模式: 适配主动(默认)=收到新消息后前5次带msg_id被动回复, 超出/无新消息自动转主动(连发不受限); 详细主动=同适配主动 + 额外推送工具调用/工具结果到QQ(看进度, 消息更多); 被动=携带msg_id回复(连发受QQ回复同一消息上限); 完全不出站=思考但不发(静默); 完全不思考=QQ入站不唤醒LLM, 仅记录上下文(仅设置页可配, 防机器人自锁)'),
    webTurnSilent: Schema.boolean().default(false).description('web 回合静默(出站模式的附加开关): 勾上后, 在 DSH 界面里发起的回合其正文块不发到 QQ(留在 DSH); 该回合中途 QQ 有人插话则从此全部放行; 图片/文件/视频/语音与工具调用不受影响'),
    warmSessionsOnStart: Schema.boolean().default(true).description('启动时预热已知 QQ 会话(默认开): 网关起来后主动把已有会话建出来并注册扩展工具, 不用等一条入站消息; 关掉=老行为(必须等消息才恢复工具)'),
    warmMaxSessions: Schema.number().default(12).description('启动预热上限(默认12): 每个预热会真的创建一个 agent, 太多会拖慢启动'),
    botplayEvents: Schema.array(botplayEventSchema).default(DEMO_BOTPLAY_EVENTS).description('botplay 互动事件(装配器编辑; /botplay 触发发卡)'),
});
/**
 * 递归给 schema 所有字段标 volatile（2026-09-24，适配 dsh 0.1.7）。
 *
 * 为什么：0.1.7 的 `settings.update()` 只接受 **schema 里声明为 volatile** 的字段
 * （dsh-settings 源码：`const form = volatileForm(schema); if (!form) throw new Error('Plugin entry "x" has no volatile fields')`）。
 * 本插件原先一个都没标 → 保存必被拒，只能退化成"自己改 profile patch"，
 * 于是踩出一连串类型写坏/密钥被覆盖的坑。标上之后宿主的正道写回就能用了。
 *
 * 旧版 schemastery（<3.18.4）没有 `.volatile()` → 自动跳过，两代通吃。
 */
/**
 * ⚠️ 故意**不标 volatile** 的字段：改它们需要"重新挂载插件"（重建 bot / 重连）。
 * 不标 volatile → loader 在配置变化时走 remount（plugin 重新 apply → bootstrap 重建 bot），
 * 这正是我们想要的"改密钥自动重连"，比自己写重连逻辑可靠。
 */
/**

/** 顶层 appId/appSecret 不标 volatile：改它们走 remount（重建 bot 连接）。 */
/** 插件导出的 Config：宿主用它推导设置表单、校验并写回。 */
export const ConfigSchema = ConfigSchemaRaw;
/* ⚠️ 2026-09-24 事故回退：不要在这里标 volatile！
 * 曾用 ConfigSchemaRaw.volatile() 让整份 Config 可热改（绕开 "no volatile fields"），
 * 结果把配置写入变成自反馈闭环：插件写 profile patch → 宿主当 volatile 变更热提交
 * → 插件重读配置 → 凭据仍无效就再写/再扫码 → 无限循环（dsh 启动卡死刷二维码）。
 * 结论：volatile 只适合"改了不需要插件做副作用"的字段；本插件配置几乎都与 bot 生命周期相关。
 * 设置页保存改由插件自己读写 profile 配置处理（见 settings-host.js）。 */
//# sourceMappingURL=config.js.map