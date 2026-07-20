/*
 * build-guide.mjs — GUIDE.md 를 앱이 로드하는 guide.js 로 변환합니다.
 * (file:// 로 열어도 동작하도록 마크다운을 JS 문자열로 인라인)
 *
 * 사용법: 프로젝트 루트에서  node tools/build-guide.mjs
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(ROOT, "GUIDE.md"), "utf8");
const out = "/* 자동 생성 — GUIDE.md 를 수정한 뒤 node tools/build-guide.mjs 를 실행하세요. */\n"
  + "window.FLOWCANVAS_GUIDE = " + JSON.stringify(md) + ";\n";
writeFileSync(join(ROOT, "guide.js"), out);
console.log("✅ guide.js 생성 완료 (" + md.length + "자)");
