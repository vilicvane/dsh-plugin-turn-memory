# Turn Memory Design

本文档记录 turn-memory 新实现经过调研并确认的设计约定，是后续实现、测试和评审的规范来源。

- 所有新实现必须遵循本文档中标记为“已确认”的约定。
- 每项候选约定必须先完成可行性调研；只有结论、成立条件和限制明确后，才可标记为“已确认”并写入本文档。
- 约定按调研顺序逐条加入；尚未写入本文档的行为视为未定，不从旧实现中默认继承。
- `obsolete/` 仅供调研和追溯，不具有规范效力。

## D-001：turn 结束后的 fork 摘要与 N→M surface 替换

状态：**已确认（方向可行，M>N 落地语义尚待单独设计）**

### 约定

- 需要压缩的主会话 turn 完成后，从该主会话启动一个 one-shot `fork` subagent，由它基于父会话上下文生成该 turn 的摘要／改写结果。
- 摘要结果不限定为单个 checkpoint。选中的 N 个当前 surface 节点将转换为 M 个摘要节点；原始事件继续保留在 append-only session log 中。本条不预先规定 M 与 N 的大小关系。
- 纯 replacement 路径的 N→M 含义是：把这 N 个节点划分为 M 个非空、连续且互不重叠的区间，每个区间追加一个 replacement surface event，合计精确覆盖原 N 个节点。该路径天然要求 `1 <= M <= N`；M>N 需要使用下面所述的 append-assisted 路径，不能伪装成纯 replacement。

### 可行性依据

- 当前 `fork` provider 会截取父 session 从 seq 0 到最近一个 `turn/end`（含）作为 child seed；未闭合的当前 turn 会被排除。因此，在目标 `turn/end` 出现后启动 fork，child 能继承该已完成 turn，同时 seed 仍是平衡、可回放的 session 前缀。
- one-shot fork 原生提供 `result`、可选 structured output 和明确的 `dispose()` 生命周期，足以承载“生成改写方案并交还主插件验证／落地”的流程。
- 当前 `Session` 的 positional replacement 一次只能把一个当前连续区间替换为一个新 surface 节点，但可以连续执行 M 次。针对 N=4、M=2 的本地探针已验证：实时 surface、`deriveMessages()`、完整 `foldSurface()` 回放和重新冷加载得到相同的两个节点。
- surface 还允许把消息追加到尾部，因此“整个 API 只能 M<=N”并不成立。对于仍位于 surface 尾部的目标区间，可以先 append 额外的 M-1 个节点，再用一个 replacement 把原 N 个节点变为第一个结果节点。本地 N=2、M=3 探针已通过完整回放和冷加载。

### 已知硬约束

