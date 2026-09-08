# Overleaf Workshop

在 Visual Studio Code 中连接 Overleaf 或 ShareLaTeX，直接打开、编辑、同步、编译和预览项目。

插件支持两种工作方式：

- **远端项目**：项目作为 VS Code 虚拟工作区打开，修改会直接同步到 Overleaf，适合使用协作、历史记录和在线编译等完整功能。
- **本地副本**：项目保存在本机文件夹中，由插件安全地与 Overleaf 双向同步，适合搭配 LaTeX Workshop、Git 和其他本地工具。

> [!IMPORTANT]
> 对于启用了验证码或 SSO 的服务器（包括 `https://www.overleaf.com`），请使用 Cookie 登录。

## 安装

可以在 VS Code 扩展面板中搜索 **Overleaf Workshop** 安装，也可以安装本地构建的 VSIX：

1. 打开 VS Code 的“扩展”面板。
2. 点击面板右上角的 `…`。
3. 选择“从 VSIX 安装…”。
4. 选择对应的 `.vsix` 文件。

本项目要求 VS Code `1.101.0` 或更高版本。

## 快速开始

### 1. 添加并登录服务器

1. 点击活动栏中的 **Overleaf Workshop** 图标，打开 **Hosts** 视图。
2. 点击视图右上角的 `+`，运行 **Add New Server**。
3. 添加服务器后，点击服务器右侧的登录按钮。
4. 选择登录方式：
   - **Login with Password**：适用于允许账号密码登录的自建服务器。
   - **Login with Cookies**：适用于 Overleaf 官方站、SSO 或启用了验证码的服务器。

登录成功后，Hosts 视图会显示该账号可以访问的项目、归档项目、回收站和标签。

### 2. 打开项目

在 Hosts 视图中右键项目，可以选择：

- **Open Project Remotely…**（云朵图标）：打开远端项目。
- **Open Project Locally…**：创建或打开本地副本。

项目右侧的云朵和电脑图标分别对应远程、本地打开。两种入口都会询问 **Current Window / New Window**，选择当前窗口或新窗口。

## 远端项目模式

远端项目以虚拟工作区形式打开。文件的新建、编辑、重命名、移动和删除会直接作用于 Overleaf；协作者的修改也会同步回 VS Code。

远端模式支持：

- 在线编译和 PDF 预览
- SyncTeX 正向、反向跳转
- 编译错误和警告诊断
- 项目历史、版本比较和下载
- 协作者位置及聊天
- Overleaf 外部链接文件的导入和刷新
- LaTeX 补全、格式化和文档结构

虚拟工作区不等同于普通本地目录，部分只支持本地文件系统的 VS Code 扩展可能无法使用。如果需要 Git、命令行工具或完整的 LaTeX Workshop 功能，请使用本地副本模式。

## 本地副本模式

### 创建本地副本

1. 在 Hosts 视图中右键项目。
2. 选择 **Open Project Locally…**。
3. 选择一个可写的父目录；插件会在其中创建项目文件夹。
4. 按提示打开创建好的本地文件夹。

本地副本包含由插件维护的 `.overleaf` 目录。不要手动修改或删除其中的同步状态、对象和恢复数据。`.vscode` 目录不会上传到 Overleaf。

### 自动同步开关

底部状态栏显示 **Auto Sync: On / Off**，点击直接切换，悬停提示中注明 Overleaf 和项目名称。文件目录上方的 **立即同步** 按钮始终可用于主动同步当前本地副本：

- **自动同步：开 / `safeAuto`**：自动同步已经稳定、能够验证且没有冲突的本地或远端变化。遇到冲突、未保存编辑器内容、网络异常或无法验证的操作时会暂停，而不会强行覆盖任一侧。
- **自动同步：关 / `manual`**：只记录待处理变化，不自动写入另一侧。确认后运行 **Local Replica: Sync Now** 才会同步。

可以在 VS Code 的“源代码管理”视图查看以下状态：

- **Incoming**：等待写入本地的 Overleaf 变化。
- **Outgoing**：等待上传到 Overleaf 的本地变化或失败项。
- **Conflicts**：必须人工处理的冲突。
- **Paused**：因安全检查、恢复状态或其他原因暂停的项目。

