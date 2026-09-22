/**
 * 近期开更新选题：在已存在的账号分类报告上，给新视频补充完整脚本和分类标签。
 *
 * 词典来自**正式选题库**（客户级，`topicLibraryStore` 的 `buildTagDictionary`），
 * 分类 id 已带账号作用域。这里不写库，只产出打标签结果。
 */

export const TOPIC_REFRESH_MAX_VIDEOS = 60;
export const TOPIC_REFRESH_MAX_CATEGORIES = 40;
export const TOPIC_REFRESH_MAX_SUBCATEGORIES = 80;

/**
 * 点赞门槛是**业务规则，不是调用方参数**：`likes > 100`，100 不达标。
 *
 * 用户口径明确（HANDOFF §0.1），所以这里做成**下界**而不是默认值 ——
 * 否则调用方传 `minLikes: 0` 就能把 1 个赞的视频放进打标签流程，
 * 而这个规则会**静默失效**（前端硬编码 100、后端默认 100 都只是「约定」，拦不住）。
 */
export const TOPIC_REFRESH_MIN_LIKES = 100;

/** 把调用方给的门槛夹到合法区间：永远不允许低于业务下界。 */
export const resolveMinLikes = value => Math.max(TOPIC_REFRESH_MIN_LIKES, asNumber(value));

/**
 * 候选视频被全部过滤掉时，**说清楚为什么**。
 *
 * 原来这里只回一句「没有满足筛选条件的可分析视频」—— 调用方（前端）拿到的信息量为零，
 * 只能靠猜：是标题为空？链接没拿到？还是点赞没过门槛？2026-09-21 排查「提取脚本 400」
 * 时为此绕了很久。所以把逐项计数一并回出去，下次一眼就能定位。
 */
export const describeTopicRefreshVideoDrop = (rawVideos, minLikes) => {
  const list = Array.isArray(rawVideos) ? rawVideos : [];
  const threshold = resolveMinLikes(minLikes);
  let missingLink = 0;
  let belowLikes = 0;
  for (const raw of list) {
    const source = raw && typeof raw === "object" ? raw : {};
    if (!cleanText(source.link || source.shareLink)) missingLink += 1;
    const likes = normalizeStats(source.stats || source.statistics).likes;
    if (!(likes > threshold)) belowLikes += 1;
  }
  // 只有「缺链接」「点赞不过门槛」是真拦路虎；标题为空**不影响**（见上面的 filter 注释）。
  const reasons = [
    missingLink ? `缺少作品链接 ${missingLink} 条` : "",
    belowLikes ? `点赞未超过 ${threshold} 的 ${belowLikes} 条` : "",
  ].filter(Boolean);
  return `收到 ${list.length} 条候选，没有一条能进入分析：${reasons.length ? reasons.join("、") : "字段形状不符合要求"}。`;
};

const asText = value => String(value ?? "").trim();

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const normalizePlatform = value => asText(value).toLowerCase() === "tiktok" ? "tiktok" : "douyin";

const normalizeId = (value, fallback) => cleanText(value, 160) || fallback;

const normalizeStats = stats => ({
  likes: asNumber(stats?.likes ?? stats?.digg_count ?? stats?.like_count),
  comments: asNumber(stats?.comments ?? stats?.comment_count),
  shares: asNumber(stats?.shares ?? stats?.share_count),
  bookmarks: asNumber(stats?.bookmarks ?? stats?.collect_count ?? stats?.favorite_count),
});

const normalizeSubcategory = (subcategory, categoryIndex, subIndex) => {
  const source = subcategory && typeof subcategory === "object" ? subcategory : {};
  const id = normalizeId(source.id, `subcategory-${categoryIndex + 1}-${subIndex + 1}`);
  return {
    id,
    name: cleanText(source.name, 120),
    description: cleanText(source.description, 360),
    topics: Array.isArray(source.topics) ? source.topics.length : asNumber(source.topicCount),
  };
};

/** 把 2.1 / 1.2 报告里的分类树压成 Agent 需要的只读词典。 */
export const normalizeTopicLibrary = categories => (
  (Array.isArray(categories) ? categories : [])
    .slice(0, TOPIC_REFRESH_MAX_CATEGORIES)
    .map((category, categoryIndex) => {
      const source = category && typeof category === "object" ? category : {};
      const subcategories = (Array.isArray(source.subcategories) ? source.subcategories : [])
        .slice(0, TOPIC_REFRESH_MAX_SUBCATEGORIES)
        .map((item, subIndex) => normalizeSubcategory(item, categoryIndex, subIndex))
        .filter(item => item.name);
      return {
        id: normalizeId(source.id, `category-${categoryIndex + 1}`),
        name: cleanText(source.name, 120),
        coreFunction: cleanText(source.coreFunction, 500),
        keywords: Array.isArray(source.keywords)
          ? source.keywords.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 20)
          : [],
        subcategories,
      };
    })
    .filter(category => category.name && category.subcategories.length > 0)
);

