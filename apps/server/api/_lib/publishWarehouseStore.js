import { MongoClient, ObjectId } from "mongodb";

/**
 * 发布仓的持久化 —— 账号标签库 + 每条选题的发布选择。
 *
 * 用户在发布仓里做三件事（HANDOFF §0.3）：
 *   3.1 选封面（背景候选 + 标题样式，最终出图）
 *   3.2 选发布文案（金句/标题/3s/互动 各勾选）
 *   3.3 选发布标签（账号恒定 3 个 + 每条选题 5 个）
 *
 * ── 两个集合，因为生命周期完全不同 ────────────────────────────────────────
 *
 *   `publish_account_tags`   **账号恒定**（文档原话：「作为账号恒定的标签库」）。
 *                            人工确认一次，之后每轮发布都复用它 —— 所以必须持久化，
 *                            不能每轮重生成（否则用户每轮都要重新确认一遍，且标签会漂）。
 *                            按 `{managerId, customerId}` 唯一。
 *
 *   `publish_selections`      **每条选题一份**的勾选结果。换一批选题就是新的一份。
 *                            按 `{managerId, customerId, topicId}` 唯一。
 *
 * ── 隔离口径（本项目第四/五种，别和前面几种混）────────────────────────────
 * 两者都按 `managerId` 字段名存，但**实际写的是当前登录用户的 id**
 * （员工也要用发布仓，见 §0.0-B7 与 §0.1「脚本/标签分析对所有登录用户开放」同一条口径）。
 * 字段名沿用 `managerId` 是为了与全项目其它 store 保持一致（`ownerObjectId` 同一套）。
 * **员工之间互不可见**：A 的发布选择 B 读不到。
 */

const ACCOUNT_TAGS_COLLECTION = "publish_account_tags";
const SELECTIONS_COLLECTION = "publish_selections";

/** 一条选题最多留几个封面/文案候选（防止前端塞进来一个巨型数组）。 */
const MAX_COVER_CANDIDATES = 12;
const MAX_COPY_OPTIONS = 12;
const MAX_TAGS = 20;
/** 参考图/生成图的 data URL 可能很大 —— 只存 URL 或截断后的 data URL。 */
const MAX_IMAGE_URL_CHARS = 4_000_000;

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 500) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const badRequest = message => Object.assign(new Error(message), { status: 400 });

let clientPromise;
/**
 * 关掉本模块缓存的 MongoClient。
 *
 * ⚠️ **只给测试收尾用**（生产不需要主动关）：
 *    需要真实数据库的 store 测试如果不关它，Node 进程会因为这条 keep-alive 连接
 *    **永远不退出** —— 症状是 `node --test` 挂住不动、既不报错也不结束（实测踩过）。
 *    测试里在 `t.after` 调它即可。
 */
export const closeMongoClient = async () => {
  const pending = clientPromise;
  clientPromise = undefined;
  // ⚠️ 这里**不要**顺手重置索引缓存的 promise：本模块的索引缓存叫
  //    `accountTagIndexPromise` / `selectionIndexPromise`（不是 `indexPromise`），
  //    写错名字会在调用时抛 `ReferenceError` —— 而它偏偏在测试收尾才被调到，
  //    于是表现为「测试全过、进程不退出」，极难定位。
  if (!pending) return;
  try {
    const client = await pending;
    await client.close();
  } catch {
    // 连接本来就没建起来 / 已经关了：忽略。
  }
};

const getClient = () => {
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
  if (!mongoUri) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    }).connect().catch(error => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
};

const getDb = async () => {
  const client = await getClient();
  const dbName = String(process.env.MONGODB_DB_NAME || "").trim();
  return client.db(dbName || undefined);
};

const ownerObjectId = value => {
  const text = asText(value);
  return ObjectId.isValid(text) ? new ObjectId(text) : null;
};

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

const requireOwner = value => {
  const owner = ownerObjectId(value);
  if (!owner) throw badRequest("Invalid owner identity");
  return owner;
};

const requireCustomerId = value => {
  const target = asText(value);
  if (!target) throw badRequest("customerId is required");
  return target;
};

/** 图片字段：只接受 url 或 dataUrl，且长度封顶（避免把几百 MB 写进一个文档）。 */
const normalizeImageRef = value => {
  const source = value && typeof value === "object" ? value : {};
  const url = asText(source.url).slice(0, MAX_IMAGE_URL_CHARS);
  const dataUrl = asText(source.dataUrl).slice(0, MAX_IMAGE_URL_CHARS);
  if (!url && !dataUrl) return null;
  return { url, dataUrl };
};

// ── 账号标签库 ──────────────────────────────────────────────────────────────