- 每个 replacement 的 `start`／`end` 必须仍是当前 surface 上的节点，范围必须连续；`sourceEventSeqs` 必须包含该次遮蔽的全部当前节点。
- replacement event 自身必须是可持久化、可冷加载的完整消息。`tool/result` 只能一对一改写当前 tool result，并且只能改变其 result content；模型侧的 tool call/result 配对还需要由规划和验证逻辑额外保证。
- 本设计假设 replacement 的同步提交期间进程不会突然停止，且没有其他写者改动目标 surface；不设计 multi-event 原子事务、回滚、transaction identity 或部分提交恢复。实现的正确性边界是提交前验证完整替换产物：确认目标 surface 仍符合计划，所有消息、范围、覆盖关系、生命周期和 tool pairing 均有效，然后在一个不含 `await` 的同步代码段中连续 append。验证通过后的同步 append 预期全部成功；任何抛错均视为规划／实现 bug。
- 若要求“每个 turn 都触发”，完成事实应以 `session/event` 中的 `turn/end` 为准，不能只依赖 `agent/status: idle`：后者表示整个 driver drain 区间结束，连续排队的多个 turn 之间不一定出现 idle。
- 当前 surface 没有 insert-before／insert-after 或空区间 replace。append-assisted 的 M>N 只能直接用于仍在 surface 尾部的区间；目标后面已有节点时，额外节点只会落到整个 surface 尾部。重建并重排全部后缀在机制上可以绕过位置限制，但会复制 transcript 和工具协议状态，不视为可接受的常规方案。
- append-assisted M>N 的额外节点属于 append-origin，human transcript 会把它们当成新增历史，而不是 model-only replacement copy；若使用占位节点再一对一替换，占位节点仍永久留在 append-only transcript 中。此外，在 turn 之间直接追加而不违反核心执行事件约定的实用消息类型主要是 `user/message`。因此该技巧目前只证明“机制可达”，不等于已经接受为产品语义。
- `MessageSource` 是生产者自报的 provenance，不是认证边界。当前 Chat 投影只凭 append-origin `user/message` 的 `source.kind === "user"` 把它显示成普通用户气泡；插件可以模仿这一外观。若直接在 turn 之间 append，原始日志仍可从缺少 inbox admission、且事件位于 turn／step 之外看出差异；若插件把消息交给 agent inbox 或 `agent/pre-step` 再由 loop append，连这些常规形状也可以模仿。因此这里的 transcript 问题是历史真实性和产品语义问题，不是无法伪造的技术身份隔离。
- assistant 与 tool 不同：启用 session relational invariant 时，append-origin `assistant/message` 必须位于匹配的开放 turn／step 内，append-origin `tool/result` 还必须与同一步中的 `tool/call` 配对。turn 结束后的简单 append 不能合法伪装成独立模型输出或工具结果；要做到这一点必须接管或参与真实 agent-loop／LLM／tool 生命周期，已经不是普通的 surface 落地操作。

### 本条未决定

- 哪些主会话／turn 具备压缩资格，以及目标 N 节点的选择规则。
- M 个节点的角色、内容格式、structured-output schema，以及是否保留 turn 起始 user message。
- fork 与下一 turn 的并发关系，是否设置下一次 request barrier，以及何时执行 `session/flush`。
- 替换产物的表示方式及其完整正确性验证规则。
- 是否接受 append-assisted M>N 的 transcript 语义；若不接受，新实现就应明确限制为纯 replacement 的 `M <= N`。
- 若接受 append-assisted M>N，额外节点应诚实标记为 plugin context，还是有意投影成普通 user message。

## D-002：fork subagent 的内存节点编辑协议

状态：**已确认（`replace_turn_nodes` 的 K→1 部分已由 D-003 取代）**

### 约定

- fork subagent 直接从继承的父会话上下文理解待总结内容；插件在初始任务 prompt 中同时提供目标 surface 的紧凑目录，使内容理解与节点寻址在第一次模型请求里同时就绪，不要求 subagent 先调用一次目录工具。
- 初始节点使用不暴露 session seq 的 opaque id（如 `n1`、`n2`）；编辑生成的新节点使用新的 opaque id（如 `r1`、`r2`）。被替换节点的 id 立即失效，新节点可以在后续调用中再次被整节点改写，或与相邻节点继续合并。
- 编辑只修改一个与父 session 隔离的内存 working surface。subagent 推理期间不写父 session；只有 finish 成功、host 完成最终产物验证后，host 才把 working surface 转换成 D-001 所述的 surface operations。
- 首版工具能力固定为：
  - `list_turn_nodes`：返回当前 working surface 的完整富目录；
  - `read_turn_nodes`：一次读取多个 id 或连续范围的当前完整内容，并受单次总输出上限约束；
  - `replace_turn_nodes`：首版把一个当前节点或当前连续区间替换为一个新节点；该 K→1 形态已由 D-003 的联合 K→M 取代；
  - `finish_turn_compression`（由 D-003 更名）：请求 host 验证最终 working surface，并以 authoritative tool result 结束 child turn。
