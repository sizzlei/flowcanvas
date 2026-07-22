// EDITOR glue — runs inside the macro's config (edit) dialog.
// Loads the saved diagram from a page attachment, and on Save writes the
// diagram YAML + a rendered PNG back as page attachments, then stores the
// filenames in the macro config so the view can render the PNG.
import { view, requestConfluence } from '@forge/bridge';

const waitForHost = () =>
  new Promise((resolve) => {
    (function poll() {
      if (window.FlowCanvasHost) return resolve(window.FlowCanvasHost);
      setTimeout(poll, 50);
    })();
  });

const nameFor = (localId, ext) => `flowcanvas-${localId}.${ext}`;

async function findAttachment(pageId, filename) {
  const res = await requestConfluence(
    `/wiki/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(filename)}`
  );
  const json = await res.json();
  return (json.results && json.results[0]) || null;
}

async function downloadText(att) {
  const res = await requestConfluence(`/wiki${att._links.download}`);
  return await res.text();
}

// PUT to child/attachment creates the file, or updates it if the name exists.
async function uploadAttachment(pageId, filename, blob) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('minorEdit', 'true');
  const res = await requestConfluence(
    `/wiki/rest/api/content/${pageId}/child/attachment`,
    { method: 'PUT', headers: { 'X-Atlassian-Token': 'no-check' }, body: fd }
  );
  if (!res.ok) throw new Error(`attachment upload failed: ${res.status}`);
}

(async () => {
  const host = await waitForHost();
  const ctx = await view.getContext();
  const pageId = ctx.extension.content.id;
  const localId = ctx.extension.macro?.localId || ctx.localId || 'default';
  const dataName = nameFor(localId, 'yaml');
  const imgName = nameFor(localId, 'png');

  // Load existing diagram (if any) from its attachment.
  try {
    const att = await findAttachment(pageId, dataName);
    if (att) host.load(await downloadText(att));
  } catch (e) {
    console.error('[FlowCanvas] load failed:', e);
  }

  // Floating Save button (persists attachments + closes the config dialog).
  const btn = document.createElement('button');
  btn.textContent = '💾 저장하고 닫기';
  btn.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:99999;padding:7px 14px;border:0;' +
    'border-radius:7px;background:#7c3aed;color:#fff;font-weight:600;cursor:pointer';
  document.body.appendChild(btn);

  async function persistAndClose() {
    btn.disabled = true;
    btn.textContent = '저장 중…';
    try {
      // 1) diagram source (YAML)
      await uploadAttachment(pageId, dataName, new Blob([host.getYAML()], { type: 'text/yaml' }));
      // 2) rendered preview (PNG) for the view mode
      await new Promise((resolve) =>
        host.exportPNGBlob(async (png) => {
          try { if (png) await uploadAttachment(pageId, imgName, png); }
          finally { resolve(); }
        })
      );
      // 3) remember filenames in macro config → closes the dialog
      await view.submit({ img: imgName, data: dataName, ts: Date.now() });
    } catch (e) {
      console.error('[FlowCanvas] save failed:', e);
      btn.disabled = false;
      btn.textContent = '⚠ 저장 실패 — 다시 시도';
    }
  }
  btn.addEventListener('click', () => persistAndClose());
})();
