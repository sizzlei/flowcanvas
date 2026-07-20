/*
 * build-aws-icons.mjs — aws-icons-src/ 폴더의 SVG/PNG 아이콘을
 * 앱에 번들되는 aws-icons.js 로 변환합니다 (base64 data URI 로 인라인).
 *
 * 사용법:
 *   1) https://aws.amazon.com/architecture/icons 에서 공식 아이콘 팩을 받아 압축 해제
 *   2) 쓰고 싶은 서비스의 .svg / .png 파일을  aws-icons-src/  아래에 복사 (하위 폴더 OK)
 *   3) 프로젝트 루트에서:   node tools/build-aws-icons.mjs
 *   4) 브라우저에서 index.html 새로고침 → 아이콘 라이브러리에 기본 표시됨
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, extname, basename, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "icon");
const OUT = join(ROOT, "aws-icons.js");

if (!existsSync(SRC)) {
  console.error("aws-icons-src 폴더가 없습니다:", SRC);
  process.exit(1);
}

function walk(dir) {
  let out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(svg|png)$/i.test(f)) out.push(p);
  }
  return out;
}

// 파일명을 사람이 읽기 좋은 서비스 이름으로 정리
function cleanName(file) {
  return basename(file)
    .replace(/\.[^.]+$/, "")
    .replace(/^(Arch-Category|Arch|Res)[_-]*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(16|32|48|64|light-bg|dark-bg|light|dark)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const files = walk(SRC).sort();
const seen = new Set();
const icons = [];
for (const p of files) {
  const mime = extname(p).toLowerCase() === ".png" ? "image/png" : "image/svg+xml";
  const b64 = readFileSync(p).toString("base64");
  const rel = p.slice(SRC.length + 1);
  const cat = rel.split(/[\\/]/)[0];          // top-level folder = category
  let name = cleanName(p) || basename(p);
  let n = name, i = 2;
  while (seen.has(n)) n = name + " " + i++;   // 중복 이름 방지
  seen.add(n);
  icons.push({ name: n, cat, uri: `data:${mime};base64,${b64}` });
}

if (!icons.length) {
  console.error("aws-icons-src 에 .svg/.png 파일이 없습니다. 아이콘을 넣고 다시 실행하세요. (기존 aws-icons.js 는 그대로 둡니다)");
  process.exit(1);
}

const header = "/* 자동 생성 파일 — tools/build-aws-icons.mjs 로 생성됨. 직접 수정하지 마세요. */\n";
writeFileSync(OUT, header + "window.FLOWCANVAS_ICONS = " + JSON.stringify(icons, null, 0) + ";\n");
console.log(`✅ ${icons.length}개 아이콘을 aws-icons.js 에 기록했습니다.`);
