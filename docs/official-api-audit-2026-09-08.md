# Overleaf 官方源码兼容性审查

修复进展（0.16.15）：第 1、2、3、4、6、7、8 项已完成代码修复，189 项单元测试通过；第 5 项 PDF 分段预览按用户要求留待后续。真实线上集成尚未验证。以下保留修复前的审查证据。

审查日期：2026-09-08。对象：当前工作区 0.16.14 源码（包含已有未提交修改），不是已安装扩展的运行时。
官方基准：GitHub main 查询返回的提交 `28ad3b03b71cb4311decdcb55c36b33ec10d72db`，提交时间 2026-06-26T08:08:18Z。固定 SHA 以便复核。
方法：直接对照官方服务端、前端源码及本地调用链。未登录真实项目、未发起写入或编译请求；以下运行影响为代码推导，不是线上性能测量。社区版源码不保证等同于 overleaf.com 全部部署功能。
范围：重点检查编译、输出下载、SyncTeX，另抽查登录和实时文档协议；不代表所有 REST 路由及同步并发场景都已审计。

## 1. P1：编译请求套用了普通请求的 15 秒超时

本地：src/api/network.ts:25、40；src/api/base.ts:356、369、544。
compile() 经通用 request() 调用 fetchWithPolicy()，没有单独指定编译超时。等待编译 HTTP 响应超过 15 秒会中止客户端等待；非幂等 POST 不自动重试。
官方：[ClsiManager][O2] 的 COMPILE_REQUEST_TIMEOUT_MS 为 12 分钟，注释说明下游 CLSI 为 10 分钟。这是服务间请求预算，不是每个账户的编译额度；足以说明合法编译可能远超插件的 15 秒。
影响：服务端仍可能继续编译，插件却已报失败，用户重试会进一步混淆状态。
建议：按操作区分超时，编译采用合适的长预算和显式取消；超时作为结果未知处理，不能盲目重发编译。

## 2. P1：手动编译被标成自动编译

本地：src/api/base.ts:556 无条件添加 auto_compile=true；src/compile/compileManager.ts:208 没有把触发类型传给 API。
官方：[compiler.ts][O4] buildCompileParams() 仅在 isAutoCompileOnLoad/isAutoCompileOnChange 时设置该参数；[CompileManager][O1] 的自动编译限流函数在 !isAutoCompile 时直接放行。
影响：手动点击编译、切换 Draft 后编译，也可能被套用自动编译的全局/组级退避规则。
建议：显式传递手动/自动来源，保留服务端正常限流，不能将真正的自动编译伪装成人工操作。

## 3. P1：失败编译的新输出日志被丢弃

本地：src/core/remoteFileSystemProvider.ts:1327 仅当 compile.status===success 时更新输出元数据；其他业务状态折叠成 false。
src/compile/compileManager.ts:210 仅在 result===true 时运行诊断，而且在 PDF 下载完成后才运行；PDF 下载失败同样阻断诊断。
官方：[local-compile-context.tsx][O16] 对所有返回的 outputFiles 建立文件列表、读取日志；仅替换 PDF 的动作限制为 success。它单独处理 stopped-on-first-error、timedout、autocompile-backoff 等状态。
影响：遇到首错停止、超时或其他编译失败时，可能只能看到泛化失败提示和旧诊断，缺少本次 output.log。
建议：分离“输出/日志更新”“PDF 替换”“业务状态”；保持旧 PDF 的同时发布本次日志和准确错误原因。

## 4. P2：本地缺少输出目录就清除远端编译缓存

本地：src/core/remoteFileSystemProvider.ts:1303-1313，解析内存树中的 .output/output.log 失败即 deleteAuxFiles()，catch 也没有区分其他异常。
首次初始化、重连重建项目树时，本地没有输出索引不等于远端没有缓存。
官方：[compiler.ts][O4] clearCache() 是独立流程，正常 compile() 不以本地是否知道 output.log 为依据清空缓存。
影响：重新打开预览/重连后的编译可能丢掉本可复用的辅助文件，增加耗时；与请求中的 incrementalCompilesEnabled=true 目标相抵触。
建议：普通编译不因本地索引缺失而清缓存；在用户明确要求或确认需要恢复时单独执行。

## 5. P2：PDF 预览缺少官方已有的分段传输和内容缓存

