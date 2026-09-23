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
  analyzeBenchmarkCover,
  clearPublishSelections,
  deleteCoverBase,
  generateCoverImage,
  getCoverBase,
  listCoverTiers,
  listPublishSelections,
  requestAccountTags,
  requestCoverPlan,
  requestCoverTitleMetrics,
  requestPortraitPlan,
  requestPublishCopy,
  requestTopicTags,
  saveAccountTags,
  saveCoverBase,
  savePublishSelection,
} from "./publishWarehouseApi";
import type {
  AccountTagLibrary,
  CoverAnalysis,
  CoverBase,
  CoverPlan,
  CoverTier,
  PublishCopyResult,
  PublishSelection,
  PublishTopicLike,
  TitleMetric,
  TitleStyleTemplate,
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

/** 标题样式模板的空壳（用户还没调过时给输入框一个可编辑的起点）。 */
const emptyTitleStyle = (): TitleStyleTemplate => ({
  fontFamily: "",
  color: "",
  position: "bottom",
  alignment: "",
  note: "",
  fontSizePx: 64,
  minFontSizePx: 36,
  maxLines: 2,
});

/**
 * 把拆解结果拼成一份**可改的**背景模板提示词。
 *
 * 这只是给用户一个起点（拆解出的四个角度 + 留白），不是业务规则 ——
 * 提示词本来就是给人改的，所以在前端组装，不占后端一次调用。
 */
const composeTemplatePrompt = (analysis: CoverAnalysis | null) => {
  if (!analysis) return "";
  const lines = [
    analysis.artStyle && `画风：${analysis.artStyle}`,
    analysis.elements && `元素：${analysis.elements}`,
    analysis.layout && `排版：${analysis.layout}`,
    analysis.visualStyle && `视觉风格：${analysis.visualStyle}`,
    analysis.reservedAreas.length > 0 && `留白区域（不要放内容）：${analysis.reservedAreas.join("；")}`,
  ].filter(Boolean);
  if (lines.length === 0) return "";
  return [
    "模仿这张对标封面的风格，生成一张竖版 3:4 的封面背景模板。",
    "只画背景，不要出现任何文字。",
    ...lines,
  ].join("\n");
};

/** 基底的上次保存时间（到秒，与报告列表同一条口径 —— 同一天存过两版要分得清）。 */
const formatMetTime = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

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

  // 3.1 内部两个子页：封面基底（账号级）/ 每条出封面（选题级）。
  // 分开的理由是这两层的**资产生命周期完全不同**：基底一次确认长期复用，
  // 每条只决定这一期的背景/人像表情/标题。混在一屏会逼用户每换一条选题就重做一次基底。
  const [coverSubTab, setCoverSubTab] = useState<"base" | "perTopic">("base");
  const [coverTiers, setCoverTiers] = useState<CoverTier[]>([]);
  const [coverBase, setCoverBase] = useState<CoverBase | null>(null);
  const [coverBaseLoading, setCoverBaseLoading] = useState(false);
  const [coverBaseSaving, setCoverBaseSaving] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [portraitLoading, setPortraitLoading] = useState(false);
  const [baseImageLoading, setBaseImageLoading] = useState("");
  const [baseTier, setBaseTier] = useState("semiCustom");
  const [baseSourceImage, setBaseSourceImage] = useState<{ url: string; dataUrl: string } | null>(null);
  const [baseAnalysis, setBaseAnalysis] = useState<CoverAnalysis | null>(null);
  const [baseTitleStyle, setBaseTitleStyle] = useState<TitleStyleTemplate | null>(null);
  const [baseBackgroundTemplate, setBaseBackgroundTemplate] = useState<{ url: string; dataUrl: string } | null>(null);
  const [baseBackgroundPrompt, setBaseBackgroundPrompt] = useState("");
  const [basePortraitPrompt, setBasePortraitPrompt] = useState("");
  const [basePortraitBasis, setBasePortraitBasis] = useState("");
  const [basePortraitImage, setBasePortraitImage] = useState<{ url: string; dataUrl: string } | null>(null);
  // 逐条的标题字号（后端算）——按「这条选题的标题」取。
  const [titleMetrics, setTitleMetrics] = useState<TitleMetric[]>([]);
  // 层二（每条出封面）的输入：这一期要用的标题 / 背景提示词 / 人像表情。
  // 它们是「这次要出的图」的输入，还不是候选，所以不写进 selection。
  const [perTopicTitle, setPerTopicTitle] = useState("");
  const [perTopicBackgroundPrompt, setPerTopicBackgroundPrompt] = useState("");
  const [perTopicExpression, setPerTopicExpression] = useState("");

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

  /**
   * 把读回来的封面基底灌进草稿态（首次进入、或保存后回读都走它）。
   *
   * 三类的资产**全部保留**、不按类型清空：用户可能在一类里配了模板、后来改选二类，
   * 再切回一类时那份模板还在（否则切一次类型就得重传一遍图）。
   */
  const applyCoverBase = useCallback((base: CoverBase | null) => {
    setCoverBase(base);
    if (!base) return;
    setBaseTier(base.tier || "semiCustom");
    setBaseSourceImage(base.sourceImage || null);
    setBaseAnalysis(base.analysis && (base.analysis.artStyle || base.analysis.summary) ? base.analysis : null);
    setBaseTitleStyle(base.titleStyle || null);
    setBaseBackgroundTemplate(base.backgroundTemplate || null);
    setBaseBackgroundPrompt(base.backgroundPrompt || "");
    setBasePortraitPrompt(base.portrait?.prompt || "");
    setBasePortraitBasis(base.portrait?.basis || "");
    setBasePortraitImage(base.portrait?.image || null);
  }, []);

  // 载入三类定义（后端 `COVER_TIERS`）与这个客户的封面基底。
  useEffect(() => {
    let active = true;
    listCoverTiers()
      .then(items => { if (active && items.length > 0) setCoverTiers(items); })
      .catch(() => { /* 读不到就退回只显示当前类型，不阻塞页面 */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!customerId) return;
    let active = true;
    setCoverBaseLoading(true);
    getCoverBase(customerId)
      .then(base => { if (active) applyCoverBase(base); })
      .catch(() => { /* 没配过就静默 */ })
      .finally(() => { if (active) setCoverBaseLoading(false); });
    return () => { active = false; };
  }, [customerId, applyCoverBase]);

  // 当前类型（读不到定义时先用一个最小兜底，保证渲染不依赖网络）。
  const activeTier: CoverTier | null = useMemo(
    () => coverTiers.find(item => item.id === baseTier) || null,
    [coverTiers, baseTier],
  );

  /**
   * 这一条选题能不能出封面：缺什么就如实列出来（并在界面上把出口指回「封面基底」）。
   *
   * ⚠️ 一类没有背景模板（它的模板就是那张固定封面图），所以「模板」的判定要按类型分岔，
   *    统一写成「必须有 backgroundTemplate」会让一类永远显示缺东西。
   */
  const coverReadiness = useMemo(() => {
    const missing: string[] = [];
    if (!activeTier) missing.push("封面类型");
    const template = baseBackgroundTemplate || baseSourceImage;
    if (activeTier?.needsBackgroundTemplate) {
      if (!baseBackgroundTemplate) missing.push("背景风格模板");
    } else if (activeTier && !template) {
      missing.push("固定封面模板");
    }
    if (activeTier?.needsPortrait && !basePortraitImage) missing.push("IP 人像");
    return { ok: missing.length === 0, missing };
  }, [activeTier, baseBackgroundTemplate, baseSourceImage, basePortraitImage]);

  /** 基底里的图上传（对标封面 / 背景模板 / IP 人像共用一套读取逻辑）。 */
  const handleBaseImageUpload = (file: File | null, apply: (image: { url: string; dataUrl: string }) => void) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("只能上传图片");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => apply({ url: "", dataUrl: String(reader.result || "") });
    reader.onerror = () => setError("图片读取失败");
    reader.readAsDataURL(file);
  };

  /** 拆解上传的对标封面（视觉模型，**不出图**）。 */
  const runCoverAnalysis = async () => {
    if (!baseSourceImage) {
      setError("请先上传一张对标封面图");
      return;
    }
    setAnalysisLoading(true);
    setError("");
    try {
      const result = await analyzeBenchmarkCover({ image: baseSourceImage });
      setBaseAnalysis(result.analysis);
      setBaseTitleStyle(result.titleStyle);
      // 拆完自动填一份可改的模板提示词（用户已经改过就不覆盖他的输入）。
      setBaseBackgroundPrompt(prev => prev.trim() ? prev : composeTemplatePrompt(result.analysis));
      if (!result.imageGenerationAvailable) {
        setError("服务器未配置出图密钥，暂时只能看拆解结果，配好后即可生成背景模板。");
      } else {
        setMessage("已拆解对标封面：画风 / 元素 / 排版 / 视觉风格 + 留白区域。");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "对标封面拆解失败");
    } finally {
      setAnalysisLoading(false);
    }
  };

  /** 出 IP 形象照的提示词建议（账号级）—— 人工改过之后才出图。 */
  const runPortraitPlan = async () => {
    setPortraitLoading(true);
    setError("");
    try {
      const result = await requestPortraitPlan({ customerId });
      setBasePortraitPrompt(String(result.ipPortrait?.prompt || ""));
      setBasePortraitBasis(String(result.ipPortrait?.basis || ""));
      setMessage("已给出 IP 形象照的提示词建议，确认后再出图。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "IP 形象照提示词生成失败");
    } finally {
      setPortraitLoading(false);
    }
  };

  /** 基底里的一次出图（背景风格模板 / IP 形象照）。唯一花钱的动作，必须点了才走。 */
  const makeBaseImage = async (kind: "backgroundTemplate" | "portrait") => {
    const prompt = kind === "portrait" ? basePortraitPrompt.trim() : baseBackgroundPrompt.trim();
    if (!prompt) {
      setError(kind === "portrait" ? "请先确认 IP 形象照的提示词" : "请先确认背景模板的提示词");
      return;
    }
    setBaseImageLoading(kind);
    setError("");
    try {
      // 背景模板拿对标封面当参考图（模仿它的风格）；IP 形象照拿客户参考照片当参考图。
      const referenceImages = kind === "backgroundTemplate"
        ? (baseSourceImage ? [baseSourceImage] : [])
        : (basePortraitImage ? [basePortraitImage] : []);
      const result = await generateCoverImage({
        prompt,
        referenceImages,
        size: "2K",
        quality: "high",
        aspectRatio: "3:4",
      });
      const image = result.images?.[0];
      if (!image) throw new Error("出图接口没有返回图片");
      const ref = { url: image.url || "", dataUrl: image.dataUrl || "" };
      if (kind === "portrait") {
        setBasePortraitImage(ref);
        setMessage("已生成 IP 形象照，确认后保存基底。");
      } else {
        setBaseBackgroundTemplate(ref);
        setMessage("已生成背景风格模板，确认后保存基底。");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "出图失败");
    } finally {
      setBaseImageLoading("");
    }
  };

  /** 保存封面基底（账号级，幂等 upsert）。 */
  const persistCoverBase = async (nextTier = baseTier) => {
    if (!customerId) {
      setError("没有读到客户信息，无法保存封面基底");
      return;
    }
    setCoverBaseSaving(true);
    setError("");
    try {
      const saved = await saveCoverBase({
        customerId,
        customerName: String(activeTask?.customerName || ""),
        tier: nextTier,
        sourceImage: baseSourceImage,
        analysis: baseAnalysis,
        titleStyle: baseTitleStyle,
        backgroundTemplate: baseBackgroundTemplate,
        backgroundPrompt: baseBackgroundPrompt,
        portrait: { prompt: basePortraitPrompt, basis: basePortraitBasis, image: basePortraitImage },
      });
      applyCoverBase(saved);
      setMessage("封面基底已保存（账号级，之后每期复用）");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "封面基底保存失败");
    } finally {
      setCoverBaseSaving(false);
    }
  };

  const clearCoverBase = async () => {
    if (!customerId) return;
    setCoverBaseSaving(true);
    setError("");
    try {
      await deleteCoverBase(customerId);
      applyCoverBase(null);
      setBaseTier("semiCustom");
      setBaseSourceImage(null);
      setBaseAnalysis(null);
      setBaseTitleStyle(null);
      setBaseBackgroundTemplate(null);
      setBaseBackgroundPrompt("");
      setBasePortraitPrompt("");
      setBasePortraitBasis("");
      setBasePortraitImage(null);
      setTitleMetrics([]);
      setMessage("封面基底已清空，可以重新选类型");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "清空封面基底失败");
    } finally {
      setCoverBaseSaving(false);
    }
  };

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
      // 出方案顺带把第一个背景候选填进「这一期的背景」输入框，用户可直接改（一类的候选提示词不上这儿用）。
      setPerTopicBackgroundPrompt(prev => prev.trim() ? prev : String(result.plan?.backgrounds?.[0]?.prompt || ""));
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
    // 出图期间用户可能换类型/换基底，所以这一刻也定格。
    const tier = baseTier;
    // 参考图同样定格：背景风格模板（模仿风格）+ IP 人像（二类同一张脸、三类换表情）。
    // ⚠️ 以前读的是页面上的一个临时上传（`referenceDataUrl`），那个入口删掉后就恒为空 ——
    //    等于「参考图编辑」这条链静默失效。现在改为读封面基底，跟着类型走。
    const generationRefs = [baseBackgroundTemplate, basePortraitImage]
      .filter(Boolean)
      .map(item => ({ url: item?.url || "", dataUrl: item?.dataUrl || "" }))
      .filter(item => item.url || item.dataUrl);
    setCoverImageLoading(title || prompt.slice(0, 20));
    setError("");
    try {
      const result = await generateCoverImage({
        prompt,
        referenceImages: generationRefs,
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
          tier,
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

  /**
   * 取候选标题的字号（后端算 —— 规则只在一处，§6.3⑬ 同一条纪律）。
   * 一次把「这条选题的标题 + 复用的标题 + 已出过的候选标题」都问掉，避免逐字请求。
   */
  const loadTitleMetrics = useCallback(async (extraTitles: string[]) => {
    const style = activeSelection?.cover?.titleStyle || baseTitleStyle;
    if (!style) return;
    const titles = Array.from(new Set([
      String(activeTopic?.title || "").trim(),
      ...extraTitles.map(item => String(item || "").trim()),
    ].filter(Boolean))).slice(0, 12);
    if (titles.length === 0) return;
    try {
      const result = await requestCoverTitleMetrics({ titles, titleStyle: style });
      setTitleMetrics(Array.isArray(result?.items) ? result.items : []);
    } catch {
      // 算不出来只是预览字号不准，不该打断出封面这条主流程。
      setTitleMetrics([]);
    }
  }, [activeSelection, baseTitleStyle, activeTopic]);

  /**
   * 一类的「出封面」**不调出图**：模板（固定人像 + 固定背景）已经在基底里确认好了，
   * 这一期只换标题文字 —— 文字由前端按标题样式叠加，所以这一步不花钱，也就没有
   * 「确认提示词再出图」那道闸门。
   */
  const makeStandardCover = async (title: string) => {
    const template = baseBackgroundTemplate || baseSourceImage;
    if (!template) {
      setError("请先在「封面基底」上传固定封面模板");
      return;
    }
    const text = title.trim();
    if (!text) {
      setError("标题不能为空");
      return;
    }
    const topicId = activeTopicId;
    const baseSel = activeSelection;
    const existing = baseSel?.cover?.candidates || [];
    // 同一模板下换个标题就是新的一条候选；标题相同则替换（不堆重复项）。
    const id = `std-${text}`.slice(0, 80);
    const candidates = [
      ...existing.filter(item => item.id !== id),
      { id, title: text, keywords: [], prompt: "", image: template, tier: baseTier },
    ];
    try {
      await persist(topicId, {
        cover: { selectedId: id, candidates, titleStyle: baseTitleStyle },
        publishCopy: baseSel?.publishCopy || null,
        topicTags: baseSel?.topicTags || null,
      });
      setMessage(`已生成封面「${text}」（模板 + 标题，未调用出图）`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "生成封面失败");
    }
  };

  /** 把标题以选定的样式叠加到封面上（纯 CSS，不依赖后端出字——模型写字会写成乱码）。 */
  const coverTitleStyle = activeSelection?.cover?.titleStyle || coverPlan?.titleStyle || baseTitleStyle;
  const overlayTitle = String(reuseTitles[0] || activeTopic?.title || "").trim();

  /**
   * 候选封面上的文字。
   *
   * 一类（标准模板）的候选**本身就是某一期的标题**，所以直接用它；
   * 二/三类的候选是生成图，`title` 只是「封面 N」这样的标签，文字用这条选题的标题。
   */
  const overlayTextFor = (candidate: CoverCandidate) => (
    String(candidate.tier || "") === "standard" && candidate.title ? candidate.title : overlayTitle
  );

  /** 后端算好的字号（取不到就退回模板基准，保持预览可读）。 */
  const fontSizeFor = (text: string) => {
    const hit = titleMetrics.find(item => item.title === text);
    return hit?.fontSizePx || coverTitleStyle?.fontSizePx || 48;
  };

  // 切选题 / 换基底 / 换类型后，重新问一次字号，并同步逐条的标题草稿。
  useEffect(() => {
    setPerTopicTitle(String(activeTopic?.title || reuseTitles[0] || "").trim());
    setPerTopicBackgroundPrompt("");
    setPerTopicExpression("");
    const style = activeSelection?.cover?.titleStyle || baseTitleStyle;
    if (!style) {
      setTitleMetrics([]);
      return;
    }
    loadTitleMetrics([
      ...reuseTitles,
      ...(activeSelection?.cover?.candidates || []).map(item => item.title),
    ]);
  }, [activeTopic?.id, reuseTitles, baseTitleStyle, activeSelection, loadTitleMetrics]);

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
          /* 3.1 内部按**资产生命周期**分两层：基底是账号级（一次确认、长期复用），
             每条只做这一类需要的最小动作。用左侧描边表达层级（与账号定位页同一套约定）。 */
          <div className="space-y-4 border-l-2 border-slate-200 pl-4 sm:pl-5">
            <div className="flex flex-wrap gap-2">
              {[
                { id: "base" as const, label: "① 封面基底（账号级）", hint: "类型 / 人像 / 背景模板 / 标题样式" },
                { id: "perTopic" as const, label: "② 每条出封面", hint: "只做这一类需要的最小动作" },
              ].map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setCoverSubTab(item.id)}
                  className={`rounded-xl border px-4 py-2.5 text-left text-sm transition ${
                    coverSubTab === item.id ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className={`font-semibold ${coverSubTab === item.id ? "text-blue-700" : "text-slate-800"}`}>{item.label}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{item.hint}</div>
                </button>
              ))}
            </div>

            {coverSubTab === "base" ? (
              <div className="space-y-4">
                {/* 第一步：选类型 —— 它决定后面要准备什么、每条要走几步 */}
                <Card className="border-slate-200 bg-white">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base font-semibold text-slate-900">第一步 · 选封面类型</CardTitle>
                      {coverBaseLoading && <span className="text-xs text-slate-400">读取上次的基底…</span>}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs leading-5 text-slate-500">
                      三类的区别是「用不用那两个可复用的 Agent」：
                      <span className="font-medium text-slate-700">一类都不用，二类只用个性化背景，三类两个都用</span>。
                      类型决定每条选题要做几步，所以先定它。
                    </p>
                    {coverTiers.map(tier => {
                      const selected = baseTier === tier.id;
                      return (
                        <button
                          key={tier.id}
                          type="button"
                          onClick={() => setBaseTier(tier.id)}
                          className={`block w-full rounded-xl border px-4 py-3 text-left transition ${
                            selected ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`text-sm font-semibold ${selected ? "text-blue-700" : "text-slate-800"}`}>
                              {tier.code}、{tier.label}
                            </span>
                            <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">{tier.summary}</Badge>
                            {selected && <Badge className="bg-blue-50 text-blue-600 hover:bg-blue-50">当前</Badge>}
                          </div>
                          <div className="mt-1.5 text-xs leading-5 text-slate-500">{tier.note}</div>
                          <div className="mt-1 text-xs text-slate-400">使用节点：{tier.whenToUse}</div>
                        </button>
                      );
                    })}
                    {coverTiers.length === 0 && (
                      <p className="text-xs text-slate-400">类型定义没读到，先检查接口是否可用再刷新。</p>
                    )}
                  </CardContent>
                </Card>

                {/* 第二步：按类型准备素材 */}
                <Card className="border-slate-200 bg-white">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-base font-semibold text-slate-900">第二步 · 准备这类要用的素材</CardTitle>
                      <div className="flex flex-wrap items-center gap-2">
                        {activeTier?.needsPortrait && <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">需要 IP 人像</Badge>}
                        {activeTier?.needsBackgroundTemplate && <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">需要背景模板</Badge>}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {/* 一类：一张固定封面模板（人像与背景都在图里），之后只换标题 */}
                    {activeTier && !activeTier.needsPortrait && !activeTier.needsBackgroundTemplate && (
                      <div>
                        <div className="text-xs font-semibold text-slate-600">固定封面模板（含固定人像与背景）</div>
                        <p className="mt-1 text-xs leading-5 text-slate-500">
                          上传一张已经做好的模板图。之后每一期只换标题文字，字号会按标题长度自动调整。
                        </p>
                        <input
                          type="file"
                          accept="image/*"
                          className="mt-2 block w-full text-xs text-slate-500"
                          onChange={event => handleBaseImageUpload(event.target.files?.[0] || null, setBaseSourceImage)}
                        />
                        {(baseBackgroundTemplate || baseSourceImage) && (
                          <img
                            src={(baseBackgroundTemplate || baseSourceImage)?.url || (baseBackgroundTemplate || baseSourceImage)?.dataUrl}
                            alt="固定封面模板"
                            className="mt-3 w-full max-w-[220px] rounded-lg border border-slate-200 object-cover"
                          />
                        )}
                      </div>
                    )}

                    {/* 二 / 三类：上传对标封面 → 拆解 → 生成背景风格模板 */}
                    {activeTier?.needsBackgroundTemplate && (
                      <div className="space-y-3">
                        <div className="text-xs font-semibold text-slate-600">对标封面（用于拆解出背景风格模板）</div>
                        <input
                          type="file"
                          accept="image/*"
                          className="block w-full text-xs text-slate-500"
                          onChange={event => handleBaseImageUpload(event.target.files?.[0] || null, image => {
                            setBaseSourceImage(image);
                            setBaseAnalysis(null);
                          })}
                        />
                        {baseSourceImage && (
                          <img
                            src={baseSourceImage.url || baseSourceImage.dataUrl}
                            alt="对标封面"
                            className="w-full max-w-[220px] rounded-lg border border-slate-200 object-cover"
                          />
                        )}
                        <Button
                          variant="outline"
                          disabled={analysisLoading || !baseSourceImage}
                          onClick={runCoverAnalysis}
                        >
                          {analysisLoading ? "拆解中…" : baseAnalysis ? "重新拆解" : "拆解这张对标封面"}
                        </Button>

                        {baseAnalysis && (
                          <div className="space-y-2 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
                            {[
                              ["画风", baseAnalysis.artStyle],
                              ["元素", baseAnalysis.elements],
                              ["排版", baseAnalysis.layout],
                              ["视觉风格", baseAnalysis.visualStyle],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <span className="font-semibold text-slate-700">{label}</span>
                                ：{value || "待人工补充"}
                              </div>
                            ))}
                            <div>
                              <span className="font-semibold text-slate-700">留白区域</span>
                              ：{baseAnalysis.reservedAreas.length > 0 ? baseAnalysis.reservedAreas.join("；") : "待人工补充"}
                            </div>
                          </div>
                        )}

                        <div>
                          <label className="text-xs font-semibold text-slate-600">背景模板提示词（可改，确认后再出图）</label>
                          <textarea
                            value={baseBackgroundPrompt}
                            onChange={event => setBaseBackgroundPrompt(event.target.value)}
                            rows={4}
                            placeholder="先拆解对标封面，会自动填入一份可改的提示词；也可以直接写"
                            className="mt-1.5 w-full rounded-xl border border-slate-300 p-3 text-xs leading-5"
                          />
                        </div>
                        <Button
                          className="h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                          disabled={baseImageLoading === "backgroundTemplate" || !baseBackgroundPrompt.trim()}
                          onClick={() => makeBaseImage("backgroundTemplate")}
                        >
                          {baseImageLoading === "backgroundTemplate" ? "出图中…（较慢）" : "确认提示词并生成背景模板"}
                        </Button>
                        {baseBackgroundTemplate && (
                          <img
                            src={baseBackgroundTemplate.url || baseBackgroundTemplate.dataUrl}
                            alt="背景风格模板"
                            className="w-full max-w-[220px] rounded-lg border border-slate-200 object-cover"
                          />
                        )}
                      </div>
                    )}

                    {/* 二 / 三类：IP 人像（三类可由 Agent 生成；二类沿用固定的一张） */}
                    {activeTier?.needsPortrait && (
                      <div className="space-y-3 border-t border-slate-100 pt-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="text-xs font-semibold text-slate-600">IP 人像</div>
                          {activeTier.canGeneratePortrait
                            ? <Badge className="bg-blue-50 text-blue-600 hover:bg-blue-50">这一类会用 IP 形象照 Agent</Badge>
                            : <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">这一类沿用固定的那一张</Badge>}
                        </div>
                        <p className="text-xs leading-5 text-slate-500">
                          {activeTier.canGeneratePortrait
                            ? "先给出提示词建议（穿着/场景来自内容定位、表情动作来自人设定位），人工改过之后再结合客户参考照片出图。"
                            : "这一类不重跑形象照 Agent，直接用一张已有的固定人像：可以上传，也可以沿用之前生成的。"}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" disabled={portraitLoading} onClick={runPortraitPlan}>
                            {portraitLoading ? "生成中…" : "给出形象照提示词建议"}
                          </Button>
                          <label className="inline-flex cursor-pointer items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 hover:border-slate-300">
                            上传参考照片
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={event => handleBaseImageUpload(event.target.files?.[0] || null, setBasePortraitImage)}
                            />
                          </label>
                        </div>
                        {basePortraitBasis && <div className="text-xs text-slate-400">依据：{basePortraitBasis}</div>}
                        <div>
                          <label className="text-xs font-semibold text-slate-600">形象照提示词（可改，确认后再出图）</label>
                          <textarea
                            value={basePortraitPrompt}
                            onChange={event => setBasePortraitPrompt(event.target.value)}
                            rows={3}
                            placeholder="先点「给出形象照提示词建议」，或直接写"
                            className="mt-1.5 w-full rounded-xl border border-slate-300 p-3 text-xs leading-5"
                          />
                        </div>
                        <Button
                          className="h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                          disabled={baseImageLoading === "portrait" || !basePortraitPrompt.trim()}
                          onClick={() => makeBaseImage("portrait")}
                        >
                          {baseImageLoading === "portrait" ? "出图中…（较慢）" : "确认提示词并生成 IP 形象照"}
                        </Button>
                        {basePortraitImage && (
                          <img
                            src={basePortraitImage.url || basePortraitImage.dataUrl}
                            alt="IP 人像"
                            className="w-full max-w-[180px] rounded-lg border border-slate-200 object-cover"
                          />
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* 第三步：标题样式模板（三类共用；字号是模板参数，逐条由后端现算） */}
                <Card className="border-slate-200 bg-white">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-semibold text-slate-900">第三步 · 标题样式模板</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs leading-5 text-slate-500">
                      三类共用：风格（字体 / 颜色 / 位置）锁在这里，保证每期一致；
                      字号只给基准与下限，<span className="font-medium text-slate-700">每期按标题长度自动收缩</span>，最多占几行也在这里定。
                    </p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <label className="block text-xs font-medium text-slate-600">
                        字体
                        <input
                          value={baseTitleStyle?.fontFamily || ""}
                          onChange={event => setBaseTitleStyle(prev => ({ ...(prev || emptyTitleStyle()), fontFamily: event.target.value }))}
                          placeholder="例如 粗黑体"
                          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-600">
                        颜色
                        <input
                          value={baseTitleStyle?.color || ""}
                          onChange={event => setBaseTitleStyle(prev => ({ ...(prev || emptyTitleStyle()), color: event.target.value }))}
                          placeholder="例如 #ffffff"
                          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-600">
                        位置
                        <select
                          value={baseTitleStyle?.position || "bottom"}
                          onChange={event => setBaseTitleStyle(prev => ({ ...(prev || emptyTitleStyle()), position: event.target.value }))}
                          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                        >
                          <option value="top">上</option>
                          <option value="center">中</option>
                          <option value="bottom">下</option>
                        </select>
                      </label>
                      <label className="block text-xs font-medium text-slate-600">
                        基准字号（px）
                        <input
                          type="number"
                          value={baseTitleStyle?.fontSizePx ?? 64}
                          onChange={event => setBaseTitleStyle(prev => ({ ...(prev || emptyTitleStyle()), fontSizePx: Number(event.target.value) || 0 }))}
                          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-600">
                        最小字号（px）
                        <input
                          type="number"
                          value={baseTitleStyle?.minFontSizePx ?? 36}
                          onChange={event => setBaseTitleStyle(prev => ({ ...(prev || emptyTitleStyle()), minFontSizePx: Number(event.target.value) || 0 }))}
                          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                        />
                      </label>
                      <label className="block text-xs font-medium text-slate-600">
                        最多行数
                        <input
                          type="number"
                          value={baseTitleStyle?.maxLines ?? 2}
                          onChange={event => setBaseTitleStyle(prev => ({ ...(prev || emptyTitleStyle()), maxLines: Number(event.target.value) || 0 }))}
                          className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        className="bg-blue-600 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                        disabled={coverBaseSaving}
                        onClick={() => persistCoverBase()}
                      >
                        {coverBaseSaving ? "保存中…" : "保存封面基底"}
                      </Button>
                      <Button variant="outline" disabled={coverBaseSaving} onClick={clearCoverBase}>
                        清空重来
                      </Button>
                      {coverBase?.updatedAt && (
                        <span className="self-center text-xs text-slate-400">
                          上次保存：{formatMetTime(coverBase.updatedAt)}
                        </span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : (
              <div className="space-y-4">
                {/* 就绪检查：缺什么就明说缺哪一步，并把出口指回基底页 */}
                <Card className="border-slate-200 bg-white">
                  <CardContent className="pt-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-800">
                        {activeTier ? `${activeTier.code}、${activeTier.label}` : "未选类型"}
                      </span>
                      {activeTier && <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">{activeTier.summary}</Badge>}
                      {coverReadiness.ok
                        ? <Badge className="bg-emerald-50 text-emerald-600 hover:bg-emerald-50">基底就绪</Badge>
                        : <Badge className="bg-amber-50 text-amber-700 hover:bg-amber-50">还缺：{coverReadiness.missing.join("、")}</Badge>}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500">{activeTier?.note || "请先在「封面基底」选好类型。"}</p>
                    {!coverReadiness.ok && (
                      <Button variant="outline" className="mt-3" onClick={() => setCoverSubTab("base")}>
                        去封面基底补齐
                      </Button>
                    )}
                  </CardContent>
                </Card>

                {/* 标题（三类都要；一类这就是唯一的动作） */}
                <Card className="border-slate-200 bg-white">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base font-semibold text-slate-900">这一期的标题</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <input
                      value={perTopicTitle}
                      onChange={event => setPerTopicTitle(event.target.value)}
                      placeholder="这一期要用的标题"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                    />
                    {reuseTitles.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {reuseTitles.map(item => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => setPerTopicTitle(item)}
                            className={`max-w-[260px] truncate rounded-lg border px-3 py-1.5 text-xs transition ${
                              perTopicTitle === item ? "border-blue-400 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                            }`}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-slate-500">
                      字号由后端按长度与留白空间算：
                      <span className="font-medium text-slate-800">{fontSizeFor(perTopicTitle)}px</span>
                      {titleMetrics.find(item => item.title === perTopicTitle)?.shrunk && "（已按长度收缩）"}
                    </div>
                  </CardContent>
                </Card>

                {/* 背景提示词（二 / 三类每期都要） */}
                {activeTier?.perIssueFields.includes("backgroundPrompt") && (
                  <Card className="border-slate-200 bg-white">
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle className="text-base font-semibold text-slate-900">这一期的背景</CardTitle>
                        <Button variant="outline" disabled={coverLoading || !activeTopic} onClick={loadCoverPlan}>
                          {coverLoading ? "生成中…" : "按脚本给提示词建议"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs leading-5 text-slate-500">
                        围绕这一期脚本的关键词生成个性化背景，关键词元素要在背景中体现。
                      </p>
                      <textarea
                        value={perTopicBackgroundPrompt}
                        onChange={event => setPerTopicBackgroundPrompt(event.target.value)}
                        rows={4}
                        placeholder="先点右上角按脚本生成候选提示词，再挑一个改；也可以直接写"
                        className="w-full rounded-xl border border-slate-300 p-3 text-xs leading-5"
                      />
                      {(coverPlan?.backgrounds || []).length > 0 && (
                        <div className="space-y-2">
                          {(coverPlan?.backgrounds || []).map(background => (
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
                              <Button variant="outline" className="shrink-0 text-xs" onClick={() => setPerTopicBackgroundPrompt(background.prompt)}>
                                用这个
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* 人像表情（三类才有） */}
                {activeTier?.perIssueFields.includes("portraitExpression") && (
                  <Card className="border-slate-200 bg-white">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base font-semibold text-slate-900">这一期的人像表情 / 动作</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <p className="text-xs leading-5 text-slate-500">
                        以基底里的 IP 形象照为参考图，结合这一期脚本生成适配的表情。
                      </p>
                      <input
                        value={perTopicExpression}
                        onChange={event => setPerTopicExpression(event.target.value)}
                        placeholder="例如 惊讶并竖起一根手指"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
                      />
                    </CardContent>
                  </Card>
                )}

                {/* 出封面：一类不花钱（模板 + 叠字），二/三类走唯一花钱的出图 */}
                <Card className="border-slate-200 bg-white">
                  <CardContent className="space-y-3 pt-6">
                    <Button
                      className="h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                      disabled={!coverReadiness.ok || Boolean(coverImageLoading) || !perTopicTitle.trim()}
                      onClick={() => {
                        if (activeTier?.id === "standard") {
                          makeStandardCover(perTopicTitle);
                          return;
                        }
                        // 二 / 三类：把基底 + 这一期的变量合成一条出图提示词，交到确认出图那条链路。
                        const parts = [
                          perTopicBackgroundPrompt.trim(),
                          perTopicExpression.trim() ? `人物表情与动作：${perTopicExpression.trim()}` : "",
                          "竖版 3:4 封面，不要写任何文字（标题由前端叠加）。",
                        ].filter(Boolean);
                        makeCoverImage(parts.join("\n"), `封面 ${coverCandidates.length + 1}`, []);
                      }}
                    >
                      {activeTier?.id === "standard"
                        ? "生成封面（模板 + 标题，不调用出图）"
                        : (coverImageLoading ? "出图中…（较慢）" : "确认提示词并生成封面")}
                    </Button>
                    {!coverReadiness.ok && (
                      <p className="text-xs leading-5 text-amber-700">
                        还缺 {coverReadiness.missing.join("、")} —— 先在「封面基底」补齐再出封面。
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* 候选与标题叠加 */}
                <Card className="border-slate-200 bg-white">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-semibold text-slate-900">
                      封面候选与标题叠加（{coverCandidates.length}）
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {coverCandidates.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
                        还没有封面。按上面的类型补齐素材后生成。
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3">
                        {coverCandidates.map(candidate => {
                          const src = candidate.image?.dataUrl || candidate.image?.url || "";
                          const isSelected = candidate.id === selectedCoverId;
                          const label = overlayTextFor(candidate);
                          const candidateTier = coverTiers.find(item => item.id === String(candidate.tier || ""));
                          return (
                            <div
                              key={candidate.id}
                              className={`overflow-hidden rounded-xl border transition ${isSelected ? "border-blue-400 ring-2 ring-blue-200" : "border-slate-200"}`}
                            >
                              <button
                                type="button"
                                className="relative block w-full"
                                onClick={() => persist(activeTopicId, {
                                  cover: { selectedId: candidate.id, candidates: coverCandidates, titleStyle: coverTitleStyle || null },
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
                                {label && (
                                  <span
                                    className={`absolute inset-x-0 px-2 text-center font-bold leading-tight drop-shadow ${
                                      coverTitleStyle?.position === "top" ? "top-2" : coverTitleStyle?.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-2"
                                    }`}
                                    style={{
                                      color: coverTitleStyle?.color || "#ffffff",
                                      // ⚠️ 用后端算好的**数字**字号：模板里的 fontSizePx 是数字，
                                      //    早期直接拿模型给的自由文本当 CSS 值，浏览器会静默丢掉。
                                      fontSize: `${fontSizeFor(label)}px`,
                                    }}
                                  >
                                    {label}
                                  </span>
                                )}
                              </button>
                              <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-2">
                                <span className="truncate text-xs text-slate-600">{candidate.title}</span>
                                <div className="flex shrink-0 items-center gap-1">
                                  {/* 换类型后旧封面仍保留，标出它当时是哪一类 */}
                                  {candidateTier && <Badge className="bg-slate-100 text-slate-500 hover:bg-slate-100">{candidateTier.code}类</Badge>}
                                  {isSelected && <Badge className="bg-blue-50 text-blue-600 hover:bg-blue-50">已选</Badge>}
                                </div>
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
