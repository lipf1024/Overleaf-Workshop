# 原生合并页面中的“标记为已解决”按钮

0.16.7 本地版在 VS Code 原生合并编辑器的 **Result（合并结果）区域右下角**添加文字按钮 **Mark as Resolved / 标记为已解决**。它采用 VS Code 内置 Git 合并按钮使用的 `editor/content` 扩展点。

VS Code 目前将这个扩展点作为实验接口 `contribEditorContentMenu` 提供。**仅安装 VSIX 不会启用这个页面内按钮**；需要为本扩展启用实验接口。此版本用于本地安装，不能按普通稳定扩展发布到 Marketplace。

## 启用

1. 先结束所有使用旧版扩展同步本地副本的窗口，再安装 `overleaf-workshop-0.16.7-native-button.vsix`。同一副本的其他新版窗口会以观察模式打开；详见 [升级与恢复说明](UPGRADING_0.16.7.md)。
2. 在命令面板运行 **Preferences: Configure Runtime Arguments**，打开 VS Code 的 `argv.json`。
3. 在顶层添加以下设置。如果已有这个数组，只添加本扩展的 ID，保留其他配置：

   ```json
   "enable-proposed-api": ["lipf1024.overleaf-workshop"]
   ```

4. 保存后完全退出并重新启动 VS Code，再打开 Overleaf 冲突文件的合并编辑器。仅 Reload Window 不足以重新读取启动参数。

也可在一个全新的 VS Code 进程中使用启动参数 `--enable-proposed-api=lipf1024.overleaf-workshop`；如果已有 VS Code 进程，参数可能被交给旧进程，不会改变已有进程的实验接口权限。

## 按钮行为

- 按钮只出现在 Overleaf 合并的 Result 区域，其他项目的 Git 合并界面不受影响。
- 点击后先让原生合并编辑器确认剩余冲突并保存结果，再重新校验本地、远端版本并应用结果。
- 只有同步验证成功才会清除冲突状态。取消确认、版本已变化或同步未验证成功都会保留冲突。
- 保存或关闭页面仍只保留草稿；状态栏及冲突文件菜单中的同名操作继续可用。

## 撤销实验接口设置

从 `argv.json` 的 `enable-proposed-api` 数组中移除 `lipf1024.overleaf-workshop`，然后完全退出并重新启动 VS Code。页面内按钮将不再显示，其他冲突解决入口继续可用。

## 本地验收状态

回归测试覆盖了按钮对应命令、取消、远端再次变化、同步失败及成功清除冲突的逻辑。实际原生窗口交互尚未完成验证：本轮隔离测试窗口启动被自动审批服务以 404 拒绝。最低声明版本 1.101.0 与当前安装版本均保留为待完成的窗口验收项。
