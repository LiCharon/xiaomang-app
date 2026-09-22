import type { TopicRefreshVideo } from "./topicLibrary";

/**
 * 「今日选题」内容分析的**纯规则**（无副作用、无网络、无浏览器 API）。
 *
 * 单独拆出来是为了能被 `node --test` 直接加载（`tests/topic-content-rules.test.mjs`）：
 * 这个文件**不能 import 任何会拉进浏览器依赖的模块**，否则测试跑不起来。
 * 真正的网络编排在 `topicContentAnalysis.ts` 里。
 *
 * ── 用户口径（2026-09-21）────────────────────────────────────────────────
 * 1. 列表只保留**严格 `likes > 100`**（100 不达标，缺失点赞算 0）。
 * 2. **近 7 天**：给达标视频**语音提取完整脚本**，供下一步二创直接复用。
 * 3. **15 天及以上**：**不提取脚本**，只做点赞筛选 + 标签判定。
 * 4. 两边都按**本账号选题库**的大类/小类打标签。
 */

/** 点赞门槛：严格大于，100 不满足。 */
export const TOPIC_MIN_LIKES = 100;

/** 只有近 7 天（含）才提取完整脚本。 */
export const TRANSCRIPT_MAX_DAYS = 7;

/** 只保留点赞严格大于门槛的条目。缺失点赞归一化成 0，天然被挡掉。 */
export const filterByLikes = <T extends { stats?: { likes?: number } }>(topics: T[], minLikes: number = TOPIC_MIN_LIKES): T[] =>
  topics.filter(topic => Number(topic?.stats?.likes || 0) > minLikes);

/** 近 7 天（含）才提取脚本；更长的窗口只筛点赞 + 打标签。 */
export const shouldExtractTranscripts = (days: number) => Number(days) <= TRANSCRIPT_MAX_DAYS;

/** 每个视频的分析结果：脚本 + 标签。 */
export type TopicContent = {
  script: string;
  scriptSource: "transcript" | "caption";
  categoryName: string;
  subcategoryName: string;
  categoryId: string;
  confidence: string;
  basis: string;
};

export type TopicContentMap = Record<string, TopicContent>;

/**
 * 把分析结果挂到 topic 对象上（**返回新对象，不改原数组**）。
 *
 * ⚠️ 这一步是「二创不用再提取脚本」的关键：勾选后 `handleSubmit` 会把选中的 topic
 * 整体序列化进 `sessionStorage.selectedTopics`，脚本只有挂在 topic 上才能跟着走过去。
 */
export const attachContent = <T extends { id: string }>(
  topics: T[],
  content: TopicContentMap,
): Array<T & { content?: TopicContent }> =>
  topics.map(topic => (content[topic.id] ? { ...topic, content: content[topic.id] } : topic));

/** 拼成后端要的刷新视频形状。 */
export const toRefreshVideo = (topic: {
  id: string;
  title?: string;
  link?: string;
  authorName?: string;
  publishDate?: string;
  platform?: string;
  stats?: { likes?: number; comments?: number; shares?: number; bookmarks?: number };
}): TopicRefreshVideo => ({
  id: String(topic.id || ""),
  title: String(topic.title || "").slice(0, 240),
  link: String(topic.link || ""),
  authorName: String(topic.authorName || ""),
  publishDate: String(topic.publishDate || ""),
  sourceText: "",
  platform: topic.platform === "tiktok" ? "tiktok" : "douyin",
  stats: {
    likes: Number(topic.stats?.likes || 0),
    comments: Number(topic.stats?.comments || 0),
    shares: Number(topic.stats?.shares || 0),
    bookmarks: Number(topic.stats?.bookmarks || 0),
  },
});

/** 后端要求视频有 id + link + title 才能转写；缺任一项的条目打不了脚本，但仍可打标签。 */
export const transcribableVideos = (
  topics: Array<Parameters<typeof toRefreshVideo>[0]>,
): TopicRefreshVideo[] => topics.map(toRefreshVideo).filter(video => video.id && video.link && video.title);
