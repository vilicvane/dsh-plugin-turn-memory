# 上下文压缩改造计划(turn-memory)

> 本文档是"两步式上下文压缩改造"的持久化记录,保存所有设计决策、语义规则、
> 实测结论与待办,防止对话丢失导致信息遗失。最后更新:2026-08-14(第一步完成实测)。

## 1. 背景与总体架构

原机制(dsh-compaction-basic):step 边界按 token 压力(阈值 0.8 × 上下文窗口)
对最旧区间做一次性重放式总结,保留尾部 16%,模型上下文里旧内容被
compacted-summary 替换,原始事件保留在追加日志中。

目标改造分两步,拆成两个独立插件,仅通过磁盘上的 surface checkpoint 格式通信:

| 步骤 | 插件 | 状态 | 职责 |
|---|---|---|---|
| 第一步 | dsh-plugin-turn-memory | 已实现、已实测 | turn 级独立摘要、延迟替换、expand_turn 三档召回 |
| 第二步 | dsh-plugin-replay-compaction(暂定名) | 未开始 | 逐段重放修正式 session 压缩,完全替代 summarize() |

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
  {kind:'plugin', plugin:'turn-memory', turn, turnSummaryId, version:1})。
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

## 3. 第二步:逐段重放修正式 session 压缩(未开始)

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

- 总结器用便宜 chat 模型(deepseek-chat);带工具(可用 expand_turn 读原文),
  因此形态是子 agent 或带工具调用,而非纯重放 + 单次 llm.stream()。
- 用能关闭思考的 purpose(如 compaction/session-title),避免 maxTokens 被隐藏推理吃掉。

### 3.5 实现要点

- 子类 BasicCompactionEngine,覆写 summarize();返回契约扩展多调用信封
  (compaction/summary 事件负载声明合并可扩展,记录 calls 数与最后一次信封);
- 基类传入的原样重放 input 可忽略,自建段序列;
- 单次修订失败可重试;整个循环服从 signal;某段缺失回退原文段;
- turn 摘要按 version 识别:未知版本 → 该 turn 回退原始转录。

### 3.6 与第一步的关系

- 第一步产出 = 第二步的段来源(粒度、格式两者共享,改动需考虑存量会话);
- 第一步的 format version 就是两份插件之间的兼容契约。

## 4. 语义规则(全计划通用,已确认)

1. 只处理根会话;goal 自动续轮算 turn;纯注入无实际工作的空 turn 跳过;
2. 逐字保留:待决问题及全部选项、用户纠错、路径/命令/错误串/标识符/数值;
3. 召回与逐字保留是互补关系:保留规则保证每轮零成本正确,召回保证低频深挖有路;
   不能因为召回变强就写弱摘要;
4. 替换延迟到用户发起的下一轮 pre-step;摘要未完成就等(有超时),超时放弃;
5. 摘要格式带版本号;未知版本 → 回退原始转录;
6. 摘要语言不指定,模型自选。

## 5. 待办与开放项

- [ ] 第一步在 web 环境试运行(需重启 dsh web;观察 turn-memory 日志、摘要质量、
      expand_turn 调用日志;据此迭代提示语);
- [ ] 标定 recentTurnThreshold(依据日志中模型主动调用的 mode 分布);
- [ ] 第二步插件实现(见第 3 节);compaction/summary 多调用信封 schema 扩展;
- [ ] 第二步后:超长 turn 拆段(一个 turn 多个摘要段)评估;
- [ ] 跨压缩缓存复用的"超段"方案评估(可选优化);
- [ ] 未知版本 turn 摘要的回退路径实测。

## 6. 关键文件与代码索引

- 插件:dsh-plugin-turn-memory 的 index.js / package.json / README.md
  (位于 ~/projects/vilicvane/dsh-plugin-turn-memory/)
- web profile 接线:~/.dsh/profiles/web/ 的 package.json 与 cordis.patch.yml
  (重启后生效)
- 冒烟测试:~/.dsh/profiles/test-turn-memory/ 与
  ~/projects/vilicvane/dsh-plugin-test-runner/(throwaway 双轮驱动器)
- 核心参考(DSH 0.1.0-rc.6):
  - dsh-compaction(契约)/ dsh-compaction-basic(summarize 唯一子类钩子)
  - dsh-session(SurfaceOp replace、SessionEventMap、KNOWN_SESSION_EVENT_TYPES)
  - dsh-subagent(ctx.subagents.start;fork seed = 父会话原始事件前缀)
  - dsh-agent-loop(agent/status idle、agent/pre-step 瀑布)
  - dsh-tools(defineTool;可选参数省略 required)
  - dsh-system-prompt(ctx.systemPrompt.section,order 100-199 为工具指引段)

## 7. 其他已记录结论

- 压缩在"模型可见上下文"层面有损、在磁盘数据层面无损(原始事件全部保留、可重放);
- 模型没有一等的历史召回通道,expand_turn 即为此补上的设计内通道;
- 本会话的完整原始记录曾用 libzstd + ctypes 现场解压验证(1522 帧、2202 事件),
  证明旁路读取可行但非设计路径。
