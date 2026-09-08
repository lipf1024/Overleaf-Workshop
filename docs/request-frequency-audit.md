# 网络调用频率核查与调整（2026-09-08）

## 范围与证据

对照官方固定提交 `28ad3b03b71cb4311decdcb55c36b33ec10d72db` 的完整源码归档，逐项追踪当前插件 **53 个 HTTP 业务入口、5 类主动 Socket.IO 消息**及本地副本调用链。53 包含 `refreshDocMetadata` 及 0.16.18 新增的延迟打开 PDF 数据源 `describePdf`（复用现有服务器路径）；下载公共实现 `download` / `_downloadAbsolute`、HTTP `request` 不重复计数。官方源码保存在本次临时核查目录，不将它打包到插件中。

这是源码与单元测试核查，未登录项目、未做线上请求计数、未声称 overleaf.com 当前部署恰好就是该提交。服务端限流阈值不是前端应该采用的发送间隔。下表中的“类别一致”仅指触发方式同类，不代表逐条网络轨迹完全一致。

0.16.19 补充：在线文本改为共享 OT 会话，首次加入一次、恢复按版本追赶，保存不再重复全文读取；5 秒去重重试、45 秒确认期限，紧凑 ACK 与完整回显均受支持。订阅保持到项目关闭；已移除无调用者的 leaveDoc。完整边界见 [OT 同步](ot-sync.md)。

0.16.18 补充：Cookie 与历史 diff 编码已修复，PDF 预览新增按需分段及同构建块缓存。以下已同步当前下载路径，完整限制见 [网络清单](network-requests.md)。

## 已作调整

1. 拼写输入防抖改为官方的 **1000 ms**。到期才读取最新文档；排队中被更新的文档版本不再提交，关闭/语言变化/释放清理待发任务，避免半截单词排队。仍保留旧 HTTP 服务能力检测。官网检查可见/变更范围，插件为保证删除换行后的诊断位置正确，在空闲后读取最新全文并用单词缓存去重；CPU 范围不完全相同。[SP]
2. 光标改为有其他协作者 **500 ms**、没有其他协作者 **5 分钟**的尾端防抖。后续光标更新重置计时，不是定时每 5 分钟发包。协作者数量变化会重新安排最新位置；断线/释放清理待发任务。在线用户在首次加入和重新加入后读取一次，随后使用推送。[CURSOR]
3. 元数据改为项目缓存与正在进行的 GET 合并，补全不再反复请求整个项目。接入 `broadcastDocMeta` 及官方单文档刷新 POST；本地文本发送后 **2000 ms**防抖，文本上传后 **250 ms**刷新；删除与重连处理缓存，迟到的旧连接读取不能覆盖新状态。广播到达时不能被较早发出的 GET 覆盖。[META] [METAS] [UPLOAD]
4. 收到 `autocompile-backoff` 后暂停该项目后续保存自动编译，避免下一次保存继续打被拒的请求。手动编译仍可执行，成功后恢复自动编译；这是插件没有网站自动编译开关时的恢复入口差异。[BACKOFF]
5. 收到 `forceDisconnect` 后按服务端 delay 关闭，禁止自动重新初始化连接，保留手动 Retry Connection。官方该指令发送点是管理员更新/维护编辑器，不应解释为已经证实用户被限流。[CONNECTION] [ADMIN]
6. 普通自动重连采用官方活跃客户端 **3–9 秒随机等待**，插件仍最多尝试 5 次；首次用户打开仍立即连接。官方另有不活跃用户 60–179 秒加 backoff 的分支，插件没有相同的浏览器活动状态，未引入可能打断后台磁盘同步的空闲断开。[CONNECTION]
7. 同项目文件上传采用官方 **并发 1**，包括本地副本暂存上传。队列等前一上传结束，错误不自动重放该上传，也不会永远阻塞下一项。队列作用域为一个 API 实例中的项目，不声称跨 VS Code 窗口全局限流。[UPLOAD]

## 全部 HTTP 封装覆盖

