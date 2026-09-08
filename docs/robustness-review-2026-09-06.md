审查对象：Overleaf Workshop 当前 **0.16.6 工作区代码**，包含尚未提交的同步重构与原生合并按钮改动。审查日期：2026-09-06。

**结论：同步核心已经有较好的防护基础，但插件整体还不足以保证在异常网络、外部程序同时编辑、多个窗口和长期运行时可靠。** 主要缺口在于保护没有覆盖所有写入入口，部分界面把未完成的操作当作成功，异常后的状态恢复和资源回收不完整。

本轮重点检查了本地副本同步、远端文件系统、连接重试、隐身模式、编译与 PDF 跳转、冲突交互和测试覆盖。`npm test` 完成编译、Vue 构建、lint，**97 项现有测试通过**。另外用当前 TypeScript 源码、临时目录和模拟服务器/VS Code API，完成了下列 **13 个问题的隔离复现**。这里的“已复现”指代码行为，不代表已在真实 Overleaf 或真实 VS Code 窗口中复现；竞争条件使用明确安排的并发时序，重试测试压缩了等待时间。

复现脚本：[probes.cjs](/private/tmp/overleaf-review-20260906/probes.cjs)。机器可读结果：[results.json](/private/tmp/overleaf-review-20260906/results.json)。所有模拟文件均在 `/private/tmp/overleaf-review-20260906`，没有访问真实账户或论文内容。复现代码用于本轮审查，没有加入项目正式测试集。

优先级约定：**P1** 为可能丢失修改、突破同步范围或破坏恢复依据，应优先修复；**P2** 为功能中断、持续资源消耗或明显体验问题，应随后修复。优先级不是漏洞利用评级，也不表示每次使用都会触发。

| 编号 | 优先级 | 问题 | 已观察到的结果 |
| --- | --- | --- | --- |
| B01 | P1 | 远端缓存失效后保存静默成功 | 函数正常返回，远端写入次数为 0 |
| B02 | P1 | 符号链接目录突破副本边界 | 副本目录外文件被更新，子文件状态仍为 clean |
| B03 | P1 | 本地替换前存在并发覆盖窗口 | 外部程序的新修改被覆盖，备份只包含旧内容 |
| B04 | P1 | 多实例并发写同步日志会丢条目 | 2 次日志写入成功后，文件里只剩 1 条 |
| B05 | P1 | 文件监听绕过忽略规则 | 被忽略的 main.aux 经 Sync Now 上传 |
| B06 | P1 | 隐身模式对 Unicode 二次错误解码 | 中文、重音字符和 emoji 内容被改变 |
| B07 | P2 | 编译异常后无法正常重试 | inCompiling 保持 true，第二次编译没有启动 |
| B08 | P2 | 项目设置请求失败绕过重试上限 | 声明最多重试 5 次，实际仍进行第 8 次请求 |
| B09 | P2 | 隐身模式消息轮询缺少结束条件 | 25 次空列表响应后仍请求下一次 |
| B10 | P2 | 跨目录移动并改名只执行移动 | 服务器操作保留 a.tex，缓存却认为是 b.tex |
| B11 | P2 | 有效 gzip 下载被误判为截断 | 58 字节传输、620 字节解压后内容被拒绝 |
| B12 | P2 | 本地副本 PDF 跳转使用错误路径 | 正向传空路径，反向打开云端文件 |
| B13 | P2 | 草稿对象没有回收 | 合并解决后仍残留 23 个无引用对象 |

1. **B01：远端文件保存可能成为“假成功”。**

   触发条件是收到与缓存版本不一致的远端 OT 更新。事件处理会把 `localCache`、`remoteCache` 清空，后续 `writeFile` 检查到缓存未就绪便直接 `return`，没有重新订阅/读取、保留待提交操作或向 VS Code 抛出保存失败。复现先调用实际事件处理器制造版本不一致，再保存用户内容，观察到请求数为 0、函数正常返回。VS Code 文件系统调用方会收到已完成的 Promise；用户若据此关闭文档，修改存在丢失风险。隔离测试没有模拟 VS Code 的备份恢复机制，因此不宣称所有情况下都会永久丢失。

   位置：[缓存失效处理](/Users/feili/Documents/projects/Overleaf-Workshop/src/core/remoteFileSystemProvider.ts:616)、[静默返回](/Users/feili/Documents/projects/Overleaf-Workshop/src/core/remoteFileSystemProvider.ts:1200)。建议把缓存未就绪视为可恢复的保存失败，重新取得版本后走显式合并/提交流程；未经确认不能报告成功。

