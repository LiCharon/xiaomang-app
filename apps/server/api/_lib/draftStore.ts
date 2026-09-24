import { normalizePublishWarehouse } from "./exportFormatters.js";

const store = new Map<string, {
  id: string;
  createdAt: string;
  titleDraft: string;
  hookDraft: string;
  endingHookDraft: string;
  scriptDraft: string;
  rewriteDraft: string;
  translationDraft: string;
  benchmarkVideos: Array<Record<string, unknown>>;
  /** 发布仓三块产出；没经过发布仓时为 null（导出侧据此决定要不要追加那一段）。 */
  publishWarehouse: Record<string, unknown> | null;
}>();

const MAX_ITEMS = 200;

export const listDrafts = () => Array.from(store.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const addDraft = (input: {
  titleDraft?: string;
  hookDraft?: string;
  endingHookDraft?: string;
  scriptDraft?: string;
  rewriteDraft?: string;
  translationDraft?: string;
  benchmarkVideos?: Array<Record<string, unknown>>;
  publishWarehouse?: Record<string, unknown> | null;
}) => {
  const item = {
    id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    titleDraft: String(input.titleDraft || ""),
    hookDraft: String(input.hookDraft || ""),
    endingHookDraft: String(input.endingHookDraft || ""),
    scriptDraft: String(input.scriptDraft || ""),
    rewriteDraft: String(input.rewriteDraft || ""),
    translationDraft: String(input.translationDraft || ""),
    benchmarkVideos: Array.isArray(input.benchmarkVideos) ? input.benchmarkVideos : [],
    publishWarehouse: input.publishWarehouse && typeof input.publishWarehouse === "object"
      ? normalizePublishWarehouse(input.publishWarehouse)
      : null,
  };

  store.set(item.id, item);

  const all = listDrafts();
  if (all.length > MAX_ITEMS) {
    all.slice(MAX_ITEMS).forEach((draft) => store.delete(draft.id));
  }

  return item;
};

export const deleteDraft = (id: string) => store.delete(id);

export const clearDrafts = () => {
  const size = store.size;
  store.clear();
  return size;
};
