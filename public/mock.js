// 목 모드(?mock=1) — /api/* 요청을 가로채 미리 정한 응답을 돌려줘요. Upstage를 부르지 않아요
// 새로고침해도 이어서 확인할 수 있게 진행 상황을 storage에 적어요
const STATE_KEY = 'jolup.mock.state';

const FALLBACK = {
  student_id: '',
  applicant_name: '',
  decision: '확인 필요',
  reason: '목 모드 예시예요. 정답지에 없는 파일이라 실제로 판정하지 않았어요',
  missing_documents: ['목 모드 예시 서류'],
  excluded_files: [],
};

// 굵게·인용 표시와 이중 인코딩까지 실제 응답 모양에 맞춰요(설계서 10장 실측)
const JUDGEMENT = `목 모드 예시예요. 실제 에이전트 출력이 아니에요

## [작업 3] 영역별 결과
1. 교양필수: 18학점 / 기준 18학점 - **충족** (목 예시)【†1】
2. 교양선택: 12학점 / 기준 12학점 - **충족** (목 예시)【†2】
3. 전공기초: 9학점 / 기준 9학점 - **충족** (목 예시)【†3】
4. 전공필수: 30학점 / 기준 30학점 - **충족** (목 예시)【†4】
5. 전공선택: 42학점 / 기준 36학점 - **충족** (목 예시)【†5】
6. 총학점: 133학점 / 기준 130학점 - **충족** (목 예시)【†6】
7. 평점: 3.74 / 기준 2.00 - **충족** (목 예시)【†7】
8. 어학: 값 없음 / 기준 없음 - **해당 없음** (목 예시)【†8】
9. 졸업인증: 논문 / 기준 필수 - **확인 필요** (목 예시)【†9】
10. 서류 확인: 필수 서류 - **확인 필요** (목 예시)【†10】

## [작업 4] 판정
- 판정: **#목 예시**【†11】`;
const encodeText = (s) => JSON.stringify(s);

// answers: 정답지 형식 { cases: [{ file, answer }] }, storage: localStorage처럼 getItem·setItem이 되는 것
export function createMockFetch(realFetch, { answers, storage }) {
  const load = () => {
    try { return JSON.parse(storage.getItem(STATE_KEY)) || { n: 0, files: {}, jobs: {} }; } catch { return { n: 0, files: {}, jobs: {} }; }
  };
  const store = (s) => storage.setItem(STATE_KEY, JSON.stringify(s));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const lastText = (fileName) => {
    const answer = answers?.cases?.find((c) => c.file === fileName)?.answer ?? FALLBACK;
    return encodeText(JSON.stringify({ ...answer, reason: `${answer.reason}【†1】` })); // 실제처럼 인용 표시를 붙여요
  };

  return async function mockFetch(input, opt = {}) {
    const path = typeof input === 'string' ? input : input.url;
    if (!path.startsWith('/api/')) return realFetch(input, opt);
    const method = (opt.method || 'GET').toUpperCase();
    const s = load();

    if (path === '/api/files' && method === 'POST') {
      const id = `file_mock_${++s.n}`;
      s.files[id] = opt.body.get('file').name;
      store(s);
      return json({ id });
    }
    let m = /^\/api\/files\/([\w-]+)$/.exec(path);
    if (m && method === 'DELETE') return json({ id: m[1], deleted: true });
    if (path === '/api/runs' && method === 'POST') {
      const { file_id: fileId } = JSON.parse(opt.body);
      const id = `job_mock_${++s.n}`;
      s.jobs[id] = { file: s.files[fileId] ?? '', polls: 0 };
      store(s);
      return json({ job_id: id, status: 'queued' });
    }
    m = /^\/api\/runs\/([\w-]+)\/steps$/.exec(path);
    if (m) {
      if (!s.jobs[m[1]]) return json({ error: { message: '없는 실행이에요' } }, 404);
      return json({ output: [
        { model: 'Instruct - 판정', content: [{ text: encodeText(JUDGEMENT) }] },
        { model: 'Instruct - 결과_json변환', content: [{ text: lastText(s.jobs[m[1]].file) }] },
      ] });
    }
    m = /^\/api\/runs\/([\w-]+)$/.exec(path);
    if (m) {
      const job = s.jobs[m[1]];
      if (!job) return json({ error: { message: '없는 실행이에요' } }, 404);
      job.polls++;
      store(s);
      if (job.polls <= 2) return json({ status: 'in_progress', failure_message: null, last_text: null });
      return json({ status: 'completed', failure_message: null, last_text: lastText(job.file) });
    }
    return json({ error: { message: '목 모드에 없는 경로예요' } }, 404);
  };
}
