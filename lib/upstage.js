// Upstage Studio API 중계 공통 — API 키는 여기(서버)에서만 붙여요
const BASE = 'https://api.upstage.ai/v2';
const REQUIRED_ENV = ['UPSTAGE_API_KEY', 'AGENT_ID', 'UPSTAGE_PROJECT_ID'];

// x-project-id는 프로젝트 안 에이전트라 모든 요청에 꼭 붙여요.
// 빠지면 업로드는 성공하고 실행만 403(No access to file)이 나서 원인을 찾기 어려워요. 그래서 호출 전에 막아요
export async function upstage(env, path, init = {}) {
  const missing = REQUIRED_ENV.filter((k) => !env[k]);
  if (missing.length) {
    return json({ error: { code: 'E-CONFIG', message: `서버 환경변수가 빠졌어요: ${missing.join(', ')}. .dev.vars를 고쳤다면 서버를 다시 켜주세요` } }, 500);
  }
  const headers = { Authorization: `Bearer ${env.UPSTAGE_API_KEY}`, 'x-project-id': env.UPSTAGE_PROJECT_ID, ...(init.headers || {}) };
  return fetch(BASE + path, { ...init, headers });
}

// extra: 덧붙일 헤더(예: Upstage가 준 retry-after)
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

// 429·503에서 Upstage가 알려준 대기 시간을 브라우저까지 넘겨요
export function retryAfter(r) {
  const v = r.headers.get('retry-after');
  return v ? { 'retry-after': v } : {};
}

export function relay(r) {
  // Upstage 응답을 풀지 않고 그대로 돌려줘요(무료 플랜 CPU 10ms 안에 끝내려고)
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8', ...retryAfter(r) },
  });
}

export const FILE_ID = /^file_[\w-]+$/;
export const JOB_ID = /^[\w-]+$/;
