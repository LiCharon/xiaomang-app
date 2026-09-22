import { apiUrl, fetchWithRetry } from "./api";
// 沿用全项目统一的接口错误口径（`reportApi.ts` 导出的那个）——
// 不要再写第二份 `parseApiError`，否则「success:false 也算失败」这条规则会两边漂移。
import { parseApiError } from "./reportApi";

/**
 * 发布仓的客户端接口（3.1 封面 / 3.2 发布文案 / 3.3 发布标签 + 持久化）。
 *
 * 沿用 `topicLibrary.ts` / `reportApi.ts` 的约定：
 *   - **不自动重试 Agent 调用**（一次调用可能几十秒，重试会让用户等两倍）；
 *   - 错误一律 `parseApiError`，把后端的可读消息透出来（不吞成「请求失败」）。
 */

/** 角度定义与后端 `publishWarehouse.js` 镜像。前端只用来渲染标签，不参与判定。 */
export const ACCOUNT_TAG_ANGLES = [
  { key: "track", label: "细分赛道" },
  { key: "painPoint", label: "用户核心痛点" },
  { key: "positioning", label: "内容核心定位" },
] as const;

export type PublishTopicLike = {
  id?: string;
  title?: string;
  link?: string;
  shareLink?: string;
  content?: {
    script?: string;
    scriptSource?: string;
    categoryName?: string;
    subcategoryName?: string;
  };
};

export type CoverBackground = {
  id: string;
  title: string;
  keywords: string[];
  prompt: string;
  reservedAreas: string[];
};

export type CoverTitleStyle = {
  fontFamily: string;
  fontSize: string;
  color: string;
  position: string;
  alignment: string;
  note: string;
};

export type CoverPlan = {
  ipPortrait: { outfitScene: string; expressionAction: string; prompt: string; basis: string };
  backgroundAnalysis: {
    artStyle: string; elements: string; layout: string; visualStyle: string;
    reservedAreas: string[]; summary: string;
  };
  titleStyle: CoverTitleStyle;
  backgrounds: CoverBackground[];
  summary: string;
};

export type PublishCopyKind = {
  kind: string;
  label: string;
  rule: string;
  /** `reuse` = 复用内容生成页已确认的标题/3s，不是 AI 现写的。 */
  source: "agent" | "reuse";
  options: string[];
};

export type PublishCopyResult = {
  items: PublishCopyKind[];
  missing: string[];
};

export type TagGroup = { key: string; label: string; quota: number; tags: string[] };

export type TopicTagsResult = {
  groups: TagGroup[];
  tags: string[];
  missing: string[];
};

export type AccountTagLibrary = {
  customerId: string;
  customerName: string;
  angles: Array<{ key: string; label: string; candidates: string[] }>;
  referenceTags: string[];
  summary: string;
};

export type CoverCandidate = {
  id: string;
  title: string;
  keywords: string[];
  prompt: string;
  image: { url: string; dataUrl: string };
};

export type PublishSelection = {
  topicId: string;
  title: string;
  cover: { selectedId: string; candidates: CoverCandidate[]; titleStyle: CoverTitleStyle | null };
  publishCopy: { items: PublishCopyKind[]; selected: string[] };
  topicTags: { groups: TagGroup[]; selected: string[]; missing: string[] };
  updatedAt: string;
};

const post = async <T,>(path: string, body: unknown): Promise<T> => {
  const response = await fetchWithRetry(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await parseApiError(response);
  return data as T;
};

const get = async <T,>(path: string): Promise<T> => {
  const response = await fetchWithRetry(apiUrl(path));
  const data = await parseApiError(response);
  return data as T;
};

// ── Agent 调用 ──────────────────────────────────────────────────────────────

export const requestCoverPlan = (payload: {
  customerId: string;
  topic: Record<string, unknown>;
  benchmarkCover?: unknown;
}) => post<{ plan: CoverPlan; imageGenerationAvailable: boolean }>("/api/agent/publish", {
  phase: "cover-plan",
  ...payload,
});

export const generateCoverImage = (payload: {
  prompt: string;
  referenceImages?: Array<{ url?: string; dataUrl?: string }>;
  size?: string;
  quality?: string;
  aspectRatio?: string;
}) => post<{ images: Array<{ url: string; dataUrl: string }>; model: string; elapsedMs: number }>(
  "/api/agent/publish",
  { phase: "cover-image", ...payload },
);

export const requestPublishCopy = (payload: {
  customerId: string;
  topic: Record<string, unknown>;
  reuseTitles: string[];
  reuseThreeSeconds: string[];
  accountTags?: string[];
}) => post<{ publishCopy: PublishCopyResult }>("/api/agent/publish", { phase: "publish-copy", ...payload });

export const requestAccountTags = (payload: { customerId: string; accountPlan?: unknown }) =>
  post<{ accountTags: AccountTagLibrary }>("/api/agent/publish", { phase: "account-tags", ...payload });

export const requestTopicTags = (payload: { customerId: string; topic: Record<string, unknown> }) =>
  post<{ topicTags: TopicTagsResult }>("/api/agent/publish", { phase: "topic-tags", ...payload });

// ── 持久化 ──────────────────────────────────────────────────────────────────

export const listPublishSelections = async (customerId: string): Promise<PublishSelection[]> => {
  const data = await get<{ items: PublishSelection[] }>(
    `/api/publish-warehouse?customerId=${encodeURIComponent(customerId)}`,
  );
  return Array.isArray(data?.items) ? data.items : [];
};

export const savePublishSelection = async (payload: {
  customerId: string;
  topicId: string;
  title?: string;
  cover?: unknown;
  publishCopy?: unknown;
  topicTags?: unknown;
}): Promise<PublishSelection> => {
  const data = await post<{ item: PublishSelection }>("/api/publish-warehouse", payload);
  return data.item;
};

export const deletePublishSelection = (customerId: string, topicId?: string) =>
  fetchWithRetry(
    apiUrl(`/api/publish-warehouse?customerId=${encodeURIComponent(customerId)}${topicId ? `&topicId=${encodeURIComponent(topicId)}` : ""}`),
    { method: "DELETE" },
  ).then(parseApiError);

export const clearPublishSelections = (customerId: string) => deletePublishSelection(customerId);

export const getAccountTags = async (customerId: string): Promise<AccountTagLibrary | null> => {
  const data = await get<{ item: AccountTagLibrary | null }>(
    `/api/publish-warehouse?resource=account-tags&customerId=${encodeURIComponent(customerId)}`,
  );
  return data?.item || null;
};

export const saveAccountTags = async (payload: {
  customerId: string;
  customerName?: string;
  angleGroups: unknown;
  confirmed: unknown;
  referenceTags?: string[];
  summary?: string;
}): Promise<AccountTagLibrary> => {
  const data = await post<{ item: AccountTagLibrary }>("/api/publish-warehouse?resource=account-tags", payload);
  return data.item;
};
