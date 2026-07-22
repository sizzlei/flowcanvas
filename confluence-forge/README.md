# FlowCanvas for Confluence (Forge)

Confluence Cloud 페이지에 FlowCanvas 편집기를 매크로로 넣습니다. draw.io처럼
**본문에는 다이어그램 이미지**가 보이고, **매크로를 편집하면 전체 편집기**가 열립니다.

**중요:** 기존 GitHub Pages 스탠드얼론 버전은 이 폴더와 무관하게 그대로 동작합니다.
이 프로젝트는 저장소 루트의 `app.js`/`styles.css` 등을 **그대로 재사용**하는 얇은 래퍼일
뿐이고, 저장 계층만 Confluence로 바꿉니다.

## 동작 방식

```
Confluence 매크로
├─ 보기(published)  → static/view   : 저장된 PNG 첨부파일을 <img> 로 표시
└─ 편집(config 대화상자) → static/editor : 전체 FlowCanvas 편집기
      ├─ app.js 가 window.FlowCanvasHost 노출 (getYAML/load/onChange/exportPNGBlob)
      └─ forge-glue.js
           ├─ 열 때: 페이지 첨부(flowcanvas-<id>.yaml) 다운로드 → host.load()
           └─ 저장: YAML + PNG 를 페이지 첨부로 업로드 → view.submit({img,data})
```

- 저장은 **페이지 첨부파일**(Confluence REST, 기본 100MB)을 사용합니다 → 이미지가 많은
  큰 다이어그램도 안전합니다(Forge storage의 240KB 제한 회피).
- 첨부 업로드/다운로드는 `@forge/bridge` 의 `requestConfluence` 로 **사용자 권한**으로
  수행합니다(별도 백엔드 resolver 불필요).

## 사전 준비

- Node.js 18+ 와 Forge CLI: `npm install -g @forge/cli`
- Atlassian 개발자 계정 로그인: `forge login`
- Confluence Cloud 사이트(무료 개발자 사이트 가능)

## 설치 & 배포

```bash
cd confluence-forge
npm install

forge register        # 최초 1회: manifest.yml 의 app.id 자동 기입
npm run deploy        # build(static/*) 후 forge deploy
forge install         # Product: Confluence 선택 → 사이트 URL 입력
```

배포 후 페이지 편집에서 `/FlowCanvas` 로 매크로를 추가 → "편집"으로 편집기를 열고,
우상단 **💾 저장하고 닫기** 를 누르면 본문에 다이어그램 PNG가 나타납니다.

## 개발(핫 리로드)

```bash
npm run tunnel        # build 후 forge tunnel
```

루트의 `app.js` 등을 수정하면 `npm run build`(또는 tunnel 재시작)로 `static/` 를 다시
생성해야 반영됩니다.

## 파일 구성

| 경로 | 설명 |
|------|------|
| `manifest.yml` | 매크로(view 리소스 + config=editor 리소스) + 권한 |
| `src/forge-glue.js` | 편집기 글루: 첨부 로드/저장 + 저장 버튼 |
| `src/forge-view.js` | 보기 글루: PNG 첨부 렌더링 |
| `src/index.js` | (미사용) 백엔드 resolver 가 필요할 때 자리 |
| `build.mjs` | 루트 앱 복사 + index.html 주입 + 글루 번들(2개 리소스) |
| `static/editor`, `static/view` | (빌드 산출물, git 제외) 실제 배포 리소스 |

## 배포 시 확인이 필요한 부분(테스트 환경 없이 작성됨)

아래는 Forge 라이브 환경에서 첫 배포 때 값/동작을 한 번 확인하는 게 좋습니다.

- **config 대화상자 크기**: Custom UI config 모달 크기는 제품이 정합니다. 편집기가
  좁으면 `viewportSize` 조정 또는 별도 전체화면 편집 방식을 검토하세요.
- **`requestConfluence` 멀티파트 업로드**: `PUT .../child/attachment` 에 `FormData`,
  헤더 `X-Atlassian-Token: no-check` 를 사용합니다. 응답 형태/권한 오류가 나면
  스코프(`write:confluence-file`)와 헤더를 확인하세요.
- **첨부 다운로드 링크**: `_links.download` 앞에 `/wiki` 를 붙여 요청합니다. 사이트에
  따라 경로가 다르면 조정하세요.
- **스코프 승인**: 스코프를 바꾼 뒤에는 `forge install --upgrade` 로 재승인해야 합니다.

## Server/Data Center

Forge는 Cloud 전용입니다. DC/Server라면 self-host 한 FlowCanvas를 HTML 매크로 앱으로
iframe 임베드하는 별도 방식을 쓰세요(저장 연동은 직접 구현).
