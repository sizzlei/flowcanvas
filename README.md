# FlowMaid

**FlowMaid** is a visual, drag-and-drop editor for building [Mermaid](https://mermaid.js.org/) flowcharts. Draw your diagram on a canvas and FlowMaid writes the Mermaid code for you — no syntax to memorize.

No build step, no server, no dependencies. Open `index.html` in any modern browser and it just works.

## ✨ Features

- **Draw, don't code** — drag shapes from the top palette onto the canvas; the Mermaid code is generated automatically as you work.
- **Drag-to-connect** — hover a node and drag the glowing handle to another node to draw an arrow.
- **Box-select** — drag on the empty canvas to select multiple nodes, then move, delete, or recolor them together.
- **Auto text wrapping** — long labels wrap onto multiple lines and the node grows to fit.
- **Node colors** — recolor selected nodes from the swatches or a custom color picker (reflected in the exported Mermaid `style` lines).
- **Curved or straight arrows** — toggle with a click (or `Cmd/Ctrl+E`).
- **Canvas navigation** — hold **Space + drag** to pan, scroll to zoom, `F` to fit the whole diagram.
- **Undo / Redo** — `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`.
- **Collapsible code panel** — hide the code sidebar for a bigger canvas.
- **Export** — download a **PNG** image, the **`.mmd`** Mermaid source, or a **`.json`** project file.
- **Save / Load** — your work auto-saves in the browser and restores on the next visit; export/import `.json` to move between machines.
- **Configurable shortcuts** — remap every keyboard shortcut in Settings; preferences persist as JSON in local storage.

## 📁 Project structure

```
FlowMaid/
├── index.html   # markup (toolbar, canvas, code panel, settings modal)
├── styles.css   # all styling; purple theme via CSS variables in :root
├── app.js       # all logic (no dependencies); see the header comment for a section map
├── README.md
└── LICENSE
```

`app.js` opens with a comment describing its 12 sections (view/pan-zoom, state, rendering, selection, interactions, CRUD, code generation, PNG export, serialize, history, shortcuts, startup).

## 🚀 Use it

### Option A — just open it
Download the folder and double-click `index.html`.

### Option B — host it on GitHub Pages (free)
1. Create a new GitHub repository and add **all files** (`index.html`, `styles.css`, `app.js`, `README.md`, `LICENSE`).
2. Push to the `main` branch.
3. In the repo, go to **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Select branch **`main`** and folder **`/ (root)`**, then **Save**.
6. After a minute, your app is live at `https://<your-username>.github.io/<repo-name>/`.

Because FlowMaid is a static site (HTML + CSS + JS in the same folder), GitHub Pages serves it directly with nothing else to configure.

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
| Box-select | Drag on empty canvas |

All key bindings (except pan/box-select) can be reassigned from the ⚙ Settings dialog.

## 🗺️ How data is stored

- **Auto-save:** the current diagram is written to `localStorage` (`flowmaid.diagram`) on every change and restored automatically.
- **Settings:** shortcut bindings are stored as JSON in `localStorage` (`flowmaid.settings`).
- **Portable files:** use **💾 Save** to download a `.json` you can commit, share, or re-open with **📂 Open**.

## 🛠️ Tech

Vanilla HTML, CSS, and JavaScript with an SVG canvas. No frameworks, no external network calls — safe to run fully offline.

## 📄 License

Released under the [MIT License](./LICENSE). Contributions welcome — open an issue or a pull request.
