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
- 早期探针用 `SubagentStartRequest.toolFilter` 把 child 限制为上述编辑工具；后续发现这种做法要求工具先存在于 global registry，因而会把 schema 暴露给 parent。D-009 已取代这部分挂载方案，编辑协议与工具体不变。
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
- 保留优先级应考虑信息的可恢复性：灵感与洞见、仍带不确定性的假设、试错和弯路所验证或排除的内容、发现、决策及其理由、结论及其范围和证据，通常难以仅从当前代码或外部状态重新推导，应优先保留。弯路不会因为问题最终解决而自动成为可删除信息；可以压缩机械执行流水，但应保留有意义的尝试、失败原因、所得认识和后续调整之间的因果关系。
- 高保真保留的是语义而非原始节点边界。后续 steer／纠正可以完整融入合并后的 user 节点，assistant 的尝试、失败、调整和结果也可以融入合并后的 assistant 节点；只有交互发生的先后或中间状态本身具有持续的因果价值时，才需要保留为多个 exchange。
- 因用户口误或信息不全而偏离原定路线的工作是一类特殊试错：若后续 steer 揭示的是用户原本就想表达的路线，而非真正改变目标，应联合改写受影响的连续范围，把相关 user 消息合成一个引用了后续 steer 作为 semantic source 的纠正后意图。“用户原本想要什么”与“assistant 实际做过什么”必须独立处理：合并 user 意图不得把 assistant／tool 的尝试、失败或发现改写成用户陈述，也不得因纠正意图而自动删除已经发生且有独立结果的试错；这些工作可压缩进后续 assistant 节点，不必保留原交互边界或原始 tool trace。
- 节点边界表达语义工作单元，不强制 user／assistant 角色交替。相邻同角色节点若承载不同的工作或信息可以保留；只有当边界只是原执行流水的残留、两者实际属于一个 coherent unit 时才应合并。真正改变目标、由中间结果触发用户决策或需要保留未解决分支的 steer 也不属于上述“补全原意”合并规则。
- fork 继承的完整 parent context 只提供语义理解，不替代 working editor 的 provenance。任一改写节点若在内容中使用某条 steer、试错、发现或结果，所选连续范围必须包含承载该信息的当前节点，使返回的 semantic sources 与内容实际来源一致；不得从未选择的 inherited context 偷渡信息。
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
- fork 已继承目标 `turn/end` 及其完整对话上下文，能够直接判断灵感、试错、纠正和结论之间的语义及因果关系；目录只承担已知内容到可编辑 opaque id 的映射。联合 K→M 允许把这些信息保留在重新组织后的 user／assistant 节点中，不要求为每段被保留的信息维持原始节点边界。
- 新的真实 fork E2E 已完成一次 6→2 联合压缩：首轮生成 user／assistant 两个节点，第二轮使用返回的两个 `r*` id 再次联合改写；最终两个 durable event 均引用全部六个 semantic sources，landing slices 分别遮蔽前三和后三个原节点。实时 surface、完整 `foldSurface()`、`deriveMessages()`、session query 与冷加载结果一致。
- worker catalog 和 node reads 不暴露 host-owned landing slice；只暴露每个当前节点仍可贡献的数值 `capacity`。连续选择范围的 capacity 相加并限制输出节点数，足够支持 worker 决定 K→M，而精确 landing partition 仅由 host 维护和校验。

### 已知边界

- 输出总数不能超过所选 working range 拥有的原始 landing positions；整个 turn 的最终节点数仍满足 `M <= N`。这里允许的是“一个当前生成节点重新拆分”，不是凭空增加 durable surface positions。
- `tool/result` 若保留为 tool 节点，物理 landing slice 仍必须一对一指向原 tool result，并只能改写 result content。普通 working trace 更适合把完整 tool-call／result 单元一起吸收到 assistant 节点；不能只遮蔽配对的一半。
- `@deepseek-ai/dsh-session` 的 canonical surface 契约支持 turn 结束后的 replacement。`0.1.0-rc.6` 的可选 `@deepseek-ai/dsh-session/invariant` companion 会对 replacement assistant message 继续施加 open-step 约束；当前 base、headless E2E 和测试 Web composition 均未加载该 companion。若未来 profile 启用它，需要先调整 upstream invariant 或改换落地生命周期，不能假设本路径仍可用。
- 多 event 落地继续采用 D-001 的运行假设：提交前完整验证、同步 append 期间没有其他 writer，也不处理进程突然停止造成的部分提交。

## D-004：实时读取的 Markdown prompt 模板

状态：**已确认**

### 约定

- fork 的完整行为 prompt 以独立 Markdown 文件 `prompts/turn-compression.md` 为唯一正文来源，使每次 prompt 重构都能直接审视完整文档；TypeScript 不再用字符串数组维护另一份行为说明。
- 每次创建 compression fork 前重新读取模板文件。模板修改对下一个 completed turn 立即生效，无需重启 Web；单个 job 在启动时得到一次完整渲染，执行期间不受后续文件修改影响。
- 模板只需要原样标量替换 `{{name}}` 与非嵌套条件块 `{{#if flag}}...{{/if}}`。当前使用项目内严格小型 renderer，不引入通用模板依赖，也不支持 helper、partial、`else`、嵌套条件或任意表达式。
- renderer 对未知变量、未知条件和残留模板表达式直接失败。目录正文按原样插入，不做 HTML escaping；模板作者负责只把 host 已构造的 prompt 数据传入已知占位符。
- 生产协议与 deterministic E2E 指令共用一份模板，但 E2E 内容必须完全位于 `e2eSmoke` 条件块内；关闭条件后的渲染结果不得包含任何 smoke 指令或 sentinel。

### 可行性依据

- Node ESM 可以用相对 `import.meta.url` 稳定定位并同步读取包内 Markdown 资源；发布文件列表显式包含 `prompts/*.md`，link profile 与打包安装使用同一路径语义。prompt 每个 completed turn 只读取一次，文件体量很小，同步读取不会进入模型或工具的长时执行路径。
- 当前动态内容只有初始节点目录、原始节点数、四个 smoke sentinel 和一个布尔条件，简单 renderer 足以完整表达且可用单元测试穷举其语法边界，无需承担 Handlebars 的额外依赖和能力面。

### 已知边界

- 模板文件缺失、读取失败或渲染失败会使该 turn 的 compression job 失败并保留原始 surface；不会回退到进程内缓存的旧 prompt，因为那会破坏“修改立即生效”的语义。
- 若将来确实需要嵌套、循环、escaping policy 或复用 partial，应重新调研模板能力并更新本条；不得在小型 renderer 上逐步堆出一个未经设计的通用模板语言。

## D-005：同插件内的自定义 session compaction engine

状态：**已确认**

### 约定

