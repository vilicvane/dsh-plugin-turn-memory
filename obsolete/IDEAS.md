1. verbatim 似乎有点少，并且 compact turn 会保留之前片段压缩后的 verbatim 吗？需要调整和验证。
2. [x] 我想把 compact turn 的主体直接换成当前上下文，而不是一个 fork 的 subagent，把 compact turn 的 prompt 放到对应的 skill 中，由当前上下文直接调用 compact_turn，提供 compact 后的内容。（已实现：撰写规则移入内嵌技能 dsh-compact-turn，当前上下文自拟 checkpoint 后经 summary 参数调用 compact_turn，fork 路径移除；node --check 通过；未重启、未提交。）
3. 需要一个 compact 持续迭代的技能，当 agent 发现之前 compact 的效果不好时，让它总结一下：为什么不好？可能怎么改善？我想的是让 agent 可以在不改变插件内置 prompt 的情况下，对 prompt 进行覆盖或局部修改。
