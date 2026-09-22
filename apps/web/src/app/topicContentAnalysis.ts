import { getTopicLibrary, transcribeTopicRefresh, analyzeTopicRefresh, type TopicLibraryDetail } from "./topicLibrary";
import {
  TOPIC_MIN_LIKES,
  shouldExtractTranscripts,
  transcribableVideos,
  type TopicContent,
  type TopicContentMap,
} from "./topicContentRules";

/**
 * 「今日选题」的内容分析**编排**：取库 → （近 7 天）分批转写 → 打标签。
 *
 * 纯规则在 `topicContentRules.ts`（那边不拉浏览器依赖，可被 `node --test` 直接加载）；
 * 这里只负责网络与流程编排。
 *
 * 词典来自**入口就定好的那个客户**：临时任务绑定的客户 / 指派任务的客户。
 * 没有客户、或该客户还没建库时**不猜**，直接如实说明原因，让界面提示去补。
 */

export type TopicAnalysisStatus =
  | "idle"
  | "loading-library"
  | "transcribing"
  | "tagging"
  | "done"
  | "no-library"
  | "error";

export type TopicAnalysis = {
  status: TopicAnalysisStatus;
  message: string;
  /** 本次是否真的提取了脚本（只有近 7 天才为 true）。 */
  transcriptsExtracted: boolean;
  taggedCount: number;
  scriptCount: number;
  error: string;
};

/** 取某个客户的选题库；没有库返回 null（不抛错，由界面如实说明）。 */
export const loadLibraryForCustomer = async (customerId: string): Promise<TopicLibraryDetail | null> => {
  if (!customerId) return null;
  return getTopicLibrary(customerId);
};

/** 分批转写的安全上限：避免后端异常时前端死循环。 */
const TRANSCRIBE_MAX_ROUNDS = 20;

/**
 * 跑一次完整的内容分析。
 *
 * `onProgress` 把进度写到界面上 —— 转写 60 条是分钟级的，没有进度用户会以为卡死。
 */
export const runTopicContentAnalysis = async (options: {
  topics: Array<{
    id: string; title?: string; link?: string; authorName?: string; publishDate?: string;
    platform?: string; stats?: { likes?: number; comments?: number; shares?: number; bookmarks?: number };
  }>;
  customerId: string;
  days: number;
  onProgress?: (patch: Partial<TopicAnalysis>) => void;
}): Promise<{ content: TopicContentMap; analysis: Partial<TopicAnalysis> }> => {
  const { topics, customerId, days, onProgress } = options;
  const videos = transcribableVideos(topics);
  const extractTranscripts = shouldExtractTranscripts(days);

  if (!customerId) {
    return {
      content: {},
      analysis: {
        status: "no-library", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0,
        message: "这条任务没有绑定客户，无法确定用哪份选题库打标签。请在创建任务时选择客户。",
      },
    };
  }

  onProgress?.({ status: "loading-library", message: "正在读取本账号的选题库…" });
  const library = await loadLibraryForCustomer(customerId);
  if (!library || !Array.isArray(library.tagDictionary) || library.tagDictionary.length === 0) {
    return {
      content: {},
      analysis: {
        status: "no-library", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0,
        message: "这个客户还没有正式选题库，无法给视频打标签。请让项目经理先在「账号定位 → 2.4」里建库。",
      },
    };
  }

  if (videos.length === 0) {
    return {
      content: {},
      analysis: {
        status: "done", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0,
        message: "达标视频都没有可用链接，无法提取脚本或打标签。",
      },
    };
  }

  // ① 近 7 天：分批转写完整脚本。后端按 `scope: "script"` 永久缓存，换窗口回来是秒开的。
  if (extractTranscripts) {
    let round = 0;
    let progress = { total: videos.length, ok: 0, failed: 0, attempted: 0, finished: false };
    while (round < TRANSCRIBE_MAX_ROUNDS) {
      round += 1;
      progress = await transcribeTopicRefresh({
        videos,
        categories: library.tagDictionary,
        recentDays: days,
        minLikes: TOPIC_MIN_LIKES,
      });
      onProgress?.({
        status: "transcribing",
        message: `正在提取完整脚本：已处理 ${progress.attempted}/${progress.total}（成功 ${progress.ok}，失败 ${progress.failed}）`,
      });
      if (progress.finished) break;
    }
  } else {
    onProgress?.({ status: "tagging", message: "超过 7 天的时间范围不提取脚本，正在按库内分类打标签…" });
  }

  // ② 打标签：无论窗口长短都要做。
  const report = await analyzeTopicRefresh({
    videos,
    categories: library.tagDictionary,
    recentDays: days,
    minLikes: TOPIC_MIN_LIKES,
  });

  const content: TopicContentMap = {};
  for (const item of report.items) {
    content[item.video.id] = {
      script: item.script || "",
      scriptSource: item.scriptSource,
      categoryName: item.category?.name || "",
      subcategoryName: item.subcategory?.name || "",
      categoryId: item.category?.id || "",
      confidence: item.confidence || "low",
      basis: item.basis || "",
    } satisfies TopicContent;
  }

  const scriptCount = Object.values(content).filter(item => item.scriptSource === "transcript").length;
  const taggedCount = Object.values(content).filter(item => item.categoryId && item.categoryId !== "review").length;
  return {
    content,
    analysis: {
      status: "done",
      transcriptsExtracted: extractTranscripts,
      scriptCount,
      taggedCount,
      message: extractTranscripts
        ? `已提取 ${scriptCount} 条完整脚本，${taggedCount}/${report.items.length} 条打上库内大类/小类标签。`
        : `本时间范围不提取脚本；${taggedCount}/${report.items.length} 条打上库内大类/小类标签。`,
    },
  };
};