const serializeAccountTags = document => ({
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  /** 人工确认后的三个标签（细分赛道 / 用户核心痛点 / 内容核心定位），每角度 1 个。 */
  confirmed: {
    track: cleanText(document.confirmed?.track, 80),
    painPoint: cleanText(document.confirmed?.painPoint, 80),
    positioning: cleanText(document.confirmed?.positioning, 80),
  },
  /** 上一轮生成的候选，恢复界面时用。 */
  angles: (Array.isArray(document.angles) ? document.angles : []).map(angle => ({
    key: asText(angle?.key),
    label: asText(angle?.label),
    candidates: (Array.isArray(angle?.candidates) ? angle.candidates : []).map(item => cleanText(item, 80)).filter(Boolean),
  })),
  referenceTags: (Array.isArray(document.referenceTags) ? document.referenceTags : []).map(item => cleanText(item, 80)).filter(Boolean),
  summary: cleanText(document.summary, 400),
  updatedAt: toIso(document.updatedAt),
});

/**
 * 写账号标签库（幂等 upsert）。
 *
 * `confirmed` 是**人工确认的结果**，`angles` 是候选来源。两者都存：
 * 只存 confirmed 的话，用户下次进来想改选就看不到其它候选了。
 */
export async function saveAccountTags({ ownerId, customerId, customerName = "", angleGroups = [], confirmed = {}, referenceTags = [], summary = "" } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(ACCOUNT_TAGS_COLLECTION);
  await ensureAccountTagIndexes(collection);

  const document = {
    managerId: owner,
    customerId: target,
    customerName: cleanText(customerName, 200),
    // 字段名统一用 `angles`（serialize 也读它）—— 别再引入第二种叫法。
    angles: angleGroups.map(group => ({
      key: asText(group?.key),
      label: asText(group?.label),
      candidates: (Array.isArray(group?.candidates) ? group.candidates : []).map(item => cleanText(item, 80)).filter(Boolean).slice(0, 8),
    })),
    confirmed: {
      track: cleanText(confirmed?.track, 80),
      painPoint: cleanText(confirmed?.painPoint, 80),
      positioning: cleanText(confirmed?.positioning, 80),
    },
    referenceTags: (Array.isArray(referenceTags) ? referenceTags : []).map(item => cleanText(item, 80)).filter(Boolean).slice(0, 20),
    summary: cleanText(summary, 400),
    updatedAt: new Date(),
  };

  await collection.updateOne(
    { managerId: owner, customerId: target },
    {
      $set: {
        customerName: document.customerName,
        angles: document.angles,
        confirmed: document.confirmed,
        referenceTags: document.referenceTags,
        summary: document.summary,
        updatedAt: document.updatedAt,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );

  const saved = await collection.findOne({ managerId: owner, customerId: target });
  return serializeAccountTags(saved);
}

/** 读账号标签库。没有就返回 null（调用方据此走「首次生成」）。 */
export async function getAccountTags({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(ACCOUNT_TAGS_COLLECTION);
  await ensureAccountTagIndexes(collection);
  const document = await collection.findOne({ managerId: owner, customerId: target });
  return document ? serializeAccountTags(document) : null;
}

/** 清空账号标签库（用户想重新生成时用）。 */
export async function deleteAccountTags({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const db = await getDb();
  const result = await db.collection(ACCOUNT_TAGS_COLLECTION).deleteOne({ managerId: owner, customerId: target });
  return { deleted: result.deletedCount > 0 };
}

let accountTagIndexPromise = null;
function ensureAccountTagIndexes(collection) {
  if (!accountTagIndexPromise) {
    accountTagIndexPromise = collection
      .createIndex({ managerId: 1, customerId: 1 }, { unique: true })
      .catch(() => {});
  }
  return accountTagIndexPromise;
}

// ── 每条选题的发布选择 ──────────────────────────────────────────────────────

const normalizeCover = value => {
  const source = value && typeof value === "object" ? value : {};
  const candidates = (Array.isArray(source.candidates) ? source.candidates : [])
    .map((item, index) => {
      const image = normalizeImageRef(item?.image || item);
      if (!image) return null;
      return {
        id: cleanText(item?.id, 80) || `cover-${index + 1}`,
        title: cleanText(item?.title, 120),
        keywords: (Array.isArray(item?.keywords) ? item.keywords : []).map(k => cleanText(k, 60)).filter(Boolean).slice(0, 12),
        prompt: cleanText(item?.prompt, 1200),
        image,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_COVER_CANDIDATES);
  return {
    /** 用户选中的封面 id（空串 = 还没选）。 */
    selectedId: cleanText(source.selectedId, 80),
    candidates,
    titleStyle: source.titleStyle && typeof source.titleStyle === "object" ? {
      fontFamily: cleanText(source.titleStyle.fontFamily, 120),
      fontSize: cleanText(source.titleStyle.fontSize, 40),
      color: cleanText(source.titleStyle.color, 60),
      position: cleanText(source.titleStyle.position, 40),
      alignment: cleanText(source.titleStyle.alignment, 40),
      note: cleanText(source.titleStyle.note, 300),
    } : null,
  };
};

const normalizePublishCopy = value => {
  const source = value && typeof value === "object" ? value : {};
  const items = (Array.isArray(source.items) ? source.items : [])
    .map(item => ({
      kind: cleanText(item?.kind, 40),
      label: cleanText(item?.label, 40),
      source: cleanText(item?.source, 20),
      options: (Array.isArray(item?.options) ? item.options : []).map(option => cleanText(option, 300)).filter(Boolean).slice(0, MAX_COPY_OPTIONS),
    }))
    .filter(item => item.kind);
  return {
    items,
    /** 勾选的结果：每一类选了哪几句。 */
    selected: (Array.isArray(source.selected) ? source.selected : []).map(item => cleanText(item, 300)).filter(Boolean).slice(0, MAX_COPY_OPTIONS),
  };
};

const normalizeTags = value => {
  const source = value && typeof value === "object" ? value : {};
  const groups = (Array.isArray(source.groups) ? source.groups : [])
    .map(group => ({
      key: cleanText(group?.key, 40),
      label: cleanText(group?.label, 40),
      quota: Math.max(1, Math.min(10, Number(group?.quota) || 1)),
      tags: (Array.isArray(group?.tags) ? group.tags : []).map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, MAX_TAGS),
    }))
    .filter(group => group.key);
  return {
    groups,
    /** 勾选的结果：最终要发布的标签。 */
    selected: (Array.isArray(source.selected) ? source.selected : []).map(tag => cleanText(tag, 80)).filter(Boolean).slice(0, MAX_TAGS),
    missing: (Array.isArray(source.missing) ? source.missing : []).map(item => cleanText(item, 60)).filter(Boolean).slice(0, 10),
  };
};

const serializeSelection = document => ({
  topicId: asText(document.topicId),
  title: cleanText(document.title, 300),
  cover: normalizeCover(document.cover),
  publishCopy: normalizePublishCopy(document.publishCopy),
  topicTags: normalizeTags(document.topicTags),
  updatedAt: toIso(document.updatedAt),
});

/** 保存一条选题的发布仓选择（幂等 upsert，按 `{owner, customerId, topicId}` 唯一）。 */
export async function savePublishSelection({ ownerId, customerId, topicId, title = "", cover = null, publishCopy = null, topicTags = null } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const topic = asText(topicId);
  if (!topic) throw badRequest("topicId is required");

  const db = await getDb();
  const collection = db.collection(SELECTIONS_COLLECTION);
  await ensureSelectionIndexes(collection);

  const now = new Date();
  await collection.updateOne(
    { managerId: owner, customerId: target, topicId: topic },
    {
      $set: {
        title: cleanText(title, 300),
        cover: normalizeCover(cover),
        publishCopy: normalizePublishCopy(publishCopy),
        topicTags: normalizeTags(topicTags),
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  const saved = await collection.findOne({ managerId: owner, customerId: target, topicId: topic });
  return serializeSelection(saved);
}

/** 取某个客户下**全部**选题的发布仓选择（发布仓要一次展示整批）。 */
export async function listPublishSelections({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);

  const db = await getDb();
  const collection = db.collection(SELECTIONS_COLLECTION);
  await ensureSelectionIndexes(collection);
  const documents = await collection
    .find({ managerId: owner, customerId: target })
    .sort({ updatedAt: -1 })
    .limit(120)
    .toArray();
  return documents.map(serializeSelection);
}

/** 只清某一条选题（用户重跑这条）。 */
export async function deletePublishSelection({ ownerId, customerId, topicId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const topic = asText(topicId);
  if (!topic) throw badRequest("topicId is required");
  const db = await getDb();
  const result = await db.collection(SELECTIONS_COLLECTION).deleteOne({ managerId: owner, customerId: target, topicId: topic });
  return { deleted: result.deletedCount > 0 };
}

/** 清空该客户下当前用户的全部发布仓选择。 */
export async function clearPublishSelections({ ownerId, customerId } = {}) {
  const owner = requireOwner(ownerId);
  const target = requireCustomerId(customerId);
  const db = await getDb();
  const result = await db.collection(SELECTIONS_COLLECTION).deleteMany({ managerId: owner, customerId: target });
  return { deleted: result.deletedCount };
}

let selectionIndexPromise = null;
function ensureSelectionIndexes(collection) {
  if (!selectionIndexPromise) {
    selectionIndexPromise = collection
      .createIndex({ managerId: 1, customerId: 1, topicId: 1 }, { unique: true })
      .catch(() => {});
  }
  return selectionIndexPromise;
}