- 每次 `replace_turn_nodes` 成功后必须返回完整的当前**结构目录**：包含所有新节点 id、landing slice、semantic sources，以及所有当前节点的顺序、kind 和 changed/unchanged 状态。它不重复返回所有节点的完整内容；需要富目录时调用 `list_turn_nodes`，需要正文时调用批量 `read_turn_nodes`。
- 首版 working node 只有一类“覆盖集合”；D-003 将其拆为可重叠的 semantic sources 与构成有序无遗漏分区的 landing slices，以支持联合 K→M。
- state-changing 工具按 exclusive 执行；一次 replacement 只按调用开始时的 working surface 解析一个连续范围。若下一步需要引用本次刚生成的 id，必须在后续工具调用中进行。
- subagent 不构造 `surfaceOp`、`sourceEventSeqs`、session seq、message id、turn／step 或 tool pairing 元数据；这些均由 host 从最终分区及原始事件推导并验证。
- `finish_turn_compression` 是唯一成功出口：只有其验证通过并调用 `concludeTurn()`，host 才接受产物。普通文本 `DONE`、child 自然停止或未调用 finish 均不构成可提交结果。

### 可行性依据

- fork child 能看到父 session 当前 surface 的消息内容，但模型上下文不会给出可供插件安全寻址的 surface seq、精确节点边界或原始覆盖关系；因此“内容已在上下文”与“prompt 内仍需紧凑目录”并不重复，二者分别解决理解和定位。
- `SubagentStartRequest.toolFilter` 会在 child scope 同时限制工具展示与执行，可以让该 child 只看到上述编辑工具；当前 fork provider 明确支持该能力。
- DSH 的 tool execute context 带 owning `agent`，host 可以把调用绑定到对应 fork job；工具成功结果还可以调用 `concludeTurn()`，所以 finish 可以同时充当最终验证点和 one-shot child 的权威结束信号。
- `defineTool` 的 `isConcurrencySafe` 能把 mutation 声明为 exclusive；批量 read 可声明为只读并一次返回多个节点。批量读取不会减少正文自身 token，但会减少固定的 tool-call／tool-result 包装和可能的额外模型轮次。
- 首版探针验证了在内存列表上执行 `n2..n3 → r1`、再执行 `r1 → r2` 或 `r1..n4 → r2` 的可行性；D-003 在此基础上把单输出扩展为联合多输出。

### 已知边界

- subagent 继承的是 fork 时的当前 surface；已经被其他 replacement 遮蔽的原始正文不会因此重新进入 child 上下文。目录和 read 工具也只面向本次 working surface，不隐式提供被遮蔽历史。
- `read_turn_nodes` 的批量参数节省的是调用包装与轮次，不会压缩所读取正文；host 必须设置总字符／token 上限并在超限时要求缩小范围。
- D-003 的联合 K→M 仍受原始 landing capacity 约束并保持最终 `M <= N`。D-001 中 append-assisted 的 M>N 若以后被接受，必须设计成另一个明确的能力，不能隐藏在 `replace_turn_nodes` 里。
- `tool/result` 的最终落地仍受 D-001 的一对一 content-only rewrite 限制；通用节点编辑协议不取消 host 对 role、消息形状和 tool pairing 的最终验证责任。

### 本条未决定

- 初始目录 preview 的最终截断长度，以及富目录对非文本 block、tool call 和 tool result 元数据的具体展示格式。
- 是否在一个调用中支持多个互不相交的 replacement。该能力只节省调用包装，不影响核心表达力，首版不需要。

## D-003：保留交互形态的联合 K→M 压缩

状态：**已确认**

### 约定