### 手动同步与检查

在本地副本中右键文件或文件夹，或者打开命令面板，可以使用：

- **Local Replica: Sync Now**：立即检查并同步允许处理的变化。
- **Local Replica: Review Pending Changes**：打开源代码管理视图查看待处理项。
- **Local Replica: Show Sync Diagnostics**：查看同步诊断。
- **Local Replica: Retry Failed Sync**：重新尝试失败的同步。
- **本地副本：检查恢复文件**：查看因中断或不确定操作保存的恢复数据。

### 处理冲突

文本冲突会出现在源代码管理的 **Conflicts** 分组中：

1. 点击冲突文件，或运行 **Local Replica: Open Merge Editor**。
2. 在 VS Code 三方合并编辑器中比较本地版本、Overleaf 版本和结果。
3. 编辑结果并保存。
4. 通过结果编辑器、源代码管理、资源管理器右键菜单或命令面板执行 **标记冲突为已解决**。

保存或关闭合并编辑器只会保留草稿，不会自动解除冲突。只有合并结果成功同步并验证后，冲突状态才会清除。如果任一侧再次变化，插件会要求重新检查，避免使用过期结果覆盖新内容。

二进制文件发生冲突时，可以选择保留本地版本、使用 Overleaf 版本，或者另存 Overleaf 版本后再处理。

### 在本地副本中编译和预览

本地副本默认关闭 Overleaf 在线编译和 PDF 预览。打开设置中的：

```text
overleaf-workshop.localReplica.enableCompileNPreview
```

即可立即启用，无需重启插件。启用后：

- 保存 `.tex`、`.sty`、`.cls` 或 `.bib` 文件时，会先安全同步到 Overleaf，再触发在线编译。
- 第一次保存会立即同步和编译；编译期间的连续保存会合并为一次补编译，避免重复请求。
- 编译期间产生的新变化会在当前编译结束后合并补编译一次。
- 只有同步和编译成功后，已打开的 PDF 才会刷新。
- 如果存在冲突或尚未同步的变化，编译会暂停并给出提示。

本地副本中的远端项目历史和远端工作区补全不可用；可以安装 LaTeX Workshop 等本地 LaTeX 扩展作为补充。

## 编译与 PDF 预览

| 操作 | Windows / Linux | macOS |
| --- | --- | --- |
| 编译项目 | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> | <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>B</kbd> |
| 打开 PDF | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> | <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd> |
| 从源码跳转到 PDF | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> | <kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd> |

也可以使用编辑器标题栏按钮或命令面板中的 **Compile Project**、**View Compiled PDF** 和 **Jump to PDF**。

- 编译状态显示在 VS Code 状态栏中。
- 点击状态栏中的编译器名称，可以切换编译模式、错误处理方式、编译器和主文档。
- 编译产生的 `output.pdf`、日志和中间文件显示在虚拟输出目录中，默认名称为 `.output`，这些文件是只读的。
- 将光标放在源码中并执行 **Jump to PDF** 可以正向跳转；在 PDF 文字上双击可以反向跳转到源码。
- 编译错误和警告会显示在编辑器以及 VS Code“问题”面板中。

## 配置项

打开 VS Code 设置并搜索 `Overleaf Workshop`。配置按 **公用**、**本地副本**、**远端项目** 三组显示。

### 公用配置

这些配置同时用于远端项目和启用了编译预览的本地副本。

| 配置项 | 默认值 | 功能 |
| --- | --- | --- |
| `overleaf-workshop.compileOnSave.enabled` | `true` | 保存 `.tex`、`.sty`、`.cls` 或 `.bib` 文件后自动编译。关闭后仍可手动编译。 |
| `overleaf-workshop.compileOutputFolderName` | `.output` | 设置虚拟编译输出目录名称，其中显示 `output.pdf`、日志和中间文件。名称不能包含文件系统保留字符。 |
| `overleaf-workshop.pdfViewer.themes` | 见下方示例 | 定义 PDF 阅读器可选择的颜色主题。新打开或刷新的 PDF 视图会使用更新后的主题列表。 |
| `overleaf-workshop.pdfViewer.defaultScrollMode` | `vertical` | 设置没有已保存阅读状态时的默认滚动方式：`vertical`、`horizontal`、`wrapped` 或 `page`。 |
| `overleaf-workshop.pdfViewer.defaultSpreadMode` | `none` | 设置没有已保存阅读状态时的默认单双页方式：`none`、`odd` 或 `even`。 |

