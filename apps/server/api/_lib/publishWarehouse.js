/**
 * 发布仓三块产出（3.1 封面 / 3.2 发布文案 / 3.3 发布标签）的归一化与规则层。
 *
 * 用户口径（2026-09-21 第七轮，见 HANDOFF §0.3）：
 *
 *   3.1 封面   三层：IP 形象照提示词 / 对标封面拆解（画风·元素·排版·视觉风格）/ 每期背景提示词
 *   3.2 发布文案 四类各 4 句：金句 · 标题 · 3s · 互动
 *                ⚠️ **标题与 3s 是「复用」选题已有的**，不由本 Agent 生成（用户明确）
 *   3.3 发布标签 ① 账号标签库：细分赛道 / 用户核心痛点 / 内容核心定位，各 2 候选 → 人工确认 1
 *                ② 选题标签：小类 x2 + 脚本核心内容 x2 + 目标用户 x1
 *
 * 🔴 这个文件**没有模型调用、没有数据库调用**，只做可单测的归一化。
 *    与 `api/_lib/benchmarkTopicRefresh.js` 同一条纪律（§6.3⑪⑬）：
 *      - 只接受输入里真实存在的 videoId，丢弃不存在的；
 *      - 数量由**后端**裁剪（候选几个是业务规则，不是模型说了算）；
 *      - 认不出的类型/缺失字段如实标「待人工补充」，**不编造**。
 */

/** 3.2 的四类发布文案。标题与 3s 复用选题已有内容，不由 Agent 生成。 */
export const PUBLISH_COPY_KINDS = [
  { key: "punchline", label: "金句", fromAgent: true, rule: "选取文案中有信息和记忆点的语句" },
  { key: "title", label: "标题", fromAgent: false, rule: "复用选题的标题" },
  { key: "threeSeconds", label: "3s", fromAgent: false, rule: "复用选题的 3 秒钩子" },
  { key: "interaction", label: "互动", fromAgent: true, rule: "根据选题主题与用户进行互动" },
];

/** 3.3 账号标签库的三个角度，各生成 2 个候选、人工确认 1 个。 */
export const ACCOUNT_TAG_ANGLES = [
  { key: "track", label: "细分赛道" },
  { key: "painPoint", label: "用户核心痛点" },
  { key: "positioning", label: "内容核心定位" },
];

/** 3.3 选题标签的配比：小类 x2 + 脚本核心内容 x2 + 目标用户 x1。 */
export const TOPIC_TAG_QUOTA = { subcategory: 2, coreContent: 2, audience: 1 };

/** 账号标签每个角度生成几个候选（人工从中确认 1 个）。 */
export const ACCOUNT_TAG_CANDIDATES_PER_ANGLE = 2;

/** 3.1 给出几个封面背景候选。 */
export const COVER_BACKGROUND_CANDIDATE_COUNT = 4;

