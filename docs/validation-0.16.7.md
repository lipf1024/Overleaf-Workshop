# 0.16.7 实施与验证记录

日期：2026-09-06。此记录对应 `overleaf-workshop-0.16.7-native-button.vsix`，在原有未提交改动上完成。

## 已通过的检查

- 完整 `npm test`：**145 项通过**，包含 TypeScript、Vue 构建与 ESLint；lint 无警告。
- `git diff --check`：通过。
- 使用本机已安装的 `vsce` 离线生成发布清单并打包，未依赖被拒绝的 npm 在线元数据请求。
- 直接检查最终 VSIX：扩展清单与 VSIX manifest 均为 0.16.7；Result 区域的 `editor/content` 按钮及 `contribEditorContentMenu` 声明存在；测试和开发脚本未被打包。
- 包内编译产物与工作区构建输出逐字节一致。
- 从最终 VSIX 解压目录加载全部 **12 个生产依赖**，实际执行原生文件锁获取和释放，均通过。
- macOS、Linux、Windows 的 x64/arm64 原生锁预编译文件全部包含在包内；其他系统未执行运行测试。
- PDF.js 3.10.111 页面、主脚本、worker、样式与渲染补丁，以及声明的 LaTeX 语言配置和第三方许可证均包含在最终包内。补充了 prepublish 资源缺失检查。

完整测试输出：`/private/tmp/overleaf-0.16.7-tests.log`。打包输出：`/private/tmp/overleaf-0.16.7-package.log`。这些临时日志用于本次验收，正式回归测试保留在源码中。

## B01–B13 回归对应关系

| 问题 | 正式回归内容 | 结果 |
| --- | --- | --- |
| B01 | 失效缓存重读、分离编辑器基线、连续保存保留远端改动、缺少基线和未确认提交返回失败 | 通过 |
| B02 | 符号链接子路径、元数据链接、准备后祖先被替换、监听器先检查路径再读取 | 通过 |
| B03 | 替换前外部编辑、已打开描述符的后续写入、删除/移动竞争、目标重新创建、恢复确认重新校验 | 通过 |
| B04 | 两个实例争用、真实目录别名、项目身份校验、独立进程崩溃接管、禁用后重新启用等待旧实例释放锁，prepared/captured/installed 三阶段强制中断 | 通过 |
| B05 | 已忽略监听路径、已跟踪文件调整忽略规则、忽略后的日志与恢复资料保留 | 通过 |
| B07 | 编译异常和保存取消释放运行锁、并发编译去重、VFS 编译失败后重新运行 | 通过 |
| B08 | 完整初始化五次上限、显式重试、认证失败终止、停止取消退避、关闭本轮传输、释放旧事件处理器 | 通过 |
| B10 | 同时移动与改名、overwrite=false、覆盖目标备份、中间名称碰撞、部分失败和确认丢失后的真实路径刷新 | 通过 |
| B11 | gzip/br/deflate 的传输长度与解压、截断压缩流、压缩分段回退、Content-Range 和 ETag 变化 | 通过 |
| B12 | 多根目录的本地源文件、PDF 所属项目反向跳转、诊断定位、排除合并元数据作为编译源 | 通过 |
| B13 | 草稿合并写入、最长等待落盘、对象引用保护、恢复日志保护、30 天/500 MiB 备份策略 | 通过 |

主要新增回归位于 [replicaRobustness.test.ts](../src/test/unit/replicaRobustness.test.ts)、[runtimeRobustness.test.ts](../src/test/unit/runtimeRobustness.test.ts) 和 [network.test.ts](../src/test/unit/network.test.ts)。原有冲突、协调器、合并、网络和 socket 测试继续保留；重启场景显式释放旧状态存储的系统锁。

## 尚未通过的窗口验收

| VS Code 版本 | 原生合并编辑器/Result 按钮实际显示与点击 |
| --- | --- |
| 最低声明版本 1.101.0 | 未执行 |
| 当前安装版本 1.129.0 | 隔离启动被阻止，未执行 |

本轮尝试按既有授权启动使用临时 user-data/extensions 目录的 VS Code 测试窗口。自动审批服务返回 `404 Not Found`，并提示 `当前 API 不支持所选模型 gpt-5.6-luna`，进程未能启动。

因此，**不能把命令注册、包内按钮声明和模拟测试当作按钮实际可见、可点击的证明**。取消、版本变化、同步失败保留冲突及成功清除冲突的逻辑已有回归覆盖，真实窗口中的这些操作仍须补验。

恢复窗口测试环境后，先按 [启用说明](../NATIVE_MERGE_BUTTON.md)启用提案，再分别运行最低版本和当前安装版本的扩展宿主测试。`VSCODE_TEST_VERSION=1.101.0` 选择最低版本；`VSCODE_EXECUTABLE_PATH` 选择已安装版本。真实按钮还需在 Result 区域完成可见性和点击检查。

## 产物

- 文件：`overleaf-workshop-0.16.7-native-button.vsix`
- 大小：6151586 字节（约 5.87 MiB）
- 包内文件数：935
- SHA-256：`f59e4deba85898488d8c44786c7d3b317cc4e9665c48dc1189e661a6bcb90951`
- 安装与迁移：[UPGRADING_0.16.7.md](../UPGRADING_0.16.7.md)

本次补齐资源的上游归档 SHA-256：

- PDF.js 3.10.111：`95cf3d37f7614b420c19890cd460fdadb2d6cb2b788e5156a17a732d393c6417`
- vscode-latex-basics 1.5.4：`3c21ef4be37008e32d1aab78722e63621a6b1c25972df22cbb02c1e505d300ce`