- turn-memory 插件同时提供逐 turn 改写和 session-level compaction，但两者仍是两个语义层：前者把一个 completed turn 压缩成较短 transcript，后者在上下文压力或显式 `/compact` 时把一段 canonical surface 合成为一个 session checkpoint。
- session-level 实现直接继承公开的 `CompactionEngine`，不继承 `BasicCompactionEngine`，也不从旧 replay-compaction 继承 segment、patch loop、cheap model、review 或 checkpoint 格式。旧实现只作为失败经验来源。
- session-level engine 只改写没有 `parentSession` 的根会话。compaction fork／spawn 以及其他 child agent 不递归触发这一层；fork 在上下文压力下失败时进入既定 fresh-spawn fallback。
- session compaction 直接读取开始时的 canonical surface；逐 turn 改写与 session compaction 共享 per-session coordinator。自动 compaction 在选择范围前等待已经启动的前一 turn 改写结束，避免一边读取旧节点、一边由另一 writer 替换同一 surface。
- 自动 pressure compaction 使用当前路由模型的 context window 和 token-meter：默认在 80% 压力触发，并保留至少 16% context window 的近期 canonical tail。range 的两端还必须落在完整 turn／standalone checkpoint 单元边界；若 token cut 落在 turn 内就向更早边界扩张 retained tail。context-overflow 可越过普通阈值，但仍不得把当前未完成 turn 纳入 checkpoint。
- 当前上游 token-meter 会把每条 `assistant/message` 都当作 provider step 的成功输出，即使它是 turn 结束后追加的 surface replacement；因此遇到精确指向 `source.plugin=turn-memory` replacement 的 `no matching step/start` 时，本 engine 改为用 token-meter 的单消息估价重新定价当前 canonical surface，并加上同一固定启发式的 system/tools envelope。fallback 不读取已遮蔽历史，也不吞掉其他 token-meter 错误。
- 每次成功操作只产生一个 durable checkpoint user message，并遵循标准事件协议：`compaction/start → compaction/summary → 紧邻的 replacement user/message → compaction/end`。replacement source 使用 `compactCheckpointSource(compactionId)`；`summary` 记录准确的 shadowed range、surface-order seqs、shadow token 价格及实际 worker 路由。
- 所有模型工作期间只维护 host-owned in-memory working checkpoint，原 surface 保持不变。全部段完成、最终内容非空、覆盖完整、selected span 仍稳定、tool-pairing 边界仍平衡且新 checkpoint 的估算 token 严格小于被替换内容后，才在无 `await` 的同步提交段追加 summary、replacement 和成功 end。
- 任一 worker、验证或提交前阶段失败都保留原 surface，并尽力追加带 error 的 `compaction/end`。manual compaction 通过 `agent.runMaintenance()` 串行化并在闭合 marker 后 flush；automatic compaction 的 marker owner 是当前 open turn。

### 可行性依据

- `@deepseek-ai/dsh-compaction` 公开了 `CompactionEngine`、checkpoint source、tool-pairing 边界检查和完整事件类型；`@deepseek-ai/dsh-token-meter` 公开了 replay-aware 的总压力及按当前 surface 顺序排列的 `{seq,tokens}`。因此自定义 backend 无需访问 `BasicCompactionEngine` 的未导出 transaction helper。
- 本地 public-API 探针已验证：detached session 可以只用公开 append API写入标准 marker、summary 和 replacement，实时 surface 与完整 replay fold 一致。
- 自动 compaction 发生在当前 turn 内时，新的 checkpoint event seq 可能高于 `turn/start`，却位于 surface 头部。实测证明按 `seq > turn/start.seq` 识别 turn 节点会把 checkpoint 错算进当前 turn，并得到非连续目标。因此 turn 归属必须排除 compact checkpoint provenance，再验证剩余目标在 surface 上连续。

### 已知边界

- 启用本 engine 的 profile 必须停用其他 `ctx.compaction` provider，例如 stock `compaction-basic` 或旧 replay-compaction；一个 Cordis context 只能有一个该服务实现。
- session checkpoint 的物理角色是一个 plugin-origin user message；“保留对话形态”由其正文中的结构化 chronological transcript 表达，不会伪造多条新的 human/model durable transcript event。
- 当前实现只压缩 completed history。若一个无法拆分的单 turn 或 retained request envelope 自身超过模型窗口，session surface replacement 无法修复。
- canonical-surface fallback 没有上游 meter 内部的 provider usage anchor，只能使用相同的四字符启发式；含大量 CJK 或 provider tokenizer 偏差的会话，其自动 pressure 触发点不如正常 meter 路径精确。manual `/compact` 的范围选择和 replacement 定价仍保持自洽。

## D-006：主模型 fork 优先的分段 working checkpoint

状态：**已确认**

### 约定

- 一个 session compaction job 先把选中的 surface range 按 completed turn 边界聚合成 token-budgeted segments；已被 turn-memory 压缩的 turn 仍作为不可拆分的自然单元。超出 segment budget 的单一 turn 单独成段，不在 tool call/result 或 turn 内强行切开。
- host 初始化一个由 segment placeholder 构成的 working checkpoint，并顺序处理各段。每个 worker 只负责一个 assigned segment，但可以把当前段与相邻的既有 memory nodes 联合改写，以便让后来的结论解决前面的假设、合并连续工作，或保留必要的因果过渡。
- 每段首先启动与 parent 使用相同 provider/model 的 one-shot `fork`。当前 fork provider 只能继承从 seq 0 到最近 completed `turn/end` 的完整前缀，不能接受 history range；因此“从 checkpoint fork 指定分段”实现为：fork 提供语义背景，host prompt 指定本次 segment 和 working-checkpoint revision，工具提供精确寻址。
- fork 因 context pressure、transport 或未完成协议而失败时，可以换成同一主模型的 fresh `spawn` 继续同一 host-owned revision。fresh worker 的 prompt 会内嵌 assigned segment 正文；它不依赖前一个 child 的隐藏上下文。有限重试耗尽后整个 compaction 失败，不提交半成品。
- 模型可见状态采用两级目录：全局 segment 目录只列 segment id、turn 范围、token/node 数、首尾 preview、状态和 revision；assigned segment 再列 opaque source-node id 与 preview，read 工具可在一次调用中展开多个单节点或连续节点范围。working checkpoint 另有可分页目录、批量 read 和 search，避免在 1M context 下每轮返回全部节点。
- state-changing 工具在一个 expected revision 上把一个当前 memory node／连续范围替换成若干有序 user/assistant memory nodes。初次处理某段时所选范围必须包含该段 placeholder；后续重试可以继续编辑已带该 segment provenance 的生成节点。mutation 返回新 revision、created ids 和局部 neighborhood，不返回完整全局目录；旧 id 或旧 revision 明确失败。
- `finish_session_segment` 是每个 worker 的唯一成功出口。host 验证 assigned segment 已被 memory nodes 覆盖且其 placeholder 消失后才推进下一段。最后一个 worker 完成并不直接写 session；host 还要验证所有 segment coverage 并渲染、定价、提交最终 checkpoint。
- 后段的预热内容不是完整重放前面各段，而是 working checkpoint 的近期 causal handoff：仍未解决的问题、活跃假设、决定、关键发现和最近交互尾部。worker 随时可通过 list/read/search 回看更早 memory nodes。
- worker 串行直接编辑同一 working checkpoint。并行只适合未来产生互不落地的局部候选；在没有额外 merge/review 协议前，不并行修改 checkpoint。

