# 上下文压缩改造计划(turn-memory)

> 本文档是"两步式上下文压缩改造"的持久化记录,保存所有设计决策、语义规则、
> 实测结论与待办,防止对话丢失导致信息遗失。最后更新:2026-08-15(第二步实现完成,
> 四轮 headless 冒烟 exit 0;待 web 重启试运行)。

## 1. 背景与总体架构

原机制(dsh-compaction-basic):step 边界按 token 压力(阈值 0.8 × 上下文窗口)
对最旧区间做一次性重放式总结,保留尾部 16%,模型上下文里旧内容被
compacted-summary 替换,原始事件保留在追加日志中。

目标改造分两步,拆成两个独立插件,仅通过磁盘上的 surface checkpoint 格式通信:

| 步骤 | 插件 | 状态 | 职责 |
|---|---|---|---|
| 第一步 | dsh-plugin-turn-memory | 已实现、已实测 | turn 级独立摘要、延迟替换、expand_turn 三档召回 |
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

### 2.3 召回(expand_turn,一个工具三个 mode,模型自选)

- fork:主模型从当前会话状态继续(暖前缀),适合最近 turn 的深挖;
- subagent:便宜模型(deepseek-chat)读全文定向回答,成本隔离在子上下文;
- raw:全文直读,超长截断,最后手段;
- auto 模式按 recentTurnThreshold(默认 3)路由:近 turn → fork,远 turn → subagent。
- 原文取自会话追加日志(排除 reasoning chunks 与 replacement 副本);
  fork 子会话自带父会话原始事件种子,因此摘要 fork 与 recall fork 都能读全文。

### 2.4 持久化与故障语义

- 摘要的持久记录 = 替换 checkpoint(user/message,source 标记
  {kind:'plugin', plugin:'turn-memory', turn, turnSummaryId, version:3}——
  当前版本;摘要格式演进(九小节 → 流式 Timeline)时递增 version。
  不引入自定义 session 事件类型——下游插件事件不在
  KNOWN_SESSION_EVENT_TYPES 内,未经 ignorable 标记会使旧构建拒绝加载日志。
- 失败/超时/取消 → turn 保持原文、无任何标记;第二步对无摘要的 turn 回退原始转录。
- 进程重启丢失 in-memory 待替换状态:该 turn 保持原文(可接受,已确认)。

### 2.5 配置项(均可选)

summaryTimeoutMs 120000 / recallTimeoutMs 180000 / cheapProvider deepseek-official /
cheapModel deepseek-chat / cheapMaxTokens 4096 / recentTurnThreshold 3 /
maxRawChars 200000 / toolResultCapChars 20000 / maxRecallDepth 4。

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

### 3.5 实现要点(按实现后事实修订)

- 子类 BasicCompactionEngine,覆写 summarize();返回契约扩展多调用信封
  (callEnvelopes 数组)。基类 commitCompactionBody 只透传固定字段、会丢弃
  未知键,因此 envelope 落盘需要 DSH core 补丁(pnpm patch,见下)。
- 基类传入的原样重放 input 可忽略,自建段序列;段的来源精确区间靠补丁
  (buildSummarizationInput 返回 shadowedSeqs),不靠从 surface 反推。
- 单次修订失败可重试(revisionRetries,默认 2);整个循环服从 signal;
  工具轮次预算(maxToolRounds,默认 6)耗尽后注入错误结果强制收尾;
  某段缺失回退原文段。
- turn 摘要按 version 识别(默认接受 [1,2]):未知版本 → 该 turn 回退原始转录。

**DSH core pnpm patch(dsh-plugin-replay-compaction/patches/,重装可复现):**

1. dsh-compaction-basic commitCompactionBody:summarize() 返回值带
   callEnvelopes 数组时,compaction/summary 事件负载附加
   {calls: N, lastEnvelope: {provider, model, maxTokens?, usage?, output}}。
2. dsh-compaction-basic buildSummarizationInput:返回值附加 shadowedSeqs
   (精确被替换区间,段序列的唯一输入依据)。
3. dsh-compaction types.d.ts:compaction/summary 负载联合增加第三变体
   {calls, lastEnvelope, rawOutput?: never, llmStreamCall?: never}。
4. dsh-compaction-basic 压力压缩 pre-step 处理器改为先 await next() 再
   压缩(decision 非 enter 或 signal aborted 则跳过):turn-memory 的延迟替换
   先于压缩落盘,压缩消费 turn-summary checkpoint 而非原始转录,且与两插件
   的 wiring 顺序无关(顺序问题实测踩坑,见 3.7)。

### 3.6 与第一步的关系

- 第一步产出 = 第二步的段来源(粒度、格式两者共享,改动需考虑存量会话);
- 第一步的 format version 就是两份插件之间的兼容契约。

### 3.7 实测结论与踩坑(第二步)

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
- **version 契约踩坑**:第一步当前 stamp version 3(摘要格式九小节 →
  流式 Timeline 时递增)。第二步的 turnSummaryVersions 必须跟进接受新
  version,否则"未知版本回退原文"会把所有 checkpoint 都退化成 raw
  段——实测冒烟暴露过一次(默认列表还是 [1,2] 时)。两份插件的兼容
  契约 = version 列表,改格式时必须同步。

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
- [ ] 标定 recentTurnThreshold(依据日志中模型主动调用的 mode 分布);
- [x] 第二步插件实现(见第 3 节);compaction/summary 多调用信封 schema 扩展
      (pnpm patch 形式,见 3.5);
- [ ] 第二步后:超长 turn 拆段(一个 turn 多个摘要段)评估;
- [ ] 跨压缩缓存复用的"超段"方案评估(可选优化);
- [x] 未知版本 turn 摘要的回退路径实测(冒烟中真实触发:默认列表缺 v3 →
      buildSegments 回退 raw transcript,行为符合规格;已把 [1,2,3] 纳入默认);
- [ ] turn-memory 修复(foreign checkpoint 排除,见 3.7)的回归:第一步自身
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
