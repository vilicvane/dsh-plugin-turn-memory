# 上下文压缩改造计划(turn-memory)

> 本文档是"两步式上下文压缩改造"的持久化记录,保存所有设计决策、语义规则、
> 实测结论与待办,防止对话丢失导致信息遗失。最后更新:2026-08-15(第二步实现完成,
> 四轮 headless 冒烟 exit 0;新增小模型折叠后的主模型 fork 终审(3.6)并冒烟
> 通过,见 3.8;compact_turn 主体改为当前上下文自拟摘要,见 8/10;
> turn 结束摘要改为下一条用户消息到来时由主 agent 自拟、fork 只作兜底,见 11;
> expand_turn 改为 raw/agentic 双模式、agentic 按 turn 时间路由,见 12)。

## 1. 背景与总体架构

原机制(dsh-compaction-basic):step 边界按 token 压力(阈值 0.8 × 上下文窗口)
对最旧区间做一次性重放式总结,保留尾部 16%,模型上下文里旧内容被
compacted-summary 替换,原始事件保留在追加日志中。

目标改造分两步,拆成两个独立插件,仅通过磁盘上的 surface checkpoint 格式通信:

| 步骤 | 插件 | 状态 | 职责 |
|---|---|---|---|
| 第一步 | dsh-plugin-turn-memory | 已实现、已实测 | turn 级独立摘要、延迟替换、expand_turn 双模式召回(时间路由) |
| 第二步 | dsh-plugin-replay-compaction | 已实现、已冒烟 | 逐段重放修正式 session 压缩,完全替代 summarize() |

第二步注册 ctx.compaction,与 dsh-compaction-basic 互斥——切换方式就是在 profile
patch 里禁用后者、插入前者。两者无代码依赖;第二步消费的是第一步留在 surface
上的 turn-summary checkpoint(按 version 字段识别,未知版本回退原始转录)。

## 2. 第一步:turn 级记忆(已完成)

### 2.1 行为规格

- 触发:根会话(session.header.parentSession === undefined)的 agent 进入 idle
  且产生了新的 turn/end 且该 turn 含至少一条 assistant/message。
- 摘要方式:one-shot fork(与主对话同 provider/model,共享暖前缀),
  任务消息为固定的九小节指令(见 2.2)。独立摘要,不滚动修订。
- 替换时机:仅在下一次用户发起的 turn 的 pre-step(claimed messages 中
  存在 source.kind === 'user')执行;替换前等待摘要完成(summaryTimeoutMs 默认
  120s,超时 abort 并放弃,该 turn 保持原文)。
- 替换范围:该 turn 的 surface 区间,须完整、连续、tool-pairing 平衡;turn 内
  发生过中途压缩(compaction/start 或 compaction/summary 落在区间内)则跳过。
- 最新用户消息永远逐字保留(替换永不覆盖包含最新用户消息的区间)。
- 摘要语言:不指定,由模型自选。

### 2.2 摘要指令结构(九小节)

Request and Intent / Work Done / Decisions and Rationale / Rejected Alternatives /
Errors and Fixes / Facts to Preserve Verbatim / Current State /
Open Questions and Pending User Input / Next Step。

强制规则:以等待用户结束的 turn,待决问题及全部选项必须逐字保留;用户纠错、
路径、命令、错误串、标识符、数值逐字保留。

### 2.3 召回(expand_turn,raw / agentic 双模式,agentic 按时间路由)