/** 对标封面拆解的四个角度（文档明确指定，别改）。 */
export const COVER_ANALYSIS_ANGLES = [
  { key: "artStyle", label: "画风" },
  { key: "elements", label: "元素" },
  { key: "layout", label: "排版" },
  { key: "visualStyle", label: "视觉风格" },
];

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 500) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const uniqTexts = (value, maxLength = 200) => {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const text = cleanText(item, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
};

// ── 3.1 封面 ────────────────────────────────────────────────────────────────

/**
 * IP 形象照提示词建议。文档口径：
 *   穿着/场景 ← 内容定位/职业；人物表情/动作 ← 人设定位。
 * 所以这里**保留两个字段的来源标注**，让项目经理能核对「这条是从账号规划哪一项推出来的」。
 */
export const normalizeIpPortraitPrompt = value => {
  const source = value && typeof value === "object" ? value : {};
  return {
    outfitScene: cleanText(source.outfitScene || source.outfit_scene || source.穿着场景, 400),
    expressionAction: cleanText(source.expressionAction || source.expression_action || source.人物表情动作, 400),
    // 直接可用的整段提示词（用户要「人工修改确认提示词后」再出图，所以要能编辑）。
    prompt: cleanText(source.prompt || source.提示词, 1200),
    // 从账号规划的哪一项推出来的（判断依据不能丢，否则用户没法复核）。
    basis: cleanText(source.basis || source.判断依据, 400),
  };
};

/** 对标封面拆解：四个角度都要，缺的如实留空。 */
export const normalizeCoverAnalysis = value => {
  const source = value && typeof value === "object" ? value : {};
  const angles = {};
  for (const angle of COVER_ANALYSIS_ANGLES) {
    angles[angle.key] = cleanText(source[angle.key], 500);
  }
  return {
    ...angles,
    // 留白区域：背景模板要按对标封面空出放标题/人像的位置。
    reservedAreas: uniqTexts(source.reservedAreas || source.reserved_areas || source.留白区域, 300),
    summary: cleanText(source.summary, 500),
  };
};

/** 每期个性化背景候选：围绕关键词元素生成，关键词必须在背景里有所体现。 */
export const normalizeCoverBackgrounds = value => {
  const list = Array.isArray(value) ? value : (Array.isArray(value?.backgrounds) ? value.backgrounds : []);
  return list
    .map(item => {
      const source = item && typeof item === "object" ? item : {};
      const prompt = cleanText(source.prompt || source.提示词, 1200);
      if (!prompt) return null;
      return {
        title: cleanText(source.title || source.标题, 120) || "背景候选",
        keywords: uniqTexts(source.keywords || source.关键词, 60),
        prompt,
        // 该背景把留白留在哪（供前端预览时摆标题）。
        reservedAreas: uniqTexts(source.reservedAreas || source.reserved_areas || source.留白区域, 300),
      };
    })
    .filter(Boolean)
    .slice(0, COVER_BACKGROUND_CANDIDATE_COUNT)
    // ⚠️ id 在**过滤与截断之后**再编，保证是连续的 bg-1..bg-N。
    //    先编号会让「被丢掉的那条」留下一个空洞（bg-1/bg-3/bg-4），
    //    而 store 与前端都按 id 引用候选 —— 跳号会让人以为是丢数据。
    .map((item, index) => ({
      id: `bg-${index + 1}`,
      ...item,
      title: item.title === "背景候选" ? `背景候选 ${index + 1}` : item.title,
    }));
};

/** 标题样式模板（字体/颜色/位置）——「非标内容类」要求生成确定的标题样式模板。 */
export const normalizeCoverTitleStyle = value => {
  const source = value && typeof value === "object" ? value : {};
  const position = cleanText(source.position || source.位置, 40).toLowerCase();
  return {
    fontFamily: cleanText(source.fontFamily || source.font_family || source.字体, 120),
    fontSize: cleanText(source.fontSize || source.font_size || source.字号, 40),
    color: cleanText(source.color || source.颜色, 60),
    // 位置只认这几种，认不出的回落到 bottom（前端预览按这个摆）。
    position: ["top", "center", "bottom", "left", "right"].includes(position) ? position : "bottom",
    alignment: cleanText(source.alignment || source.对齐, 40),
    note: cleanText(source.note, 300),
  };
};

/** 3.1 的完整产出。 */
export const normalizeCoverPlan = value => {
  const source = value && typeof value === "object" ? value : {};
  return {
    ipPortrait: normalizeIpPortraitPrompt(source.ipPortrait || source.ip_portrait || source.IP形象照),
    backgroundAnalysis: normalizeCoverAnalysis(source.backgroundAnalysis || source.background_analysis || source.对标封面拆解),
    titleStyle: normalizeCoverTitleStyle(source.titleStyle || source.title_style || source.标题样式),
    backgrounds: normalizeCoverBackgrounds(source.backgrounds || source.每期背景),
    summary: cleanText(source.summary, 600),
  };
};

// ── 3.2 发布文案 ────────────────────────────────────────────────────────────

/**
 * 每个选题四类各 4 句。
 *
 * ⚠️ 标题与 3s **不由 Agent 生成**，由调用方从内容生成页已选结果传进来
 * （用户明确要求「复用」）。所以这里把它们作为入参接收并如实标注来源。
 *
 * @param agentValue   模型输出（只需 punchline / interaction）
 * @param reuse        { title: [..], threeSeconds: [..] } —— 复用来的，不经模型
 */
export const normalizePublishCopy = (agentValue, reuse = {}) => {
  const source = agentValue && typeof agentValue === "object" ? agentValue : {};
  const punchline = uniqTexts(source.punchline || source.金句, 200).slice(0, 4);
  const interaction = uniqTexts(source.interaction || source.互动, 200).slice(0, 4);
  const title = uniqTexts(reuse.title, 200).slice(0, 4);
  const threeSeconds = uniqTexts(reuse.threeSeconds, 200).slice(0, 4);

  const byKind = { punchline, title, threeSeconds, interaction };
  return {
    items: PUBLISH_COPY_KINDS.map(kind => ({
      kind: kind.key,
      label: kind.label,
      rule: kind.rule,
      // 来源必须如实标注：用户要能分辨哪几句是 AI 写的、哪几句是复用已有内容。
      source: kind.fromAgent ? "agent" : "reuse",
      options: byKind[kind.key],
    })),
    // 空的那几类单独列出来，前端据此提示「这一类没生成出来」而不是静默少一块。
    missing: PUBLISH_COPY_KINDS.filter(kind => byKind[kind.key].length === 0).map(kind => kind.label),
  };
};

// ── 3.3 发布标签 ────────────────────────────────────────────────────────────

/**
 * 账号标签库：三个角度各 2 候选。
 *
 * 这是**账号恒定**的（文档：「作为账号恒定的标签库」），所以结果要被人工确认后持久化，
 * 而不是每轮重新生成 —— 调用方负责存，这里只做归一化与数量约束。
 */
export const normalizeAccountTags = value => {
  const source = value && typeof value === "object" ? value : {};
  const byAngle = {};
  for (const angle of ACCOUNT_TAG_ANGLES) {
    byAngle[angle.key] = uniqTexts(
      source[angle.key] || source[angle.label],
      80,
    ).slice(0, ACCOUNT_TAG_CANDIDATES_PER_ANGLE);
  }
  return {
    angles: ACCOUNT_TAG_ANGLES.map(angle => ({
      key: angle.key,
      label: angle.label,
      candidates: byAngle[angle.key],
    })),
    // 参考对标账号的高频标签（文档提到可以参考 1.2 的高频标签）。
    referenceTags: uniqTexts(source.referenceTags || source.reference_tags, 80).slice(0, 12),
    // 示例（文档给的样例形状）：夏律讲劳动用工：#劳动法 #企业用工合规 #用工风险
    summary: cleanText(source.summary, 400),
  };
};

/**
 * 选题标签：小类 x2 + 脚本核心内容 x2 + 目标用户 x1。
 *
 * ⚠️ 每类**都必须真的凑够配额**，不够就在 `missing` 里如实说 ——
 * 少了标签用户能看见，编一个假的看不出来（§6.3⑪）。
 */
export const normalizeTopicTags = value => {
  const source = value && typeof value === "object" ? value : {};
  const subcategory = uniqTexts(source.subcategory || source.小类, 60).slice(0, TOPIC_TAG_QUOTA.subcategory);
  const coreContent = uniqTexts(source.coreContent || source.core_content || source.脚本核心内容, 60).slice(0, TOPIC_TAG_QUOTA.coreContent);
  const audience = uniqTexts(source.audience || source.目标用户, 60).slice(0, TOPIC_TAG_QUOTA.audience);

  const groups = [
    { key: "subcategory", label: "小类", quota: TOPIC_TAG_QUOTA.subcategory, tags: subcategory },
    { key: "coreContent", label: "脚本核心内容", quota: TOPIC_TAG_QUOTA.coreContent, tags: coreContent },
    { key: "audience", label: "目标用户", quota: TOPIC_TAG_QUOTA.audience, tags: audience },
  ];
  return {
    groups,
    tags: groups.flatMap(group => group.tags),
    missing: groups.filter(group => group.tags.length < group.quota)
      .map(group => `${group.label} ${group.tags.length}/${group.quota}`),
  };
};

/**
 * 把选中的内容拼成可直接复制发布的一整条（文档：「整合…为每个选题整合一整个发布仓」）。
 *
 * `accountTags` 是账号恒定的那三个（已人工确认），`topicTags` 是这个选题的标签。
 */
export const buildPublishBundle = ({ cover = null, publishCopy = null, topicTags = null, accountTags = [] } = {}) => {
  const tagList = [
    ...(Array.isArray(accountTags) ? accountTags : []),
    ...(Array.isArray(topicTags) ? topicTags : []),
  ].map(item => cleanText(item, 80)).filter(Boolean);

  const copyLines = (Array.isArray(publishCopy) ? publishCopy : [])
    .map(item => cleanText(item, 500))
    .filter(Boolean);

  return {
    cover,
    copy: copyLines,
    tags: tagList,
    // 可直接粘贴到抖音发布框的文本：文案换行 + 标签以 # 开头空格分隔。
    text: [
      copyLines.join("\n"),
      tagList.map(tag => (tag.startsWith("#") ? tag : `#${tag}`)).join(" "),
    ].filter(Boolean).join("\n\n"),
  };
};