### 可行性依据

- `SubagentStartRequest` 支持 parent、agentOptions、toolFilter 和 cancellation，但没有 seed range；fork provider 的 completed-turn prefix 也没有可配置切片。fresh spawn 则不继承 parent history。上述双路径分别利用了两者真实能力，没有把 range selection 假装成 fork API；内部工具的实际挂载按 D-009 使用 agentOptions marker 与 scope-local registration，而不是 global tools 加 toolFilter。
- 工具 execute context 能把调用绑定到具体 child；`concludeTurn()` 与 `tools/result` 事件可将 finish tool 的成功结果作为权威完成信号。working state 位于 host，因此 child dispose、重启或 provider fallback 不会丢掉已经接受的 revision。
- 全部 segment 最终落成一个 replacement event，不受 turn-memory N→M landing capacity 限制；内部 user/assistant memory node 数只影响 checkpoint 正文结构。

### 已知边界

- fork worker仍携带完整 completed parent prefix；普通 pressure trigger 必须为其 prompt、工具轮次和输出预留 headroom。context overflow 时 fork 可能立即失败，fresh spawn 是必要的恢复路径，而不是 range-limited fork。
- segment token 数来自 token-meter 的 surface-node估价，不是 worker prompt 的精确 provider tokenizer 数；segment budget 和 read character cap 都需要保守配置。
- 当前 working checkpoint 只在内存中可续跑。它支持更换 child 继续同一进程内 job，但不把半成品持久化为可跨进程恢复的 session 状态；进程突然停止后由未闭合 compaction marker 暴露失败，原 surface 仍未被替换。

## D-007：turn compression 的 fork 后 fresh-spawn 续跑

状态：**已确认**

### 约定

- turn compression 的 working surface 继续由 host 内的 `TurnNodeEditor` 持有。每次成功的 `replace_turn_nodes` 都立即成为该 job 已接受的内存状态；worker 自身是否随后正常结束，不回滚这些 mutation。
- worker 未通过 `finish_turn_compression` 权威完成时，本次 worker 失败。插件先 dispose 当前 child；每个 job 只有第一个 worker 从 parent `fork`，后续 worker 均以同一 provider／model fresh `spawn`，并从 editor 的最新完整目录与读取工具继续。`turnWorkerAttempts` 限制的是连续未产生 accepted replacement 的失败 worker 数，默认三个；任何一次成功的 `replace_turn_nodes` 都把该预算重置。只要持续产生 accepted progress，worker 总数不受这个值限制；连续无进展失败耗尽预算后才放弃整个 job，父 surface 始终保持原样。
- 不继续使用已经失败的 child：context overflow 的直接成因可能正是 parent seed 或 worker 累积的 reasoning／tool history。首个 fork 保留 parent 的完整语义 cache；fresh spawn 同时去掉 parent seed 与前一 worker 的局部历史，使“第一次请求已被 parent context 撑爆”也有可执行的恢复路径。
- current catalog 是编辑结构的唯一事实源。`n*` 表示尚未被该 job 改写的 original node；`r*` 表示本 worker或更早 worker 已成功写入 host editor 的 replacement，不是临时草稿。fork seed 仍是原 transcript，不含 `r*` 的完整新正文；fresh spawn 完全不继承 transcript。因此 `read_turn_nodes` 对 unchanged `n*` 返回原 block 顺序和 raw reasoning，对 `r*` 返回 accepted content；超长选择按稳定字符 `offset` 分页，恢复 worker 必须按当前 ids 读取后继续，不能从原始布局重建。
- 每个 worker 只允许其当前 child 调用工具。切换 worker 前清空 child binding；前一个 run quiesce 后才绑定新 child，因此旧 worker 不能用 stale ids 与恢复 worker 并发修改 editor。
- 任意非 authoritative completion 都按有无 accepted progress 更新连续无进展预算，包括 provider error、context overflow 映射后的 `error`、max-tokens、基础设施异常，以及 child 正常停止但漏掉 finish。有 replacement 就重置预算并续跑；没有 replacement 就消耗一次预算。父 job 的 cancellation 直接终止，不启动恢复 worker。
- landing provenance 记录实际使用的 worker 总数。真实 E2E 把连续无进展预算设为一，在首个 fork 完成一次 replacement 后强制其无 finish 结束；该进展重置预算，因而第二个 fresh spawn 仍能识别已接受的 `r*`、继续二次改写、finish、落地并通过冷加载。E2E 同时断言 provider 顺序为 `fork, spawn`。

### 可行性依据

- `SubagentRun.result` 只把 child 失败归一为非 `completed` stop reason，provider 的 `CONTEXT_WINDOW_EXCEEDED` 细节仍保存在 child log；续跑协议无需依赖易变的错误文本，因为任何未 finish 的 attempt 都不能提交，而 editor 是否已有进度可由 host 直接观察。
- one-shot `dispose()` 会等待 child resource quiescence，随后 `start('spawn', { parent })` 创建零 parent context 的新 child；DSH 的 child route resolution 在未覆盖时继承 parent provider、model 和 maxTokens。`TurnNodeEditor`、opaque id 计数器、semantic sources 与 landing partition 都位于插件 job，不随 child dispose 丢失。
- replacement 工具返回当前目录，prompt 又在每个 worker 启动时嵌入同一 editor 的 rich catalog；原节点的 exact content 由 host 保留并通过有界分页读取，恢复 worker因此能从最新结构开始，不需要 replay 前一个 worker 的隐藏 reasoning 或工具调用。

### 已知边界

- 续跑状态只存在于当前进程的 job 内；Web 进程突然终止后不会恢复半成品，但父 surface 仍未被替换。
- fresh spawn 仍可能在单个 worker 内主动读取过多原文后再次 overflow；失败后会从同一 host editor 重新启动，读取上限与 prompt 应帮助它按节点／offset 分批处理，但不承诺任意单节点一定能被目标模型一次完整容纳。

## D-008：completed turn 的重启恢复与串行回补

状态：**已确认**

### 约定