所有业务封装均列出；详细 URL/body/调用文件继续以 [network-requests.md](network-requests.md) 为索引。

| 封装 | 当前触发/频率 | 官方依据 | 核查结果 |
|---|---|---|---|
| `getCsrfToken` | 登录、验证 Cookie、退出时；无输入触发或定时轮询 | [AUTH] [ROUTES] | 按操作触发；插件自行抓取 HTML/Cookie，浏览器没有同样的登录准备链，不宣称请求数相同 |
| `getUserId` | 登录、验证 Cookie、退出时；无输入触发或定时轮询 | [AUTH] [ROUTES] | 按操作触发；插件自行抓取 HTML/Cookie，浏览器没有同样的登录准备链，不宣称请求数相同 |
| `passportLogin` | 登录、验证 Cookie、退出时；无输入触发或定时轮询 | [AUTH] [ROUTES] | 按操作触发；插件自行抓取 HTML/Cookie，浏览器没有同样的登录准备链，不宣称请求数相同 |
| `updateCookies` | 登录、验证 Cookie、退出时；无输入触发或定时轮询 | [AUTH] [ROUTES] | 按操作触发；插件自行抓取 HTML/Cookie，浏览器没有同样的登录准备链，不宣称请求数相同 |
| `logout` | 登录、验证 Cookie、退出时；无输入触发或定时轮询 | [AUTH] [ROUTES] | 按操作触发；插件自行抓取 HTML/Cookie，浏览器没有同样的登录准备链，不宣称请求数相同 |
| `userProjectsJson` | 树列表加载/刷新、选择来源项目；旧项目列表接口为兼容回退 | [LIST] [TAGS] [USERPROJECT] | 按列表需求读取；官网支持首屏预载/分页，插件显式刷新。没有高频输入触发，不加无依据的秒数 |
| `getProjectsJson` | 树列表加载/刷新、选择来源项目；旧项目列表接口为兼容回退 | [LIST] [TAGS] [USERPROJECT] | 按列表需求读取；官网支持首屏预载/分页，插件显式刷新。没有高频输入触发，不加无依据的秒数 |
| `projectEntitiesJson` | 用户选择跨项目链接的来源项目时 | [ENTITIES] | 按来源项目读取，无定时轮询 |
| `newProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `cloneProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `renameProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `deleteProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `archiveProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `unarchiveProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `trashProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `untrashProject` | 对应的用户项目管理操作 | [PROJECT] | 事件触发类别一致；不自动重放 POST/DELETE |
| `getFile` | 打开二进制文件、同步快照及写前/写后确认 | [TREE] [DOC] | 按需；本地副本额外校验保留，下载全量/范围差异未在本轮迁移 |
| `addDoc` | 用户文件操作或本地副本确认的变更 | [TREE] | 用户操作类别一致；本地副本的磁盘变更/校验见下文，不按逐字输入生成文件管理请求 |
| `uploadFile` | 文件上传、本地副本二进制暂存；现在同一 API 实例的同一项目并发上限 1 | [UPLOAD] | 已调整：官方 Uppy limit:1；已成功上传的文本实体 250 ms 后更新元数据 |
| `uploadProject` | 用户导入 ZIP | [ZIP] | 一次导入一个请求；与官网上传模式同类，没有周期任务 |
| `addFolder` | 用户文件操作或本地副本确认的变更 | [TREE] | 用户操作类别一致；本地副本的磁盘变更/校验见下文，不按逐字输入生成文件管理请求 |
| `deleteEntity` | 用户文件操作或本地副本确认的变更 | [TREE] | 用户操作类别一致；本地副本的磁盘变更/校验见下文，不按逐字输入生成文件管理请求 |
| `renameEntity` | 用户文件操作或本地副本确认的变更 | [TREE] | 用户操作类别一致；本地副本的磁盘变更/校验见下文，不按逐字输入生成文件管理请求 |
| `moveEntity` | 用户文件操作或本地副本确认的变更 | [TREE] | 用户操作类别一致；本地副本的磁盘变更/校验见下文，不按逐字输入生成文件管理请求 |
| `compile` | 保存/手动/初次预览；忙时合并一次后续任务 | [COMPILE] [BACKOFF] | 保存立即执行按用户既有要求保留；官方逐字自动编译 2500 ms 防抖、maxWait 5000 ms，不是保存防抖；服务端 backoff 已持久暂停自动任务 |
| `stopCompile` | 用户停止当前编译 | [COMPILE] | 按明确停止动作发送，无轮询 |
| `getMetadata` | 同项目同连接首次补全时加载一次；并发请求合并，随后读缓存 | [META] | 已调整：去掉每次引用补全 GET；官方是首次 project:joined 后 200 ms 预加载，插件按首次需要懒加载 |
| `refreshDocMetadata` | 本地文本 OT 已发送确认后，按文档 2000 ms 防抖；文本上传后 250 ms | [META] [METAS] [UPLOAD] | 新增已接入：多人 broadcast:true 接收广播，单人 false 使用响应；旧部署 403/404/405/501 后不重复 POST，退回变更后防抖 GET |
| `proxyRequestToSpellingApi` | 初次打开立即；编辑停止 1000 ms 后检查最新文档；缓存命中不发请求 | [SP] | 已调整调度；仍是旧 HTTP 引擎，官网使用本地 Hunspell，网络请求数不相同，不能称完全对齐 |
| `spellingControllerLearn` | 用户添加/移除词典词条 | [SP] [ROUTES] | 用户动作触发；不随每次输入发送 |
| `spellingControllerUnlearn` | 用户添加/移除词典词条 | [SP] [ROUTES] | 用户动作触发；不随每次输入发送 |
| `getProjectSettings` | 项目初始化、重连、必要的树重新加入时读取 HTML | [CONNECTION] [ROUTES] | 浏览器从页面 meta 获取，插件额外读取；受初始化 promise 合并，不是定时设置轮询 |
| `updateProjectSettings` | 用户改变编译器、主文件、拼写语言 | [ROUTES] | 按设置提交触发，不对每次输入提交设置 |
| `describePdf` / `PdfByteSource` | 新预览/构建变化时探测；PDF.js 按需取 64 KiB 块，命中缓存不请求，失败重试该块 | [PDF] | 0.16.18 新增标准 Range；强 ETag 约束，安全完整回退；未移植官方跨构建对象缓存 |
| `getFileFromClsi` | 编译输出发布后，PDF/日志/BBL 被打开或刷新时下载 | [PDF] [COMPILE] | 编译驱动；PDF 自定义预览已改走 describePdf；此入口保留普通 fs.readFile/日志等完整读取，不声称与官网对象缓存相同 |
| `proxySyncPdf` | 用户源码/PDF 双向定位动作 | [SYNC] | 动作触发，无随光标移动轮询 SyncTeX |
| `proxySyncCode` | 用户源码/PDF 双向定位动作 | [SYNC] | 动作触发，无随光标移动轮询 SyncTeX |
| `getAllTags` | 树列表加载/刷新、选择来源项目；旧项目列表接口为兼容回退 | [LIST] [TAGS] [USERPROJECT] | 按列表需求读取；官网支持首屏预载/分页，插件显式刷新。没有高频输入触发，不加无依据的秒数 |
| `createTag` | 对应的用户标签操作 | [TAGS] [PROJECT] | 事件触发类别一致；无后台轮询 |
| `renameTag` | 对应的用户标签操作 | [TAGS] [PROJECT] | 事件触发类别一致；无后台轮询 |
| `deleteTag` | 对应的用户标签操作 | [TAGS] [PROJECT] | 事件触发类别一致；无后台轮询 |
| `addProjectToTag` | 对应的用户标签操作 | [TAGS] [PROJECT] | 事件触发类别一致；无后台轮询 |
| `removeProjectFromTag` | 对应的用户标签操作 | [TAGS] [PROJECT] | 事件触发类别一致；无后台轮询 |
| `proxyToHistoryApiAndGetUpdates` | 首次历史加载/分页 | [HISTORY] [HAPI] | 按需分页；30 秒 TreeData 刷新只读本地缓存 |
| `proxyToHistoryApiAndGetFileDiff` | 选择历史版本/文件进行比较 | [HISTORY] [HAPI] | 选择驱动；不是逐字编辑或周期拉取 |
| `proxyToHistoryApiAndGetFileTreeDiff` | 选择历史版本/文件进行比较 | [HISTORY] [HAPI] | 选择驱动；不是逐字编辑或周期拉取 |
| `downloadZipOfVersion` | 用户下载历史 ZIP、添加/删除版本标签 | [HAPI] | 动作触发，无后台写入/下载循环 |
| `createLabel` | 用户下载历史 ZIP、添加/删除版本标签 | [HAPI] | 动作触发，无后台写入/下载循环 |
| `deleteLabel` | 用户下载历史 ZIP、添加/删除版本标签 | [HAPI] | 动作触发，无后台写入/下载循环 |
| `getMessages` | 聊天视图加载读取消息、用户发送消息；新消息由 Socket 推送 | [CHAT] | 没有聊天轮询；官网另有分页，插件默认最多 50 条。无需套固定输入防抖 |
| `sendMessage` | 聊天视图加载读取消息、用户发送消息；新消息由 Socket 推送 | [CHAT] | 没有聊天轮询；官网另有分页，插件默认最多 50 条。无需套固定输入防抖 |
| `refreshLinkedFile` | 用户刷新/创建外部链接文件 | [LINK] | 动作触发；不随文本输入刷新外部资源 |
| `createLinkedFile` | 用户刷新/创建外部链接文件 | [LINK] | 动作触发；不随文本输入刷新外部资源 |

## 全部主动 Socket.IO 消息覆盖

| 消息 | 官方 | 当前插件与决定 |
|---|---|---|
| `joinProject` | 建立/恢复连接后加入项目 [CONNECTION] | 初始化与恢复 promise 合并；强制断开阻止自动加入；普通重连有随机等待和最多 5 次上限。副本需要确认树时也会重新加入，额外成本保留并记录 |
| `joinDoc` | 打开文档/恢复订阅 [DOC] | 首次初始化、断线恢复；按文档合并初始化，恢复带 fromVersion。健康在线保存及文本快照复用已确认会话，不重复读取全文 |
| `applyOtUpdate` | 单人 flushDelay **2000 ms**，收到 remoteop 后 **500 ms**；一个 inflight，后续 pending 用 OT compose；延时从首次提交开始，不是每次输入重置的尾端防抖；编译/关闭可立即 flush [OT] [BUFFER] [DOC] | 保存后立即提交增量，一个 inflight、后续保存 compose，远端操作双向变换。5 秒去重重试，45 秒暂停。保留保存边界，不叠加官网逐键 flushDelay；确认以 otUpdateApplied 为准 |
| `clientTracking.getConnectedUsers` | 每次 project:joined 后读取，后续推送 [CURSOR] | 已补齐重新加入后的读取与当前 publicId 更新，不增加轮询 |
| `clientTracking.updatePosition` | 有人 500 ms，无人 5 分钟尾端防抖 [CURSOR] | 已对齐延迟与最新位置合并；插件仍等待可选 ACK，官方前端不带 callback，服务端两种均支持 |

被动消息不是主动请求，但可能引出后续读取：`otUpdateApplied` 更新缓存并通知副本；文件树消息更新树；`broadcastDocMeta` 更新元数据；聊天与在线用户推送更新 UI。不能用状态栏刷新周期推算服务器请求频率。

## 本地副本：使用多人协作作为参照

已检查 `localReplicaSCM.ts`、`localReplicaSync/monitors.ts`、`coordinator.ts`、`remoteFileSystemProvider.ts` 的观察、路径排队、快照与 OT 提交链。

- 文本使用独立 OT 会话，维护 confirmed、inflight、pending 和 draft；服务器版本只由会话推进。接收实际远端操作，变换本地保存与未保存内容；不把 socket 接收回调当成应用确认。
- 本地 watcher 对同路径 500 ms 合并，并等待磁盘稳定；这是处理文件写入/原子替换，不是服务器“每 500 ms 拉一次”。编译准备可提前处理已保存的当前路径，避免二次等待。
- 同路径有队列、同条件正在进行的远端快照复用；已确认相同内容可以跳过提交。不同文件的上传现在也受项目并发 1 约束。
- 在线文本取消重复全文读取，采用版本连续性和应用确认。二进制暂存、读回、替换验证及本地磁盘恢复日志保留；未知提交不能丢弃或改版本重发。
- 2 秒 owner/state 观察、250 ms 草稿持久化（最长等待 1 秒）、10 分钟本地垃圾回收均主要是本地 I/O，不是相同周期的 Overleaf 轮询。获取所有权/恢复时才可能产生初始化与同步请求。

## 有意保留或尚未对齐的差异

这些不是“已经完全一致”。

- **拼写引擎**：官网本地 Hunspell；本轮对齐调度但未移植引擎，所以插件旧接口仍可能产生 HTTP 请求。遇不支持的 404/405/501 后停止。
- **保存编译与文本发送**：保留用户此前明确要求的首次保存立即同步/编译。官方 2500 ms、maxWait 5000 ms 是输入自动编译策略，且依赖 ShareJS 的缓冲发送；不能机械叠加到插件保存流程。[COMPILE]
- **元数据**：官网项目加入 200 ms 后预加载、语法层发现 metadata-outdated 后按文档 2000 ms 刷新；插件首次补全懒加载，已提交文本变化后刷新，不具备官网完全相同的语法触发粒度。旧服务器没有单文档接口时退回变更防抖 GET，可能有额外请求。
- **重试与连接**：官网通用 fetch-json 没有插件相同的 GET 自动重试循环；插件保留最多 2 次有界读取重试和 Retry-After，POST/DELETE 不重放。官方空闲/慢心跳逻辑依赖浏览器可见性与活动模型；插件仍需后台副本同步，不复制空闲断开。旧 Socket.IO 0.9 的握手/心跳不声称与官网兼容层完全一致。[FETCH] [CONNECTION]
- **PDF 与二进制**：0.16.18 已接入 PDF.js 标准 Range transport 和当前构建块缓存；不支持安全分段的服务器、普通二进制/ZIP 仍完整读取。官方跨构建对象缓存未移植，线上首屏性能仍需实测。[PDF]
- **磁盘恢复校验、登录准备、列表预载/分页**：有上述明确的架构/交互差异，不能声称按请求条数一致。未发现把所有普通接口挂在逐字输入或固定高频轮询上的实现。

## 验证

新增调度测试使用虚拟时间，覆盖实际 1000/500/300000/2000 ms 边界、半截单词合并、过时排队任务、关闭/断线/释放、元数据合并和广播竞态、服务端强制断开、上传串行与失败后队列释放、单文档元数据参数、自动编译 backoff 跨保存生效。0.16.17 当时的完整单元测试 **202 项通过**，TypeScript/聊天视图构建与 lint 通过。没有实际 VS Code GUI/Overleaf 多用户压力测试，因此不提供实测 QPS 或延迟保证。

## 官方源文件

- **[SP]** [services/web/frontend/js/features/source-editor/extensions/spelling/spellchecker.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/source-editor/extensions/spelling/spellchecker.ts)
- **[META]** [services/web/frontend/js/features/ide-react/context/metadata-context.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/context/metadata-context.tsx)
- **[METAS]** [services/web/app/src/Features/Metadata/MetaController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Metadata/MetaController.mjs)
- **[CURSOR]** [services/web/frontend/js/features/ide-react/context/online-users-context.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/context/online-users-context.tsx)
- **[OT]** [services/web/frontend/js/features/ide-react/editor/share-js-doc.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/editor/share-js-doc.ts)
- **[BUFFER]** [services/web/frontend/js/vendor/libs/sharejs.js](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/vendor/libs/sharejs.js)
- **[DOC]** [services/web/frontend/js/features/ide-react/editor/document-container.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/editor/document-container.ts)
- **[COMPILE]** [services/web/frontend/js/features/pdf-preview/util/compiler.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/compiler.ts)
- **[BACKOFF]** [services/web/frontend/js/shared/context/local-compile-context.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/shared/context/local-compile-context.tsx)
- **[CONNECTION]** [services/web/frontend/js/features/ide-react/connection/connection-manager.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/connection/connection-manager.ts)
- **[ADMIN]** [services/web/app/src/Features/ServerAdmin/AdminController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/ServerAdmin/AdminController.mjs)
- **[UPLOAD]** [services/web/frontend/js/features/file-tree/components/file-tree-create/modes/file-tree-upload-doc.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/components/file-tree-create/modes/file-tree-upload-doc.tsx)
- **[ZIP]** [services/web/frontend/js/features/project-list/hooks/use-project-uploader.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/hooks/use-project-uploader.tsx)
- **[PROJECT]** [services/web/frontend/js/features/project-list/util/api.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/util/api.ts)
- **[LIST]** [services/web/frontend/js/features/project-list/context/project-list-context.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/context/project-list-context.tsx)
- **[TAGS]** [services/web/frontend/js/features/project-list/hooks/use-project-tags.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/hooks/use-project-tags.tsx)
- **[TREE]** [services/web/frontend/js/features/file-tree/util/sync-mutation.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/util/sync-mutation.ts)
- **[LINK]** [services/web/frontend/js/features/file-tree/util/api.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/util/api.ts)
- **[ENTITIES]** [services/web/frontend/js/features/file-tree/hooks/use-project-entities.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/hooks/use-project-entities.ts)
- **[USERPROJECT]** [services/web/frontend/js/features/file-tree/hooks/use-user-projects.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/hooks/use-user-projects.ts)
- **[HISTORY]** [services/web/frontend/js/features/history/context/history-context.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/history/context/history-context.tsx)
- **[HAPI]** [services/web/frontend/js/features/history/services/api.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/history/services/api.ts)
- **[CHAT]** [services/web/frontend/js/features/chat/context/chat-context.tsx](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/chat/context/chat-context.tsx)
- **[PDF]** [services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts)
- **[SYNC]** [services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts)
- **[FETCH]** [services/web/frontend/js/infrastructure/fetch-json.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/infrastructure/fetch-json.ts)
- **[ROUTES]** [services/web/app/src/router.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/router.mjs)
- **[AUTH]** [services/web/app/src/Features/Authentication/AuthenticationController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Authentication/AuthenticationController.mjs)

[SP]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/source-editor/extensions/spelling/spellchecker.ts
[META]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/context/metadata-context.tsx
[METAS]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Metadata/MetaController.mjs
[CURSOR]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/context/online-users-context.tsx
[OT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/editor/share-js-doc.ts
[BUFFER]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/vendor/libs/sharejs.js
[DOC]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/editor/document-container.ts
[COMPILE]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/compiler.ts
[BACKOFF]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/shared/context/local-compile-context.tsx
[CONNECTION]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/ide-react/connection/connection-manager.ts
[ADMIN]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/ServerAdmin/AdminController.mjs
[UPLOAD]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/components/file-tree-create/modes/file-tree-upload-doc.tsx
[ZIP]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/hooks/use-project-uploader.tsx
[PROJECT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/util/api.ts
[LIST]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/context/project-list-context.tsx
[TAGS]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/project-list/hooks/use-project-tags.tsx
[TREE]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/util/sync-mutation.ts
[LINK]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/util/api.ts
[ENTITIES]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/hooks/use-project-entities.ts
[USERPROJECT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/file-tree/hooks/use-user-projects.ts
[HISTORY]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/history/context/history-context.tsx
[HAPI]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/history/services/api.ts
[CHAT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/chat/context/chat-context.tsx
[PDF]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts
[SYNC]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts
[FETCH]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/infrastructure/fetch-json.ts
[ROUTES]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/router.mjs
[AUTH]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Authentication/AuthenticationController.mjs