2. **B02：符号链接的子路径仍可能被同步，写到副本外。**

   目录扫描能发现 `linked` 是符号链接，但阻止列表只做路径完全相等判断，远端枚举出的 `linked/shared.tex` 仍然通过。`resolveSafe` 只用字符串路径判断是否在根目录内，不检查父目录的真实位置。复现中 `linked` 指向临时副本外的目录，扫描确实报告了符号链接问题，但远端更新仍改写了外部的 `shared.tex`，并把该子文件记为 `clean`。

   位置：[扫描与过滤](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSCM.ts:369)、[路径校验](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:235)。建议禁止目录问题下的全部子路径，在所有读写入口验证实际父目录位置，处理检查期间的路径变化。

3. **B03：检查、备份和最终替换之间存在外部写入竞争。**

   `atomicLocalWrite` 先读取并验证旧内容，随后异步写备份、写日志，最后才重命名临时文件覆盖目标。如果其他编辑器或生成程序在这个间隔保存，新内容会被覆盖，备份也不包含它。复现在 `prepared` 日志落盘后插入一次外部写入：最终文件变成远端内容，备份仍只有 `base`。原子重命名保障文件不会只写一半，不能自动保障中间出现的新修改不丢失。删除路径也存在类似的检查与操作间隔，删除分支本轮未另做复现。

   位置：[检查和替换的间隔](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:188)、[最终替换](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:256)。建议围绕“保存实际被替换的内容”设计保护流程，对不能排除的并发变化保留版本并冻结，不能只增加一次早期哈希检查就认为已解决。

4. **B04：多个 VS Code 窗口没有共享的副本写入互斥。**

   `writeQueue` 是 `SyncStateStore` 实例字段。两个窗口或两个实例读取同一个 `journal.json`、各自追加后覆盖写入，会发生后写覆盖先写。复现让两个实例先读到同一份日志，然后并发完成写入，两次调用都成功，但最终只有一条记录。这会削弱异常恢复依据；目前没有实际启动两个 VS Code 窗口进行端到端复现。

   位置：[日志读改写](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:141)、[实例内写队列](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:250)。建议为副本建立跨进程所有权/锁和失效接管规则，第二个实例只观察或明确提示正在被另一窗口管理。

5. **B05：忽略文件通过监听器进入同步，后续扫描也不会移除。**

   `listAllPaths` 使用忽略规则，但本地、远端监听器直接调用协调器。协调器只保护自己的内部目录，没有统一的用户忽略规则，而且扫描把已有记录重新加入候选集合。复现证明默认忽略的 `main.aux` 不在扫描结果中，却在收到变更后进入 `pending-upload`，运行 Sync Now 后上传。类似逻辑也影响其他构建产物和自定义忽略目录。新建本地文件需要一次手动同步，因此不是“所有新忽略文件立即自动上传”。

   位置：[监听入口](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSCM.ts:335)、[扫描合并已有记录](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/coordinator.ts:76)。建议让扫描、监听、手动同步和重试都通过同一套过滤，并正确处理已经进入状态库的忽略路径。

6. **B06：隐身模式返回的 Unicode 文本被当作 latin1 字节再次解码。**

   `SocketIOAlt.joinDoc` 从历史接口取得正常 JavaScript 字符串；外层 `SocketIOAPI.joinDoc` 无条件执行 packed UTF-8 解码。复现从隐身模式返回 `中文 é 😀`，外层得到不同字符串，其中还包含 NUL 字符。这里已确认文档读取内容损坏；本轮没有把损坏文本提交到真实服务器。

   位置：[隐身模式文本返回](/Users/feili/Documents/projects/Overleaf-Workshop/src/api/socketioAlt.ts:364)、[无条件解码](/Users/feili/Documents/projects/Overleaf-Workshop/src/api/socketio.ts:486)。建议统一传输适配层返回值，按实际协议解码，并测试中文、重音字母、emoji 和非 BMP 字符。

7. **B07：编译状态在异常路径上不能复位。**

   `compile` 设置编译状态后启动一条未返回、未等待的 Promise 链，也没有顶层 `catch/finally`。读取当前文档、连接、解析日志等步骤抛错后，`inCompiling` 可一直为 `true`，后续点击被最前面的守卫直接忽略。模拟连接失败后，第二次调用没有发起新请求。普通失败/无需编译的分支还主动 `Promise.reject()`，产生未处理拒绝。

   位置：[编译流程](/Users/feili/Documents/projects/Overleaf-Workshop/src/compile/compileManager.ts:197)。建议改成一个可等待的完整流程，统一错误提示和状态复位，并检查 `saveAll()` 的布尔结果。