- 实时 `turn/end` 与进程重启后的恢复使用同一个 per-root-session 待处理队列。已有 turn compression job 时，新完成的 turn 只排队而不丢弃；同一 session 始终只有一个 drain 和一个 active compression job，按最旧 turn 优先串行处理。
- root agent 每次 `agent/created` 时扫描 append-only session events 中所有合法 `turn/end`，而非只检查最后一个 turn。凡没有 durable turn-memory compression marker 的 completed turn 均加入队列；因此 Web 在 `turn/end` 后、replacement 落地前停止时，下次 cold resume 会重新执行该 turn。
- 已完成判断以每个 turn 最新的 durable `turn/end` 为准。已落地判断扫描完整事件日志中 `source.plugin=turn-memory`、`phase=compression`、匹配 turn number 的 marker，不只扫描当前 surface；即使 marker 后来被 session checkpoint 遮蔽，也不得把该 turn 当作漏压缩重新执行。
- subagent 可以权威 finish 一个已经足够紧凑、无需 mutation 的 turn。DSH 尚无第三方 log-only event 注册面，因此 no-op landing 用该 turn 第一个 current user node 的 exact-content 1→1 positional replacement 持久化：正文、角色和 surface 位置不变，只生成新的 message identity 并携带 turn-memory marker。它不是为了伪造压缩量，而是让“已审视且无需改写”成为可冷加载的幂等事实；不得用强制 mutation 逼模型扩写短 turn。
- job prepare 后必须先做 host-side 可满足性检查。若 completed turn 以 user 开始但没有任何非空 assistant transcript（典型场景是第一份模型请求立即 error／abort），不得启动 compression worker：纯 replacement 无法从单一 user landing 产生满足 `user → assistant` 的两个节点，模型也不得根据隐藏上下文编造未发生的 assistant 结果。host 直接保留原 surface、写入上述 no-op marker，并记录 `workerAttempts=0`。
- 队列真正开始某个 turn 前重新读取当前 agent/session、marker、目标 `turn/end` 和 current surface range，不持有恢复扫描时的陈旧 surface 计划。目标已被其他 rewrite 遮蔽或不再构成可压缩 current range 时，本轮记录原因并跳过，不试图复活已离开 surface 的原始节点。
- `agent` 暂时不可用、队列正在处理其他 turn、目标缺少 durable `turn/end`、无 eligible current range、prepare 失败和 worker 失败都必须有可定位 session/turn 的日志，不能再通过无声 return 表现为“没有触发”。agent 不可用时保留队列，等待下一次 `agent/created`；worker 有界失败后本进程继续后续 turn，且由于没有落地 marker，下次 agent 恢复仍可再次回补。
- per-session queue 的完整 drain promise 是 turn rewrite 与 session compaction 之间的 barrier。新 turn 在 active drain 期间加入时必须由同一 drain 接着处理；drain 退出边界上出现的新 work 必须启动下一次 drain，不能因 promise 清理竞态永久滞留。

### 可行性依据

- root session 的 completed-turn 事实、turn number 和原消息都已持久化在 append-only events；successful landing 又会在 replacement user/assistant event 上写入 turn-memory marker，所以恢复所需的“候选集合减已完成集合”不依赖进程内状态或 child session。
- `agent/created` 在新建和 cold resume 时均提供已加载的 agent/session；过滤 `header.parentSession` 后不会把 compression fork child 纳入 root recovery。实际 fork 仍需 active parent agent，因此无 agent 时只能排队，不能仅凭 detached session 启动。
- rc.6 与 rc.7 的 detached surface probe 均验证了 no-op marker 路径：替换前后的 `deriveMessages()` 文本和角色完全一致，实时 surface 与完整 `foldSurface()` 都得到同一 `[marker user, original assistant]` 顺序。
- 历史实例 `session-6cee…` 的首 turn 只有一个 1080 字 user 节点；旧 worker 在不可同时满足“两种角色”和“最多一个 landing output”的条件下执行了 31 次 replacement、8 次失败 finish，最终才因 transport error 停止。该实例证明重试预算不能修复 host 提交的不可满足问题，必须在 fork 前旁路。
- current surface 在每次 job prepare 时重新计算，且最终 landing 前已有连续范围稳定性校验。多个 missed turn 可以从旧到新依次替换互不相交的 current ranges；某一个失败也不要求阻断后续 turn。
- restart-recovery E2E 故意让 live `turn/end` 不启动压缩，flush 并销毁 parent agent，再 cold resume 同一 session。恢复扫描随后完成真实 fork、跨 worker 续跑和 6→2 landing；第二次 cold resume 验证 durable marker 去重且 replacement seq identity 不变。

### 已知边界

- D-007 的 accepted `r*` working state 仍只存在当前进程。进程停止后的恢复粒度是整个尚未落地的 turn，不会继续停止前 child 的半成品；父 surface 未提交，因此重做是安全的。
- 恢复只能处理仍有 eligible current surface range 的 turn。若另一个 compaction/rewrite 已经遮蔽原目标而又没有 turn-memory marker，本实现记录 skip，但没有 durable 的“不可恢复”墓碑；后续每次 cold resume 仍可能再次发现并快速跳过该 turn。
- 本条不提供跨进程 exactly-once 执行。它提供 durable landing detection 和 at-least-once recovery；设计继续采用 D-001 的单进程、同步 landing 假设，不处理在多个 replacement append 中间强制终止造成的部分提交。

## D-009：压缩编辑工具仅属于对应 worker scope

状态：**已确认**

### 约定

- turn editor 与 session-memory editor 工具不得通过插件根 `ctx.tools.register()` 注册。普通插件 context 的注册属于全局层，会把 schema 注入主会话及无关 subagent 的 request header；工具体内再检查 active job 只能阻止错误执行，不能阻止模型看到工具、浪费 schema token 或误判自身角色。
- 每类 compression worker 使用独立的进程内 tool-scope marker。marker 通过 DSH 明确可扩展的 `AgentOptions` 随 one-shot child 创建请求传递；同步 `agent/created` 边界在 child 第一份 prompt 组装前识别 marker，先对该 agent 设置空 global allow-list，再通过 `agent.ctx.tools.register()` 只挂载该类 worker 的工具。marker 不提供权限，`jobFor()` 的 parent、active job 和 child identity 校验仍是执行边界。
- turn worker 只能看到 turn editor 工具；session compaction worker 只能看到 session-memory editor 工具；主会话、普通 subagent 和另一类 worker都看不到这些内部工具。不得把 `SubagentStartRequest.toolFilter` 的 `allow` 误解成工具归属声明：它只过滤 child 已经继承的可见全局工具，不会从 parent 隐藏全局注册。
- E2E 除了要求 worker 实际完成工具协议，还必须检查主会话持久化的 `request/header.tools`，逐项确认两类内部工具均不存在。这样验证的是实际发给 provider 的 model-facing catalog，而不只是工具执行时的拒绝逻辑。

### 可行性依据

- DSH `AgentOptions` 是 merge-extensible creation state；in-process subagent 会把 caller options 合并进 child options。Agent registry 同步派发 `agent/created`，随后 provider 才向 child inbox 发送初始 prompt，因此 listener 中的 agent-scope restriction 与注册会在第一次 request assembly 前完成。
- DSH tool registry 明确区分 plain plugin context 的 global registration 与 `agent.ctx` 的 scope-local registration。global allow-list restriction 隐藏继承能力后，scope-local definitions 仍合并到该 agent 的最终 catalog，并随 agent scope dispose 自动清理。
- 历史主会话 `session-2ce5…` 的首个 request header 已包含两套内部工具；turn 3 的主模型因此误判自己是 compaction worker，并调用 `list_turn_nodes` 与 `list_session_segments`。两次调用虽被 `jobFor()` 拒绝，仍证明仅靠运行时校验不能满足工具隔离。