本地：src/api/network.ts:96 下载并聚合全部数据，src/core/pdfViewEditorProvider.ts:28/78 等完整字节后传入 Webview，views/pdf-viewer/index.js:200 以 data 加载。
官方：[pdf-js-wrapper.ts][O8] 通过 URL、rangeChunkSize 和自定义 range transport 加载；
[pdf-caching-transport.ts][O6]、[pdf-caching.ts][O5] 实现按范围读取、缓存复用和回退；类型包含 size/ranges/hash/startXRefTable 等元数据（[类型][O17]）。
影响：这是性能能力缺失，不是非法接口调用；每次完整下载后才能渲染。Draft 降低输出体积但没有改变该链路。
补充：插件网络层已经能处理服务器返回的 206 并继续取后续段，不能笼统说“完全不支持分段”；它不支持的是把分段结果提前交给 PDF.js 按需预览。
插件只在下载 URL 添加 enable_pdf_caching=true，没有像官方一样在编译请求侧协商并使用缓存元数据，不能仅凭该参数认为获得官方的缓存加速。
建议：优先确认部署实际响应的范围能力和元数据，再接入范围传输、取消、版本隔离和完整下载回退。官方 Web 代理的 _proxyToClsi 并未直接透传 Range，不能假定所有下载路径等价。

## 6. P2：SyncTeX 行号与查询参数编码不符

本地：src/compile/compileManager.ts:263 把 VS Code 从 0 开始的 start.line 直接传入；src/core/remoteFileSystemProvider.ts:1392 和 src/api/base.ts:679 没有加 1。
官方：[use-synctex.ts][O9] 使用 line: String(row + 1)。
本地 proxySyncCode() 直接拼接 file 参数；官方使用 URLSearchParams。
影响：跳转可能偏移一行；路径含 &、# 等字符时查询字符串语义改变，目标文件不正确。
建议：在明确边界做行号转换，使用 URLSearchParams，并对特殊字符路径增加回归验证。

## 7. P2：增量编译在服务端错误后仍固定开启

本地：src/api/base.ts:550 固定 incrementalCompilesEnabled:true。
官方：[compiler.ts][O4] 设置 incrementalCompilesEnabled: !this.error，注释明确服务端错误后回退完整编译。
影响：特定增量编译故障缺少官方同等的恢复路径；不能据此断言每次失败都会再次失败。
建议：保留编译错误分类，按官方语义选择下一次编译的增量策略，不以每次删除远端缓存替代。

## 8. P2：部分登录错误响应读取了错误字段

本地：src/api/base.ts:299-302 把 HTTP 200 错误响应读取为 message.message，而 401 分支读取 message.text。
官方：[AuthenticationController][O12] passportLogin() 定义消息为 message.text，可用 info.status 或默认 200 返回错误；另有 {redir} 分支。
影响：某些登录失败没有有效提示；收到 JSON 重定向响应时可能因缺少 message 而抛错。
限定：插件发送 Accept: */*，官方 [acceptsJson][O18] 优先匹配 html，因此不能断言当前普通密码登录成功必然返回 JSON、必然失败。之前的 302 成功路径仍可能适用。
建议：按实际响应结构分别处理 redir/message.text，使用 Location 处理 HTTP 重定向，并保留有意义的错误兜底。

## 已核实不能列为协议冲突的内容

- Draft 参数仍在官方 CompileController 中使用，不是过期/虚构功能（[O0]）。
- joinDoc(docId, {encodeRanges:true}, callback) 虽然比当前四参数形式旧，但官方 [Router][O19] 明确兼容旧参数形式，不能仅凭签名差异宣称协议失效。
- joinDoc 的 packed UTF-8 解码与官方 WebsocketController 的编码相匹配（[O10]）。
- 本地副本的基线校验、未知结果冻结属于插件额外安全策略，本身不构成“违背官方”。
- 仅在 success 时替换 PDF 与官方一致；问题是失败时连新日志和业务状态也一起丢弃。
- docs/webapi.md 是历史路由快照，不是现行接口规范；后续修改应固定官方提交并复核线上行为。

## 建议处理顺序

先修复 1、2、3，避免错误状态和无效重试；随后处理 4、6、7、8；再实施第 5 项的范围预览优化并测量同步/编译/下载/首屏渲染耗时。
本次仅审查并新增报告，没有改动插件实现或创建新版本安装包。

[O0]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/CompileController.mjs
[O1]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/CompileManager.mjs
[O2]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/ClsiManager.mjs
[O3]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/ClsiURLHelpers.mjs
[O4]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/compiler.ts
[O5]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-caching.ts
[O6]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-caching-transport.ts
[O7]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/output-files.ts
[O8]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.ts
[O9]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/hooks/use-synctex.ts
[O10]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/real-time/app/js/WebsocketController.js
[O11]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/components/pdf-preview-provider.tsx
[O12]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Authentication/AuthenticationController.mjs
[O13]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Compile/ClsiCacheController.mjs
[O14]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/features/pdf-preview/util/pdf-caching-flags.ts
[O15]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Helpers/AsyncFormHelper.mjs
[O16]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/frontend/js/shared/context/local-compile-context.tsx
[O17]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/types/compile.ts
[O18]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/infrastructure/RequestContentTypeDetection.mjs
[O19]: https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/real-time/app/js/Router.js