8. **B08：项目设置接口故障会造成无上限的重连。**

   重试计数在 `joinProject` 成功时就归零，而项目设置下载尚未成功。若 Socket 连接正常、设置接口持续失败，每轮都会回到第一次重试，绕过 5 次上限，也无法形成预期的指数退避。复现压缩等待时间，在第 8 次请求人为终止；代码自身没有达到上限。

   位置：[过早清零](/Users/feili/Documents/projects/Overleaf-Workshop/src/core/remoteFileSystemProvider.ts:308)。建议完整初始化全部成功后再清零，区分认证错误、可重试错误与协议错误，提供有效的取消/手动重连动作。

9. **B09：隐身模式的消息抓取在空历史或错误结果下不会退出。**

   循环要求新消息与缓存中的某个 ID 相交；缓存是空数组时，相交条件永远不成立。响应缺少 `messages` 时同样反复增加抓取数量。复现连续返回 25 次成功空列表，代码仍请求第 26 次，只有测试主动中止才停下。另有 `SyncTimer` 不在异常后重调度、停止期间正在执行的回调可能重新设定定时器的问题，这两条是源码观察，未计入 13 个复现。

   位置：[无界循环](/Users/feili/Documents/projects/Overleaf-Workshop/src/api/socketioAlt.ts:276)、[定时器生命周期](/Users/feili/Documents/projects/Overleaf-Workshop/src/api/socketioAlt.ts:52)。建议为空列表、错误、没有更多历史和最大抓取量设置终止条件，使用带取消和异常恢复的轮询。

10. **B10：跨目录且同时改名时，远端实际名称与缓存不一致。**

    从 `one/a.tex` 变成 `two/b.tex` 时，代码只执行 `moveEntity(...folder_id)`，没有执行重命名，却直接把缓存中的名称改为 `b.tex`。复现记录到只有 move 请求；模拟服务器按接口契约保留 `a.tex`，缓存却显示 `b.tex`。这会使显示、路径查询与下一次刷新出现不一致。

    位置：[rename 实现](/Users/feili/Documents/projects/Overleaf-Workshop/src/core/remoteFileSystemProvider.ts:1294)、[move 请求只包含目录](/Users/feili/Documents/projects/Overleaf-Workshop/src/api/base.ts:540)。建议明确分步执行移动和改名，对每一步验证，并处理半完成状态。

11. **B11：下载长度校验不兼容压缩响应。**

    Undici fetch 会自动解压 gzip 响应，但 `Content-Length` 仍描述压缩后的传输字节数。当前拿解压后的数组长度去比较，完整下载也会被误判截断。用 Undici MockAgent 返回有效 gzip，58 字节解压为 620 字节，结果被拒绝。是否常见取决于 Overleaf/CDN/代理的压缩设置；不是所有下载都会失败。

    位置：[响应与长度校验](/Users/feili/Documents/projects/Overleaf-Workshop/src/api/network.ts:90)。建议明确处理 `Content-Encoding`，区分传输长度和内容长度，并覆盖压缩响应与 range 组合。

12. **B12：本地副本的正反向 PDF 跳转没有统一映射本地路径。**

    `CompileManager.check` 对本地副本返回项目根 URI。正向跳转随后从根 URI 拆出源文件路径，得到空字符串；反向跳转始终构造 `overleaf-workshop:` URI。复现中活动文件是本地 `chapter.tex`，正向请求的源路径是空字符串，反向调用打开了云端文件。这可能让用户在同一窗口中编辑错副本。编译诊断也直接绑定远端 URI，是同类源码问题，未单独进行 UI 验证。

    位置：[本地模式 URI](/Users/feili/Documents/projects/Overleaf-Workshop/src/compile/compileManager.ts:142)、[正向跳转](/Users/feili/Documents/projects/Overleaf-Workshop/src/compile/compileManager.ts:271)、[反向跳转](/Users/feili/Documents/projects/Overleaf-Workshop/src/compile/compileManager.ts:326)。建议统一项目身份、相对文件路径、本地与远端 URI 的映射，让诊断和跳转使用用户当前编辑副本。

13. **B13：每次合并编辑产生完整内容对象，解决后没有回收。**

    每次文本变更都把完整文档写入 content-addressed 对象库，没有防抖或只保留最终草稿的策略。`pruneBackups` 只管理备份目录，未管理 objects 或 merge 会话目录。复现保存 20 个不同草稿并完成合并后，仍有 23 个无引用内容对象，即使调用备份清理也不会删除。实际增长取决于文档大小与编辑次数；例如 100 KiB 文档产生一万份不同内容对象，原始内容量就接近 1 GiB，这是容量估算，不是本轮压力测试结果。

    位置：[每次文本变更持久化](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/conflictManager.ts:108)、[对象存储](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:71)、[备份清理](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/stateStore.ts:166)。建议合并草稿写入做防抖/合并队列，按基线、当前冲突和日志可达性回收内容对象，关闭已解决会话后清理合并目录。

