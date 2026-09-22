import { buildWorkflowCompatiblePayload, getBenchmarkTopicsFromBody, getShareLinksFromBody, validateWorkflowCompatiblePayload } from "./adapter.js";
import { getContentAgentConfig, shouldUseContentAgent } from "./config.js";
import { AgentError, sendSseEvent, setSseHeaders } from "./http.js";
import { createRequestLogger, safeLink } from "./logger.js";
import { buildCreativeFallback, resolveTikHubVideo, resolveWeChatChannelsTopicVideo, runCreativeAgents, transcribeVideo } from "./providers.js";
import { buildCategoryAdaptation } from "../topicCreativeAdaptation.js";
import { getTopicLibraryCreativeAdaptation } from "../topicLibraryStore.js";
import { GOLD_THREE_SECOND_TYPE_LABELS } from "../goldThreeSeconds.js";
import { ENDING_HOOK_TYPE_LABELS } from "../endingHooks.js";

export { shouldUseContentAgent } from "./config.js";

/**
 * 从请求体里取「分享链接 → 这条视频在选题库里被判定的内容大类」。
 *
 * 前端在「今日选题」页已经把每条的大类判好了（`topic.content.categoryName`），
 * 二创直接用，**后端不再让模型判一次**（那会多付一次 ~20s 的固定开销，
 * 还会和已有标签产生两个互相矛盾的口径）。
 *
 * 兼容三种写法：`content_adaptation` / `contentAdaptation` / 同层 `category_names`。
 */
export const getCategoryNamesFromBody = body => {
  const raw = body?.content_adaptation ?? body?.contentAdaptation ?? body?.category_names ?? body?.parameters?.content_adaptation;
  const map = new Map();
  if (!raw || typeof raw !== "object") return map;
  for (const [link, categoryName] of Object.entries(raw)) {
    const key = String(link || "").trim();
    const value = String(categoryName || "").trim();
    if (key && value) map.set(key, value);
  }
  return map;
};

const topicWorkflowKey = (topic = {}) => {
  const source = topic?.source || {};
  const rawData = topic?.rawData || {};
  const id =
    source.objectId ||
    rawData.id ||
    rawData.object_id ||
    rawData.objectId ||
    topic.id ||
    source.objectNonceId ||
    rawData.object_nonce_id ||
    rawData.objectNonceId ||
    topic.title ||
    "";
  return `wechat_channels:${String(id || "topic").replace(/^wechat_channels:/, "")}`;
};

const buildContentAgentInputs = ({ shareLinks = [], benchmarkTopics = [], shareLinkPlatform = "douyin" } = {}) => [
  ...shareLinks.map(link => ({
    platform: shareLinkPlatform,
    shareLink: link,
  })),
  ...benchmarkTopics
    .filter(topic => topic?.platform === "wechat_channels" || topic?.source?.platform === "wechat_channels")
    .map(topic => ({
      platform: "wechat_channels",
      shareLink: topicWorkflowKey(topic),
      topic,
    })),
];

/**
 * 取「某个客户的选题库 → 链接 → 三秒/结尾钩子适配计划」。
 *
 * 一次请求只读一次库（不是每条视频读一次），然后把类别配比**按大类名**解析出来，
 * 最后按链接挂到每条视频上。
 *
 * ⚠️ 三类失败都**不影响生成**，只降级：没有 customerId / 没有库 / 库读失败
 * → 返回空表，下面 `runCreativeAgents` 会自动退回原来的自由二创提示词。
 * 二创是这个页面的主功能，不该因为「这个客户还没建库」就整条挂掉。
 */
const loadAdaptationByLink = async ({ customerId, categoryNames, logger }) => {
  const target = String(customerId || "").trim();
  if (!target || categoryNames.size === 0) return { map: new Map(), enabled: false };
  let library = null;
  try {
    // 员工侧只读口径：不按 managerId 过滤（员工不是库的属主），只回配比来源。
    library = await getTopicLibraryCreativeAdaptation({ customerId: target });
  } catch (error) {
    logger?.warn("creative.adaptation.library_failed", {
      code: error?.code || "TOPIC_LIBRARY_READ_FAILED",
      error: error instanceof Error ? error.message : "library read failed",
    });
    return { map: new Map(), enabled: false };
  }
  if (!library) {
    logger?.info("creative.adaptation.library_missing", { customerId: target });
    return { map: new Map(), enabled: false };
  }

  // 一个库可能有多个对标账号，各自一棵分类树。同一大类名在多个账号下都要能命中
  // —— 用「包含即命中」而不是「取第一个账号」，否则第二个账号的配比永远用不上。
  const accounts = Array.isArray(library.accounts) ? library.accounts.filter(Boolean) : [];
  const map = new Map();
  for (const [link, categoryName] of categoryNames.entries()) {
    const matches = accounts.map(account => ({
      accountName: account.accountName,
      goldThreeSeconds: buildCategoryAdaptation({
        categoryName,
        report: account.goldThreeSeconds,
        labels: GOLD_THREE_SECOND_TYPE_LABELS,
      }),
      endingHooks: buildCategoryAdaptation({
        categoryName,
        report: account.endingHooks,
        labels: ENDING_HOOK_TYPE_LABELS,
      }),
    }))
      // 只保留真的算出了槽位的账号：算不出槽位等于这个账号的库没纳入那份分析。
      .filter(item => item.goldThreeSeconds.slots.length > 0 || item.endingHooks.slots.length > 0);
    if (matches.length > 0) map.set(link, { customerName: library.customerName, candidates: matches });
  }

  logger?.info("creative.adaptation.ready", {
    customerId: target,
    accountCount: accounts.length,
    requestedLinks: categoryNames.size,
    matchedLinks: map.size,
  });
  return { map, enabled: true };
};

