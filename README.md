# FlowMaid

**FlowMaid** is a visual, drag-and-drop editor for building [Mermaid](https://mermaid.js.org/) flowcharts. Draw your diagram on a canvas and FlowMaid writes the Mermaid code for you — no syntax to memorize.

It is a single, self-contained HTML file. No build step, no server, no dependencies. Open it in any modern browser and it just works.

## ✨ Features

- **Draw, don't code** — drag shapes from the top palette onto the canvas; the Mermaid code is generated automatically as you work.
- **Drag-to-connect** — hover a node and drag the glowing handle to another node to draw an arrow.
- **Node colors** — recolor any node from the swatches or a custom color picker (reflected in the exported Mermaid `style` lines).
- **Curved or straight arrows** — toggle with a click (or `Cmd/Ctrl+E`).
- **Canvas navigation** — hold **Space + drag** to pan, scroll to zoom, `F` to fit the whole diagram.
- **Undo / Redo** — `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`.
- **Collapsible code panel** — hide the code sidebar when you want a bigger canvas.
- **Export** — download a **PNG** image, the **`.mmd`** Mermaid source, or a **`.json`** project file.
- **Save / Load** — your work auto-saves in the browser and restores on the next visit; export/import `.json` to move between machines.
- **Configurable shortcuts** — remap every keyboard shortcut in Settings; preferences persist as JSON in local storage.

## 🚀 Use it

### Option A — just open the file
Download `index.html` and double-click it. That's the whole app.

### Option B — host it on GitHub Pages (free)
1. Create a new GitHub repository and add `index.html` (and this `README.md`, `LICENSE`).
2. Push to the `main` branch.
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Select branch **`main`** and folder **`/ (root)`**, then **Save**.
6. After a minute, your app is live at `https://<your-username>.github.io/<repo-name>/`.

Because FlowMaid is a static single-file app, GitHub Pages serves it directly with nothing else to configure.

## ⌨️ Default shortcuts

| Action | Shortcut |
| --- | --- |
| Delete selection | `Delete` / `Backspace` |
| Undo | `Cmd/Ctrl + Z` |
| Redo | `Cmd/Ctrl + Shift + Z` |
| Toggle curved arrows | `Cmd/Ctrl + E` |
| Fit to screen | `F` |
| Save to file | `Cmd/Ctrl + S` |
| Open file | `Cmd/Ctrl + O` |
| Deselect | `Esc` |
| Pan canvas | Hold `Space` + drag |

All of these can be reassigned from the ⚙ Settings dialog.

## 🗺️ How the diagram is stored

- **Auto-save:** the current diagram is written to `localStorage` (`flowmaid.diagram`) on every change and restored automatically.
- **Settings:** shortcut bindings are stored as JSON in `localStorage` (`flowmaid.settings`).
- **Portable files:** use **💾 저장 / Save** to download a `.json` you can commit, share, or re-open with **📂 열기 / Open**.

## 🛠️ Tech

Vanilla HTML, CSS, and JavaScript with an SVG canvas. No frameworks, no external network calls — safe to run fully offline.

## 📄 License

Released under the [MIT License](./LICENSE). Contributions welcome — open an issue or a pull request.
