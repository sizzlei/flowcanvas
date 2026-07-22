// VIEW glue — runs on the published page. Reads the PNG attachment named in
// the macro config and renders it. Double-click / the macro toolbar opens the
// editor (config dialog) provided by Confluence.
import { view, requestConfluence } from '@forge/bridge';

(async () => {
  const root = document.getElementById('root');
  try {
    const ctx = await view.getContext();
    const pageId = ctx.extension.content.id;
    const cfg = ctx.extension.config || {};
    if (!cfg.img) {
      root.textContent = '다이어그램이 없습니다. 매크로를 편집해 FlowCanvas를 여세요.';
      return;
    }
    const res = await requestConfluence(
      `/wiki/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(cfg.img)}`
    );
    const json = await res.json();
    const att = json.results && json.results[0];
    if (!att) {
      root.textContent = '미리보기 이미지를 찾을 수 없습니다.';
      return;
    }
    const dl = await requestConfluence(`/wiki${att._links.download}`);
    const url = URL.createObjectURL(await dl.blob());
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'FlowCanvas diagram';
    img.style.cssText = 'max-width:100%;height:auto;display:block';
    root.innerHTML = '';
    root.appendChild(img);
  } catch (e) {
    console.error('[FlowCanvas] view render failed:', e);
    root.textContent = '미리보기를 불러오지 못했습니다.';
  }
})();