PDF 主题示例：

```json
{
  "overleaf-workshop.pdfViewer.themes": {
    "default": { "fontColor": "#000000", "bgColor": "#FFFFFF" },
    "light": { "fontColor": "#000000", "bgColor": "#F5F5DC" },
    "dark": { "fontColor": "#FBF0D9", "bgColor": "#4B4B4B" }
  }
}
```

阅读器会保存每个 PDF 的浏览状态；已经保存的滚动和单双页状态优先于默认值。

### 本地副本配置

这些设置支持按工作区文件夹分别配置。

| 配置项 | 默认值 | 功能 |
| --- | --- | --- |
| `overleaf-workshop.localReplica.syncMode` | `safeAuto` | 选择本地副本的同步方式。`safeAuto` 自动处理稳定且无冲突的变化；`manual` 只记录变化，等待执行 **Local Replica: Sync Now**。修改后立即生效。 |
| `overleaf-workshop.localReplica.enableCompileNPreview` | `false` | 为当前本地副本启用 Overleaf 在线编译、PDF 预览和保存后自动刷新。修改后立即生效。 |

旧版本可能在 `.overleaf/settings.json` 中保存 `enableCompileNPreview`。插件会把旧值迁移到 VS Code 的本地副本设置；设置界面中的显式值优先。

### 远端项目配置

| 配置项 | 默认值 | 功能 |
| --- | --- | --- |
| `overleaf-workshop.formatWithLineBreak.enabled` | `true` | 格式化远端 LaTeX 文档时按约 80 字符宽度换行；关闭后格式化器基本不主动限制行宽。 |

## 使用 Cookie 登录

请只从自己已经登录的浏览器会话中复制 Cookie，不要把 Cookie 发给其他人或提交到项目文件中。

1. 在浏览器中登录目标 Overleaf 服务器。
2. 打开开发者工具，切换到“网络 / Network”面板。
3. 访问服务器的项目列表页面。
4. 找到路径为 `/project` 的请求。
5. 在该请求的请求头中复制完整的 `Cookie` 值，例如 `overleaf_session2=...` 或 `sharelatex.sid=...`。
6. 回到 VS Code，选择 **Login with Cookies** 并粘贴该值。

## 常见问题

### 保存后为什么没有编译？

请依次确认：

- `overleaf-workshop.compileOnSave.enabled` 是否开启。
- 本地副本是否开启 `overleaf-workshop.localReplica.enableCompileNPreview`。
- 保存的文件扩展名是否为 `.tex`、`.sty`、`.cls` 或 `.bib`。
- 源代码管理视图中是否存在冲突、暂停项或尚未同步的变化。
- 当前是否已成功连接并登录 Overleaf 服务器。

### 为什么本地副本没有立即上传？

如果同步模式是 `manual`，需要运行 **Local Replica: Sync Now**。即使使用 `safeAuto`，冲突、未保存内容、不稳定文件、网络异常和无法验证的远端操作也会暂停同步，避免覆盖数据。

### 为什么其他扩展在远端项目中不可用？

远端项目是 VS Code 虚拟工作区。仅支持普通本地文件系统的扩展可能无法工作，请改用本地副本模式。

## 更多文档与开发

- [详细文档索引](./docs/README.md)
- [完整使用文档](./docs/wiki.md)
- [贡献和构建说明](./CONTRIBUTING.md)
- [项目结构](./docs/anatomy.md)
- [当前网络请求清单与官方源码核对](./docs/network-requests.md)
- [Overleaf Web API 说明](./docs/webapi.md)

本项目参考了 [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) 和 [vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics)。
