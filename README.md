<p align="center">
  <img src="https://raw.githubusercontent.com/bbjyzzwwy/Tiny-TODO-List/master/resources/icon.png" alt="Tiny TODO List logo" width="128" height="128">
</p>

<h1 align="center">Tiny TODO List</h1>

<p align="center">
  <strong>A clean sidebar TODO list for VS Code with groups, keyboard editing, and completion tracking.</strong>
</p>

<p align="center">
  <a href="https://github.com/bbjyzzwwy/Tiny-TODO-List/blob/master/README.md">English</a> |
  <a href="https://github.com/bbjyzzwwy/Tiny-TODO-List/blob/master/README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/bbjyzzwwy/Tiny-TODO-List/master/demo.gif" alt="Tiny TODO List demo">
</p>

---

## Features

- **Sidebar TODO list** — Open your tasks from the VS Code Activity Bar without leaving the editor.
- **Grouped tasks** — Organize TODOs into collapsible groups with item counts.


## Usage

1. Click the Tiny TODO List icon in the VS Code Activity Bar.
2. Add tasks in the sidebar view.
3. Double-click task text to edit, click checkboxes to complete, and use groups to keep related work together.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` on selected item | Start editing |
| `Enter` while editing | Save and create a new TODO below |
| `Escape` while editing | Cancel edit |
| `Backspace` / `Delete` | Permanently delete selected items |
| `Escape` with selected items | Clear selection |

## Mouse Actions

| Action | Result |
|--------|--------|
| Click checkbox | Toggle complete or incomplete |
| Click item | Select item |
| Ctrl/Cmd + Click | Toggle multi-select |
| Shift + Click | Select range |
| Double-click text | Edit inline |
| Click group header | Collapse or expand group |

## Development

```bash
npm install
npm run compile
npm run watch
```

Press `F5` in VS Code to launch the Extension Development Host.

## Changelog

See [CHANGELOG.md](https://github.com/bbjyzzwwy/Tiny-TODO-List/blob/master/CHANGELOG.md).

## License

MIT
