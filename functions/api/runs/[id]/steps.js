// GET /api/runs/:id/steps → 전체 step(include=all)을 풀지 않고 흘려보내요. 판정 근거는 브라우저에서 찾아요.
import { upstage, json, relay, JOB_ID } from '../../../../lib/upstage.js';

export async function onRequestGet({ params, env }) {
  if (!JOB_ID.test(params.id)) return json({ error: { code: 'E-STUDIO-REQUEST', message: 'job id 형식 오류' } }, 400);
  return relay(await upstage(env, `/responses/${params.id}?include=all`));
}
