// POST /api/runs { file_id } → Upstage POST /v2/responses (에이전트 실행)
import { upstage, json, FILE_ID } from '../../../lib/upstage.js';

export async function onRequestPost({ request, env }) {
  const { file_id } = await request.json().catch(() => ({}));
  if (!FILE_ID.test(file_id || '')) {
    return json({ error: { code: 'E-STUDIO-REQUEST', message: 'file_id가 필요해요' } }, 400);
  }
  const r = await upstage(env, '/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.AGENT_ID, // 에이전트는 서버에서 고정해요(브라우저가 고르지 못하게)
      input: [{ role: 'user', content: [{ type: 'input_file', file_id }] }],
      include: ['last'],
      background: true,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return json(body, r.status);
  return json({ job_id: body.id, status: body.status });
}
