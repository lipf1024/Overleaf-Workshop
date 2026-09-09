# 当前网络请求清单与 Overleaf 官方源码核对

## 1. 基准与结论

- 日期：2026-09-08；插件：当前工作区 **0.16.23** 源码。
- 官方基准：`28ad3b03b71cb4311decdcb55c36b33ec10d72db`（2026-06-26T08:08:18Z；本轮使用已获取的官方 main 固定快照）。所有官方链接固定到此提交，避免 main 漂移。
- 范围：`src/api/base.ts`、`extendedBase.ts`、`socketio.ts`、`socketSafety.ts`、`network.ts`，并追踪 VFS、本地副本、编译、补全、聊天、历史和 Webview 调用者。
- 提取结果：**53 个 HTTP 业务入口（含延迟打开的 PDF 数据源），均找到生产调用者；5 类主动 Socket.IO 事件**。这是方法数，不是唯一 URL 数、单次操作请求数，也不包含 Socket.IO 底层握手/心跳。PDF CMap 的第三方资源另列。
- “路由存在”只代表官方代码存在同一路径/用途，不代表线上所有部署已启用、不代表公开 API 稳定性承诺，也不代表性能达标。协议必需条件、官方实现习惯和插件自选策略分开记录。
- 本轮没有登录真实项目、没有发起编译/写入/压力测试。结论基于源码，**不能给出真实 p95 延迟、下载吞吐或线上限流阈值**。此文档记录当前实现；原始审查未操作线上项目，后续修复版本已在各项注明。

0.16.23 更新：文件同步入口先检查本地类型和已加载远端目录树，目录不再被当作二进制文件下载/上传。远端目录事件枚举文件路径后，仅协调其后代文件；不新增 HTTP/Socket.IO 接口或轮询。旧版无内容的目录错误记录在确认没有基线、冲突及恢复日志后自动清理。

0.16.22 更新：编译仅准备触发文件和本轮保存的同项目文件，OT 确认等待按文档范围捕获；不再等待全项目同步队列或因其他待上传文件阻止编译。其他待同步文件只提示，编译使用其当前远端版本。本轮必需文件未确认仍暂停，PDF 显示具体原因。此调整没有新增 HTTP/Socket.IO 接口、定时轮询或自动上传新文件策略。

0.16.19 更新：健康在线文本保存改用共享 OT 会话，复用订阅版本，不再四次读取全文。兼容 `{doc,v}` 应用确认和完整操作回显，增加版本追赶、去重恢复、独立持久化日志及有限编译等待。文档订阅保持到项目会话结束；移除已无调用者的 `leaveDoc` 封装。详见 [OT 同步与恢复](ot-sync.md)。

0.16.18 更新：Cookie 合并/失效清理与响应体释放、历史 diff 查询编码已修复；PDF 预览新增 64 KiB 按需分段、块缓存/合并、单块重试及同构建复用。不支持安全分段时回退完整下载，见 N2/N5/N6。

0.16.17 调用频率核查：新增已接入的单文档元数据刷新，调整拼写/光标/元数据调度、上传串行、编译退避、强制断开与重连。逐项覆盖和有意保留的差异见 [调用频率核查](request-frequency-audit.md)。

0.16.16 更新：传输/上传预算已改为 10 分钟，ZIP name/编码/响应校验已修复；旧拼写接口不支持时明确提示一次并停止请求，失败不再缓存为正确词。新版 Hunspell 引擎尚未移植。以下 N1/N2/N3/N7 保留审查背景并标注剩余限制。

主要结论：核心项目/文件/编译路由大体有官方依据；0.16.15 的七项修复、0.16.16 的传输/ZIP/拼写失败处理，0.16.17 的调用调度调整及 0.16.18 的 Cookie、历史查询、PDF 分段预览已落地。但不能给出“全部符合”的结论。仍有拼写检查旧路由、部分服务器只能完整下载、标签响应类型、HTML 会话耦合及输出路由部署适配等差异，见第 6 节。

## 2. 请求公共策略