- agentic(默认,须带 question):turn 结束时间(无则开始时间)距今 ≤
  recallRecentWindowMs(默认 7200000,2 小时)走 fork——fork 的上下文是已完成
  turn 的原始全文重放(不是 checkpoint),目标 turn 全文直接作答;仅当 provider
  磁盘缓存还保留着这些 turn 直播时持久化的 prefix unit 时才是暖前缀、零额外
  模型调用(DeepSeek 官方:缓存 best-effort,"不再使用后自动清除,通常几小时至
  几天"——窗口取官方下限"几小时"附近);更早的 turn 走 subagent——便宜模型
  (deepseek-chat)读完整转录定向回答,成本隔离在子上下文;无时间戳时回退
  newest−2 轮距。
- raw:全文直读,超长截断(maxRawChars),最后手段;主会话上下文里本就有所有
  checkpoint,agentic 答不上时模型可按需升级为 raw 读全文。
- 原文取自会话追加日志(排除 reasoning chunks 与 replacement 副本);
  fork 子会话自带父会话原始事件种子,因此摘要 fork 与 recall fork 都能读全文。

### 2.4 持久化与故障语义

- 摘要的持久记录 = 替换 checkpoint(user/message,source 标记
  {kind:'plugin', plugin:'turn-memory', turn, turnSummaryId, version:4}——
  当前版本;摘要格式演进(九小节 → 四段 Timeline → 纯时间线,无固定 section)时递增 version。
  不引入自定义 session 事件类型——下游插件事件不在
  KNOWN_SESSION_EVENT_TYPES 内,未经 ignorable 标记会使旧构建拒绝加载日志。
- 失败/超时/取消 → turn 保持原文、无任何标记;第二步对无摘要的 turn 回退原始转录。
- 进程重启丢失 in-memory 待替换状态:该 turn 保持原文(可接受,已确认)。

### 2.5 配置项(均可选)

summaryTimeoutMs 120000 / recallTimeoutMs 180000 / cheapProvider deepseek-official /
cheapModel deepseek-chat / cheapMaxTokens 8192 / recallRecentWindowMs 7200000 /
maxRawChars 500000 / toolResultCapChars 20000 / maxRecallDepth 4。

### 2.6 实测结论(headless 冒烟 profile,两轮真实模型 turn,exit 0)

- 九小节摘要生成正确、逐字保留生效;
- 替换节点 surfaceOp replace:[7,48] 精确覆盖 turn 1,最新用户消息原样保留;
- 模型主动调用 expand_turn(turn=1, mode=raw) 成功取回被替换的全文并准确复述;
- 日志可加载性不受影响。

### 2.7 技术要点(踩坑记录,第二步复用)

- 工具参数 schema:可选参数省略 required 键(required:false 会导致插件加载失败);
- profile 外 linked 插件需要在自己目录单独 pnpm install 依赖;
- 测试 profile 需要 pnpm onlyBuiltDependencies 批准 node-pty 构建 + node-gyp rebuild;
- 测试 runner 必须 inject 所需服务并 await loader.await() 后才能用服务。

## 3. 第二步:逐段重放修正式 session 压缩(已实现)

### 3.1 目标

完全替代 BasicCompactionEngine 的 summarize(),触发条件、区间选择、锁、收敛校验、
持久化事务全部继承;切换 = 换插件行。

### 3.2 段与输入布局

- 段 = 第一步的 turn 摘要(无摘要的 turn 回退为该 turn 的原始转录段);
- 旧的 compacted-summary(切换前的存量)当作不可变段直接合并,不重新摘要;
- 迭代布局(每次迭代:新段插入在摘要块之前,摘要块整体替换且始终在尾部):

      [固定指令][段1][段2]...[段k][<running-summary> S_{k-1} </running-summary>] → S_k

- 分隔标记:segment / running-summary 成对标签,复用现有 turn-summary /
  compacted-summary 约定;指令文本必须逐字节稳定(缓存 key),状态信息靠标记表达。

### 3.3 缓存性质(已论证)

- 循环内:第 k+1 次迭代的 [指令][段1..k] 前缀全量命中缓存,仅新段与重写的摘要块
  是新输入;输出每次重写,受 maxTokens 约束。
- 跨压缩:被压缩段被合并摘要取代后前缀变样,下次压缩基本冷启动;若想跨压缩复用,
  可把合并摘要作为"超段"永久追加(已列为后续可选优化,不在第二步首版)。
- 总结器换便宜模型不影响循环内增量缓存(循环输入与主会话前缀无关)。

### 3.4 模型与形态

- 总结器用便宜 chat 模型(deepseek-chat);带工具(可用 read_turn 读原文),
  形态实现为手写工具循环 over ctx.llm.stream,而非子 agent 或纯重放 +
  单次 llm.stream()。read_turn 是插件私有工具(闭包直读被压缩 session 的
  追加日志),与 turn-memory 的 expand_turn 无代码依赖。
- purpose: 'compaction' → deepseek 适配器附加 x-deepseek-harness-compact:1
  请求头(平台压缩模式提示);deepseek-chat 是非推理模型,隐藏推理不会吃掉
  maxTokens。适配器里真正强制 thinking:disabled 的是 purpose 'session-title'
  与 reasoningEffort 'off'——若换用推理模型总结,需二选一。
- **终审(3.6)**:折叠完成后,再起一个主模型 fork(继承对话 provider/model 与
  完整历史种子,可用 expand_turn 读原文)对候选摘要做最后检查与修正;fork 走
  agent loop 没有 purpose 通道,主模型若开推理,推理 token 计入其 maxTokens
  (继承自父会话,非折叠的 8192 上限)。

### 3.5 实现要点(按实现后事实修订)

- 子类 BasicCompactionEngine,覆写 summarize();返回契约扩展多调用信封
  (callEnvelopes 数组)。基类 commitCompactionBody 只透传固定字段、会丢弃
  未知键,因此 envelope 落盘需要 DSH core 补丁(pnpm patch,见下)。
- 基类传入的原样重放 input 可忽略,自建段序列;段的来源精确区间靠补丁
  (buildSummarizationInput 返回 shadowedSeqs),不靠从 surface 反推。
- 单次修订失败可重试(revisionRetries,默认 2);整个循环服从 signal;
  工具轮次预算(maxToolRounds,默认 6)耗尽后注入错误结果强制收尾;
  某段缺失回退原文段。
- turn 摘要按 version 识别(默认接受 [1,2,3,4],须与第一步的
  TURN_SUMMARY_VERSION 同步):未知版本 → 该 turn 回退原始转录。

**DSH core pnpm patch(dsh-plugin-replay-compaction/patches/,重装可复现):**

1. dsh-compaction-basic commitCompactionBody:summarize() 返回值带
   callEnvelopes 数组时,compaction/summary 事件负载附加
   {calls: N, lastEnvelope: {provider, model, maxTokens?, usage?, output}}。
2. dsh-compaction-basic buildSummarizationInput:返回值附加 shadowedSeqs
   与 shadowedTokenCount(精确被替换区间与它的 token 计价,段序列与终审
   shrink 预检的唯一输入依据)。
3. dsh-compaction types.d.ts:compaction/summary 负载联合增加第三变体
   {calls, lastEnvelope, rawOutput?: never, llmStreamCall?: never},并给
   该变体加可选 review?: {provider, model, output}——终审 fork 的路由与产出
   的落盘记录。
4. dsh-compaction-basic 压力压缩 pre-step 处理器改为先 await next() 再
   压缩(decision 非 enter 或 signal aborted 则跳过):turn-memory 的延迟替换
   先于压缩落盘,压缩消费 turn-summary checkpoint 而非原始转录,且与两插件
   的 wiring 顺序无关(顺序问题实测踩坑,见 3.8)。
5. dsh-compaction-basic commitCompactionBody:summarize() 返回值带 review
   字段时,compaction/summary 负载附加 {review}。

### 3.6 终审(小模型折叠 → 主模型 fork 修正)

- 时机:折叠循环产出最终 running summary 之后、summarize() 返回之前;每次
  压缩各跑一次(可用 reviewEnabled:false 关闭)。
- 形态:one-shot fork(ctx.subagents.start('fork')),不覆盖 agentOptions →
  继承主对话的 provider/model;fork seed = 父会话已完成 turn 的原始事件前缀,
  因此 fork 上下文 = 主会话当前 surface,可用 expand_turn(mode raw)按需读
  任意 turn 原文。候选摘要在 <candidate-summary> 标签对里随 prompt 传入,
  固定指令文本字节稳定(单次调用,缓存性质不关键)。
- 指令要点:保持候选的平铺时间线形式(与折叠输出同构);纠错、删虚假/过时
  断言、补可验证的缺失事实;逐字保留规则不变;"收紧而非扩写";只输出摘要
  文本。
- **shrink 预检(关键)**:基类的收敛校验在 summarize() 返回后对帧化消息
  (CHECKPOINT_PREAMBLE + <compacted-summary> 标签)计 token,≥ shadowedTokenCount
  即抛错——终审如果放大了摘要,可能让本可通过的压缩整体失败。因此插件在
  接受终审前用 ctx.tokenMeter 按同一帧化形状预估计价,仅当 framed <
  shadowedTokenCount 才采纳(依赖补丁 2 传入 shadowedTokenCount;帧化文本
  与基类逐字节一致,预检与实际校验同计价)。
- 故障语义(硬规则:**终审永远不能弄挂一次本可成功的压缩**):fork 启动失败、
  stopReason 非 completed、输出为空、shrink 预检不通过 → 保留折叠输出并
  warn;调用方 signal 中止 → 原样抛出(压缩事务按基类路径 fail-close)。
  超时靠 AbortController 融合(reviewTimeoutMs,默认 180s)。
- 落盘:compaction/summary 负载增加 review: {provider, model, output}
  (补丁 5 + 补丁 3 的类型扩展)。
- 配置:reviewEnabled true / reviewTimeoutMs 180000 / reviewMaxDepth 4
  (均可选)。

### 3.7 与第一步的关系

- 第一步产出 = 第二步的段来源(粒度、格式两者共享,改动需考虑存量会话);
- 第一步的 format version 就是两份插件之间的兼容契约。

### 3.8 实测结论与踩坑(第二步)

- **最终冒烟(四轮,exit 0)**:主压缩一次折叠 3 段 = turn-summary(turn 1,
  2167 chars) + turn-summary(turn 2, 3282 chars) + raw-transcript(turn 3,
  4026 chars),3 次迭代 3 次调用;compaction/summary 负载 {calls: 3,
  lastEnvelope: deepseek-official/deepseek-chat, outputBlocks: 2} 落盘成功;
  单 checkpoint 折叠被收敛校验正确拒绝(shrink check,summary 不比原 checkpoint
  小)→ compaction/end(error)、surface 不变、无 summary 事件——fail-closed
  事务路径实测通过;fork 子会话全部跳过压缩;surface 0/1 节点时正确返回
  null(整个 surface 都在保留尾部内)。turn 3 因 span 内落入压缩事件而保持
  原文(turn-memory 的既有保守规则),由压缩的 raw 段兜底。
- **多调用信封落盘**:compaction/summary 负载 {calls: 3, lastEnvelope:
  {provider, model, maxTokens, usage, output}} 实测落盘成功(3 段 3 次调用);
  前提是补丁 1(基类否则丢弃未知字段)。
- **pre-step 顺序踩坑(重要)**:两插件都挂 agent/pre-step,waterfall 按注册序
  FIFO。若压缩处理器先跑,它会在 turn-memory 替换落盘前把该 turn 的原文压掉,
  且 compaction 事件落在 turn span 内使 turn-memory 跳过替换(tryReplace 的
  "SKIP compaction events in span")——段全部回退原始转录。靠 wiring 顺序
  (turn-memory 列在 replay-compaction 之前)不够稳:实测两次应用,replay 的
  构造函数仍比 turn-memory 的 apply 早 2ms(并发 import 竞速)。正解 = 补丁 4:
  压缩处理器先 await next() 再压缩,与注册顺序解耦。
- **turn-memory span 覆盖 bug(由第二步冒烟暴露,已修)**:替换 checkpoint 的
  seq 落在下一个 turn 的 span 内(替换在下一 turn 的首次 pre-step 执行),
  tryReplace 的 seq 区间走查会把**上一个 turn 的 checkpoint** 一起计入
  spanSeqs,于是每次替换都吞掉前一个 checkpoint——surface 上只剩最后一个
  turn-summary,更早摘要事实丢失(仅存在于原始日志)。修复:span 走查排除
  source.plugin === 'turn-memory' 且 turn !== 本 turn 的节点;foreign
  checkpoint 落在 span 中间时天然因不连续而跳过。
- **极小阈值测试假象**:thresholdRatio 0.0002 时阈值重试循环会对自己刚写的
  compact checkpoint 再压缩(走 legacy-checkpoint 段,无害的测试专用现象);
  keepFromIdx=0(整个 surface 都在保留尾部内)时正确返回 null 不压缩。
- **fork 子会话不压缩**:自动压缩仅根会话(PLAN 规则 1);摘要 fork / recall
  fork 的 seeded surface 保持原文,否则摘要质量受损(compactIfNeeded 覆写
  parentSession !== undefined → null)。
- **应用顺序事实**:loader 应用顺序 = 条目列表顺序(applyEntryPatches 对
  insert 是 data.push(...insert);EntryTree.entries() 按 store 插入序)。
  之前 patch 注释里"逆序应用"的假设是错的。
- **version 契约踩坑**:第一步当前 stamp version 4(摘要格式九小节 →
  四段 Timeline → 纯时间线时递增)。第二步的 turnSummaryVersions 必须跟进
  接受新 version,否则"未知版本回退原文"会把所有 checkpoint 都退化成
  raw 段——实测冒烟暴露过(默认列表还是 [1,2] 时)。两份插件的兼容
  契约 = version 列表,改格式时必须同步(当前默认 [1,2,3,4])。
- **fork 终审(新增,冒烟实测)**:折叠完成后起主模型 fork(deepseek-v4-pro)
  复查候选摘要。冒烟中主压缩(3 段 = turn-summary×2 + raw×1,3 次调用,
  fold 4631 chars)的终审被接受(6018 chars,framed 1607 < shadowed 2312),
  review 记录 {provider, model, output} 随 compaction/summary 落盘;legacy
  单 checkpoint 折叠的终审也被接受(5673 chars,framed 1521 < 1607);单
  checkpoint(turn-1 摘要)折叠的终审被 shrink 预检正确拒绝(framed 1092
  >= shadowed 481 → 保留 fold 输出,该折叠随后同样被基类收敛校验拒绝,
  不产生 summary 事件——单 checkpoint 重写不缩小的既有现象)。review fork
  单次耗时 ~20-55s(主模型 + 全历史种子上下文)。

## 4. 语义规则(全计划通用,已确认)

1. 只处理根会话;goal 自动续轮算 turn;纯注入无实际工作的空 turn 跳过;
2. 逐字保留:待决问题及全部选项、用户纠错、路径/命令/错误串/标识符/数值;
3. 召回与逐字保留是互补关系:保留规则保证每轮零成本正确,召回保证低频深挖有路;
   不能因为召回变强就写弱摘要;
4. 替换延迟到用户发起的下一轮 pre-step;摘要未完成就等(有超时),超时放弃;
5. 摘要格式带版本号;未知版本 → 回退原始转录;
6. 摘要语言不指定,模型自选。

## 5. 待办与开放项

- [ ] 第一、二步在 web 环境试运行(需重启 dsh web;观察 turn-memory 与
      replay-compaction 日志、摘要质量、expand_turn 调用日志;据此迭代提示语);
- [x] 标定 recallRecentWindowMs:DeepSeek 官方文档无固定缓存时长数字,只说
      "不再使用后自动清除,通常几小时至几天"(best-effort,命中需完整匹配已持久化
      的 cache prefix unit);取官方下限附近 7200000(2 小时)为默认值,可配置。
- [x] 第二步插件实现(见第 3 节);compaction/summary 多调用信封 schema 扩展
      (pnpm patch 形式,见 3.5);
- [x] 主模型 fork 终审实现并冒烟(review 落盘记录、shrink 预检拒绝路径实测,
      见 3.6 / 3.8);
- [ ] 终审在 web 环境试运行观察(主模型复查的修正质量与每次压缩的额外成本;
      可用 reviewEnabled:false 关闭);
- [ ] 第二步后:超长 turn 拆段(一个 turn 多个摘要段)评估;
- [ ] 跨压缩缓存复用的"超段"方案评估(可选优化);
- [x] 未知版本 turn 摘要的回退路径实测(冒烟中真实触发:默认列表缺 v3 →
      buildSegments 回退 raw transcript,行为符合规格;已把 [1,2,3] 纳入默认);
- [ ] turn-memory 修复(foreign checkpoint 排除,见 3.8)的回归:第一步自身
      冒烟 + web 试运行观察。

## 6. 关键文件与代码索引

- 插件:dsh-plugin-turn-memory 的 index.js / package.json / README.md
  (位于 ~/projects/vilicvane/dsh-plugin-turn-memory/)
- 第二步插件:dsh-plugin-replay-compaction 的 index.js / package.json /
  README.md / patches/(两个 pnpm patch)/ pnpm-lock.yaml
  (位于 ~/projects/vilicvane/dsh-plugin-replay-compaction/;patch 重装可复现)
- web profile 接线:~/.dsh/profiles/web/ 的 package.json 与 cordis.patch.yml
  (已禁用 compaction-basic、插入 turn-memory + replay-compaction,重启后生效)
- 第二步冒烟测试:~/.dsh/profiles/test-replay-compaction/ 与
  ~/projects/vilicvane/dsh-plugin-replay-test/(throwaway 四轮驱动器)
- 第一步冒烟测试:~/.dsh/profiles/test-turn-memory/ 与
  ~/projects/vilicvane/dsh-plugin-test-runner/(throwaway 双轮驱动器)
- 核心参考(DSH 0.1.0-rc.6,npx checkout =
  /home/vilicvane/.npm/_npx/1e7f6d9597241db0/node_modules,运行中的 web
  服务器实际执行这份代码;~/.dsh/profiles/node_modules 的 @deepseek-ai 是
  指向它的符号链接;linked 插件须自装依赖):
  - dsh-compaction(契约)/ dsh-compaction-basic(summarize 唯一子类钩子;
    commitCompactionBody 只透传固定字段,buildSummarizationInput 不传
    shadowedSeqs——两处均靠 pnpm patch 扩展)
  - dsh-session(SurfaceOp replace、SessionEventMap、KNOWN_SESSION_EVENT_TYPES)
  - dsh-subagent(ctx.subagents.start;fork seed = 父会话原始事件前缀)
  - dsh-agent-loop(agent/status idle、agent/pre-step 瀑布;waterfall 按注册序
    FIFO,preStep 的 claimed messages 在瀑布之后才 append 上 surface)
  - dsh-llm(BlockAssembler / createUserMessage / createToolResultMessage /
    FinishReason;purpose 字段:'compaction' → x-deepseek-harness-compact:1 头,
    'session-title' → thinking:disabled,reasoningEffort 'off' → thinking:disabled)
  - dsh-tools(defineTool;可选参数省略 required)
  - dsh-system-prompt(ctx.systemPrompt.section,order 100-199 为工具指引段)
  - cordis-plugin-loader(EntryTree.entries() 按 Object.values(store) 迭代 =
    store 插入序;EntryGroup.update 按列表序 create → applyEntryPatches 的
    insert 按列表序 data.push → **loader 应用顺序 = 条目列表顺序,不是逆序**)

## 7. 其他已记录结论

- 压缩在"模型可见上下文"层面有损、在磁盘数据层面无损(原始事件全部保留、可重放);
- 模型没有一等的历史召回通道,expand_turn 即为此补上的设计内通道;
- 本会话的完整原始记录曾用 libzstd + ctypes 现场解压验证(1522 帧、2202 事件),
  证明旁路读取可行但非设计路径;
- 运行中的 dsh web 服务器实际执行 npx checkout 的代码
  (/home/vilicvane/.npm/_npx/1e7f6d9597241db0/node_modules),重启须走
  ~/.dsh/restart-web.sh(30 秒延迟脚本,见 dsh-web-restart 技能);
- 会话日志是折叠存储(存储行数 ≠ 事件数,chunk 合批);surface 只有
  user/message、assistant/message、tool/result 三种类型,tool/call 不在
  surface 上——配平校验必须遍历日志区间。

## 8. compact_turn(长 turn 主动压缩)

- 需求:turn 46 提出"指示模型主动停下来完成一次压缩",避免只依赖自动压力触发。
- 尾部保留决策(2026-08-15):暂不保留尾巴,只留 turn 起始消息逐字、当前
  step 不动,压缩最彻底——理由:不留尾巴时 prompt 好坏对结果的影响更清晰,
  便于观察摘要质量;后续可再加"保留最近一步/节点"。
- 范围 = 当前 turn surface 上,起始消息之后、当前 step 的 assistant 消息
  之前的所有节点(含 runtime 快照与技能目录消息;它们的内容由压缩器归入
  checkpoint);连续压缩语义由 surface 机制背书(turn 47/48 已钉死):
  已压缩部分不会再次进入压缩输入,旧 checkpoint 若再次被选中则以一条浓缩
  摘要参与合并。
- 工具性质:模型工具 compact_turn,参数 summary(必填,checkpoint 文本),
  可选 turn 参数(整 turn 模式,见 11);
  isConcurrencySafe: () => false 独占执行,保证 compactRegion 的
  whole-surface stability 事务不被并发工具破坏;范围经日志区间工具配对
  平衡走查后才提交;root 会话专用。
- 配套修改:tryReplace 与 agent/created 恢复路径移除了"turn 内发生过压缩
  即跳过"的旧逻辑——turn 自己的压缩 checkpoint 纳入替换 span,最终 turn
  摘要把中途 checkpoint 与尾巴收敛成一条记录(收敛合并,非原文重喂)。
- 实现于 turn 50;未重启、未提交(等用户核对后指示)。
- 条件式尾部提醒(需求来源 turn 51,实现于 turn 52):走 runtime-context 快照
  通道,每 step 重评估、自我替换、位于上下文末尾;当前 turn surface 节点数
  超过 reminderNodeThreshold(默认 30,按节点数不按 token——用户明确
  要求)时快照末尾出现一行提醒,1.5 倍阈值升级为直接警告;低于阈值零贡献
  零 token,压缩落地后 turn 缩回阈值以下提醒自行消失。仅根会话、内容稳定。

## 9. 过渡期统一:compaction-basic 指令补丁(已撤销)

- 起因(turn 57):当时以为 web 仍以 harness 自带 dsh-compaction-basic 为压缩
  后端,给 npx 安装锚点里的 COMPACTION_INSTRUCTION 打了时间线语义补丁,并
  固化补丁脚本 scripts/patch-compaction-instruction.py。
- 勘误(turn 58):web profile 的 cordis.patch.yml 自 2026-08-15 02:28 起就已
  `compaction-basic: disabled` 并插入 replay-compaction——运行中的服务器从未
  加载 compaction-basic,补丁是死代码;补丁脚本、本节的"过渡期必需"措辞、
  技能里的过渡期条目都建立在错误前提上。
- 撤销(turn 59,用户选 A):从 npm 下载
  `@deepseek-ai/dsh-compaction-basic@0.1.0-rc.6` 原版 tarball 还原锚点内
  lib/index.js(九段指令、drop stale 措辞回归,node --check 通过);删除
  scripts/patch-compaction-instruction.py。统一时间线原则由
  replay-compaction 自身指令(FIXED_INSTRUCTION / REVIEW_INSTRUCTION)保证。
- 真实记录:压缩后端现状 = replay-compaction(turn 内 compact_turn 与压力
  压缩都由它执行);compaction-basic 已退役,无需任何补丁。

## 10. 模型分工:turn 内压缩摘要走主模型 fork(turn 59 用户选 B)

- 需求(turn 59):turn 54/57 两次 turn 内压缩各耗时 3.5 分钟,取证显示
  provider/model = deepseek-chat——compact_turn 只算范围、摘要委托
  ctx.compaction,后端换成 replay-compaction 后意外落到它的 chat 默认值
  (当初第二步"便宜模型"的决定);用户选择 B:架构分离,turn 内 = 主模型、
  session = chat,互不牵扯。用户明确表示本就没打算与 session 压缩扯上关系。
- 实现:
  - turn-memory:compact_turn 先 spawn 主模型 fork 生成摘要——fork 的 seed
    止于最后 turn/end、看不到未完成 turn,故区间转录随 prompt 送达
    (buildCompactSummaryPrompt,时间线语义与 turn 摘要同一套原则);随后调
    后端 compactRegionWithSummary(start, end, agent, summary, envelope,
    signal);后端无此入口时回退 compactRegion(自带摘要)。
  - replay-compaction:新增 compactRegionWithSummary——把预供摘要挂到
    pendingSummaries(按 agent),调用继承的 compactRegion;基类
    regionDependencies 动态派发 this.summarize,summarize() 头部按
    input.shadowedSeqs 首尾匹配 pending 后直接返回该摘要(匹配不上则走
    原折叠路径)。锁、whole-surface 稳定性、收缩校验、事件序列、持久化全部
    复用继承事务,零事务复制;匹配校验使 pending 不会被同 agent 的其他
    压缩误消费。
- 附带收益:慢的问题消失——主模型 fork 与 turn 摘要同路径(约 30 秒),
  不再触发 deepseek-chat 的 reasoning 慢路径。
- 状态:实现于 turn 60,两插件 node --check 通过;未重启、未提交。
- 后续:turn 结束摘要同样改由主会话自拟、fork 退为兜底,见 11。

- 变更(当前上下文自拟,替代 fork 主体):用户要求 compact_turn 的主体
  不再走 fork——当前上下文(主模型自身)在调用前按 dsh-compact-turn
  技能(插件内嵌,rank 250,项目级同名技能可覆盖)自拟 checkpoint 文本,
  随 summary 参数传入。工具保留范围校验(根会话、tool-pair 平衡、端点
  选择)与 compactRegionWithSummary 事务(锁/稳定性/收缩校验全部复用),
  envelope 只带 {provider, model}(不再有 fork rawOutput)。撰写规则从
  buildCompactSummaryPrompt 移入该技能(时间线语义不变);
  replay-compaction 后端契约零改动;MEMORY_SECTION 与工具描述都点名
  该技能,模型压缩前先 skill 加载再自拟。状态:node --check 通过;
  未重启、未提交。

## 11. 整 turn 摘要改由主会话自拟(fork 只作兜底)

- 需求:turn 结束摘要与 turn 内压缩统一由主会话(当前上下文)撰写;时机选在
  下一条用户消息到来时——用户的新问题进入上下文,作为"保留什么"的取舍透镜,
  帮助 agent 写摘要。
- 行为:
  - turn/end(idle)→ 该 turn 只登记 pending,零模型调用;
  - 下一条消息 → runtime 上下文(context contributor,order 131)出现 pending
    提示,主 agent 先按 dsh-compact-turn 技能撰写上一 turn 的整 turn
    checkpoint(上一 turn 用户原话逐字进摘要,或写 <verbatim kind="turn-prompt"/>
    由替换时还原),再调 compact_turn(turn=N, summary);
  - compact_turn 新增可选 turn 参数:整 turn 模式复用 tryReplace 直接落盘
    (turn-memory 标记 checkpoint,与 fork 兜底同一替换路径),不走压缩后端、
    无收缩校验;turn 内模式(无 turn 参数)不变;
  - 主 agent 整个下一 turn 都没做 → 该 turn 结束时主模型 fork 兜底补摘要
    (晚一个 turn,再下一个 pre-step 落地);fork 失败后每 turn 重试一次;
  - 服务器重启恢复:最后一个无 checkpoint 的已完成 turn 重新登记 pending,
    由恢复后的主 agent 撰写(不再 spawn 恢复 fork)。
- 理由:与 turn 内压缩对齐(同一撰写者、同一技能);用户下一个问题进入提示,
  摘要能保留与后续相关的内容;fork 退化为兜底,正常路径零额外模型调用。
- 状态:实现于 2026-08-15;node --check 通过;未重启、未提交(等重启后实测)。

## 12. expand_turn 双模式 + 时间路由(2026-08-15)

- 需求(turn 8):mode 只留 raw、agentic 两种;agentic 内部根据 turn 的时间
  决定是用之前的 checkpoint + 提示词由主会话回答,还是用 cheap 模型回答;
  用户明确倾向放宽种种限制。
- 实现:
  - mode enum ['agentic','raw'],默认 agentic;question 仅 agentic 必填;
    auto/fork/subagent 三种显式 mode 删除,路由内化为实现细节;
  - findTurnSpan 顺带返回 turn/start、turn/end 的 time(SessionEvent 自带
    epoch ms);routeAgenticRecall:span.endTime ?? span.startTime 距今 ≤
    recallRecentWindowMs(默认 7200000,2 小时)→ fork,否则 → subagent
    (cheap 模型读完整转录);无时间戳回退 newest−2 轮距;
  - recallForkPrompt:上下文是父会话已完成 turn 的原始全文重放(不是
    checkpoint),目标 turn 全文直接作答;fork 内缺失部分可用 expand_turn
    mode raw 补齐;
  - turn 9 修正:初版"fork 凭 checkpoint 回答、窗口 3600000"基于错误假设
    (fork seed = 父会话原始日志事件,读 dsh-subagent-fork-in-process 的
    completedTurnPrefix 确认);fork 仅当 provider 磁盘缓存保留着这些 turn
    直播时持久化的 prefix unit 时才是暖的;DeepSeek 官方缓存无固定时长
    ("不再使用后自动清除,通常几小时至几天",best-effort),窗口改取官方下限
    附近 2 小时;raw 定位改为"主会话上下文本就有所有 checkpoint"的质量兜底。
  - 放宽:cheapMaxTokens 4096→8192(旧值实测 max-tokens 失败)、maxRawChars
    200000→500000、近期窗口从 recentTurnThreshold 轮数制改为时间制;
  - 保留的守卫:tool-pair 平衡校验、收缩校验、toolResultCapChars 20000、
    recallTimeoutMs 180000、maxRecallDepth 4。
- 状态:turn 9 修正后 node --check 通过;未提交。

## 13. compact_turn turn 内边界 bug 修复 + TS 化与单元测试(turn 10)

- 现象:turn 内 compact_turn 承诺"turn 起始消息逐字保留",实测 turns 7/8/9 的
  turn 内折叠区间都恰好从该 turn 的用户消息 seq 开始(204683/262046/308409),
  用户消息被折进 checkpoint、脱离 surface;撰写 turn 8/9 摘要时上下文里已看
  不到目标 turn 的用户消息,只能从日志恢复(turn 7 摘要首行因此是转述而非逐字)。
- 根因:spanStart = nodes.findIndex(seq > turnStart.seq) 按 position 顺序查找;
  前序 turn 的替换 checkpoint 位置在 open turn 之前、其 seq 又大于当前
  turn/start,查找提前一步停在 checkpoint 上,startSeq = nodes[spanStart+1]
  恰好是用户消息,被纳入折叠区间。佐证:4 条 turn 内折叠中除第一条(11707,当时
  surface 尚无 checkpoint)外,替换起点全部等于各自 turn 的用户消息 seq。
- 修复:改为找 surface 上 seq 大于 turn/start 的最小 seq 节点(open turn 的
  用户消息),再取其下一张作为折叠起点。
- 随修复把插件 TS 化(index.js → index.ts,git mv 保留历史):纯边界逻辑抽到
  lib/bounds.ts(computeSpanBoundaries / computeWalkRange / checkToolPairBalance)
  与 lib/routing.ts(routeRecallByAge),入口只做调用;node 24 原生 type stripping
  直接跑 .ts、零构建(入口 exports 指 index.ts);tsconfig 开 erasableSyntaxOnly,
  lib 全量严格定型,入口文件增量定型(noImplicitAny 关,消费 harness 运行时用
  结构类型)。
- 单元测试 test/bounds.test.ts + test/routing.test.ts(node:test,17 例,含
  spanStart 回归用例:前序 checkpoint 大 seq 下用户消息绝不入折叠区间),
  pnpm test 17/17 通过;pnpm typecheck 通过(dsh-tools 自带 .d.ts,tsc 首次跑出
  34 个真实类型错误——findLastEvent 可选参、catch 变量、空数组 never[]、
  Promise<void> 等——已全部修正)。
- 工作流改为:改 index.ts / lib/*.ts → pnpm typecheck + pnpm test → 走
  dsh-web-restart 重启生效(包内技能文案、README 已同步)。
- 状态:typecheck + 17 测试通过;重启调度中(30 秒延迟,由下一 turn 以运行时
  证据验证新代码生效);未提交。

## 14. 压缩边界 request-prefix dump(turn 11)

- 需求:compact_turn 落盘后,把"等价于下一 request 前缀"的接缝信息写进项目内
  临时目录,只留最后两个节点(checkpoint + 其后第一个保留节点),肉眼确认边界。
- 实现:新增配置 prefixDumpDir(默认 ''=关闭);三个替换路径(turn 内压缩事务、
  compact_turn 整 turn 替换、fork 兜底替换)落盘后,把接缝两节点按 request
  前缀里的文本形态渲染(lib/prefix.ts 纯函数 renderBoundaryNode /
  renderPrefixBoundary)追加写入 <dir>/request-prefix.txt。turn 内模式的
  header 另注一行:保留在 checkpoint 之前的 turn 起始用户消息 seq。tool/result
  节点只占一行占位(名字或 callId),不发全文,保持接缝可读。
- turn 13 变更:用户要求保留全部边界记录——dump 从单文件覆盖改为追加:新增
  纯函数 appendDumpBlock(existing, block)(lib/prefix.ts),首块原样写入、后续
  块接在分隔线(DUMP_BLOCK_SEPARATOR)之后;dumpPrefixBoundary 改为读旧文件
  再拼接写回。旧文件内容保留,新块接在末尾,文件只增不减。
- 测试:test/prefix.test.ts(12 例,含 next=null 的 surface 尾部场景与
  appendDumpBlock 的累积/分隔/顺序)。
- 本机 profile(cordis.patch.yml)已把 prefixDumpDir 指向本项目 .tmp/
  (.gitignore 排除);生效需 dsh web 重启,由下一 turn 的压缩以文件存在为证。
- 状态:重启调度中;未提交。