/** 后端重新归一化前端视频，避免把任意字段原样送给 Agent。 */
export const normalizeTopicRefreshVideos = (videos, options = {}) => {
  const minLikes = resolveMinLikes(options.minLikes);
  const maxVideos = Math.max(1, Math.min(TOPIC_REFRESH_MAX_VIDEOS, asNumber(options.maxVideos) || TOPIC_REFRESH_MAX_VIDEOS));
  return (Array.isArray(videos) ? videos : [])
    .map((video, index) => {
      const source = video && typeof video === "object" ? video : {};
      const id = normalizeId(source.id || source.videoId, `refresh-${index + 1}`);
      const stats = normalizeStats(source.stats || source.statistics);
      return {
        id,
        title: cleanText(source.title, 240),
        link: cleanText(source.link || source.shareLink, 1000),
        authorName: cleanText(source.authorName, 120),
        publishDate: cleanText(source.publishDate, 40),
        sourceText: cleanText(source.sourceText || source.desc, 900),
        platform: normalizePlatform(source.platform),
        stats,
      };
    })
    // ⚠️ 门槛是**严格大于**（用户口径 `likes > 100`：100 不达标）。
    // 写成 `>=` 会让刚好 100 赞的视频混进来。点赞缺失归一化成 0，不会被误放行。
    // ⚠️ **不要求标题**：抖音允许「无描述发布」，前端 `isAnalysableRawVideo` 也刻意放行了
    // 这类作品（它的注释写得很清楚：「有文案」不是必要条件）。原来这里卡 `video.title`，
    // 于是「明明抓到了视频、也能转写」，却被后端静默丢光 → 回一句
    // 「没有满足筛选条件的可分析视频」，用户完全看不出问题在哪。
    // 标题只是给打标签当上下文，缺了不影响提取脚本，界面也早有「（无标题）」兜底。
    .filter(video => video.id && video.link && video.stats.likes > minLikes)
    .slice(0, maxVideos);
};

const transcriptFor = (transcripts, videoId) => {
  if (transcripts instanceof Map) return cleanText(transcripts.get(videoId)?.text, 12_000);
  if (transcripts && typeof transcripts === "object") return cleanText(transcripts[videoId]?.text || transcripts[videoId], 12_000);
  return "";
};

/** id → 分类/小类 的查表。id 是**唯一权威**的匹配方式。 */
const categoryById = categories => new Map(
  (Array.isArray(categories) ? categories : []).map(category => [asText(category?.id), category]),
);
const subcategoryById = category => new Map(
  (Array.isArray(category?.subcategories) ? category.subcategories : []).map(item => [asText(item?.id), item]),
);

// ── 短别名协议（2026-09-21）──────────────────────────────────────────────────
//
// 🔴 为什么要它：词典里的分类 id 带**账号作用域**，实测长约 200 字符
// （`url-https://www.douyin.com/user/MS4wLjABAAAA…::cat-1`）。提示词原来要求模型
// **原样回抄这个 id**，结果既贵又不可靠：一次实测 30 条里 **29 条的 id 抄错**
// （抄错的会被名称兜底救回一部分，救不回就静默落「待人工复核」）；
// 而且模型要把这串 id 写进每一条输出里，光输出就多烧几千个 token（更慢）。
//
// 现在改成：提示词里给大类编 `c1/c2/…`、小类在各自大类内编 `s1/s2/…`，
// 模型只回短代号，**后端按位置映射回真实 id**。代号是**按归一化后的顺序**生成的，
// 同一份词典永远得到同一套代号，所以发送端（buildBenchmarkTopicRefreshInput）
// 和解析端（resolveTagging）各自算一遍就能对上，不需要额外传递映射表。
//
// 保留旧的 id / 名称解析作为兜底：模型偶尔会「自作主张」回旧格式，
// 能把它对上就对上，对不上（同名歧义）才落「待人工复核」。
export const categoryCode = index => `c${index + 1}`;
export const subcategoryCode = index => `s${index + 1}`;

/** 代号 → 条目 的查表（按归一化顺序生成，与发送端一致）。 */
const categoryByCode = categories => new Map(
  (Array.isArray(categories) ? categories : []).map((category, index) => [categoryCode(index), category]),
);
const subcategoryByCode = category => new Map(
  (Array.isArray(category?.subcategories) ? category.subcategories : [])
    .map((item, index) => [subcategoryCode(index), item]),
);