| 类型 | 当前实现 | 判断 |
|---|---|---|
| 普通 HTTP JSON/HTML | `fetchWithPolicy`，默认 15 秒；`redirect: manual`；成功接受 200/201/204 | 短请求可用；上传已采用单独 10 分钟策略 |
| GET 自动重试 | 最多重试 2 次（含首次最多 3 次）；429/5xx/部分网络错误；约 1 秒、2 秒加抖动 | 有界重试合理；不是官方规定的统一次数 |
| Retry-After | 秒数/日期均识别，不再截到 30 秒（受 JavaScript 定时器最大值限制） | 退避等待可由调用者信号取消。所查官方基础限流中间件只发 429 文本，不保证携带该头 [LIMIT] |
| 文件上传并发 | 同一 API 实例、同一项目的 uploadFile 并发上限为 1；前一项结束后才开始下一项，失败不重放 | 包括本地副本暂存上传；不是跨窗口的全局限流 |
| POST/DELETE | 默认不自动重试；`POST /api/project` 虽用于读取也不重试 | 保守，避免重复创建/删除；不是性能违规 |
| 编译 | 独立 12 分钟客户端等待；支持 AbortSignal；超时/网络断开可归类 unknown-outcome；autocompile-backoff 暂停该项目自动编译，手动编译成功恢复 | 与长编译需求匹配；12 分钟不是账户可用编译额度。服务端预算依据 [CLSI] |
| 普通文件/ZIP/完整下载回退 | `undici.request`；每次下载尝试默认 10 分钟（续段共享预算）；全量读入；失败最多重试 2 次；重试通常从头开始 | 超时预算已修复；仍需完整读取，失败重试通常从头开始，见 N2 |
| PDF 按需预览 | 首次 Range 探测 64 KiB；206 且强 ETag 时按 PDF.js 所需块读取，If-Range 验证；缓存块并合并相同块请求，失败最多重试该块 2 次 | 关闭预览取消请求；同构建复用；200 直接缓存完整结果；弱/缺失 ETag 或压缩响应回退完整下载。不保证所有部署都能分段 |
| 普通下载的 206 续段处理 | 校验 Content-Range、长度、ETag；续段加 Range/If-Range；最终聚合后才返回 | 有基本一致性保护；不是“边下边看”。弱/缺失 ETag 的强一致性仍需按服务端实际行为评估 |
| 压缩下载 | 请求 identity，校验线上字节长度，支持 gzip/br/deflate 解码；压缩 206 尝试全量回退 | 完整性保护；identity 可能增加可压缩文本传输量，是明确的取舍 |
| 认证 | Web 请求携带 Cookie；JSON POST 携带 `_csrf`，部分额外带 `X-Csrf-Token`；DELETE 用头；文件上传用 multipart + CSRF 头 | 与会话 Web 路由方式一致。multipart ZIP 的 CSRF 在查询中，需正确编码 |
| CDN | 仅动态输出下载域分支不发送网站 Cookie | 避免跨域泄露 Cookie；其选择条件与官方略有差别，见 N5 |
| Socket.IO ACK | 默认 10 秒；连接 epoch 保护；断连/超时不自动重发写操作 | 合理安全策略，10 秒并非官方协议必需值 |
| 重连 | 外层最多 5 次尝试，失败后每次 3–9 秒随机等待，认证错误终止；服务器 forceDisconnect 禁止自动重连，保留手动 Retry Connection；先销毁旧连接 | 有界恢复；不应只看底层旧注释判断为无限重连 |

实现位置：[HTTP 与下载](../src/api/network.ts)、[认证与 REST](../src/api/base.ts)、[Socket ACK](../src/api/socketSafety.ts)、[VFS 初始化与重连](../src/core/remoteFileSystemProvider.ts)。

## 3. HTTP 请求清单

说明：`{...}` 为运行时变量，未记录真实 Cookie、CSRF、项目 ID 或私有文件内容。生产调用列是静态找到的入口之一；封装内部的 Cookie 登录链也算调用。`body`/`formData` 在表后解释。官方引用只覆盖明确注明的核对程度。