## D-010：图片压缩为可主动恢复的 lazy memory reference

状态：**已确认**

### 约定

- DSH durable message 中的 `type=image` 已经只保存 content-addressed `ImageAttachmentRef`，但 provider adapter 会在每次包含该 surface node 的请求中自动读取并编码图片，因此它仍是 eager model context。turn-memory 压缩图片时应能把它降级成纯文本 `<memory-image ... />` marker：marker 留在 ordinary transcript context 中，图片字节不再自动进入后续请求。
- marker 由 host 根据 canonical attachment metadata 生成，至少包含完整 `attachmentId`、media type、宽高和 encoded byte length，可附带经过转义的 display name。compression worker 可以移动或合并 marker，但不得编造、删去或改写其 reference identity；host 在 turn landing 和 session checkpoint 提交前验证选中 source 中的每个 image reference 仍出现在最终文本中。
- `contentText()` 遇到 image block 时输出 canonical marker，而不是静默忽略图片。original turn node 未改写时仍保留原 eager image block；worker 将带 marker 的节点落为 replacement text 后，图片才成为 lazy reference。prompt 应把这种降级作为 completed-history 的常规选择，同时保留与图片相邻的 human text 和已经得到的视觉结论。
- 插件公开 `read_memory_image({ ref })`。它只接受当前 agent session 或其 active root parent 的 append-only events 中真实出现过的 attachment id，解析完整 `ImageAttachmentRef`，通过 `ctx.attachments.readImage()` 校验后返回一个 ordinary image content block。模型只在文字 memory 不足以回答像素位置、遗漏细节或重新判断时主动调用；读取结果只进入该次 tool interaction，不把旧 checkpoint 自动恢复成 eager image surface。
- `read_memory_image` 是主会话有意可见的普通 memory capability，不属于 D-009 要隔离的 host editor 工具。turn/session compression worker 的 global tools 被 scope 清空，因此两种 worker scope 也显式附带同一个读取工具，使 fork、fresh spawn 和主 agent 都能解析 marker。
- 不把 attachment store 的内部 object path 写进模型上下文。浏览器上传不保留原始客户端路径；`$DSH_HOME/attachments/...` 是 backend-private、无扩展名且可能不在 workspace sandbox 中，也不能跨 attachment backend 或 DSH home 稳定迁移。

### 可行性依据

- `ImageAttachmentRef` 已包含持久、可序列化且由摘要校验的 identity 与图片元数据；真实 bytes 由 attachment service 独立保存。append-only 原事件即使被 surface replacement 遮蔽仍可作为授权和解析依据，session export 也会扫描完整日志并携带其中引用的 media object。
- DSH tool renderer 可以像现有 `read_image` 一样同时返回 text block 与 image block；pi-ai adapter 仅在这个 image block 真正进入 request 时调用 attachment store 并转换成 provider image data，因此 lazy marker 本身没有视觉 token/pixel payload。
- turn editor 和 session source renderer 都已经经过同一个 `contentText()` seam；在这里引入 canonical marker 可以覆盖 user image、assistant image 以及 nested tool-result image，不需要为每种压缩路径复制序列化逻辑。

### 已知边界

- 首版 resolver 依赖图片仍可在当前 session 或 active root parent 的 append-only events 中找到；不提供任意 attachment-store object 的全局读取能力，也不把 attachment id 当 bearer URL。
- 普通 text-only 模型即使看见 marker 也不能消费返回的 image block；工具应失败明确并保留原 lazy reference，而不是把路径或 bytes 塞回文本。

## D-011：turn/session worker 的连续无进展预算与一次 overflow replay

状态：**已确认**

### 约定

- D-007 的 turn continuation 语义扩展到 session segment：配置的 worker-attempt budget 表示**连续未产生 accepted mutation 的失败 worker 数**，不是 worker 总数。每个 session worker 启动前记录 `SessionMemoryEditor.revision`；任何一次成功 `replace_session_memory` 使 revision 增加，即使 child 随后 overflow、timeout、max-tokens、transport error 或漏调 finish，也把连续无进展计数清零并从当前 host-owned revision 继续。只有无 revision 变化的失败才消耗预算。
- 每个 segment 单独开始一份连续无进展预算。首个 worker 仍按 D-006 使用 parent fork；同一 segment 的 continuation 仍使用 fresh same-model spawn，并通过 embedded assigned source 与 working handoff 接续。`finish_session_segment` 成功是唯一完成条件；前面 segment 已完成或当前 worker 仅自然停止都不替代它。
- turn 与 session runner 保持各自清晰实现，不为了代码去重强行抽取统一 runner。二者必须用测试维持同一 progress/no-progress/finish 语义；只有出现边界和错误处理都完全相同的极小 helper 时才共享。
- provider-confirmed context overflow 的外层恢复固定为 one-shot：同一个 active root turn 第一次 overflow 可以运行一次 session compaction；只有 surface replacement generation 确实增加时才重放原主模型请求一次。同一 turn 的重放请求若再次 overflow，直接保留 provider error，不再 compact/replay；agent 回到 idle 后清除 one-shot 状态。删除可配置的 `maxOverflowRetries` 与数字计数器。
- pressure compaction 成功后仍高于 threshold 时继续选择另一段属于同一次 pressure policy 的多-pass convergence，不是 worker continuation 或主请求 replay；现有 `compactionRetries` 暂时保持独立语义，不参与上述预算。
- 当前不把 stock `compaction-basic` 作为运行时第二 provider 或自动 fallback。一个 Cordis context 只能有一个 `ctx.compaction` service；完整 basic transaction 还会重新使用不接受 post-turn assistant replacement 的 upstream meter，并在真正容量不足时一次性 replay 同一大范围。未来若需要兜底，应在本 engine 内复用 basic-style one-shot summarizer，同时继续使用本插件的 canonical-surface pricing、lazy image reference 验证和单一 transaction，而不是并排加载两个 engine。

### 可行性依据

- `SessionMemoryEditor.revision` 在每次 accepted replacement 后同步递增并由 host 持有，和 turn job 的 `mutationCount` 一样不依赖 child 最终 stop reason；dispose 失败 child 后 fresh spawn 可以从最新 catalog/revision 继续。
- `agent/request-error` 的 middleware 只有在返回 `{ kind: 'retry' }` 时才会重放刚失败的主请求；surface `replaceGeneration` 能证明 compaction 已实际产生可用于重放的新上下文。per-agent one-shot set 足以区分第一次与重放后的第二次 overflow，无需可配置计数。
- session E2E 可以把连续无进展预算设为一，在第一个 segment 的 fork 完成一次 replacement 后强制其无 finish 结束；revision progress 必须允许 fresh spawn 继续并提交，直接覆盖旧固定-attempt 实现会错误耗尽的路径。

### 已知边界

- accepted editor state 仍只在当前进程存活；进程重启后的 turn recovery 或下一次 session compaction 从 canonical source 重新建立 job，不恢复半成品 revision。
- 持续提交形式上有效但语义无价值的 mutation 可以持续重置预算；final validation、prompt contract 和日志用于发现这种模型行为。当前不另设会与“有进展即可续跑”冲突的 worker 总数上限。