**与最近合并页面直接相关的发行限制：** 0.16.6 的页面内按钮依赖 `contribEditorContentMenu`。普通安装 VSIX 不会自动打开该接口，需要运行时启用并完全重启 VS Code，因此这个版本还不是普通用户即装即用的稳定发行形态。声明位置：[package.json](/Users/feili/Documents/projects/Overleaf-Workshop/package.json:928)。已有启用文档，但文档不能替代实际交互验证。原生窗口测试此前被自动审批服务 404 阻断，本轮没有重试该启动动作，也没有把单元测试通过当作按钮已显示的证据。

**其他体验与健壮性观察，尚未计入上述已复现问题：**

- 本地副本内的语言功能覆盖不足：`IntellisenseProvider.selector` 只选择 `overleaf-workshop` scheme，本地 `file:` 文档不会获得这些内置补全/格式化/符号服务。其他 LaTeX 扩展可能补足，不能据此断言用户完全没有这些功能。见 [intellisense/index.ts](/Users/feili/Documents/projects/Overleaf-Workshop/src/intellisense/index.ts:17)。
- 一些“冲突”实际是脏缓冲区或路径冻结，没有可合并的 `pendingConflictId`，但 UI 放在同一个 Conflicts 分组，容易出现“标红了却没有可解决内容”。应区分内容冲突、暂缓同步、路径不受支持、网络未验证。见 [协调器的 merge 分支](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/coordinator.ts:494)。
- 初始化失败时存在资源清理缺口：`initWatch` 在 `initialize` 之前创建 ConflictManager、装饰器、输出和 SCM，失败后 `createSCM` 仅捕获记录，没有释放这些已分配对象。见 [初始化顺序](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSCM.ts:326)、[失败捕获](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/scmCollectionProvider.ts:139)。
- 隐身模式、历史与拼写状态存在未统一管理的定时器；源码中有不保存句柄的 `setInterval` 和反复 `setTimeout`，缺少对应 dispose。需要持续运行和重连压力测试确认实际泄漏规模。见 [历史定时器](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/historyViewProvider.ts:80)、[语言状态轮询](/Users/feili/Documents/projects/Overleaf-Workshop/src/intellisense/langIntellisenseProvider.ts:57)。
- 远端修改通知的完整性仍需真实服务器验证。读取快照后会对未打开的文档执行 `leaveDoc`，本地副本主要靠文件变更事件触发同步，没有周期性远端补扫。如果服务器仅向已订阅文档发送 OT 更新，可能漏掉纯远端修改。现有 FakeAdapter 测试会主动调用 `handleRemote`，不能验证订阅协议。见 [leaveDoc](/Users/feili/Documents/projects/Overleaf-Workshop/src/core/remoteFileSystemProvider.ts:760)、[RemoteChangeMonitor](/Users/feili/Documents/projects/Overleaf-Workshop/src/scm/localReplicaSync/monitors.ts:58)。此项是待确认风险，不作为已证实故障。

**已具备的有效保护：** 本地副本有内容哈希基线、版本化远端快照、按路径串行、写入日志与备份、未验证结果保持 pending、冲突跨保存/重启保留，以及旧快照拒绝应用。HTTP 普通请求有超时和错误分类，非幂等写入不会按普通 GET 自动重试；Socket 确认有超时与连接代次检查。97 项现有测试确实覆盖了这些核心行为，因此不建议推倒重写。

**健壮性判断与建议顺序：**

| 方面 | 判断 | 下一步最有价值的工作 |
| --- | --- | --- |
| 单文件、单实例同步核心 | 已有防护，覆盖较好 | 保留现有基线、日志、版本验证和冲突冻结机制 |
| 数据边界与并发写入 | 存在已复现的保护缺口 | 先修 B01–B06，统一写入入口、路径校验和副本所有权 |
| 异常恢复 | 部分错误会卡住或无限循环 | 修编译状态机、完整初始化重试、隐身模式退出条件 |
| 长期运行 | 尚无完整容量和资源回收策略 | 草稿对象回收、计时器取消、失败初始化清理 |
| 日常使用与发布 | 路径语义和安装门槛不一致 | 修 PDF/诊断映射、移动改名、压缩下载，明确稳定发行方案 |
| 测试可信度 | 核心单元测试有效，不能代表整插件稳定 | 把本轮复现变成回归测试，补真实 extension-host、双窗口、断线及 Unicode 场景 |

建议先完成一轮“数据不会静默丢失、不会同步越界”的修复，再处理编译/重连/隐身模式恢复，最后完善页面按钮部署、跳转、文案及长期资源回收。是否修复、如何分版本发布，尚未在本轮执行。
