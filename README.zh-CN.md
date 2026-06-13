<p align="center">
  <img src="https://raw.githubusercontent.com/bbjyzzwwy/Tiny-TODO-List/master/resources/icon.png" alt="Tiny TODO List 图标" width="128" height="128">
</p>

<h1 align="center">Tiny TODO List</h1>

<p align="center">
  <strong>一个干净的 VS Code 侧边栏 TODO 列表，支持分组、键盘编辑和完成状态管理。</strong>
</p>

<p align="center">
  <a href="https://github.com/bbjyzzwwy/Tiny-TODO-List/blob/master/README.md">English</a> |
  <a href="https://github.com/bbjyzzwwy/Tiny-TODO-List/blob/master/README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bbjyzzwwy/Tiny-TODO-List/master/demo.gif" alt="Tiny TODO List 演示">
</p>

---

## 功能

- **侧边栏 TODO 列表** — 从 VS Code 活动栏打开任务列表，不需要离开当前编辑器。
- **任务分组** — 用可折叠分组整理 TODO，每个分组会显示任务数量。

## 使用方法

1. 点击 VS Code 活动栏中的 Tiny TODO List 图标。
2. 在侧边栏视图中添加任务。
3. 双击任务文本进行编辑，点击复选框标记完成，用分组整理相关任务。

## 键盘快捷键

| 按键 | 操作 |
|------|------|
| 选中任务后按 `Enter` | 开始编辑 |
| 编辑时按 `Enter` | 保存并在下方创建新 TODO |
| 编辑时按 `Escape` | 取消编辑 |
| `Backspace` / `Delete` | 永久删除选中的任务 |
| 选中任务时按 `Escape` | 清空选择 |

## 鼠标操作

| 操作 | 结果 |
|------|------|
| 点击复选框 | 切换完成或未完成 |
| 点击任务 | 选中任务 |
| Ctrl/Cmd + 点击 | 切换多选 |
| Shift + 点击 | 范围选择 |
| 双击文本 | 内联编辑 |
| 点击分组标题 | 折叠或展开分组 |

## 开发

```bash
npm install
npm run compile
npm run watch
```

在 VS Code 中按 `F5` 可启动 Extension Development Host 进行调试。

## 更新日志

见 [CHANGELOG.md](https://github.com/bbjyzzwwy/Tiny-TODO-List/blob/master/CHANGELOG.md)。

## 许可证

MIT