## D-012：content block 支持边界

状态：**已确认**

- DSH `0.1.0-rc.7` core 的 `ContentBlockMap` 仍只有 `text`、`reasoning`、`image`、`tool-call` 和 `tool-result`；对 rc.7 官方 base bundle 全部插件的声明扫描没有发现任何官方 module augmentation 增加其他 content block。provider SDK 内部的 audio、file、video、document 等 wire type 不属于 DSH durable message vocabulary。
- `reasoning` 不直接投影进压缩后 surface：原始逐步思考噪音过大，一旦节点被 turn replacement 改写或进入 session checkpoint，raw reasoning 不进入新 surface。D-014 负责压缩前的 hints，D-016 要求把其中高重建成本的工作产物转写成 ordinary assistant memory，D-017 另提供只读 append-only source fallback；三者均不改变“raw reasoning 不常驻压缩 surface”的边界。
- `tool-call`／`tool-result` 继续采用现有的部分语义投影与 host tool-pair validation，不承诺把 call id、error flag 和 provider replay metadata 复制进压缩文本。未来若官方或第三方扩展 `ContentBlockMap`，必须先明确该 block 的保留、lazy reference 或显式丢弃策略，不能因为结构里恰好存在 `content` 字段就假设已经支持。

## D-013：长 turn 在压缩边界后自动续开

状态：**已确认**

### 约定

- completed-turn compression 启用时，插件默认启用长 turn continuation。host 仅计数当前 root session 的 open turn 中 append-origin model-visible surface nodes；旧 turn、session checkpoint replacement 和 `@deepseek-ai/dsh-system-prompt` runtime snapshot 不计入该 turn 的工作量。默认提醒间隔为 30 nodes，可用 `turnContinuation.reminderIntervalNodes` 调整或以 `turnContinuation.enabled: false` 关闭。
- open turn 每跨过一个间隔只提醒一次，即默认在 30、60、90……节点里程碑出现。host 从 durable runtime snapshot 的具名 section 恢复本 turn 已显示的最高里程碑，因此普通 step 和进程重启都不会重复同一级提醒；若一步跨过多个区间，只显示当前最高里程碑。提醒同时给出 open-turn 当前 node 数、整个 canonical context 的 token 估值和下一节点里程碑作为参考，但触发只取决于 open-turn node 数。
- 里程碑到达时，插件通过一轮 dynamic runtime context 显示 `<turn-memory-continuation>`，而不是强制中断或在之后每轮持续占据上下文。其正文是简短的第一人称 `<assistant-self-check>`，直接要求模型停下来总结并调用公开工具 `continue_after_turn_compression({ handoff })`；它仍是明确标记来源的 plugin runtime context，不伪造 durable `assistant/message`。只有整个任务能在接下来少量动作内完成时才继续当前 turn。若一个不可拆分的 mutation 正在执行，模型只先完成该 mutation 再交接。handoff 简述已完成内容、当前状态和下一 turn 的准确工作。
- 工具只允许 root conversation 在 open turn 且已达到阈值时调用。成功调用用 `concludeTurn()` 结束当前 turn；native mode 下配对的 durable `tool/call` 原始 handoff 参数和成功 `tool/result`，或 Code Mode 下成功的 `tool/code-dispatch`，共同构成权威 continuation request。普通文本承诺、自然停止或失败的工具调用都不产生自动续开请求。
- `turn/end` 后仍执行普通 turn-memory fork 压缩。只有 replacement/no-op marker 已落地且 session 已 flush，host 才把一条 `source.kind=plugin` 的 user-role follow-up 投递给同一个 agent。该输入明确声明自己是自动 continuation、不是新的人类指令，并携带 handoff；`Agent.followup()` 保证它成为独立 ordinary turn，而不是当前 turn 的 steer 或额外 step。
- continuation request 可通过 completed-turn recovery 路径跨进程恢复。dispatch 去重不依赖进程内 flag：append-only log 中同一 request id 的 `agent/inbox/spliced` insertion 或已 claim 的 `user/message` 都证明 follow-up 已投递。若 turn 压缩失败则不续开；没有 landing marker 的 request 会在后续 agent cold resume 重新进入压缩，成功后再投递。
- runtime snapshot、长 turn 提醒和自动 continuation wrapper 是 host control context，不是 human intent。turn compression prompt 必须把这一边界纳入整体 transcript 规则：不逐字保留或伪装成用户要求；但当前工作为何尚未完成、已经得到的结论和 handoff 中真实的 unresolved state 仍按正确 assistant 角色压缩保留。

### 可行性依据

- DSH `SystemPrompt.context()` 在每次 request assembly 求值，并把具名 dynamic context sections 物化为 durable user-role snapshot；空文本不贡献 context，更新后的快照取代旧快照。插件可扫描 append-only 历史中的本 section marker 恢复已提醒里程碑，同时让提醒在下一轮 assembly 自动消失，不需要新增事件或追加 steer。
- DSH `ToolRunContext.concludeTurn()` 把成功 tool result 标为当前 turn 的终止边界；`Agent.followup()` 则明确把输入排入 `next-turn` 并唤醒 driver，使“结束当前 turn”和“开启独立下一 turn”不需要伪造 `turn/start`／`user/message` 事件。
- `tool/call`／`tool/result`、`tool/code-dispatch` 和 agent inbox mutation 都是 core 已知的 durable event。native pair 提供 call identity、turn、handoff 和成功事实；Code Mode dispatch 提供同一 open-turn 区间内的 sub-call identity、结构化参数与 `isError`。follow-up 的 message identity/source 在 inbox insertion 与 claim 后的 `user/message` 中保持一致，因此两端都能从 append-only log 恢复，且不需要新增 persistence vocabulary。
- 当前 per-session compression pump 已由 coordinator 暴露为 turn-rewrite barrier。follow-up 在 landing、snapshot flush 和 pump 尾部才投递；下一 turn 即使同步 wake，其 pre-step pressure compaction 也会等当前 rewrite promise 退出，不会在未落地的 surface 上开始请求。

### 已知边界

- open-turn 与 entire-context token 数都是 token-meter 的 provider-neutral 估价，不是目标 provider 对整份 request 的精确计数；里程碑提醒是提前切分复杂工作 turn 的策略，不替代 context-overflow recovery。
- 模型可以忽略提醒，因此本机制是协作式 handoff，不是 hard limit。强制在任意 tool/mutation 中间切断会破坏外部操作语义，当前不做。
- request tool pair 与 follow-up inbox insertion 分别是 append-only durable facts，但不承诺跨多个进程同时驱动同一 session 时的分布式 exactly-once；沿用本项目单 active agent/session writer 的运行假设。

## D-014：长 reasoning block 的异步 thought hints

状态：**已确认**

### 约定