/**
 * 多条账号命中同一个大类时，选槽位最全的那一条。
 *
 * 一个客户可以有多个对标账号（「不合并」是明确口径），同名大类可能同时存在于
 * 两个账号的分类树里。二创只需要**一份**配比，所以取「能算出槽位更多」的那份
 * —— 也就是库纳入得更完整的那份分析。两边都一样时保持原顺序（稳定，不随机）。
 */
const buildVideoAdaptation = entry => {
  const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
  if (candidates.length === 0) return null;
  const score = item => item.goldThreeSeconds.slots.length + item.endingHooks.slots.length;
  return candidates.reduce((best, item) => (score(item) > score(best) ? item : best), candidates[0]);
};

export const runContentAgent = async (shareLinksOrInputs, options = {}) => {
  const config = options.config || getContentAgentConfig();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const logger = options.logger;
  const inputs = Array.isArray(shareLinksOrInputs) && shareLinksOrInputs.some(item => item && typeof item === "object")
    ? shareLinksOrInputs
    : buildContentAgentInputs({ shareLinks: shareLinksOrInputs });

  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new AgentError("share_links is required", { code: "SHARE_LINKS_EMPTY", status: 400 });
  }
  if (inputs.length > config.maxLinksPerRun) {
    throw new AgentError(`Too many links in one run, max is ${config.maxLinksPerRun}`, {
      code: "TOO_MANY_LINKS",
      status: 400,
    });
  }

  // 选题库配比：一次读库、按链接挂到每条视频上（读不到就是空表，自动降级）。
  const adaptationContext = await loadAdaptationByLink({
    customerId: options.customerId,
    categoryNames: options.categoryNames instanceof Map ? options.categoryNames : new Map(),
    logger,
  });

  const results = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const shareLink = input.shareLink;
    const progressBase = { index, total: inputs.length, shareLink, platform: input.platform };
    const itemStartedAt = Date.now();
    logger?.info("agent.item.start", {
      index: index + 1,
      total: inputs.length,
      shareLink: safeLink(shareLink),
      platform: input.platform,
    });

    onProgress({
      ...progressBase,
      step: "resolve-video",
      message: input.platform === "wechat_channels"
        ? `正在准备第 ${index + 1}/${inputs.length} 条视频号媒体`
        : `正在解析第 ${index + 1}/${inputs.length} 条对标视频链接`,
    });
    const video = input.platform === "wechat_channels"
      ? resolveWeChatChannelsTopicVideo(input.topic)
      : await resolveTikHubVideo(shareLink, config, { logger, platform: input.platform });
    onProgress({
      ...progressBase,
      step: "video-resolved",
      title: video.title,
      message: `已获取视频信息：${video.title || "未识别标题"}`,
    });

    onProgress({
      ...progressBase,
      step: "transcribe-video",
      title: video.title,
      providers: config.transcriptProviders,
      message: `开始提取音频并转写口播，执行方案：${config.transcriptProviders.join(" -> ")}`,
    });
    const transcript = await transcribeVideo(video, config, {
      logger,
      onProgress: progress => onProgress({ ...progressBase, ...progress }),
    });
    onProgress({
      ...progressBase,
      step: "transcript-ready",
      provider: transcript.provider,
      message: `口播转写完成，命中方案：${transcript.provider}`,
    });

    onProgress({
      ...progressBase,
      step: "creative-agents",
      provider: transcript.provider,
      message: "开始并行调用 4 个 DeepSeek 创作 Agent：开头钩子、结尾钩子、标题、二创文案",
    });
    // 这条视频的库内大类适配。取不到就是 null（`runCreativeAgents` 会退回原提示词）。
    const adaptation = buildVideoAdaptation(adaptationContext.map.get(shareLink));
    let creative;
    try {
      creative = await runCreativeAgents(video, transcript, config, {
        logger,
        adaptation,
        onProgress: progress => onProgress({ ...progressBase, ...progress }),
      });
    } catch (error) {
      logger?.error("creative.agents.unhandled_error", {
        code: error?.code || "CREATIVE_AGENTS_FAILED",
        status: error?.status,
        error: error instanceof Error ? error.message : "Creative agents failed",
      });
      onProgress({
        ...progressBase,
        step: "creative-agents-fallback",
        level: "warn",
        code: error?.code,
        message: "创作 Agent 发生未捕获错误，已使用兼容保底结果继续输出",
      });
      creative = buildCreativeFallback(video, transcript, error);
    }
    onProgress({
      ...progressBase,
      step: "creative-agents-ready",
      fallbackCount: Array.isArray(creative.warnings) ? creative.warnings.length : 0,
      message: Array.isArray(creative.warnings) && creative.warnings.length > 0
        ? `4 个创作 Agent 已完成，其中 ${creative.warnings.length} 个使用保底结果，正在整理为前端兼容结构`
        : "4 个创作 Agent 已完成，正在整理为前端兼容结构",
    });

    results.push({ shareLink, video, transcript, creative });
    logger?.info("agent.item.end", {
      index: index + 1,
      total: inputs.length,
      durationMs: Date.now() - itemStartedAt,
      transcriptProvider: transcript.provider,
      title: video.title,
    });
    onProgress({
      ...progressBase,
      step: "completed",
      message: `第 ${index + 1}/${inputs.length} 条视频处理完成`,
    });
  }

  const payload = buildWorkflowCompatiblePayload(results);
  onProgress({
    step: "payload-ready",
    total: inputs.length,
    message: "全部结果已生成，正在输出工作流兼容 payload",
  });
  const validated = validateWorkflowCompatiblePayload(payload, inputs.length);
  logger?.info("agent.payload.ready", {
    resultCount: inputs.length,
  });
  return validated;
};