| 方法封装 / 代码 | HTTP 与路径 | 主要请求体 | 触发 / 调用位置 | 官方核对与结论 |
|---|---|---|---|---|
| [getCsrfToken](../src/api/base.ts) | `GET /login` | `—` | 登录/验证 Cookie；[src/api/base.ts](../src/api/base.ts) | HTML/会话耦合；见 N6 [A] |
| [getUserId](../src/api/base.ts) | `GET /project` | `—` | 登录/验证 Cookie；[src/api/base.ts](../src/api/base.ts) | HTML/会话耦合；见 N6 [A] |
| [passportLogin](../src/api/base.ts) | `POST /login` | `{_csrf,email,password}` | 登录/验证 Cookie；[src/utils/globalStateManager.ts](../src/utils/globalStateManager.ts) | HTML/会话耦合；见 N6 [A] |
| [updateCookies](../src/api/base.ts) | `GET /socket.io/socket.io.js` | `—` | 登录/验证 Cookie；[src/api/base.ts](../src/api/base.ts) | HTML/会话耦合；见 N6 [A] |
| [logout](../src/api/base.ts) | `POST /logout` | `—` | 用户退出登录；[src/utils/globalStateManager.ts](../src/utils/globalStateManager.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [userProjectsJson](../src/api/base.ts) | `GET /user/projects` | `—` | 项目列表刷新；旧接口为回退路径；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [getProjectsJson](../src/api/base.ts) | `POST /api/project` | `{}` | 项目列表刷新；旧接口为回退路径；[src/utils/globalStateManager.ts](../src/utils/globalStateManager.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [projectEntitiesJson](../src/api/base.ts) | `GET /project/{projectId}/entities` | `—` | 选择跨项目链接文件时列举来源文件；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [newProject](../src/api/base.ts) | `POST /project/new` | `{projectName, template}` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [cloneProject](../src/api/base.ts) | `POST /project/{projectId}/clone` | `{projectName}` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [renameProject](../src/api/base.ts) | `POST /project/{projectId}/rename` | `{newProjectName}` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [deleteProject](../src/api/base.ts) | `DELETE /project/{projectId}` | `—` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [archiveProject](../src/api/base.ts) | `POST /project/{projectId}/archive` | `—` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [unarchiveProject](../src/api/base.ts) | `DELETE /project/{projectId}/archive` | `—` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [trashProject](../src/api/base.ts) | `POST /project/{projectId}/trash` | `—` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [untrashProject](../src/api/base.ts) | `DELETE /project/{projectId}/trash` | `—` | 用户项目管理操作；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [getFile](../src/api/base.ts) | `GET /project/{projectId}/file/{fileId}` | `—` | 打开二进制文件/本地副本校验；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；全量下载，10 分钟预算，见 N2 [R] |
| [addDoc](../src/api/base.ts) | `POST /project/{projectId}/doc` | `{parent_folder_id:parentFolderId, name:filename}` | 远端文件操作/副本同步；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；写请求不自动重放，需保留写后验证 [E] |
| [uploadFile](../src/api/base.ts) | `POST /project/{projectId}/upload?folder_id={parentFolderId}` | `formData` | 上传文件/同步暂存文件；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | multipart 与官方一致；同项目并发 1；10 分钟预算及多阶段成本见 N2/N8 [U] |
| [uploadProject](../src/api/base.ts) | `POST /project/new/upload?{params}` | `formData` | 用户导入 ZIP 项目；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | name/查询编码/业务响应已修复；见 N7 [U] |
| [addFolder](../src/api/base.ts) | `POST /project/{projectId}/folder` | `body` | 远端文件操作/副本同步；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；写请求不自动重放，需保留写后验证 [E] |
| [deleteEntity](../src/api/base.ts) | `DELETE /project/{projectId}/{fileType}/{fileId}` | `—` | 远端文件操作/副本同步；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；写请求不自动重放，需保留写后验证 [E] |
| [renameEntity](../src/api/base.ts) | `POST /project/{projectId}/{entityType}/{entityId}/rename` | `{name}` | 远端文件操作/副本同步；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；写请求不自动重放，需保留写后验证 [E] |
| [moveEntity](../src/api/base.ts) | `POST /project/{projectId}/{entityType}/{entityId}/move` | `{folder_id:newParentFolderId}` | 远端文件操作/副本同步；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；写请求不自动重放，需保留写后验证 [E] |
| [compile](../src/api/base.ts) | `POST /project/{projectId}/compile{isAutoCompile?'?auto_compile=true':''}` | `body` | 保存触发/手动编译/预览初始化；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 已区分手动与自动，12 分钟等待；见第 5 节 [CF] |
| [stopCompile](../src/api/base.ts) | `POST /project/{projectId}/compile/stop` | `—` | 用户停止编译；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；不重放 POST；未携带 clsiserverid，需线上验证 [C] |
| [getMetadata](../src/api/base.ts) | `GET /project/{projectId}/metadata` | `—` | 首次补全合并加载，后续读项目缓存；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；见调用频率说明 [R] |
| [refreshDocMetadata](../src/api/base.ts) | `POST /project/{projectId}/doc/{docId}/metadata` | `{broadcast}` | 文本发送后按文档 2 秒防抖；文本上传后 250 ms；[VFS](../src/core/remoteFileSystemProvider.ts) | broadcast=true 通过广播更新缓存，false 使用响应；403/404/405/501 后停止此 POST，退回变更后防抖 GET；见 [频率核查](request-frequency-audit.md) |
| [proxyRequestToSpellingApi](../src/api/base.ts) | `POST /spelling/check` | `body` | 远端文档打开立即/文本变化 1 秒防抖；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 当前官方基础路由无 /spelling/check；见 N1 [SP] |
| [spellingControllerLearn](../src/api/base.ts) | `POST /spelling/learn` | `body` | 用户添加/移除词典词条；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | word 字段匹配；会话确定用户，token 为遗留冗余字段 [SL] |
| [spellingControllerUnlearn](../src/api/base.ts) | `POST /spelling/unlearn` | `{word}` | 用户添加/移除词典词条；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | word 字段匹配；会话确定用户，token 为遗留冗余字段 [SL] |
| [getProjectSettings](../src/api/base.ts) | `GET /project/{projectId}` | `—` | 初始化/重连时抓取项目 HTML；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；正则提取 meta，非结构化设置 API，见 N6 [R] |
| [updateProjectSettings](../src/api/base.ts) | `POST /project/{projectId}/settings` | `setting` | 修改主文件、编译器、拼写语言；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [describePdf](../src/api/base.ts) / [PdfByteSource](../src/api/pdfByteSource.ts) | `GET 输出 URL 或 /project/{id}/file/{fileId}`，带 `Range` / `If-Range` | `—` | PDF 预览首次打开、构建变化、PDF.js 按需取块；[预览](../src/core/pdfViewEditorProvider.ts) | 新增业务入口，复用现有服务器路径；强 ETag 约束分段，旧部署安全回退；Cookie 保留在扩展宿主，CDN 不带 Cookie |
| [getFileFromClsi](../src/api/base.ts) | `GET 编译响应的 output URL（Web/CDN）` | `—` | 普通文件读取下载 PDF/日志等输出；PDF 自定义预览改走 describePdf；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 动态输出 URL；条件式 CDN 无 Cookie，见 N2/N5；含 _downloadAbsolute 分支 [C] |
| [proxySyncPdf](../src/api/base.ts) | `GET /project/{projectId}/sync/pdf?{params}` | `—` | PDF/源码定位操作；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 行号及编码已修；未携带 clsiserverid，需线上验证 [SYNC] |
| [proxySyncCode](../src/api/base.ts) | `GET /project/{projectId}/sync/code?{params}` | `—` | PDF/源码定位操作；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 行号及编码已修；未携带 clsiserverid，需线上验证 [SYNC] |
| [getAllTags](../src/api/base.ts) | `GET /tag` | `—` | 项目列表/链接文件选择时读取标签；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [createTag](../src/api/base.ts) | `POST /tag` | `{name}` | 用户创建项目标签；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 返回单个对象却声明为数组；见 N4 [TAG] |
| [renameTag](../src/api/base.ts) | `POST /tag/{tagId}/rename` | `{name}` | 用户管理项目标签；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [deleteTag](../src/api/base.ts) | `DELETE /tag/{tagId}` | `—` | 用户管理项目标签；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [addProjectToTag](../src/api/base.ts) | `POST /tag/{tagId}/project/{projectId}` | `—` | 用户管理项目标签；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [removeProjectFromTag](../src/api/base.ts) | `DELETE /tag/{tagId}/project/{projectId}` | `—` | 用户管理项目标签；[src/core/projectManagerProvider.ts](../src/core/projectManagerProvider.ts) | 路由存在；按需调用，参数已做静态核对 [R] |
| [proxyToHistoryApiAndGetUpdates](../src/api/base.ts) | `GET /project/{projectId}/updates?min_count=10{beforeQuery}` | `—` | 历史面板首次加载/加载更多；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在，min_count=10 和 before 分页；非定时网络轮询 [H] |
| [proxyToHistoryApiAndGetFileDiff](../src/api/base.ts) | `GET /project/{projectId}/diff?pathname={pathname}&from={from}&to={to}` | `—` | 查看历史文件差异；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | pathname/from/to 已用 URLSearchParams 编码，见 N3 [H] |
| [proxyToHistoryApiAndGetFileTreeDiff](../src/api/base.ts) | `GET /project/{projectId}/filetree/diff?from={from}&to={to}` | `—` | 查看历史文件树差异；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；按需调用，参数已做静态核对 [H] |
| [downloadZipOfVersion](../src/api/base.ts) | `GET /project/{projectId}/version/{version}/zip` | `—` | 下载/应用历史版本；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 全量 ZIP，10 分钟预算；受历史下载限流 [H] |
| [createLabel](../src/api/base.ts) | `POST /project/{projectId}/labels` | `{comment, version}` | 历史版本标记操作；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；按需调用，参数已做静态核对 [H] |
| [deleteLabel](../src/api/base.ts) | `DELETE /project/{projectId}/labels/{labelId}` | `—` | 历史版本标记操作；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | 路由存在；按需调用，参数已做静态核对 [H] |
| [getMessages](../src/api/base.ts) | `GET /project/{projectId}/messages?limit={limit}` | `—` | 打开聊天面板/获取消息；[src/collaboration/chatViewProvider.ts](../src/collaboration/chatViewProvider.ts) | 条件式 chat 功能；默认 limit=50，响应数组匹配 [CHAT] |
| [sendMessage](../src/api/base.ts) | `POST /project/{projectId}/messages` | `{client_id, content}` | 用户发送聊天消息；[src/collaboration/chatViewProvider.ts](../src/collaboration/chatViewProvider.ts) | client_id/content 匹配；204 成功，靠推送接收消息 [CHAT] |
| [refreshLinkedFile](../src/api/extendedBase.ts) | `POST /project/{project_id}/linked_file/{file_id}/refresh` | `{shouldReindexReferences: false}` | 用户刷新/创建链接文件；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | body 与 new_file_id 匹配；provider 是否启用取决于服务配置 [LINK] |
| [createLinkedFile](../src/api/extendedBase.ts) | `POST /project/{project_id}/linked_file` | `{name, parent_folder_id, provider, data}` | 用户刷新/创建链接文件；[src/core/remoteFileSystemProvider.ts](../src/core/remoteFileSystemProvider.ts) | body 与 new_file_id 匹配；provider 是否启用取决于服务配置 [LINK] |

请求体补充：

- `uploadFile.formData`：`targetFolderId/name/type/qqfile`；查询 `folder_id` 指定目标目录。官方 multer 从 `qqfile` 读取文件、从 query.folder_id 取目录，返回 success/entity_id/entity_type；当前普通文件上传会校验这几个字段 [UPLOAD]。
- `uploadProject.formData`：ZIP 文件 `qqfile`；查询含 `_csrf/qquuid/qqfilename/qqtotalfilesize`。现包含 name 字段并校验 success/project_id，见 N7。
- `compile.body`：`check:'silent'`、draft、incrementalCompilesEnabled、rootResourcePath、stopOnFirstError；触发类型控制 auto_compile 查询。没有协商 PDF 分块元数据，见 N5 [CF]。
- `spelling/check.body`：language、skipLearnedWords、token、words。learn 为 token/word；unlearn 为 word。基础官方 learn/unlearn 只需要 word 并从会话确认用户 [SL]。
- `updateProjectSettings.setting`：调用者传入 compiler/rootDocId/spellCheckLanguage 等设置；没有把任意本地 VS Code 配置发送到 Overleaf。
- 已移除没有生产调用者的 `getLabels`、`deleteAuxFiles`、`indexAll` 封装。官方对应路由仍可存在；普通编译不调用清缓存或参考文献全量索引。

## 4. Socket.IO 与外部资源

这里的 `scheme=v1/v2` 是插件的加入项目流程分支，**不是声明使用 socket.io-client 的 1.x/2.x 版本**；两个分支都经过 `_initSocketV0()` 使用旧客户端库。

| 网络行为 | 当前参数 / 触发 | 官方对照 | 判断 |
|---|---|---|---|
| Socket.IO 连接、握手、心跳、可用 transport | 连接服务器 origin；Cookie/Origin；v2 流程附 projectId/t；底层库负责握手等 | [RT]、[WS] | 不应把协议底层请求数当成一个普通 GET；需线上确认代理/自建前缀部署 |
| joinProject | v1 发 `{project_id}`；v2 等 joinProjectResponse | [RT]、[WS] | 两种流程由状态机控制；项目建立后才标记 ready |
| joinDoc | 首次 docId、`{encodeRanges:true}`；恢复加 fromVersion | [RT] 参数兼容分支 | 每个文档首次初始化一次，恢复按版本追赶；健康在线保存和已订阅文本快照不再重复 join。history-ot 明确拒绝 |
| applyOtUpdate | `{doc,lastV,v,op,dupIfSource}` | [RT]、[WS] | 一个 inflight，后续保存 compose；应用确认来自 otUpdateApplied 的紧凑 ACK 或完整自身回显。5 秒去重重试，45 秒暂停；不再读回全文判定保存成功 |
| clientTracking.getConnectedUsers | 首次加入及重新加入后获取在线用户 | [RT] | 后续主要接收推送，不是每 500 ms 拉在线列表 |
| clientTracking.updatePosition | 编辑器选择变化后防抖发送 doc_id/row/column | [RT] | 已按官方有人 500 ms / 无人 5 分钟尾端防抖；只提交最新位置，断线/释放取消待发任务 |
| forceDisconnect（接收） | 按服务端 delay 断开，暂停自动重连；通知提供 Retry Connection 按钮 | [频率核查中的官方依据](request-frequency-audit.md) | 官方用于管理员维护/更新编辑器；不等于已经证实用户被限流。恢复入口：命令面板 → Overleaf: Retry Connection |
| 服务端事件 | reciveNewDoc/File/Folder、reciveEntityRename/Move、removeEntity、otUpdateApplied、clientTracking.*、new-chat-message、compilerUpdated、rootDocUpdated、spellCheckLanguageUpdated、broadcastDocMeta、连接事件 | [RT]、[WS]；不同业务控制器发出事件 | 这些是接收流量，不是主动轮询；`recive` 拼写是遗留协议名字，不能擅自改名 |
| PDF CMap | PDF.js 按需读取 `https://cdn.jsdelivr.net/npm/pdfjs-dist@3.10.111/cmaps/` | 非 Overleaf API | 打开需要 CMap 的 PDF 可能增加第三方网络依赖，建议本地打包或验证离线行为；不发送网站 Cookie |

没有发现聊天 Webview 自行调用远端 API；它通过扩展消息桥接。`LocalGitBridgeSCMProvider` 当前是空实现，不应凭类名或 GitHub 输入框声称存在 Git 拉取/推送流量。依赖安装脚本下载 PDF.js/语法数据属于开发与构建流量，不计入扩展运行时清单。

## 5. 调用频率、缓存与官方限制

### 5.1 实际触发

下表汇总当前策略；53 个 HTTP 业务入口、6 类主动 Socket.IO 消息与官方触发方式的逐项对照见 [调用频率核查](request-frequency-audit.md)。防抖间隔不是固定轮询周期，也不代表实测 QPS。

| 场景 | 当前行为 | 性能评估 |
|---|---|---|
| 保存编译 | 首次立即执行；同项目预览未打开则跳过自动编译；忙时合并为一次后续请求并保留涉及的文件路径；仅等待本轮文件确认 | 不存在固定 300 ms 保存延迟；即使合并，持续输入保存仍可能触发服务器限流；autocompile-backoff 后暂停该项目自动编译，手动编译成功恢复 |
| 编译来源 | force=true 作为手动/强制，false 为自动；初始化/预览/设置更新命令也走强制路径 | 比旧版全部 auto 正确，但“自动打开预览时”的来源尚未独立表达；不能称与官方 load/change/manual 三类完全一致 |
| 本地副本 | watcher 稳定性等待与路径队列；已初始化文本使用实际 OT 操作流；磁盘 CAS 与恢复日志 | 在线文本不再全文读回；二进制和结构变更仍保留校验，恢复场景可能额外读取 |
| 同步观察窗口 | 2 秒定时检查本地 owner/state；接管所有权后可能初始化远端 | 不是每 2 秒固定 HTTP 拉整个项目 |
| 历史面板 | 30 秒 fire TreeData 事件；getChildren 读缓存；getHistory 首次/分页才请求 | 不是 30 秒轮询历史 API |
| 协作状态栏 | 500 ms 重绘本地状态；在线列表初次加入/重新加入读取一次，随后推送；光标另按有人 500 ms/无人 5 分钟防抖 | 不是 500 ms 网络轮询 |
| 拼写检查 | 打开立即、文本变化 1 秒尾端防抖；检查最新全文，缓存去重；串行队列跳过已过时的文档版本 | 官方使用客户端 Hunspell worker，当前旧服务端检查方式偏离较大 [SP] [HU] |
| 补全元数据 | getMetadata 被项目补全调用，经 VFS 获取 | 已用项目级缓存和正在进行的 GET 合并；单文档 2 秒防抖 POST 和 broadcastDocMeta 刷新，引用与命令补全读取最新缓存 |
| 文件上传 | 同 API 实例、同项目串行，最多一个进行中的上传 | 已按官方上传器并发 1 调整；磁盘同步仍保留必要的读回确认 |
| 聊天 | 载入消息 + 用户提交 + 新消息事件 | 不应为实时性增加周期性拉取 |

### 5.2 官方源码中的示例阈值

以下是固定官方提交里的服务端配置，**不是对 overleaf.com 当前线上额度的承诺**。还可能叠加 IP、用户、项目、套餐、代理和动态全局限制；不得把阈值当成应持续打满的目标。

| 路由类别 | 所查官方配置 | 来源 |
|---|---|---|
| 编译 HTTP | 200 次 / 10 分钟；另有 recently-compiled 与 auto-compile 全局/组限流 | [R] [CM] |
| 项目列表 POST | 30 次 / 分钟 | [R] |
| 创建项目 / 导入项目 | 20 次 / 分钟 | [R] [U] |
| 文件上传 | 500 次 / 15 分钟，并带项目维度 | [U] |
| 创建/刷新 linked file | 各 100 次 / 分钟，带项目维度 | [L] |
| 标签常见写操作 | 各 30 次 / 分钟 | [R] |
| 发送聊天消息 | 100 次 / 分钟，且 chat 功能可能未启用 | [R] |
| 历史版本 ZIP | 30 次 / 小时 | [H] |
| 杂项编译输出下载 | 1000 次 / 小时；PDF 特定下载路径另有策略 | [R] [C] |
| 全量引用索引（封装已移除，仅作官方参考） | 30 次 / 分钟 | [R] |

当前客户端没有统一预算协调器。单次 GET 有界重试不会无限请求，但大量文件同步/历史读取等请求仍可能叠加；文件上传已限同项目并发 1，补全元数据已合并，需要服务器返回的 429、业务 backoff 状态和实测计数共同判断。

## 6. 尚未符合或需要改进的点

### N1：旧拼写服务兼容性（已增加能力检测；现代本地引擎待移植）

插件仍调用 POST /spelling/check；所查官方基础 router 只有 learn/unlearn，官方前端的 SpellChecker 通过 HunspellManager worker 检查/建议 [R] [SP] [HU]。不能确认线上私有模块是否仍保留旧接口，因此结论是“未在当前官方基础路由找到，需迁移或能力探测”，而不是断言所有 Overleaf 部署必定 404。

0.16.16 已修复失败缓存：只有成功且结构有效的结果才缓存；404/405/501 明确不支持时，每个 VFS 提示一次并停止后续请求，其他失败仍允许后续检查。参见 [拼写缓存](../src/intellisense/langMisspellingCheckProvider.ts)。0.16.17 又将文本变化改为 1 秒防抖，并跳过已过时的排队版本；关闭文档或释放时清理待发任务。新版浏览器端 Hunspell 尚未移植，调度对齐不代表已经取消 HTTP 拼写请求，也无法把“不支持”的服务变成可用拼写检查。

### N2：长传输与 PDF 分段（0.16.18 已增加按需预览）

原 15 秒传输问题已在 0.16.16 修复：PDF、ZIP、二进制下载和上传使用 10 分钟预算。每次下载尝试的续段共享预算，最多三次尝试，尚无跨尝试整体截止时间。下载重试仍通常重新开始，可能放大流量。官方输出代理允许更长传输时间 [C]，编译和下载不是同一个超时预算。

0.16.18 的 PDF 自定义预览已接入 PDFDataRangeTransport：首先读取 64 KiB，随后仅按 PDF.js 需要读取数据块；同块并发请求合并，成功块缓存，失败只重试该块。一个预览内同输出构建复用数据源；关闭文档会取消下载，替换 PDF 失败保留上一份已显示的数据源。普通二进制、ZIP、直接 fs.readFile 和完整回退仍使用上述全量下载逻辑。

验证数据：项目内真实 PDF.js 从 2,097,811 字节测试 PDF 读取首页文字，仅传输 131,731 字节（3 次 Range）；这不是线上首屏渲染速度测量。大图片或复杂页面可能仍需读取文件的大部分内容。

### N3：历史 diff 查询编码（0.16.18 已修复）

pathname/from/to 已改为 URLSearchParams，测试覆盖空格、中文、`&`、`#`、`+`、`?`。与先前已修复的 SyncTeX、ZIP 查询一起，避免动态值破坏查询结构。[历史封装](../src/api/base.ts)

### N4：createTag 响应类型与官方不一致（类型契约，当前 UI 风险较低）

官方 TagsController 返回单个 tag 对象，插件强行断言为 ProjectTagsResponseSchema[] [TAG]。当前 UI 只判断 success 后刷新，不读取这份 tags，所以不是已证实的创建标签失败。应修正类型，避免后续调用者误当数组。

### N5：PDF 预览和输出 URL 策略没有完全采用官方方案（性能/部署适配）

官方按 PDF 文件的 build 与 pdfDownloadDomain 决定 CDN URL，再按需带 clsiserverid [PDF] [PC]。插件要求 pdfDownloadDomain 与 clsiServerId 同时存在；仅有域名而无 server ID 时退回 Web，可能损失 CDN 性能。需用实际返回体验证该组合是否出现。

0.16.18 已实现标准 HTTP Range 预览与当前构建的字节块缓存。没有移植官方基于编译结果 PDF 对象信息的跨构建缓存，也没有在编译请求中协商 enable_pdf_caching；标准字节分段不等于官方对象缓存。普通 Web 输出代理和编译 CDN 的 Range 能力仍有区别。

只在 206、Content-Range 合法且强 ETag 可确认同一文件版本时分段；后续总长度/ETag 变化或服务器改回 200 会报错，禁止混合不同构建。服务器忽略 Range 返回 200 时直接复用完整响应；没有强 ETag 或压缩响应时安全回退。源码 PDF 文件缺少构建标识，因此不会跨 refresh 复用旧版本。

stopCompile、SyncTeX 没带已有 clsiserverid；官方后续请求会带 [CF] [SYNC]。服务端也可能用 Cookie/默认路由补足，因此属于多后端部署风险，尚非已证实的所有部署失败。

### N6：HTML/会话解析与响应资源管理需改进（稳定性）

getCsrfToken、getUserId、getProjectSettings 依赖固定 HTML 属性顺序/结构；getProjectSettings 会把部分缺失 meta 退化为空列表，并硬编码编译器。官方网页结构不是稳定的公开 API schema，应把抓取失败与真正空值区分。

0.16.18 已合并全部 Set-Cookie、按名称替换旧值、处理 Max-Age/Expires 删除，并取消无需读取的响应体；登录前后也合并 Cookie。它是同服务器 Cookie 请求头合并，不是完整浏览器 Cookie Jar，Domain/Path 多作用域、站点前缀等部署适配仍需实测。[会话封装](../src/api/base.ts)

### N7：ZIP 导入参数不匹配（0.16.16 已修复）

官方 ProjectUploadController 使用 body.name 为项目取名 [UPLOAD]；插件现向 multipart 发送 name/qqfile，并编码 CSRF、文件名等查询值。成功响应必须包含 success:true 和非空 project_id；业务失败会显示错误，不会误报导入成功。真实线上导入仍需安装后验证。

### N8：同步的额外请求成本、限流退避和取消仍需实测（性能取舍）

副本二进制更新仍可能包含读取旧文件、上传暂存、验证和替换等请求。0.16.19 的健康在线文本更新直接提交版本化 OT，依赖应用确认，不再执行重复全文校验；首次初始化、断线恢复、历史不足时的快照恢复仍可能读取全文。磁盘保护和二进制验证不因文本优化而取消。

0.16.16 已取消 Retry-After 的 30 秒截断，退避等待和下载层响应调用者取消；各文件操作 UI 的取消信号尚未全面贯通。当前官方基础限流可能根本不返回 Retry-After [LIMIT]，不能把这些问题表述为当前线上一定触发。

## 7. 已修复内容与验证

### 7.1 0.16.15 协议与错误处理

| 已完成 | 当前证据 / 限制 |
|---|---|
| 编译独立超时与取消 | 12 分钟客户端预算；ACK/普通 HTTP/文件下载仍有各自预算 |
| 区分手动与自动编译 | 根据 force 传来源；初始化来源的进一步细分见 5.1 |
| 失败也发布日志、清旧诊断 | 若本次没有输出日志，不假借上次日志；保留旧 PDF；PDF 下载失败仍尝试本次诊断 |
| 不因本地缺少 output.log 清远端缓存 | deleteAuxFiles 未使用封装已移除 |
| 错误后回退非增量编译 | 恢复标志在 VFS 内；不等于对未知结果自动重试 |
| SyncTeX 行号与编码 | 编辑器 row+1 一次，正反向查询用 URLSearchParams |
| 登录错误 text 与重定向 | 兼容嵌套 message.text、JSON redir、HTTP Location；会话全面适配仍见 N6 |

0.16.15 当时通过 189 项测试；0.16.16 增加传输取消、ZIP 参数/失败响应以及拼写失败缓存和能力检测。这些验证均不证明每个线上接口都可用。

### 7.2 0.16.17 调度调整与剩余差异

- 已调整：拼写 1 秒防抖、光标按协作者数量防抖、元数据缓存/请求合并/广播与单文档刷新、上传串行、自动编译 backoff 暂停、强制断开与手动恢复、普通重连 3–9 秒随机等待。
- 保留差异：首次保存立即同步/编译；必要磁盘快照校验；有界 GET 重试；元数据首次使用懒加载及旧服务器回退。Hunspell 本地引擎、官方 PDF 跨构建对象缓存与浏览器空闲连接模型尚未移植，不能称为全部与官网一致。
- 上一轮代码验证：**202 项单元测试通过**，TypeScript/聊天视图构建、lint 和 VSIX 内容校验通过；未做实际多人联机或线上请求频率测试。完整依据和各接口状态见 [调用频率核查](request-frequency-audit.md)。

### 7.3 0.16.18 验证

Cookie 多头/同名替换/过期删除/响应释放、历史路径编码、PDF 分块/缓存/重试/版本一致性/完整回退/关闭取消、预览消息通道和旧构建保留均有回归测试。**213 项测试通过**，包含真实 PDF.js 的首页读取；构建与 lint 通过。尚未在真实 Overleaf 登录环境测试各 CDN/代理的 Range 支持，不能承诺统一加速比例。

## 8. 后续验收方法

1. 使用专门测试项目，记录 endpoint 类别、触发来源、耗时、字节数、HTTP/业务状态、重试次数、连接 epoch、取消结果；不记录 Cookie、CSRF、完整签名下载 URL 或正文。
2. 分别测手动编译、保存自动编译、预览首次打开、普通重连；区分同步完成、编译完成、下载完成、首屏渲染四个时间点。
3. 下载用小/大 PDF 和受控慢网络，检查 200/206、Range、ETag、压缩、过期构建 404、取消和连续两版隔离；分别测试 Web 与 CDN。
4. 写操作超时用模拟服务验证未知结果和禁止重放，再在测试项目核验最终状态；不要用真实论文做故障注入。
5. 检查中文/空格/&/# 文件路径的 SyncTeX、历史 diff、ZIP 导入；检查 业务失败/无有效 ID 的响应与 429。
6. 对比冷/热缓存，以及多窗口观察者/唯一同步 owner 的请求数。报告 p50/p95 和样本量后，才能声称性能满足目标。
7. 更新此文档时重新确认官方 SHA，重跑源码请求点清单与调用者检查。新增接口必须记录路由、body、认证、响应、超时、重试、触发频率和官方依据。

## 9. 官方证据索引

以下均为同一固定提交中的官方文件；旧 [webapi.md](webapi.md) 仅作历史路由索引，不作为当前契约。

- **[R]** [services/web/app/src/router.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/router.mjs)
- **[E]** [services/web/app/src/Features/Editor/EditorRouter.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Editor/EditorRouter.mjs)
- **[H]** [services/web/app/src/Features/History/HistoryRouter.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/History/HistoryRouter.mjs)
- **[L]** [services/web/app/src/Features/LinkedFiles/LinkedFilesRouter.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/LinkedFiles/LinkedFilesRouter.mjs)
- **[U]** [services/web/app/src/Features/Uploads/UploadsRouter.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Uploads/UploadsRouter.mjs)
- **[C]** [services/web/app/src/Features/Compile/CompileController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/CompileController.mjs)
- **[CM]** [services/web/app/src/Features/Compile/CompileManager.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/CompileManager.mjs)
- **[CF]** [services/web/frontend/js/features/pdf-preview/util/compiler.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/compiler.ts)
- **[PDF]** [services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts)
- **[PC]** [services/web/frontend/js/features/pdf-preview/util/pdf-caching.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-caching.ts)
- **[RT]** [services/real-time/app/js/Router.js](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/real-time/app/js/Router.js)
- **[WS]** [services/real-time/app/js/WebsocketController.js](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/real-time/app/js/WebsocketController.js)
- **[A]** [services/web/app/src/Features/Authentication/AuthenticationController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Authentication/AuthenticationController.mjs)
- **[SP]** [services/web/frontend/js/features/source-editor/extensions/spelling/spellchecker.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/source-editor/extensions/spelling/spellchecker.ts)
- **[HU]** [services/web/frontend/js/features/source-editor/hunspell/HunspellManager.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/source-editor/hunspell/HunspellManager.ts)
- **[SL]** [services/web/app/src/Features/Spelling/SpellingController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Spelling/SpellingController.mjs)
- **[TAG]** [services/web/app/src/Features/Tags/TagsController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Tags/TagsController.mjs)
- **[CHAT]** [services/web/app/src/Features/Chat/ChatController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Chat/ChatController.mjs)
- **[UPLOAD]** [services/web/app/src/Features/Uploads/ProjectUploadController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Uploads/ProjectUploadController.mjs)
- **[LINK]** [services/web/app/src/Features/LinkedFiles/LinkedFilesController.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/LinkedFiles/LinkedFilesController.mjs)
- **[LIMIT]** [services/web/app/src/Features/Security/RateLimiterMiddleware.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Security/RateLimiterMiddleware.mjs)
- **[SYNC]** [services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts)
- **[CLSI]** [services/web/app/src/Features/Compile/ClsiManager.mjs](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/ClsiManager.mjs)

[R]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/router.mjs
[E]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Editor/EditorRouter.mjs
[H]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/History/HistoryRouter.mjs
[L]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/LinkedFiles/LinkedFilesRouter.mjs
[U]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Uploads/UploadsRouter.mjs
[C]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/CompileController.mjs
[CM]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/CompileManager.mjs
[CF]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/compiler.ts
[PDF]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts
[PC]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-caching.ts
[RT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/real-time/app/js/Router.js
[WS]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/real-time/app/js/WebsocketController.js
[A]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Authentication/AuthenticationController.mjs
[SP]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/source-editor/extensions/spelling/spellchecker.ts
[HU]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/source-editor/hunspell/HunspellManager.ts
[SL]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Spelling/SpellingController.mjs
[TAG]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Tags/TagsController.mjs
[CHAT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Chat/ChatController.mjs
[UPLOAD]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Uploads/ProjectUploadController.mjs
[LINK]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/LinkedFiles/LinkedFilesController.mjs
[LIMIT]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Security/RateLimiterMiddleware.mjs
[SYNC]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts
[CLSI]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/ClsiManager.mjs
