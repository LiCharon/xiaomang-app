import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { apiUrl, fetchWithRetry } from "./api";
import { parseApiError } from "./reportApi";
import { clearCachedFinalDrafts, readCachedFinalDrafts } from "./finalDraftCache";
import {
  ACCOUNT_TAG_ANGLES,
  clearPublishSelections,
  generateCoverImage,
  listPublishSelections,
  requestAccountTags,
  requestCoverPlan,
  requestPublishCopy,
  requestTopicTags,
  saveAccountTags,
  savePublishSelection,
} from "./publishWarehouseApi";
import type {
  AccountTagLibrary,
  CoverPlan,
  PublishCopyResult,
  PublishSelection,
  PublishTopicLike,
  TopicTagsResult,
} from "./publishWarehouseApi";

/**
 * 发布仓 —— 内容生成页之后的最后一步。
 *
 * 流程（用户 2026-09-21 拍板）：
 *   内容生成页（选标题/3秒/二创文案） → **发布仓**（选封面 / 发布文案 / 发布标签 + 核查 + 导出）
 *   → 最终文案编辑页
 *
 * 三块产出（见 HANDOFF §0.3 与 `docs/3.1~3.3`）：
 *   3.1 封面     按选题库的内容定位出提示词 → 人工确认 → 出图（唯一花钱的步骤）
 *   3.2 发布文案 金句 + 互动由 Agent 出；**标题与 3s 复用内容生成页已选的结果**，不重跑模型
 *   3.3 发布标签 账号恒定 3 个（三角度各确认 1）+ 每条选题 5 个（小类x2+核心内容x2+目标用户x1）
 *
 * ⚠️ 客户与大类都从「今日选题」的入口带下来（`contentCustomerId` + `topic.content.*`），
 *    **不在本页再选一次客户** —— 与 `/topics` 同一条口径（HANDOFF §0.1）。
 */

type TopicLike = PublishTopicLike;