/**
 * 解析模型给的大类。
 *
 * 优先**短代号**（`c1`）；再退到 id（唯一，带账号作用域）；最后才是名称 ——
 * 而名称在多个对标账号之间会重复（这正是「不合并」的后果），
 * 所以**只有唯一命中时才敢用**：模型回一个裸名字时若直接 `find()`，
 * 会静默绑到第一个同名账号，打错账号还不报错。命中多个同名一律算「无法稳定对应」。
 */
const resolveCategory = (categories, value) => {
  const text = asText(value);
  if (!text) return null;
  const byCode = categoryByCode(categories);
  if (byCode.has(text)) return byCode.get(text);
  const byId = categoryById(categories);
  if (byId.has(text)) return byId.get(text);
  const byName = (Array.isArray(categories) ? categories : []).filter(category => asText(category?.name) === text);
  return byName.length === 1 ? byName[0] : null;
};

/** 解析模型给的小类。优先短代号，其次 id，最后唯一同名。 */
const resolveSubcategory = (category, value) => {
  const text = asText(value);
  if (!text || !category) return null;
  const byCode = subcategoryByCode(category);
  if (byCode.has(text)) return byCode.get(text);
  const byId = subcategoryById(category);
  if (byId.has(text)) return byId.get(text);
  const byName = (Array.isArray(category.subcategories) ? category.subcategories : [])
    .filter(item => asText(item?.name) === text);
  return byName.length === 1 ? byName[0] : null;
};

const normalizeConfidence = value => {
  const text = asText(value).toLowerCase();
  return ["high", "medium", "low"].includes(text) ? text : "low";
};

const REVIEW_NAME = "待人工复核";

/** 归类结果：`hasValidTag` 决定用真实分类还是落待人工复核。 */
const resolveTagging = (categories, raw) => {
  // 短代号优先；旧格式（长 id / 名称）作为兜底一并接受。
  const category = resolveCategory(categories, raw?.categoryCode || raw?.categoryId || raw?.categoryName);
  const subcategory = resolveSubcategory(category, raw?.subcategoryCode || raw?.subcategoryId || raw?.subcategoryName);
  return { category, subcategory, hasValidTag: Boolean(category && subcategory) };
};

/**
 * 只接受分类词典里真实存在的大类/小类（按 id）。Agent 自造的分类、以及跨账号同名
 * 无法分辨的分类，都会落到待人工复核，不把模型输出直接当成账号选题库的一部分。
 */
export const normalizeBenchmarkTopicRefresh = ({ videos, categories, transcripts, agentOutput, recentDays = 7, minLikes = 100 } = {}) => {
  const normalizedVideos = normalizeTopicRefreshVideos(videos, { minLikes });
  const topicLibrary = normalizeTopicLibrary(categories);
  const rawItems = Array.isArray(agentOutput?.items) ? agentOutput.items : [];
  const byVideoId = new Map(rawItems.map(item => [asText(item?.videoId), item]));

  const items = normalizedVideos.map(video => {
    const raw = byVideoId.get(video.id) || {};
    const { category, subcategory, hasValidTag } = resolveTagging(topicLibrary, raw);
    const transcript = transcriptFor(transcripts, video.id);
    const script = transcript || video.sourceText;
    const scriptSource = transcript ? "transcript" : "caption";
    const modelConfidence = normalizeConfidence(raw.confidence);
    // 没有真实转写时，判断依据只是发布文案 —— 置信度不许继承模型的 high。
    // 提示词里本来就写了这条，但提示词管不住模型，必须在归一化里兜住。
    const confidence = !hasValidTag ? "low" : (scriptSource === "caption" ? "low" : modelConfidence);
    return {
      video,
      script,
      scriptSource,
      category: hasValidTag ? { id: category.id, name: category.name } : { id: "review", name: REVIEW_NAME },
      subcategory: hasValidTag ? { id: subcategory.id, name: subcategory.name } : { id: "review", name: REVIEW_NAME },
      confidence,
      basis: cleanText(raw.basis || raw.reason, 500)
        || (hasValidTag
          ? (scriptSource === "caption" ? "只有发布文案、没有真实转写，依据不足，待人工复核" : "依据视频脚本与账号选题库分类判断")
          : "模型未能与现有选题库的大类/小类稳定对应"),
    };
  });

  return {
    version: "1.0",
    reportType: "benchmark_topic_refresh",
    recentDays: asNumber(recentDays) || 7,
    minLikes: resolveMinLikes(minLikes),
    analyzedCount: items.length,
    transcriptCount: items.filter(item => item.scriptSource === "transcript").length,
    captionFallbackCount: items.filter(item => item.scriptSource === "caption").length,
    categories: topicLibrary,
    items,
    analysisSource: "agent",
    warnings: [],
    analyzedAt: new Date().toISOString(),
  };
};

