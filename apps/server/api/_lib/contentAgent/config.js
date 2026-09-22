export const DEFAULT_MAIN_WORKFLOW_ID = "7618854964156563519";

const splitCsv = (value, fallback = []) => {
  const items = String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toFfmpegSize = (value, fallback) => {
  const text = String(value || "").trim();
  return /^[1-9]\d*(?:[kKmMgG])?$/.test(text) ? text : fallback;
};

const normalizeAsrAudioFormat = (value) => {
  const format = String(value || "").toLowerCase();
  return ["auto", "mp3", "wav"].includes(format) ? format : "auto";
};

const normalizeTranscriptProvider = (value) => {
  const provider = String(value || "").toLowerCase();
  if (provider === "tikhub") return "tikhub-ffmpeg";
  return provider;
};

const isExplicitTrue = (value) => String(value || "").trim().toLowerCase() === "true";

const isExplicitFalse = (value) => String(value || "").trim().toLowerCase() === "false";

const isLocalDevelopmentEnvironment = () => {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return environment === "" || environment === "development" || environment === "test";
};

const shouldLogTikHubWechatResponses = () => {
  const value = process.env.TIKHUB_WECHAT_RESPONSE_LOG;
  // 仅本地开发默认开启；预发、生产等持久化日志环境必须由运维显式确认。
  return isLocalDevelopmentEnvironment() ? !isExplicitFalse(value) : isExplicitTrue(value);
};

const getTranscriptProviders = () => {
  const allowed = new Set(["tikhub-music", "tikhub-ffmpeg", "ffmpeg", "doubao-video"]);
  const enableTikHubProvider = String(process.env.TIKHUB_TRANSCRIPT_PROVIDER_ENABLED || "true").toLowerCase() !== "false";
  // tikhub-music 用 music.play_url mp3 直送 ASR，跳过 ffmpeg 提取（实测快约 12 倍）。
  // 默认开启。music 是纯背景音乐（无人声）时 ASR 返回空，provider 链自动回退到 tikhub-ffmpeg。
  // 如需关闭设 TIKHUB_MUSIC_PROVIDER_ENABLED=false。
  const enableMusicProvider = String(process.env.TIKHUB_MUSIC_PROVIDER_ENABLED || "true").toLowerCase() !== "false";
  const providers = splitCsv(process.env.TRANSCRIPT_PROVIDERS, ["ffmpeg", "doubao-video"])
    .map(normalizeTranscriptProvider)
    .filter(item => allowed.has(item));
  const normalized = providers.length > 0 ? providers : ["ffmpeg", "doubao-video"];
  if (enableTikHubProvider && normalized.includes("ffmpeg") && !normalized.includes("tikhub-ffmpeg")) {
    normalized.unshift("tikhub-ffmpeg");
  }
  // tikhub-music 插入链首（优先于 tikhub-ffmpeg），ASR 返回空时自动回退
  if (enableMusicProvider && normalized.includes("tikhub-ffmpeg") && !normalized.includes("tikhub-music")) {
    normalized.unshift("tikhub-music");
  }
  return Array.from(new Set(normalized));
};

export const getContentAgentConfig = () => {
  const mainWorkflowId =
    process.env.AGENT_CONTENT_WORKFLOW_ID ||
    DEFAULT_MAIN_WORKFLOW_ID;

  return {
    provider: "agent",
    mainWorkflowId,
    maxLinksPerRun: toInt(process.env.AGENT_MAX_LINKS_PER_RUN, 5),
    requestTimeoutMs: toInt(process.env.AGENT_REQUEST_TIMEOUT_MS, 120000),
    tikhubBaseUrl: process.env.TIKHUB_BASE_URL || "https://api.tikhub.io",
    tikhubApiToken: process.env.TIKHUB_API_TOKEN || "",
    tikhubWechatResponseLogEnabled: shouldLogTikHubWechatResponses(),
    tikhubRegion: process.env.AGENT_VIDEO_REGION || "CN",
    apiRetryAttempts: toInt(process.env.AGENT_API_RETRY_ATTEMPTS, 2),
    apiRetryBaseDelayMs: toInt(process.env.AGENT_API_RETRY_BASE_DELAY_MS, 500),
    creativeAgentRetryAttempts: toInt(process.env.AGENT_CREATIVE_RETRY_ATTEMPTS, 2),
    creativeAgentRetryBaseDelayMs: toInt(process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS, 1200),
    // 通用 Agent 重试：给分类分析、黄金三秒这类「一次调用出一份报告」的 Agent 用。
    // 它们原先没有重试，一次瞬时故障就直接掉进规则兜底，用户看到的就是「Agent 曾发生异常」。
    agentRetryAttempts: toInt(process.env.AGENT_RETRY_ATTEMPTS, 2),
    agentRetryBaseDelayMs: toInt(process.env.AGENT_RETRY_BASE_DELAY_MS, 1500),
    // 重试总预算。单次 HTTP 超时就有 AGENT_REQUEST_TIMEOUT_MS=120s，
    // 而 serverless 函数的 maxDuration 也是 120s：没有这个预算守卫，
    // 重试会把函数拖到被平台强杀，那样连兜底报告都拿不到，比直接降级更糟。
    agentRetryBudgetMs: toInt(process.env.AGENT_RETRY_BUDGET_MS, 90000),
    transcriptProviders: getTranscriptProviders(),
    transcriptCacheTtlMs: toInt(process.env.AGENT_TRANSCRIPT_CACHE_TTL_MS, 60 * 60 * 1000),
    ffmpegEnabled: String(process.env.FFMPEG_ENABLED || "true").toLowerCase() !== "false",
    ffmpegTimeoutMs: toInt(process.env.FFMPEG_TIMEOUT_MS, 90000),
    ffmpegAudioMaxBytes: toInt(process.env.FFMPEG_AUDIO_MAX_BYTES, 24 * 1024 * 1024),
    ffmpegFastProbeSize: toFfmpegSize(process.env.FFMPEG_FAST_PROBE_SIZE, "4194304"),
    ffmpegFastAnalyzeDuration: toFfmpegSize(process.env.FFMPEG_FAST_ANALYZE_DURATION, "3000000"),
    asrAudioFormat: normalizeAsrAudioFormat(process.env.ASR_AUDIO_FORMAT || "auto"),
    asrWavMaxBytes: toInt(process.env.ASR_WAV_MAX_BYTES, 20 * 1024 * 1024),
    tikhubMediaUrlMaxAttempts: toInt(process.env.TIKHUB_MEDIA_URL_MAX_ATTEMPTS, 2),
    // TikHub CDN 媒体下载大小预警阈值（仅日志，不硬拒绝）。
    // 超过此值的文件会被标记为「超大」，配合 URL 按大小排序，确保只有小文件全失败时才回退到大文件。
    tikhubMediaLargeBytes: toInt(process.env.TIKHUB_MEDIA_LARGE_BYTES, 50 * 1024 * 1024),
    mediaProxyUrl: process.env.TIKTOK_MEDIA_PROXY_URL || process.env.TIKHUB_MEDIA_PROXY_URL || process.env.MEDIA_PROXY_URL || "",
    mediaUseEnvProxy: String(process.env.MEDIA_USE_ENV_PROXY || "true").toLowerCase() !== "false",
    wechatMediaMaxBytes: toInt(process.env.WECHAT_CHANNELS_MEDIA_MAX_BYTES, 220 * 1024 * 1024),
    doubaoAsrEndpoint:
      process.env.DOUBAO_ASR_ENDPOINT ||
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    doubaoApiKey: process.env.DOUBAO_API_KEY || "",
    doubaoAppKey: process.env.DOUBAO_APP_KEY || "",
    doubaoAccessKey: process.env.DOUBAO_ACCESS_KEY || "",
    doubaoResourceId: process.env.DOUBAO_RESOURCE_ID || "volc.bigasr.auc_turbo",
    doubaoVideoEndpoint: process.env.DOUBAO_VIDEO_ENDPOINT || "",
    doubaoVideoApiKey: process.env.DOUBAO_VIDEO_API_KEY || "",
    doubaoVideoModel: process.env.DOUBAO_VIDEO_MODEL || "doubao-seed-2-0-mini-260428",
    doubaoVideoAuthHeader: process.env.DOUBAO_VIDEO_AUTH_HEADER || "Authorization",
    // 黄金三秒的真实口播转写。复用员工二创那套 ASR / 视频理解能力
    // （provider 链见 transcriptProviders）。
    //
    // 2026-09-17：黄金三秒改成对全部 60 条做分析，而完整转写实测一条约 89 秒
    // （其中「下载/解码整条视频」占大头），60 条根本跑不完。
    // 但只要**开场 3 秒**的话没必要转整条 —— 下面这个 clip 让 ffmpeg 只取开头
    // 一小段音频（`-t N`，见 buildFfmpegAudioExtractArgs），提取和 ASR 都随之变快。
    // 只对黄金三秒生效：员工二创链路仍然要完整转写，不要给它传这个值。
    goldTranscriptClipSeconds: toInt(process.env.GOLD_TRANSCRIPT_CLIP_SECONDS, 5),
    // 黄金三秒**专用**的 provider 顺序：默认把本地 ffmpeg 排在第一位。
    //
    // 2026-09-17 实测（HANDOFF §4.4）：本地 ffmpeg + 裁剪 5s 比 TikHub 服务端的 ffmpeg
    // 快 2~4 倍（有 mp3 直链 2.0s vs 5.5s；无直链 9.1s vs 12.3~15.4s）。而且**只有本地
    // ffmpeg 吃得到 goldTranscriptClipSeconds 的裁剪** —— 全局链路里它排第 3，几乎轮不到，
    // 裁剪等于死代码。
    //
    // 显式传这个顺序还会关掉「有 TikHub 就跳过本地 ffmpeg」那条隐式优化（见 transcribeVideo），
    // 否则顺序会被静默改回 TikHub 优先。TikHub 仍然留作兜底：本地 ffmpeg 失败会自动往下走。
    // 想回到旧行为，把它设成与 TRANSCRIPT_PROVIDERS 一致或留空即可。
    goldTranscriptProviders: splitCsv(process.env.GOLD_TRANSCRIPT_PROVIDERS, ["ffmpeg", "tikhub-music", "tikhub-ffmpeg", "doubao-video"]),
    // 设为 false 可整体关掉黄金三秒的转写，回到纯发布文案的行为。
    goldTranscriptEnabled: String(process.env.GOLD_TRANSCRIPT_ENABLED || "true").toLowerCase() !== "false",
    // 转写覆盖多少条 —— 与分析样本数（60）保持一致，否则部分大类只能靠发布文案推断。
    goldTranscriptLimit: toInt(process.env.GOLD_TRANSCRIPT_LIMIT, 60),
    // 每个请求处理几条。
    //
    // 2026-09-17：从 3 放大到 30。原来 3 是**裁剪之前**定的 —— 那时完整转写 89s/条，
    // 240s 预算只装得下 3 条。裁剪后单条 ~1.7s，60 条还要跑 20 轮，
    // **每轮的固定开销（鉴权 + 2 次进度查询 + 往返）已经和实际工作同一量级**。
    // 30 条约需 (30 × 1.7 / 并发 3) ≈ 17s，240s 预算远远用不完，轮数 20 → 2。
    // 单条变慢时预算守卫会提前收尾并返回 partial progress，前端会接着驱动下一批。
    goldTranscriptBatchSize: toInt(process.env.GOLD_TRANSCRIPT_BATCH_SIZE, 30),
    goldTranscriptConcurrency: toInt(process.env.GOLD_TRANSCRIPT_CONCURRENCY, 3),
    // TikHub 解析的预取宽度（与转写并发解耦）。
    // 解析实测 3.4~4.7s/条、比裁剪后的转写还慢，所以给它更宽的通道提前跑，
    // 转写 worker 直接取现成的结果。设 0 退回「解析和转写串行」的老行为。
    goldTranscriptResolveConcurrency: toInt(process.env.GOLD_TRANSCRIPT_RESOLVE_CONCURRENCY, 8),
    // 单批转写的总预算。必须明显小于该端点的 serverless maxDuration（300s），
    // 否则函数会被平台强杀，这一批的转写结果全部丢失。
    goldTranscriptBudgetMs: toInt(process.env.GOLD_TRANSCRIPT_BUDGET_MS, 240000),
    // 对标视频「高赞评论」抓取。TikHub 评论接口**按次计费**，所以抓过的视频永久落库
    // （commentStore.js），下面这些参数只决定「一次请求抓多少、跑多快」。
    // 每个请求处理几个视频（与转写同理：批太小，每轮的固定开销就和实际工作同一量级）。
    benchmarkCommentBatchSize: toInt(process.env.BENCHMARK_COMMENT_BATCH_SIZE, 10),
    // 每个视频按点赞降序保留多少条评论 —— 也就是「最被认同的几条」。
    benchmarkCommentLimitPerVideo: toInt(process.env.BENCHMARK_COMMENT_LIMIT_PER_VIDEO, 30),
    benchmarkCommentConcurrency: toInt(process.env.BENCHMARK_COMMENT_CONCURRENCY, 4),
    // 单批抓取的总预算。必须明显小于该端点的 serverless maxDuration（300s），
    // 否则函数会被平台强杀 —— 在途的付费请求结果会跟着一起丢。
    benchmarkCommentBudgetMs: toInt(process.env.BENCHMARK_COMMENT_BUDGET_MS, 240000),
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
    deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    deepseekTemperature: Number.parseFloat(process.env.DEEPSEEK_TEMPERATURE || "0.7"),
    // DeepSeek 允许的 max_tokens 上限是 393216（实测 API 报错信息为 [1, 393216]）。
    // 当前用的是推理模型（deepseek-flash），思考 token 计入 max_tokens：上限给小了会
    // 出现「思考吃满预算 → message.content 为空 → DEEPSEEK_EMPTY → 直接掉规则兜底」。
    // 这里只是上限，模型正常结束不会真的用到，调高不额外花钱。
    deepseekMaxTokens: toInt(process.env.DEEPSEEK_MAX_TOKENS, 393216),
    useDeepseekJsonMode: String(process.env.DEEPSEEK_USE_RESPONSE_FORMAT || "true").toLowerCase() !== "false",
  };
};

export const isMainContentWorkflow = (body, config = getContentAgentConfig()) => {
  const workflowId = String(body?.workflow_id || body?.workflowId || "").trim();
  return Boolean(workflowId && config.mainWorkflowId && workflowId === config.mainWorkflowId);
};

export const shouldUseContentAgent = (body, config = getContentAgentConfig()) => {
  return isMainContentWorkflow(body, config);
};
