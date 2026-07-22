// Builds the two Forge Custom UI resources from the standalone FlowCanvas app.
//   static/editor/ — full FlowCanvas editor + forge-glue (config/edit dialog)
//   static/view/   — tiny page that shows the rendered PNG (published view)
// The standalone repo-root app is copied verbatim; nothing there is modified.
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // flowcanvas repo root
const editorOut = path.join(here, 'static', 'editor');
const viewOut = path.join(here, 'static', 'view');

const COPY = ['styles.css', 'aws-icons.js', 'guide.js', 'gif.js', 'app.js'];

async function buildEditor() {
  await fs.mkdir(editorOut, { recursive: true });
  for (const f of COPY) {
    await fs.copyFile(path.join(root, f), path.join(editorOut, f));
  }
  let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const tag = '<script type="module" src="forge-glue.js"></script>';
  if (!html.includes('forge-glue.js')) html = html.replace('</body>', `${tag}\n</body>`);
  await fs.writeFile(path.join(editorOut, 'index.html'), html);

  await build({
    entryPoints: [path.join(here, 'src', 'forge-glue.js')],
    outfile: path.join(editorOut, 'forge-glue.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true,
  });
}

async function buildView() {
  await fs.mkdir(viewOut, { recursive: true });
  const html = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:sans-serif}#root{padding:8px;color:#666;font-size:14px}</style></head>
<body><div id="root">로딩 중…</div>
<script type="module" src="forge-view.js"></script></body>
</html>
`;
  await fs.writeFile(path.join(viewOut, 'index.html'), html);
  await build({
    entryPoints: [path.join(here, 'src', 'forge-view.js')],
    outfile: path.join(viewOut, 'forge-view.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true,
  });
}

async function main() {
  await buildEditor();
  await buildView();
  console.log('✅ static/editor · static/view 빌드 완료');
}

main().catch((e) => { console.error(e); process.exit(1); });