- raw reasoning 在 completed-turn compression 开始前保持原样。短 reasoning block 不做单独预处理；长 reasoning block 一旦收到完整的 `assistant/chunk` `block-end`，host 就立即启动一个异步小模型 one-shot 请求产生 thought hints。同一 turn 可以有多个独立且并发的 hint 任务。
- hint 请求只有两部分：置于前缀的固定 system prompt，以及作为唯一 user message 的该 reasoning block 原文。不附带 parent history、当前 user request、turn／step／block id、长度或其他动态前缀；关联身份由 host 在请求外维护。固定指令因而始终位于变化的 thought 之前，允许 provider 尽可能复用这一小段稳定前缀。
- thought hints 是导航性的回忆索引，不是权威 summary、原文替代或必须保留的事实列表。它们应突出难重建的灵感、假设与不确定性、试错及排除项、发现、决定与理由、结论的证据与边界、未解分支，但不要变成逐步重述。
- turn compression 在对应 `turn/end` 后等待该 turn 已启动的 hint 任务。主模型仍通过正常 parent `fork` 继承完整 completed turn，包括原始 reasoning blocks 及 provider replay metadata；hints 只作为额外的临时 prompt 输入。主模型自行决定从哪里提取细节，并应回看原始 reasoning 核对 hint 中的线索。
- hint 生成失败、超时、返回空文本或在重启前丢失都不阻止 turn compression：原始 reasoning 仍是主模型的完整事实来源。进程恢复时，host 从 durable `assistant/message` reasoning blocks 重新识别长 block 并补跑缺失的 hints，不持久化中间 hints。
- hints 流程不写 parent session，也不合成未闭合 turn 的 surface。canonical surface 在模型工作期间保持不变，最终仍只有普通 turn compression 的一次 N→M landing。
- 任何含 reasoning block 的原 assistant surface node 在最终 working surface 中都必须被 replacement 覆盖；不得以“已经很短”为由将该原节点 unchanged 落地。replacement 可以把有价值的 reasoning 语义压缩进普通 assistant text，但 raw reasoning 不进入压缩后 surface。本条取代 D-012 中“reasoning 完全不处理”的旧边界。

### 可行性依据

- DSH `StreamChunk` 的 `block-end` 携带已组装的完整 `reasoning` block，且 `session/event` 观察者在进程中可直接收到该事件，因而文本型 hint 不需要等待 `assistant/message`、`step/end` 或 `turn/end`。
- `ctx.llm.stream()` 接受手工组装的 provider/model、system prompt 和 message 列表，可用小模型完成不带工具、不建 child session 的 one-shot 调用。这比 parent fork 更符合“只读一个 thought”的输入契约。
- stock fork 只能 seed 到最近的 completed `turn/end`，不能继承未闭合当前 turn；而 reasoning replay metadata 又在 terminal `finish` chunk 才齐备。hints 不依赖 replay，直接使用 `block-end` 文本；最终主 worker 则等到真实 `turn/end` 后沿用标准 fork，两者分别使用各自可验证的完整边界。
- durable assistant message 仍保留 reasoning content。因此 cold resume 可以在不依赖任何进程内状态的情况下重建同一组 hint 输入；中间产物不持久化也不会影响最终 surface 可回放性。

### 已知边界

- “长”的即时判定只能依据 block 文本长度或 provider-neutral 估算，不是该小模型 tokenizer 的精确 token 数。阈值、小模型路由、hint 输出上限与单次请求超时必须可配置。
- 某些容错型 adapter 可能只发 delta 而不发 `block-end`。实时路径在这种情况下无法提前启动，但 `turn/end` 后可从已组装的 durable assistant reasoning block 补跑。
- hints 减少的是主 worker 寻找重要线索的语义负担，不是 parent fork 的输入长度。主模型仍继承 raw reasoning，provider 是否命中内部 prompt／KV cache 不属于插件可承诺的正确性边界。
- 并发 hints 会增加本地或远程 provider 的瞬时负载。首版允许 provider 自行排队，不额外设计持久化工作队列或全局并发调度。

## D-015：用户 lineage fork 与旧 reasoning no-op 的恢复

状态：**已确认**

### 约定

- “用户会话”按 durable origin 语义判断，而不是按是否存在 `parentSession` 判断。`origin="subagent"` 或正 delegation depth 的内部 agent 不运行 turn memory；用户从 UI 建立的 lineage fork 虽有 `parentSession`，但没有 subagent origin 且 `delegationDepth=0`，应与普通用户会话一样运行 thought hints、turn compression、turn continuation 与 session compaction。
- durable turn-memory completion marker 通常提供幂等性；但若该 turn 的**当前 surface**仍包含 assistant reasoning block，则 marker 来自旧的 reasoning-unaware no-op，不再满足 D-014 的 landing invariant。恢复扫描必须把它视为 stale completion 并重新压缩，而不是永久跳过。
- 重新处理旧 no-op 时，旧 marker 是 turn/end 之后追加、但仍占据该 turn 当前 surface 位置的 user replacement。turn selection 应按 `source.plugin=turn-memory` 与 `source.turn` 将它纳入目标；主 fork 仍只继承 completed-turn prefix 中的原始 user/assistant evidence，host editor 则以当前 marker content 和 raw-reasoning assistant node 完成一次新的 N→M landing。
- 新 landing 后当前 surface 不再含 reasoning，旧 marker 即使仍存在于 append-only log 中也不会再次触发迁移；判定因此保持幂等。真正没有 assistant reasoning/text 的失败 turn 仍保留合法 no-op marker，不会被重复处理。
- live `turn/end` 在启动异步 worker 前，以首个 user node 的等内容 replacement 留下 `phase="pending"` durable marker；成功 landing 的较新 `phase="compression"` marker关闭该状态。cold recovery 只处理 pending、上述 stale reasoning 迁移项，或已有 continuation request 的 turn。
- pending marker 成为 current landing node 后，editor 必须把 marker seq 用于 positional landing，并把 marker 的 `sourceEventSeqs` 展开为 semantic provenance。最终 replacement 的 durable `sourceEventSeqs` 取 semantic sources 与本节点 landing seqs 的并集：前者保留原 human provenance，后者满足 surface replacement 对所有被遮蔽 current events 的 coverage。只保留任一侧都会分别丢失原 user identity 或导致 landing validation 失败。
- marker-free completed turn 不能区分“插件尚未安装”与“旧实现未观察到”，因此不做推测性 backfill。首次安装后打开或 fork 一份旧会话不会批量压缩历史；这项 activation boundary 比恢复无法证明曾被插件接管的 turn 更重要。

## D-016：以继续实现所需的重建成本衡量 reasoning 压缩

状态：**已确认**

### 约定

