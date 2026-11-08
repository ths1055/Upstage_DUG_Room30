// 판정 결과 보고서 PDF — 1명이면 1쪽, 여러 명이면 요약 1쪽 + 학생별 1쪽
// fonts: { regular, bold } = 한글 글꼴 바이트(public/fonts/*.otf), fontkit은 @pdf-lib/fontkit
import { mapExcluded, excludedLabel } from './core.js';
const W = 595.28, H = 841.89, M = 48;
const COLOR = { '졸업 가능': [0.13, 0.55, 0.30], '확인 필요': [0.85, 0.60, 0.05], '졸업 요건 부족': [0.80, 0.20, 0.18] };

function wrap(text, font, size, width) {
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const ch of para) {
      if (font.widthOfTextAtSize(line + ch, size) > width && line) { lines.push(line); line = ch; } else line += ch;
    }
    lines.push(line);
  }
  return lines;
}

export async function buildReport(PDFLib, fontkit, fonts, cases, { title = '졸업요건 사정 결과', round = '' } = {}) {
  const { rgb } = PDFLib;
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const R = await doc.embedFont(fonts.regular, { subset: false }); // OTF(CFF) 글꼴은 pdf-lib 자체 subset이 깨져서, 미리 줄인 글꼴을 통째로 넣어요
  const B = await doc.embedFont(fonts.bold, { subset: false }); // OTF(CFF) 글꼴은 pdf-lib 자체 subset이 깨져서, 미리 줄인 글꼴을 통째로 넣어요
  const made = new Date().toLocaleString('ko-KR');
  let page, y;
  const newPage = () => {
    page = doc.addPage([W, H]); y = H - M;
    page.drawText(`${title}${round ? ' · ' + round : ''}`, { x: M, y: 24, size: 7.5, font: R, color: rgb(0.5, 0.5, 0.5) });
    page.drawText(`AI 1차 사정 결과예요. 최종 판정은 담당자가 확인해요 · 만든 시각 ${made}`, { x: M, y: 14, size: 7.5, font: R, color: rgb(0.5, 0.5, 0.5) });
  };
  const text = (s, { size = 10, font = R, x = M, width = W - 2 * M, gap = 4, color = rgb(0.1, 0.1, 0.1) } = {}) => {
    for (const l of wrap(s, font, size, width)) {
      if (y < M + size) newPage();
      page.drawText(l, { x, y: y - size, size, font, color }); y -= size + gap;
    }
  };
  const row = (cols, widths, { font = R, size = 9, fill = null } = {}) => {
    const cells = cols.map((c, i) => wrap(c, font, size, widths[i] - 8)); // 긴 글도 자르지 않고 줄을 바꿔요
    const lineH = size + 3;
    const h = size + 8 + (Math.max(...cells.map((l) => l.length)) - 1) * lineH;
    if (y < M + h) newPage();
    let x = M;
    cells.forEach((lines, i) => {
      if (fill) page.drawRectangle({ x, y: y - h, width: widths[i], height: h, color: fill });
      page.drawRectangle({ x, y: y - h, width: widths[i], height: h, borderColor: rgb(0.75, 0.75, 0.75), borderWidth: 0.5 });
      lines.forEach((s, n) => page.drawText(s, { x: x + 4, y: y - size - 3 - n * lineH, size, font }));
      x += widths[i];
    });
    y -= h;
  };

  if (cases.length > 1) { // 요약 쪽
    newPage();
    text(title, { size: 18, font: B, gap: 10 });
    const n = (d) => cases.filter((c) => c.result?.decision === d).length;
    text(`전체 ${cases.length}건 · 졸업 가능 ${n('졸업 가능')} · 확인 필요 ${n('확인 필요')} · 졸업 요건 부족 ${n('졸업 요건 부족')}`, { size: 10, gap: 10 });
    const w = [30, 200, 85, 85, 99];
    row(['번호', '파일', '학번', '성명', '판정'], w, { font: B, fill: rgb(0.94, 0.94, 0.94) });
    cases.forEach((c, i) => row([String(i + 1), c.fileName, c.result?.student_id || '', c.result?.applicant_name || '', c.result?.decision || '실행실패'], w));
  }

  for (const c of cases) { // 학생별 쪽
    newPage();
    const r = c.result || {};
    text('졸업요건 사정 결과', { size: 16, font: B, gap: 10 });
    const w = [80, W - 2 * M - 80];
    [['학번', r.student_id], ['성명', r.applicant_name], ['학과', c.dept || '(묶음 PDF)'], ['파일', c.fileName]]
      .forEach(([k, v]) => row([k, v || ''], w, { font: R }));
    y -= 12;
    const dec = r.decision || '실행실패';
    const col = COLOR[dec] || [0.4, 0.4, 0.4];
    page.drawRectangle({ x: M, y: y - 30, width: W - 2 * M, height: 30, color: rgb(...col) });
    page.drawText(`판정  ${dec}`, { x: M + 12, y: y - 21, size: 14, font: B, color: rgb(1, 1, 1) });
    y -= 44;
    text('이유', { size: 11, font: B }); text(r.reason || c.error || '', { gap: 4 }); y -= 6;
    text('빠진 서류', { size: 11, font: B }); text((r.missing_documents || []).join(', ') || '없음'); y -= 6;
    text('제외된 파일', { size: 11, font: B });
    text((c.excludedMapped || mapExcluded(r.excluded_files, [])).map(excludedLabel).join(', ') || '없음');
    y -= 6;
    if (c.areas?.length) {
      text('영역별 결과', { size: 11, font: B, gap: 6 });
      const aw = [80, 110, 70, W - 2 * M - 260];
      row(['영역', '이수/기준', '결과', '이유'], aw, { font: B, fill: rgb(0.94, 0.94, 0.94) });
      c.areas.forEach((a) => row([a.area, a.value, a.result, a.note], aw));
      y -= 6;
    }
    text(`실행 ${c.jobId || '-'} · ${c.finishedAt ? new Date(c.finishedAt).toLocaleString('ko-KR') : '-'}${c.checked ? ' · 담당자 확인함' : ''}${c.memo ? ' · 메모: ' + c.memo : ''}`,
      { size: 8, color: rgb(0.45, 0.45, 0.45) });
  }
  return doc.save();
}