- turn-memory 的产物是压缩后的 transcript，不是回顾式的 assistant-only summary。压缩必须保留总体时序、因果演进和可辨认的 user／assistant 交互过程；低价值的连续 working trace 和补充性质的 steer 可以合并，时间或因果上关键的转折、纠正、约束、发现、失败、决策和外部结果应高保真保留，必要时继续作为独立节点。
- 允许把 `user₁ → assistant₁ → user₂ → assistant₂` 联合压缩为 `user′ → assistant′`：`user′` 合并初始意图与后续 steer，`assistant′` 合并原响应、因 steer 发生的调整及最终结果。输出粒度由信息结构决定，不设固定节点数，也不默认把整个 turn 压成一个 assistant 节点。
- working surface 覆盖该 completed turn 的全部当前 surface 节点，包括第一个 user message；否则无法表达“初始请求 + 后续 steer”的联合 user 节点。没有被编辑的 working node 在最终落地时保持原 surface event，不追加等价 replacement copy。
- `replace_turn_nodes` 取代 D-002 的 K→1 版本：一次调用选择一个当前节点或一个当前连续范围，并用 `nodes[]` 提交 1..M 个有序输出。所有输出**共同**派生自完整选中范围，不要求每个输出只总结某个连续输入子区间；成功后为每个输出分配新的 `r*` id，并返回完整结构目录。
- 已生成节点仍可被后续调用选择。只要所选 working range 尚拥有足够的原始 landing positions，一个当前节点也可以被重新拆成多个输出；因此 refinement 可以改变内容、角色和节点数，而不局限于再次 K→1。
- host 对每个 working node 分别维护两种关系：
  - semantic sources：内容实际派生自哪些原始目标节点，联合 K→M 的每个输出都继承所选范围 semantic sources 的有序并集，允许不同输出重叠；
  - landing slice：该节点最终在 surface 上遮蔽哪些原始位置，所有当前节点的 landing slices 始终构成原目标范围的有序、无遗漏、无重叠分区。
- 联合 K→M 时，host 把选中范围拥有的 landing positions 确定性地分成 M 个非空连续切片，只用于持久化位置。每个落地 event 的 `surfaceOp.start/end` 使用自己的切片，但 `sourceEventSeqs` 使用该输出的完整 semantic sources；不得把 landing slice 描述成该输出的唯一语义来源。
- 最终 compressed turn 必须以 user 节点开始、以 assistant 节点结束。subagent 仍不构造 durable session 元数据；唯一成功出口更名为 `finish_turn_compression`，以免 summary 命名把模型推向单一 assistant checkpoint。

### 可行性依据

- 当前 canonical surface 校验对 replacement 的要求是：`start/end` 必须定位一个当前连续范围，且 `sourceEventSeqs` 必须至少包含该次遮蔽的全部当前节点；它允许同时引用其他更早事件。因此多个输出可以分别遮蔽不重叠的 landing slices，同时各自诚实引用完整联合输入作为 provenance。
- editor 可以在父 session 之外完成全部 K→M 规划，再将最终 landing partition 以 M 次同步 replacement append 落地；这仍满足 D-001 的物理 `M <= N` 约束，不需要 append-assisted 插入。
- 新的真实 fork E2E 已完成一次 6→2 联合压缩：首轮生成 user／assistant 两个节点，第二轮使用返回的两个 `r*` id 再次联合改写；最终两个 durable event 均引用全部六个 semantic sources，landing slices 分别遮蔽前三和后三个原节点。实时 surface、完整 `foldSurface()`、`deriveMessages()`、session query 与冷加载结果一致。

### 已知边界

- 输出总数不能超过所选 working range 拥有的原始 landing positions；整个 turn 的最终节点数仍满足 `M <= N`。这里允许的是“一个当前生成节点重新拆分”，不是凭空增加 durable surface positions。
- `tool/result` 若保留为 tool 节点，物理 landing slice 仍必须一对一指向原 tool result，并只能改写 result content。普通 working trace 更适合把完整 tool-call／result 单元一起吸收到 assistant 节点；不能只遮蔽配对的一半。
- `@deepseek-ai/dsh-session` 的 canonical surface 契约支持 turn 结束后的 replacement。`0.1.0-rc.6` 的可选 `@deepseek-ai/dsh-session/invariant` companion 会对 replacement assistant message 继续施加 open-step 约束；当前 base、headless E2E 和测试 Web composition 均未加载该 companion。若未来 profile 启用它，需要先调整 upstream invariant 或改换落地生命周期，不能假设本路径仍可用。
- 多 event 落地继续采用 D-001 的运行假设：提交前完整验证、同步 append 期间没有其他 writer，也不处理进程突然停止造成的部分提交。