export const runContentAgentWorkflow = async (_req, res, options = {}) => {
  const config = options.config || getContentAgentConfig();
  const body = options.body || {};
  const shareLinks = getShareLinksFromBody(body);
  const benchmarkTopics = getBenchmarkTopicsFromBody(body);
  // 前端通过 source_platform 标记分享链接来源平台（douyin/tiktok），默认 douyin。
  // 视频号走 benchmark_topics，平台由 topic 自身标记，不依赖此字段。
  const shareLinkPlatform = String(body?.source_platform || body?.sourcePlatform || "douyin").toLowerCase() === "tiktok"
    ? "tiktok"
    : "douyin";
  const inputs = buildContentAgentInputs({ shareLinks, benchmarkTopics, shareLinkPlatform });
  const logger = options.logger || createRequestLogger("content-agent");
  // 选题库的二创适配：客户在「入口」就定了（临时任务 / 指派任务带下来），
  // 大类由前端从「今日选题」页**已判定**的标签带过来 —— 后端不再让模型判一次。
  const customerId = String(body?.customerId || body?.customer_id || body?.parameters?.customerId || "").trim();
  const categoryNames = getCategoryNamesFromBody(body);
  logger.info("workflow.agent.start", {
    workflowId: body?.workflow_id,
    linkCount: shareLinks.length,
    topicCount: benchmarkTopics.length,
    inputCount: inputs.length,
    // 只记个数，不记客户 id 与大类名（日志里不带业务内容）。
    adaptationCustomerBound: Boolean(customerId),
    adaptationCategoryCount: categoryNames.size,
    provider: config.provider,
    transcriptProviders: Array.isArray(config.transcriptProviders) ? config.transcriptProviders.join(",") : "",
    doubaoResourceId: config.doubaoResourceId,
    tikhubConfigured: Boolean(config.tikhubApiToken),
    deepseekConfigured: Boolean(config.deepseekApiKey),
    doubaoAsrConfigured: Boolean(config.doubaoApiKey || (config.doubaoAppKey && config.doubaoAccessKey)),
    doubaoVideoConfigured: Boolean(config.doubaoVideoEndpoint && config.doubaoVideoApiKey),
  });

  setSseHeaders(res, 200);

  try {
    sendSseEvent(res, "Progress", {
      message: "content-agent-started",
      total: inputs.length,
      step: "content-agent-started",
    });

    const payload = await runContentAgent(inputs, {
      config,
      logger,
      customerId,
      categoryNames,
      onProgress: progress => sendSseEvent(res, "Progress", progress),
    });

    sendSseEvent(res, "Message", {
      content: JSON.stringify(payload),
    });
    sendSseEvent(res, "Done", {});
    logger.info("workflow.agent.done", {
      linkCount: shareLinks.length,
      topicCount: benchmarkTopics.length,
      inputCount: inputs.length,
    });
    res.end();
  } catch (error) {
    const status = error?.status || 500;
    const message = error instanceof Error ? error.message : "Content agent failed";
    sendSseEvent(res, "Error", {
      error_message: message,
      code: error?.code || "CONTENT_AGENT_FAILED",
      status,
      details: error?.details,
    });
    logger.error("workflow.agent.error", {
      status,
      code: error?.code || "CONTENT_AGENT_FAILED",
      error: message,
    });
    res.end();
  }
};

export const canHandleContentAgentWorkflow = shouldUseContentAgent;