const searchableText = (video, transcript) => [video?.title, video?.sourceText, transcript].map(asText).filter(Boolean).join(" ").toLowerCase();

/** Agent 不可用时的可人工复核兜底：只用已有分类名称/关键词，不发明标签。 */
export const buildHeuristicBenchmarkTopicRefresh = ({ videos, categories, transcripts, recentDays = 7, minLikes = 100 } = {}) => {
  const normalizedVideos = normalizeTopicRefreshVideos(videos, { minLikes });
  const topicLibrary = normalizeTopicLibrary(categories);
  // 同名分类在多个账号之间会重复（「不合并」的后果）。同名超过一个时**不猜**，
  // 否则 `find()` 会静默绑到第一个账号 —— 与 Agent 路径同一个坑，兜底同样要躲开。
  const uniqueByName = (list, name) => {
    const key = asText(name).toLowerCase();
    if (!key) return null;
    const hits = (Array.isArray(list) ? list : []).filter(item => asText(item?.name).toLowerCase() === key);
    return hits.length === 1 ? hits[0] : null;
  };
  const agentItems = normalizedVideos.map(video => {
    const text = searchableText(video, transcriptFor(transcripts, video.id));
    // 先按关键词命中（依据更强），命中不唯一时退回「分类名唯一」的消歧。
    const byKeyword = topicLibrary.filter(item =>
      item.keywords.some(keyword => keyword && text.includes(asText(keyword).toLowerCase())));
    let category = byKeyword.length === 1 ? byKeyword[0] : null;
    if (!category) {
      const byName = topicLibrary.find(item => item.name && text.includes(asText(item.name).toLowerCase()));
      category = uniqueByName(topicLibrary, byName?.name);
    }
    let subcategory = null;
    if (category) {
      const byName = category.subcategories.find(item => item.name && text.includes(asText(item.name).toLowerCase()));
      subcategory = uniqueByName(category.subcategories, byName?.name);
    }
    return {
      videoId: video.id,
      // 一律回传 **id**：归一化只认 id，避免同名跨账号再被猜一次。
      categoryId: category?.id,
      subcategoryId: subcategory?.id,
      confidence: "low",
      basis: category && subcategory
        ? "标题 / 发布文案与现有分类名称或关键词命中"
        : "关键词不足或分类名在多个账号间重复、无法分辨，待人工复核",
    };
  });
  const report = normalizeBenchmarkTopicRefresh({
    videos: normalizedVideos,
    categories: topicLibrary,
    transcripts,
    agentOutput: { items: agentItems },
    recentDays,
    minLikes,
  });
  return { ...report, analysisSource: "heuristic", warnings: [{ code: "BENCHMARK_TOPIC_REFRESH_AGENT_FAILED", fallbackUsed: true }] };
};

/** 发给 Agent 的输入：完整脚本只用于判断，不让 Agent 回写脚本内容。 */
/**
 * Agent 的输入。
 *
 * ⚠️ `topicLibrary` 里给的是**短代号**（`c1` / `s1`）而不是真实 id：
 * 真实 id 长约 200 字符（带账号作用域），让模型回抄既容易抄错、又白烧输出 token。
 * 代号按归一化顺序生成，解析端用同一套规则映射回真实 id（见 `categoryCode`）。
 */
export const buildBenchmarkTopicRefreshInput = ({ videos, categories, transcripts, recentDays = 7, minLikes = 100 } = {}) => ({
  recentDays: asNumber(recentDays) || 7,
  minLikes: resolveMinLikes(minLikes),
  topicLibrary: normalizeTopicLibrary(categories).map((category, categoryIndex) => ({
    categoryCode: categoryCode(categoryIndex),
    name: category.name,
    coreFunction: category.coreFunction,
    keywords: category.keywords,
    subcategories: category.subcategories.map((item, subIndex) => ({
      subcategoryCode: subcategoryCode(subIndex),
      name: item.name,
      description: item.description,
    })),
  })),
  videos: normalizeTopicRefreshVideos(videos, { minLikes }).map(video => ({
    videoId: video.id,
    title: video.title,
    sourceText: video.sourceText,
    publishDate: video.publishDate,
    stats: video.stats,
    transcript: transcriptFor(transcripts, video.id),
  })),
});
