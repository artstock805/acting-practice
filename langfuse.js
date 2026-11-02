// Langfuse 추적: 키(LANGFUSE_PUBLIC_KEY·LANGFUSE_SECRET_KEY)가 있을 때만 Claude 호출을 Langfuse에 기록
// 배역 분석·초목표 분석·장면 그림 설명마다 무엇을 보냈고(지시문·대본) 무엇이 왔는지, 토큰·걸린 시간·오류를 점검하는 용도
// 키가 없으면 아무것도 바꾸지 않음 (테스트·키 없는 환경에서는 Langfuse 패키지도 불러오지 않음)
'use strict';

const FLUSH_WAIT_MS = 2000;   // Cloud Run은 응답 뒤 CPU를 줄이므로 기록을 보내고 답함. 단 Langfuse가 느려도 이 이상은 기다리지 않음

let shared;   // 서버마다 따로 만들지 않고 프로세스에 하나

function createLangfuseTracing(env = process.env) {
  const publicKey = (env.LANGFUSE_PUBLIC_KEY || '').trim();   // Secret Manager 값에 딸려 온 줄바꿈 제거
  const secretKey = (env.LANGFUSE_SECRET_KEY || '').trim();
  if (!publicKey || !secretKey) return null;
  if (shared) return shared;
  const { LangfuseSpanProcessor } = require('@langfuse/otel');
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { setLangfuseTracerProvider, startObservation } = require('@langfuse/tracing');
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl: (env.LANGFUSE_BASE_URL || '').trim() || undefined,   // 비우면 EU(cloud.langfuse.com)
    environment: (env.LANGFUSE_TRACING_ENVIRONMENT || '').trim() || 'local',
    exportMode: 'immediate',
  });
  setLangfuseTracerProvider(new NodeTracerProvider({ spanProcessors: [processor] }));
  shared = { startObservation, flush: () => processor.forceFlush() };
  return shared;
}

const usageOf = (usage = {}) => Object.fromEntries(
  [['input', usage.input_tokens], ['output', usage.output_tokens],
    ['cache_read_input_tokens', usage.cache_read_input_tokens], ['cache_creation_input_tokens', usage.cache_creation_input_tokens]]
    .filter(([, n]) => typeof n === 'number'));

// 기록 쪽에서 난 오류는 로그만 남김 (Claude 답·오류는 그대로 돌려줌)
function quietly(fn) {
  try { return fn(); } catch (err) { console.error('[langfuse]', err && err.message ? err.message : err); return undefined; }
}

async function flushQuietly(tracing) {
  let timer;
  const wait = new Promise((resolve) => { timer = setTimeout(resolve, FLUSH_WAIT_MS); timer.unref(); });
  try {
    await Promise.race([tracing.flush(), wait]);
  } catch (err) {
    console.error('[langfuse]', err && err.message ? err.message : err);   // 기록 실패가 사용자 답을 막지 않게
  } finally { clearTimeout(timer); }
}

// client.beta.messages.create만 감싼 클라이언트를 돌려줌 (호출 하나 = Langfuse generation 하나, 이름은 claude-<name>)
function traceClaude(client, name, tracing) {
  if (!client || !tracing) return client;
  const create = async (req) => {
    const generation = quietly(() => tracing.startObservation(`claude-${name}`, {
      model: req.model,
      input: { system: req.system, messages: req.messages },
      modelParameters: { max_tokens: req.max_tokens },
      metadata: { output_config: req.output_config },
    }, { asType: 'generation' }));
    if (!generation) return client.beta.messages.create(req);
    try {
      const res = await client.beta.messages.create(req);
      quietly(() => {
        const cut = res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens';
        const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        generation.update({
          model: res.model,
          output: text,
          usageDetails: usageOf(res.usage),
          level: cut ? 'WARNING' : 'DEFAULT',
          ...(cut ? { statusMessage: res.stop_reason } : {}),
        });
      });
      return res;
    } catch (err) {
      quietly(() => generation.update({ level: 'ERROR', statusMessage: err && err.message ? err.message : String(err) }));
      throw err;
    } finally {
      quietly(() => generation.end());
      await flushQuietly(tracing);
    }
  };
  return { beta: { messages: { create } } };
}

module.exports = { traceClaude, createLangfuseTracing };