- turn compression 的优化目标是减少后续重复工作，不是追求最短文本或固定压缩率。raw reasoning 可能是在尚未写文件、尚未产生 final text 时唯一形成的工作产物；worker 必须把已经稳定的高重建成本内容转写为 ordinary assistant memory。
- 需要按实际内容保留的 operational payload 包括架构与文件／模块职责、接口与类型、schema／state machine／data flow、算法与公式、坐标与参数、关键命令、invariant、edge case、failure mode、兼容约束、验证／测试方案、被排除的替代方案及理由，以及准确的后续实现状态。不是要求复制全部代码或逐步思考；重复 self-talk、机械草拟和可由结论加必要证据代替的推导仍应压缩。
- 主 worker 的最终自检是：raw turn 从普通 context 消失后，下一位有能力的 agent 能否在不重复实质调查、设计或推导的情况下继续。若只能知道“要实现某模块”而不知道 reasoning 已确定的做法，则属于过度压缩。
- thought-hints prompt 与主 compression prompt 必须共同表达这一目标。hints 仍只是可能不完整的导航索引；主 worker 不能把 hint 当成完整 preservation checklist，hint 缺失也不能降低上述 landing 目标。

### 可行性依据

- parent fork 已继承完整 completed turn reasoning；`rewrite-required=raw-reasoning` 又强制对应 assistant 节点在落地前转成 ordinary text。`TurnNodeEditor` 和 landing validation 限制节点数、角色、provenance、tool pairing 与图片 ref，但没有设置 replacement 字符上限，因此保留更多必要实现细节不需要修改 surface 机制。
- 真实 85,603 字 reasoning 恢复样本中，收到 hints 的 worker 只留下约千字高层方案，未收到 hints 的 lineage fork 只留下数百字纲要；原文中的模块 API、阶段函数、参数、边界与验证计划大量消失。两者证明当前 wording 会把 implementation-ready state 错当成可丢弃的机械细节，同时证明 hints 只能改善定位，不能代替主 worker 的完整保真职责。

### 已知边界

- “足够继续”是语义质量目标，host 无法仅凭字符数或 schema 完整验证。prompt regression、真实 surface 检查和 source fallback 用于发现与缓解失败，不承诺每个模型调用都达到相同压缩质量。
- 本条不要求保留 raw chain-of-thought，也不设最低输出长度。安全的压缩比例取决于该 turn 实际形成的不可替代工作，而非 reasoning 原文长度。

## D-017：当前 session append-only 原 turn 的按需读取兜底

状态：**已确认**

### 约定

- 插件默认公开一个只读 `read_session_history` 工具。调用时不传 `turn` 会分页列出当前 calling agent session 最近完成的 turn、可见文本／reasoning 规模和是否已有 turn-memory landing；传 `turn=<n>` 则读取该 turn 在原 `turn/start..turn/end` 区间内的 user／assistant／tool-result 节点，并按原 block 顺序显式呈现 reasoning。
- 工具只读取 calling agent 自己的 append-only session events，不接受任意 session id，也不跨会话搜索。surface replacement 或 session checkpoint 只遮蔽旧节点，不删除原事件，因此 current／shadowed 状态仅作为说明，不影响读取权限。
- 原 turn 不自动注入每次模型请求；只有压缩 memory 缺少完成当前任务所需的昂贵细节时才调用。单次结果受 `sessionHistory.maxReadChars` 限制，超长 turn 通过 `offset` 继续；调用结果是普通 tool interaction，不会把原节点永久恢复为 standing surface。
- 该工具是主会话的普通 memory capability，不属于 D-009 的 compression editor。turn/session worker 仍使用各自更精确的 inherited source 或 assigned source，不额外把此 fallback 加入隔离 worker scope。

### 可行性依据

- DSH session object 在 active agent scope 内保留完整 append-only `events` 和 folded `surface`。每个 completed turn 由 durable `turn/start`、`turn/end` 定界，assistant durable message 仍含原 reasoning blocks；读取不依赖 persistence backend 私有路径、Zstd 解压或 `sessionQuery` 只能看到的 current surface。
- 工具 schema 不暴露 session selector，execution 又从 `exec.agent.session` 取得唯一数据源，因此多个并行 session 共享插件实例时不会互读。字符窗口使 reasoning-only 大节点也能有界返回，同时允许本次 85k 样本在默认 160k cap 内一次恢复。

### 已知边界

- 这是事后取回机制，不会自动判断哪条压缩 memory 缺失，也不能替代 D-016 的正常保真目标。模型必须先从 catalog 选择 turn；一次读取会临时增加当前 turn 的上下文和计费。
- 工具只投影 core 已支持的 user／assistant／tool-result 内容；它不是 raw event debugger，不返回 step lifecycle、provider replay metadata 或 host-only control events。

## D-018：压缩 worker 的 prompt 与工具隔离

状态：**已确认**

### 约定

- turn compression 与 session compaction 的内部 worker 只接收各自当前 user message 中的完整任务协议及插件为该 worker 挂载的私有工具。主运行时的 persona、其他插件的静态 guidance 和本次 child 新组装的 dynamic runtime context 不参与 worker 请求。
- 两类 worker 共用同一个 agent-scoped 隔离边界：每次 child start 必须携带 per-child persona，先 shadow 父 preset 继承的 `deployment:persona`；再以唯一 complete `turn-memory:worker` system-prompt section 排除其余全局静态 section，以 runtime-context suppressor 排除动态 context，并沿用私有工具 allow-none 后再注册的隔离方式。persona 与进程内 scope marker 必须由同一个启动选项 API 成对返回，避免调用点只传 marker 而重新引入多个 complete section。隔离精确绑定到目标 worker，不改变普通主 agent 或其他 subagent。
- fork seed 中已经存在的 parent 历史消息不属于“child 新注入”。其中早先持久化的 runtime-context snapshot 仍作为待压缩原始 transcript 的一部分可见；压缩协议继续把这类 plugin scaffolding 与 human intent 区分，并在没有持续因果价值时移除。

### 可行性依据

- DSH 的 `agent/created` 同步发生在 child 首次 prompt 前，且 `agent.ctx` 提供 agent-scoped `systemPrompt.section()`、`suppressRuntimeContext()` 与 tool registry。`complete: true` 会在 assembly waterfall 后恢复为唯一 system section，runtime suppressor 会清空本次 assembly 的 contexts，因此无需让 turn-memory 知道 todo-stack 等其他插件的名字。
- DSH 的 `SubagentStartRequest.persona` 会在 child scope 注册非 complete 的 `deployment:persona`，其作用域比 join 进来的 parent preset 更近，因而能 shadow 其中可能为 complete 的同名 section；随后 worker scope 的 `turn-memory:worker` 才是唯一 effective complete section。fork 与 spawn 的 in-process driver 都走同一套 child composition。
- turn 与 session worker 已经通过同一个 `WorkerToolScope` marker 挂载私有工具；把 prompt boundary 放入该 scope 会自然覆盖 fork 与 fresh-spawn 两种路径，同时不会把压缩工具或隔离规则暴露给 parent。

### 已知边界

- 隔离不会也不应删除 fork 已继承的 parent 历史快照，否则会改变 canonical source；最终产物是否保留其中信息仍由压缩协议和 host validation 决定。
- worker 的完整行为契约仍以实时读取的 Markdown task prompt 为唯一来源。isolated system section 只声明边界，不重复压缩策略，避免两份协议漂移。