const TABS = [
  { id: "cover", label: "3.1 封面", hint: "按内容定位出提示词，确认后出图" },
  { id: "copy", label: "3.2 发布文案", hint: "金句 / 标题 / 3s / 互动" },
  { id: "tags", label: "3.3 发布标签", hint: "账号恒定标签 + 选题标签" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const toPreview = (text: string, max = 90) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};

const toggle = (list: string[], value: string) =>
  list.includes(value) ? list.filter(item => item !== value) : [...list, value];

export default function PublishWarehousePage() {
  const navigate = useNavigate();

  const selectedTopics = useMemo(() => loadJson<TopicLike[]>("selectedTopics", []), []);
  const contentTasks = useMemo(() => loadJson<any[]>("contentTasks", []), []);
  const activeTask = contentTasks?.[0];
  const workflowGroups = useMemo(
    () => loadJson<Array<{ id: string; shareLink: string; result: any }>>("contentWorkflowGroups", []),
    [],
  );
  const customerId = useMemo(() => String(sessionStorage.getItem("contentCustomerId") || "").trim(), []);

  const [activeTab, setActiveTab] = useState<TabId>("cover");
  const [activeTopicIndex, setActiveTopicIndex] = useState(0);

  // 每条的发布仓选择（按 topicId 存）。
  const [selections, setSelections] = useState<Record<string, PublishSelection>>({});
  const [loadingSelections, setLoadingSelections] = useState(false);
  const [savingTopicId, setSavingTopicId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // 3.1 封面
  const [coverPlan, setCoverPlan] = useState<CoverPlan | null>(null);
  const [coverPlanTopicId, setCoverPlanTopicId] = useState("");
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverImageLoading, setCoverImageLoading] = useState("");
  const [coverPromptDraft, setCoverPromptDraft] = useState("");
  const [referenceDataUrl, setReferenceDataUrl] = useState("");

  // 3.2 发布文案
  const [copyResult, setCopyResult] = useState<PublishCopyResult | null>(null);
  const [copyLoading, setCopyLoading] = useState(false);

  // 3.3 发布标签
  const [accountTags, setAccountTags] = useState<AccountTagLibrary | null>(null);
  const [accountTagsLoading, setAccountTagsLoading] = useState(false);
  const [accountConfirmed, setAccountConfirmed] = useState<Record<string, string>>({});
  const [topicTags, setTopicTags] = useState<TopicTagsResult | null>(null);
  const [topicTagsLoading, setTopicTagsLoading] = useState(false);

  // 导出 / 结束任务
  const [exporting, setExporting] = useState("");
  const [bitableUrl, setBitableUrl] = useState("");
  const [bitableNewName, setBitableNewName] = useState("");
  const [taskCompleteVisible, setTaskCompleteVisible] = useState(false);

  const activeTopic = selectedTopics[activeTopicIndex] || null;
  const activeTopicId = String(activeTopic?.id || "");
  const activeSelection = selections[activeTopicId] || null;

  /**
   * 把「内容生成页已选的结果」读回来 —— 3.2 的标题与 3s 要**复用**它们。
   *
   * 内容生成页把每个链接的结果放在 `contentWorkflowGroups`；
   * 这里按当前选题的链接取回它那一组，避免把别的选题的钩子串到这条上。
   */
  const activeGroupResult = useMemo(() => {
    const link = String(activeTopic?.link || activeTopic?.shareLink || "").trim();
    if (!link) return null;
    const group = workflowGroups.find(item => String(item?.shareLink || "").trim() === link);
    return group?.result || null;
  }, [workflowGroups, activeTopic]);

  const reuseTitles = useMemo(() => {
    const titles = Array.isArray(activeGroupResult?.titles) ? activeGroupResult.titles : [];
    const first = titles.map((item: any) => String(item || "").split("\n")[0].replace(/^《|》$/g, "").trim()).filter(Boolean);
    return first.slice(0, 4);
  }, [activeGroupResult]);

  const reuseThreeSeconds = useMemo(() => {
    const hooks = Array.isArray(activeGroupResult?.hooks) ? activeGroupResult.hooks : [];
    return hooks
      .filter((item: any) => item?.hookType === "opening_text")
      .map((item: any) => String(item?.content || "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }, [activeGroupResult]);

  const selectedScript = useMemo(() => {
    const scripts = Array.isArray(activeGroupResult?.scripts) ? activeGroupResult.scripts : [];
    const first = scripts.map((item: any) => String(item?.content || "").trim()).filter(Boolean)[0];
    return first || String(activeTopic?.content?.script || "").trim();
  }, [activeGroupResult, activeTopic]);

  // ── 载入已保存的发布仓（换批选题后恢复上次的勾选）─────────────────────────
  useEffect(() => {
    if (!customerId) return;
    let active = true;
    setLoadingSelections(true);
    listPublishSelections(customerId)
      .then(items => {
        if (!active) return;
        const map: Record<string, PublishSelection> = {};
        for (const item of items) map[item.topicId] = item;
        setSelections(map);
      })
      .catch(() => { /* 首次使用没有记录，静默 */ })
      .finally(() => { if (active) setLoadingSelections(false); });
    return () => { active = false; };
  }, [customerId]);

  // 载入账号标签库（账号恒定，确认过一次就一直复用）。
  useEffect(() => {
    if (!customerId) return;
    let active = true;
    setAccountTagsLoading(true);
    import("./publishWarehouseApi")
      .then(({ getAccountTags }) => getAccountTags(customerId))
      .then(library => {
        if (!active || !library) return;
        setAccountTags(library);
        setAccountConfirmed(library.confirmed || {});
      })
      .catch(() => { /* 没确认过就静默 */ })
      .finally(() => { if (active) setAccountTagsLoading(false); });
    return () => { active = false; };
  }, [customerId]);

  const persist = useCallback(async (topicId: string, patch: Partial<PublishSelection>) => {
    if (!customerId || !topicId) return;
    setSavingTopicId(topicId);
    try {
      const saved = await savePublishSelection({
        customerId,
        topicId,
        title: String(selectedTopics.find(item => String(item.id) === topicId)?.title || ""),
        ...patch,
      });
      setSelections(prev => ({ ...prev, [topicId]: saved }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "发布仓保存失败");
    } finally {
      setSavingTopicId("");
    }
  }, [customerId, selectedTopics]);

  // ── 3.1 封面 ──────────────────────────────────────────────────────────────
  const loadCoverPlan = async (topic: TopicLike | null) => {
    if (!topic) return;
    setCoverLoading(true);
    setError("");
    try {
      const result = await requestCoverPlan({
        customerId,
        topic: {
          topicId: String(topic.id || ""),
          title: String(topic.title || ""),
          threeSeconds: String(topic.content?.threeSeconds || ""),
          script: selectedScript,
          categoryName: String(topic.content?.categoryName || ""),
          subcategoryName: String(topic.content?.subcategoryName || ""),
        },
      });
      setCoverPlan(result.plan);
      setCoverPlanTopicId(String(topic.id || ""));
      setCoverPromptDraft(String(result.plan?.backgrounds?.[0]?.prompt || result.plan?.ipPortrait?.prompt || ""));
      if (!result.imageGenerationAvailable) {
        setError("服务器未配置出图密钥（XXCAPI_API_KEY），可以先用提示词，配好后即可出图。");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "封面方案生成失败");
    } finally {
      setCoverLoading(false);
    }
  };

  const makeCoverImage = async (prompt: string, title: string, keywords: string[]) => {
    if (!prompt.trim()) {
      setError("请先确认出图提示词");
      return;
    }
    // ⚠️ 出图是全流程最慢的一步（按钮上就写着「较慢」），期间用户完全可能切到别的选题。
    //    所以把「发起时」的选题与已选状态先定格：否则 await 回来读到的 activeTopicId 是切走之后的，
    //    这张已经花过钱的图会落到**别的选题**上，而原选题什么都没留下。
    const topicId = activeTopicId;
    const baseSelection = activeSelection;
    const baseCandidates = baseSelection?.cover?.candidates || [];
    const titleStyle = baseSelection?.cover?.titleStyle || coverPlan?.titleStyle || null;
    setCoverImageLoading(title || prompt.slice(0, 20));
    setError("");
    try {
      const result = await generateCoverImage({
        prompt,
        // 用户上传了参考照片就走参考图编辑（文档要求的「结合现有参考照片」）。
        referenceImages: referenceDataUrl ? [{ dataUrl: referenceDataUrl }] : [],
        size: "2K",
        quality: "high",
        aspectRatio: "3:4",
      });
      const image = result.images?.[0];
      if (!image) throw new Error("出图接口没有返回图片");
      const candidates = [
        ...baseCandidates,
        {
          id: `cover-${baseCandidates.length + 1}`,
          title: title || `封面 ${baseCandidates.length + 1}`,
          keywords,
          prompt,
          image: { url: image.url || "", dataUrl: image.dataUrl || "" },
        },
      ];
      await persist(topicId, {
        cover: { selectedId: candidates[candidates.length - 1].id, candidates, titleStyle },
        publishCopy: baseSelection?.publishCopy || null,
        topicTags: baseSelection?.topicTags || null,
      });
      setMessage(`已生成封面「${title}」`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "出图失败");
    } finally {
      setCoverImageLoading("");
    }
  };

  /** 把标题以选定的样式叠加到封面上（纯 CSS，不依赖后端出字——模型写字会写成乱码）。 */
  const coverTitleStyle = activeSelection?.cover?.titleStyle || coverPlan?.titleStyle || null;
  const overlayTitle = String(reuseTitles[0] || activeTopic?.title || "").trim();

  // ── 3.2 发布文案 ──────────────────────────────────────────────────────────
  const loadPublishCopy = async () => {
    if (!activeTopic) return;
    setCopyLoading(true);
    setError("");
    try {
      const result = await requestPublishCopy({
        customerId,
        topic: {
          topicId: activeTopicId,
          title: String(activeTopic.title || ""),
          script: selectedScript,
          categoryName: String(activeTopic.content?.categoryName || ""),
          subcategoryName: String(activeTopic.content?.subcategoryName || ""),
        },
        // ★ 复用：标题与 3s 直接来自内容生成页，不重跑模型。
        reuseTitles,
        reuseThreeSeconds,
        accountTags: Object.values(accountConfirmed).filter(Boolean),
      });
      setCopyResult(result.publishCopy);
      await persist(activeTopicId, {
        cover: activeSelection?.cover || null,
        publishCopy: { items: result.publishCopy.items, selected: activeSelection?.publishCopy?.selected || [] },
        topicTags: activeSelection?.topicTags || null,
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "发布文案生成失败");
    } finally {
      setCopyLoading(false);
    }
  };

  // ── 3.3 发布标签 ──────────────────────────────────────────────────────────
  const loadAccountTags = async () => {
    setAccountTagsLoading(true);
    setError("");
    try {
      const result = await requestAccountTags({ customerId });
      // ⚠️ 结果可能是空的（Agent 没产出 / 老数据为 null）。原来直接
      //    `setAccountTags(result.accountTags)`，拿到 undefined 后渲染层读 `.angles` 就整页崩。
      //    空结果必须**如实提示**而不是把状态写成 undefined。
      if (!result?.accountTags?.angles?.length) {
        setError("账号标签这次没有生成出候选，请重试或先补齐账号定位信息。");
        return;
      }
      setAccountTags(result.accountTags);
      setAccountConfirmed(prev => {
        const next = { ...prev };
        // 没确认过的角度默认取第一个候选（用户仍可改），确认过的保留。
        for (const angle of result.accountTags.angles) {
          if (!next[angle.key]) next[angle.key] = angle.candidates[0] || "";
        }
        return next;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "账号标签生成失败");
    } finally {
      setAccountTagsLoading(false);
    }
  };

  const confirmAccountTags = async () => {
    if (!accountTags) return;
    try {
      const saved = await saveAccountTags({
        customerId,
        customerName: String(activeTask?.customerName || ""),
        angleGroups: accountTags.angles,
        confirmed: {
          track: accountConfirmed.track || "",
          painPoint: accountConfirmed.painPoint || "",
          positioning: accountConfirmed.positioning || "",
        },
        referenceTags: accountTags.referenceTags,
        summary: accountTags.summary,
      });
      setAccountTags(saved);
      setMessage("账号标签库已确认保存（之后每一轮发布都复用它）");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "账号标签保存失败");
    }
  };

  const loadTopicTags = async () => {
    if (!activeTopic) return;
    setTopicTagsLoading(true);
    setError("");
    try {
      const availableSubcategories = String(activeTopic.content?.subcategoryName || "")
        .split(/[、,，\s]+/).filter(Boolean);
      const result = await requestTopicTags({
        customerId,
        topic: {
          topicId: activeTopicId,
          title: String(activeTopic.title || ""),
          script: selectedScript,
          categoryName: String(activeTopic.content?.categoryName || ""),
          subcategoryName: String(activeTopic.content?.subcategoryName || ""),
          availableSubcategories,
        },
      });
      setTopicTags(result.topicTags);
      await persist(activeTopicId, {
        cover: activeSelection?.cover || null,
        publishCopy: activeSelection?.publishCopy || null,
        topicTags: { groups: result.topicTags.groups, selected: result.topicTags.tags, missing: result.topicTags.missing },
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "选题标签生成失败");
    } finally {
      setTopicTagsLoading(false);
    }
  };

  // ── 导出 / 核查 ───────────────────────────────────────────────────────────
  const readPendingDraftItems = async () => {
    try {
      const response = await fetchWithRetry(apiUrl("/api/final-drafts"));
      const data = await response.json();
      const list = Array.isArray(data?.items) ? data.items : [];
      if (list.length > 0) return list;
    } catch {
      // 回落到浏览器缓存
    }
    return readCachedFinalDrafts();
  };

  const exportAll = async (format: "feishu" | "bitable") => {
    setExporting(format);
    setError("");
    try {
      const items = await readPendingDraftItems();
      if (items.length === 0) throw new Error("暂无可导出的已保存文案，请先在最终文案编辑页保存");
      if (format === "feishu") {
        const response = await fetchWithRetry(apiUrl("/api/export/feishu"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentName: `${activeTask?.customerName || "选题"} - 选题复盘`, items }),
        });
        const data = await parseApiError(response);
        setMessage(`已写入飞书文档${data?.documentUrl ? `：${data.documentUrl}` : ""}`);
        if (data?.documentUrl) window.open(String(data.documentUrl), "_blank", "noopener,noreferrer");
      } else {
        const response = await fetchWithRetry(apiUrl("/api/export/bitable"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetUrl: bitableUrl,
            items,
            taskInfo: activeTask ? { customerName: String(activeTask.customerName || "") } : null,
          }),
        });
        const data = await parseApiError(response);
        setMessage(`已写入飞书多维表格${data?.bitableUrl ? `：${data.bitableUrl}` : ""}`);
        if (data?.bitableUrl) window.open(String(data.bitableUrl), "_blank", "noopener,noreferrer");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "导出失败");
    } finally {
      setExporting("");
    }
  };

  const createBitable = async () => {
    setExporting("create");
    setError("");
    try {
      const response = await fetchWithRetry(apiUrl("/api/export/bitable/create"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: bitableNewName.trim() || undefined }),
      });
      const data = await parseApiError(response);
      const url = String(data?.bitableUrl || "");
      setBitableUrl(url);
      setMessage(`已创建多维表格${url ? `：${url}` : ""}`);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "创建多维表格失败");
    } finally {
      setExporting("");
    }
  };

  /**
   * 把当前选题的三块产出拼成最终编辑页要的负载。
   *
   * ⚠️ 只带 http(s) 封面外链，**不带 dataUrl**：出图可能回 base64，一张几 MB，
   *    塞进 sessionStorage 会把配额撑爆、连带别的草稿一起丢。只有内嵌图时用 `coverInline` 如实标注。
   * 标签口径与后端 `buildPublishBundle` 一致：账号恒定标签 + 选题标签，统一补 `#`。
   */
  const buildPublishPayload = () => {
    const url = String(selectedCover?.image?.url || "").trim();
    const dataUrl = String(selectedCover?.image?.dataUrl || "").trim();
    const copyList = (activeSelection?.publishCopy?.selected || [])
      .map(item => String(item || "").trim()).filter(Boolean);
    const tagList = [...Object.values(accountConfirmed), ...tagSelected]
      .map(item => String(item || "").trim()).filter(Boolean)
      .map(item => (item.startsWith("#") ? item : `#${item}`));
    return {
      coverUrl: /^https?:\/\//i.test(url) ? url : "",
      coverTitle: String(selectedCover?.title || ""),
      coverPrompt: String(selectedCover?.prompt || ""),
      coverInline: !/^https?:\/\//i.test(url) && Boolean(dataUrl),
      copy: copyList.join("\n"),
      tags: Array.from(new Set(tagList)).join(" "),
    };
  };

  const goToFinalEditor = () => {
    // 把本条的发布产出带给最终编辑页（那一页只读 `finalDraftPayload`，
    // 并把它作为可编辑段落并入最终草稿，之后导出飞书文档与多维表格都带着它）。
    const existing = loadJson<any>("finalDraftPayload", null);
    const payload = {
      ...(existing || {}),
      publishWarehouse: buildPublishPayload(),
      taskInfo: existing?.taskInfo || (activeTask ? {
        id: String(activeTask._id || ""),
        customerName: String(activeTask.customerName || ""),
        platformName: String(activeTask.platformName || ""),
      } : null),
    };
    sessionStorage.setItem("finalDraftPayload", JSON.stringify(payload));
    navigate("/final-editor");
  };

  const confirmComplete = async () => {
    try { localStorage.removeItem(`bitableBinding:${String(activeTask?._id || "")}`); } catch { /* 忽略 */ }
    setTaskCompleteVisible(true);
    setTimeout(() => { window.location.href = "/"; }, 1800);
  };

  const handleReferenceUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("参考照片必须是图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setReferenceDataUrl(String(reader.result || ""));
    reader.onerror = () => setError("参考照片读取失败");
    reader.readAsDataURL(file);
  };

  const coverCandidates = activeSelection?.cover?.candidates || [];
  const selectedCoverId = activeSelection?.cover?.selectedId || "";
  const selectedCover = coverCandidates.find(item => item.id === selectedCoverId) || null;

  const copyItems = activeSelection?.publishCopy?.items || copyResult?.items || [];
  const copySelected = activeSelection?.publishCopy?.selected || [];

  const tagGroups = activeSelection?.topicTags?.groups || topicTags?.groups || [];
  // 上面的 optional chaining 已经兜住了 topicTags 为 null；这里再确认一遍 groups 是数组。
  const tagSelected = activeSelection?.topicTags?.selected || [];

  const confirmedAccountTagList = Object.values(accountConfirmed).filter(Boolean);

  return (
    <div className="min-h-screen bg-[#f5f7fb]">
      <header className="border-b border-slate-200/80 bg-white/80 px-5 py-6 backdrop-blur sm:px-8 lg:px-10">
        <div className="mx-auto max-w-[1500px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600">
                <span className="h-2 w-2 rounded-full bg-blue-600" />
                PUBLISH WAREHOUSE
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">发布仓</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                为每条选题确认封面、发布文案与发布标签。确认完进最终文案编辑页保存 ——
                这三块会<span className="font-medium text-slate-700">并入最终文案</span>，
                导出飞书文档与多维表格时一并带过去。
              </p>
            </div>
            <div className="flex items-center gap-2.5">
              <Button
                variant="outline"
                className="h-10 rounded-xl border-slate-200 bg-white text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900"
                onClick={() => navigate("/content")}
              >
                返回内容生成
              </Button>
              <Button
                className="h-10 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
                onClick={goToFinalEditor}
              >
                进入最终文案编辑页
              </Button>
            </div>
          </div>
          {!customerId && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
              没有读到客户信息（`contentCustomerId` 为空）。发布仓的标签与封面都依赖客户选题库，
              请从「今日选题」正常进入。
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-5 py-6 sm:px-8 lg:px-10">
        {error && (
          <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">{error}</div>
        )}
        {message && (
          <div className="mb-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-700">{message}</div>
        )}

        {/* 选题切换 */}
        <Card className="mb-5 border-slate-200 bg-white">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold text-slate-900">
                选题 {selectedTopics.length > 0 ? `${activeTopicIndex + 1} / ${selectedTopics.length}` : "（无）"}
              </CardTitle>
              <div className="flex items-center gap-2">
                {savingTopicId && <span className="text-xs text-slate-400">保存中…</span>}
                {loadingSelections && <span className="text-xs text-slate-400">读取上次进度…</span>}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {selectedTopics.length === 0 ? (
              <p className="text-sm text-slate-500">没有读到选题，请先在内容生成页确认选题。</p>
            ) : selectedTopics.map((topic, index) => (
              <button
                key={String(topic.id || index)}
                type="button"
                onClick={() => {
                  setActiveTopicIndex(index);
                  setCoverPlan(null);
                  setCoverPlanTopicId("");
                  // 提示词是**按选题**写的，切走必须清掉 —— 否则它的内容与当前选题无关，
                  // 而「确认提示词并生成封面」是唯一花钱的按钮，带着上一条的提示词出图等于白花钱。
                  // （参考照片不跟着清：它是**按客户**的 IP 形象照，同一客户下本来就该复用。）
                  setCoverPromptDraft("");
                  setCopyResult(null);
                  setTopicTags(null);
                }}
                className={`max-w-[280px] truncate rounded-xl border px-3 py-2 text-left text-xs transition ${
                  index === activeTopicIndex
                    ? "border-blue-400 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                }`}
              >
                {topic.title || "（无标题）"}
              </button>
            ))}
          </CardContent>
        </Card>

        {/* 三块的分栏 */}
        <div className="mb-5 flex flex-wrap gap-2">
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-xl border px-4 py-2.5 text-left text-sm transition ${
                activeTab === tab.id ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className={`font-semibold ${activeTab === tab.id ? "text-blue-700" : "text-slate-800"}`}>{tab.label}</div>
              <div className="mt-0.5 text-xs text-slate-400">{tab.hint}</div>
            </button>
          ))}
        </div>

        {/* ── 3.1 封面 ─────────────────────────────────────────────────────── */}
        {activeTab === "cover" && (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-slate-900">封面方案（提示词）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  className="h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                  disabled={coverLoading || !activeTopic}
                  onClick={() => loadCoverPlan(activeTopic)}
                >
                  {coverLoading ? "生成中…" : coverPlanTopicId === activeTopicId ? "重新生成方案" : "生成封面方案"}
                </Button>

                {coverPlan?.ipPortrait?.prompt && (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                    <div className="font-semibold text-slate-700">IP 形象照提示词</div>
                    <p className="mt-1 whitespace-pre-wrap">{coverPlan.ipPortrait.prompt}</p>
                    {coverPlan.ipPortrait.basis && <p className="mt-1 text-slate-400">依据：{coverPlan.ipPortrait.basis}</p>}
                  </div>
                )}

                {coverPlan?.backgroundAnalysis?.summary && (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                    <div className="font-semibold text-slate-700">对标封面拆解</div>
                    <p className="mt-1">{coverPlan.backgroundAnalysis.summary}</p>
                  </div>
                )}

                <div>
                  <label className="text-xs font-semibold text-slate-600">出图提示词（可改，确认后再出图）</label>
                  <textarea
                    value={coverPromptDraft}
                    onChange={event => setCoverPromptDraft(event.target.value)}
                    rows={4}
                    className="mt-1.5 w-full rounded-xl border border-slate-300 p-3 text-xs leading-5"
                    placeholder="先生成方案，或直接写提示词"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600">参考照片（可选，上传后走参考图编辑）</label>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={event => handleReferenceUpload(event.target.files?.[0] || null)}
                    className="mt-1.5 block w-full text-xs text-slate-500"
                  />
                </div>

                <Button
                  className="h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                  disabled={Boolean(coverImageLoading) || !coverPromptDraft.trim()}
                  onClick={() => makeCoverImage(coverPromptDraft, `封面 ${coverCandidates.length + 1}`, [])}
                >
                  {coverImageLoading ? "出图中…（较慢）" : "确认提示词并生成封面"}
                </Button>

                {coverPlan?.backgrounds && coverPlan.backgrounds.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-600">背景候选（点「用这个」填入提示词）</div>
                    {coverPlan.backgrounds.map(background => (
                      <div key={background.id} className="flex items-start gap-2 rounded-xl border border-slate-200 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-slate-800">{background.title}</div>
                          <div className="mt-1 line-clamp-2 text-xs text-slate-500">{toPreview(background.prompt)}</div>
                          {background.keywords.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {background.keywords.map(keyword => (
                                <Badge key={keyword} className="bg-slate-100 text-slate-600 hover:bg-slate-100">{keyword}</Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          className="shrink-0 text-xs"
                          onClick={() => setCoverPromptDraft(background.prompt)}
                        >
                          用这个
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold text-slate-900">
                  封面候选与标题叠加（{coverCandidates.length}）
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {coverCandidates.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
                    还没有封面。先确认提示词并生成。
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {coverCandidates.map(candidate => {
                      const src = candidate.image?.dataUrl || candidate.image?.url || "";
                      const isSelected = candidate.id === selectedCoverId;
                      const style = activeSelection?.cover?.titleStyle || coverPlan?.titleStyle;
                      return (
                        <div
                          key={candidate.id}
                          className={`overflow-hidden rounded-xl border transition ${isSelected ? "border-blue-400 ring-2 ring-blue-200" : "border-slate-200"}`}
                        >
                          <button
                            type="button"
                            className="relative block w-full"
                            onClick={() => persist(activeTopicId, {
                              cover: { selectedId: candidate.id, candidates: coverCandidates, titleStyle: coverPlan?.titleStyle || null },
                              publishCopy: activeSelection?.publishCopy || null,
                              topicTags: activeSelection?.topicTags || null,
                            })}
                          >
                            {src ? (
                              <img src={src} alt={candidate.title} className="aspect-[3/4] w-full object-cover" />
                            ) : (
                              <div className="flex aspect-[3/4] w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
                                无图片
                              </div>
                            )}
                            {/* 标题叠加：纯 CSS。让模型在图上写字会写成乱码，所以文字一律前端叠。 */}
                            {overlayTitle && (
                              <span
                                className={`absolute inset-x-0 px-2 text-center font-bold leading-tight drop-shadow ${
                                  style?.position === "top" ? "top-2" : style?.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-2"
                                }`}
                                style={{ color: style?.color || "#ffffff", fontSize: style?.fontSize || "14px" }}
                              >
                                {overlayTitle}
                              </span>
                            )}
                          </button>
                          <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                            <span className="truncate text-xs text-slate-600">{candidate.title}</span>
                            {isSelected && <Badge className="bg-blue-50 text-blue-600 hover:bg-blue-50">已选</Badge>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {selectedCover && (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                    当前选中：<span className="font-medium text-slate-800">{selectedCover.title}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── 3.2 发布文案 ─────────────────────────────────────────────────── */}
        {activeTab === "copy" && (
          <Card className="border-slate-200 bg-white">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold text-slate-900">发布文案（四类各勾选）</CardTitle>
                <Button
                  className="bg-slate-950 text-white hover:bg-slate-800"
                  disabled={copyLoading || !activeTopic}
                  onClick={loadPublishCopy}
                >
                  {copyLoading ? "生成中…" : copyItems.length > 0 ? "重新生成" : "生成发布文案"}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs leading-5 text-slate-500">
                金句与互动由 AI 生成；<span className="font-medium text-slate-700">标题与 3s 直接复用你在内容生成页已确认的结果</span>，不会重跑一遍。
              </p>
              {copyItems.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
                  还没有发布文案。点右上角生成。
                </p>
              ) : copyItems.map(item => (
                <div key={item.kind} className="rounded-xl border border-slate-200 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{item.label}</span>
                    <Badge className={item.source === "reuse" ? "bg-slate-100 text-slate-600 hover:bg-slate-100" : "bg-blue-50 text-blue-600 hover:bg-blue-50"}>
                      {item.source === "reuse" ? "复用已有" : "AI 生成"}
                    </Badge>
                    {item.options.length === 0 && <span className="text-xs text-amber-600">这一类没有生成出内容</span>}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {item.options.map(option => {
                      const checked = copySelected.includes(option);
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => {
                            const nextSelected = toggle(copySelected, option);
                            persist(activeTopicId, {
                              cover: activeSelection?.cover || null,
                              publishCopy: { items: copyItems, selected: nextSelected },
                              topicTags: activeSelection?.topicTags || null,
                            });
                          }}
                          className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                            checked ? "border-blue-400 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                          }`}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* ── 3.3 发布标签 ─────────────────────────────────────────────────── */}
        {activeTab === "tags" && (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-semibold text-slate-900">账号标签库（恒定）</CardTitle>
                  <Button variant="outline" disabled={accountTagsLoading} onClick={loadAccountTags}>
                    {accountTagsLoading ? "生成中…" : accountTags ? "重新生成" : "生成候选"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs leading-5 text-slate-500">
                  三个角度各选 1 个，确认后作为账号恒定标签长期复用（不用每轮重选）。
                </p>
                {ACCOUNT_TAG_ANGLES.map(angle => {
                  // 先取出来再用：写成 `x || [].map(...)` 会让 `.map` 绑到 `[]` 上，
                  // 而且三元与 `||` 混在一起极易读错。派生值统一放使用它的 JSX 之前。
                  const candidates = (accountTags?.angles || []).find(item => item.key === angle.key)?.candidates || [];
                  return (
                    <div key={angle.key}>
                      <div className="text-xs font-semibold text-slate-600">{angle.label}</div>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {candidates.map(candidate => (
                          <button
                            key={candidate}
                            type="button"
                            onClick={() => setAccountConfirmed(prev => ({ ...prev, [angle.key]: candidate }))}
                            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                              accountConfirmed[angle.key] === candidate
                                ? "border-blue-400 bg-blue-50 text-blue-700"
                                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                            }`}
                          >
                            {candidate}
                          </button>
                        ))}
                        {candidates.length === 0 && (
                          <span className="text-xs text-slate-400">还没生成候选</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <Button
                  className="h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                  onClick={confirmAccountTags}
                  disabled={!accountTags}
                >
                  确认并保存账号标签
                </Button>
                {confirmedAccountTagList.length > 0 && (
                  <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
                    当前账号标签：{confirmedAccountTagList.join(" / ")}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-200 bg-white">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-semibold text-slate-900">选题标签</CardTitle>
                  <Button variant="outline" disabled={topicTagsLoading} onClick={loadTopicTags}>
                    {topicTagsLoading ? "生成中…" : tagGroups.length > 0 ? "重新生成" : "生成标签"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs leading-5 text-slate-500">
                  配比：小类 x2 ＋ 脚本核心内容 x2 ＋ 目标用户 x1。
                </p>
                {tagGroups.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
                    还没有标签。点右上角生成。
                  </p>
                ) : tagGroups.map(group => (
                  <div key={group.key}>
                    <div className="text-xs font-semibold text-slate-600">
                      {group.label}
                      <span className="ml-1 text-slate-400">{group.tags.length}/{group.quota}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {group.tags.map(tag => {
                        const checked = tagSelected.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => persist(activeTopicId, {
                              cover: activeSelection?.cover || null,
                              publishCopy: activeSelection?.publishCopy || null,
                              topicTags: { groups: tagGroups, selected: toggle(tagSelected, tag), missing: activeSelection?.topicTags?.missing || [] },
                            })}
                            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                              checked ? "border-blue-400 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                            }`}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {(activeSelection?.topicTags?.missing || []).length > 0 && (
                  <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                    有类别没凑够：
                    {(activeSelection?.topicTags?.missing || []).join("、")}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── 核查 + 导出 ───────────────────────────────────────────────────────── */}
        <Card className="mt-5 border-slate-200 bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold text-slate-900">核查与导出</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-lg font-semibold text-slate-900">{coverCandidates.length}</div>
                <div className="mt-1 text-xs text-slate-500">封面候选（已选 {selectedCoverId ? 1 : 0}）</div>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-lg font-semibold text-slate-900">{copySelected.length}</div>
                <div className="mt-1 text-xs text-slate-500">已选发布文案</div>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-lg font-semibold text-slate-900">{tagSelected.length + confirmedAccountTagList.length}</div>
                <div className="mt-1 text-xs text-slate-500">已选标签（含账号标签）</div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button className="bg-blue-600 text-white hover:bg-blue-700" onClick={goToFinalEditor}>
                进入最终文案编辑页
              </Button>
              <Button variant="outline" disabled={exporting === "feishu"} onClick={() => exportAll("feishu")}>
                {exporting === "feishu" ? "写入中…" : "写入飞书文档"}
              </Button>
              <Button variant="outline" disabled={exporting === "bitable"} onClick={() => exportAll("bitable")}>
                {exporting === "bitable" ? "写入中…" : "写入多维表格"}
              </Button>
            </div>

            {/* 这两个按钮写的是「已保存的最终文案」，而草稿是在最终文案编辑页保存出来的。
                不写清前提的话，第一次走流程的人会在这里点出一个「暂无可导出」的错误。 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
              导出读的是<span className="font-medium text-slate-700">已保存的最终文案</span>
              （在最终文案编辑页点「保存最终文案」时产生）。还没保存过的话，先点左边的
              「进入最终文案编辑页」保存一条，再回来导出 —— 封面、发布文案与发布标签会一并带进导出结果。
            </div>

            <div className="rounded-xl border border-slate-200 px-4 py-3">
              <div className="text-xs font-semibold text-slate-600">飞书多维表格</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={bitableNewName}
                  onChange={event => setBitableNewName(event.target.value)}
                  placeholder="表格名称（可选）"
                  className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <Button variant="outline" disabled={exporting === "create"} onClick={createBitable}>
                  {exporting === "create" ? "创建中…" : "创建新多维表格"}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={bitableUrl}
                  onChange={event => setBitableUrl(event.target.value)}
                  placeholder="或粘贴已有表格 URL（https://xxx.feishu.cn/base/<token>）"
                  className="min-w-[260px] flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs"
                />
                <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">
                  {bitableUrl ? "已绑定" : "未绑定"}
                </Badge>
              </div>
            </div>

            <Button
              className="h-11 w-full rounded-xl bg-emerald-600 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-600/40 disabled:opacity-70"
              onClick={confirmComplete}
            >
              确认无误（结束本次任务）
            </Button>
            {taskCompleteVisible && (
              <div className="rounded-xl bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
                本次任务已完成，正在返回工作台…
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
