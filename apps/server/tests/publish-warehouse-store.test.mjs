import test from "node:test";
import assert from "node:assert/strict";
import { connectTempDb, mongoUri } from "./helpers/mongo-temp-db.mjs";
import {
  clearPublishSelections,
  closeMongoClient,
  deleteAccountTags,
  deletePublishSelection,
  getAccountTags,
  listPublishSelections,
  saveAccountTags,
  savePublishSelection,
} from "../api/_lib/publishWarehouseStore.js";

/**
 * 发布仓两个 store 的契约测试。
 *
 * ⚠️ 需要真实 MongoDB。与 `tests/` 里其它测试不同，这一份**会自读 `.env`**
 *    （`npm test` 不带 `--env-file`，而项目既有测试刻意都不依赖数据库）。
 *    为了让这个新 store 真的被测到，这里自己做两件事：
 *      1. `.env` 存在就加载（不覆盖已有环境变量）；
 *      2. 全程只用**临时库**，跑完 `dropDatabase()`。
 *    **`MONGODB_URI` 缺失时整组跳过** —— 不会让没有数据库的环境上 `npm test` 变红。
 */

const TEMP_DB = `xmpubverify_${process.pid.toString(36)}${Date.now().toString(36)}`;

/** 没有 MONGODB_URI 时整组跳过；连不上则由 `setup()` 填 `skipReason` 再跳过。 */
const skip = mongoUri ? false : "缺少 MONGODB_URI，跳过需要数据库的 store 测试";

let db = null;
let client = null;
let skipReason = "";

const setup = async () => {
  if (db) return;
  const result = await connectTempDb(TEMP_DB);
  db = result.db;
  client = result.client;
  skipReason = result.skipReason;
};

const OWNER_A = "651111111111111111111111";
const OWNER_B = "652222222222222222222222";
const CUSTOMER = "653333333333333333333333";


test("发布仓 store", { skip }, async t => {
  await setup();
  if (!db) {
    t.skip(skipReason);
    return;
  }
  t.after(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    // ★ 同上：不关 store 的缓存连接，进程不会退出。
    await closeMongoClient();
  });

  await t.test("账号标签库：没存过时读回 null（调用方据此走首次生成）", async () => {
    assert.equal(await getAccountTags({ ownerId: OWNER_A, customerId: CUSTOMER }), null);
  });

  await t.test("账号标签库：保存候选 + 人工确认结果，读回形状完整", async () => {
    const saved = await saveAccountTags({
      ownerId: OWNER_A,
      customerId: CUSTOMER,
      customerName: "冒烟客户",
      angleGroups: [
        { key: "track", label: "细分赛道", candidates: ["劳动法", "用工合规"] },
        { key: "painPoint", label: "用户核心痛点", candidates: ["怕赔钱", "不懂新规"] },
        { key: "positioning", label: "内容核心定位", candidates: ["用工风险", "老板必看"] },
      ],
      confirmed: { track: "劳动法", painPoint: "怕赔钱", positioning: "用工风险" },
      referenceTags: ["劳动仲裁"],
      summary: "冒烟",
    });

    assert.equal(saved.customerName, "冒烟客户");
    assert.deepEqual(saved.confirmed, { track: "劳动法", painPoint: "怕赔钱", positioning: "用工风险" });
    // ★ 候选也要留着 —— 只存 confirmed 的话用户下次想改选就看不到别的候选了。
    assert.equal(saved.angles.length, 3);
    assert.deepEqual(saved.angles[0].candidates, ["劳动法", "用工合规"]);
    assert.deepEqual(saved.referenceTags, ["劳动仲裁"]);

    const readBack = await getAccountTags({ ownerId: OWNER_A, customerId: CUSTOMER });
    assert.deepEqual(readBack.confirmed, saved.confirmed);
    assert.equal(readBack.angles.length, 3);
    // ★★ 候选必须**往返存活**：只存 confirmed 的话，用户下次进来想改选就看不到其它候选了。
    //    （CDP 渲染验证里发现过「保存后候选消失」，所以这里把往返钉死。）
    assert.deepEqual(
      readBack.angles.map(angle => [angle.key, angle.candidates]),
      [
        ["track", ["劳动法", "用工合规"]],
        ["painPoint", ["怕赔钱", "不懂新规"]],
        ["positioning", ["用工风险", "老板必看"]],
      ],
      "保存后读回，每个角度的候选都要还在",
    );
  });

  await t.test("账号标签库：同客户重复保存是 upsert（不会存出两条）", async () => {
    await saveAccountTags({
      ownerId: OWNER_A,
      customerId: CUSTOMER,
      angleGroups: [{ key: "track", label: "细分赛道", candidates: ["新赛道"] }],
      confirmed: { track: "新赛道" },
    });
    const count = await db.collection("publish_account_tags").countDocuments({ customerId: CUSTOMER });
    assert.equal(count, 1, "一个客户只有一份账号标签库");
    const readBack = await getAccountTags({ ownerId: OWNER_A, customerId: CUSTOMER });
    assert.equal(readBack.confirmed.track, "新赛道");
    assert.equal(readBack.confirmed.painPoint, "", "没传的角度清空成空串，不留上一次的脏值");
  });

  await t.test("★ 账号标签库按用户隔离：员工 B 看不到员工 A 的", async () => {
    await saveAccountTags({ ownerId: OWNER_A, customerId: CUSTOMER, confirmed: { track: "A的赛道" } });
    assert.equal(await getAccountTags({ ownerId: OWNER_B, customerId: CUSTOMER }), null);
    await saveAccountTags({ ownerId: OWNER_B, customerId: CUSTOMER, confirmed: { track: "B的赛道" } });
    // 两者并存，互不覆盖（唯一索引是 owner + customer 两字段）。
    assert.equal((await getAccountTags({ ownerId: OWNER_A, customerId: CUSTOMER })).confirmed.track, "A的赛道");
    assert.equal((await getAccountTags({ ownerId: OWNER_B, customerId: CUSTOMER })).confirmed.track, "B的赛道");
    await deleteAccountTags({ ownerId: OWNER_B, customerId: CUSTOMER });
  });

  await t.test("选题选择：没有 topicId 直接 400（不许存出无法归属的脏数据）", async () => {
    await assert.rejects(
      () => savePublishSelection({ ownerId: OWNER_A, customerId: CUSTOMER, topicId: "" }),
      error => error.status === 400,
    );
    await assert.rejects(
      () => savePublishSelection({ ownerId: OWNER_A, customerId: "", topicId: "t1" }),
      error => error.status === 400,
    );
  });

  await t.test("选题选择：保存封面/文案/标签并读回（含 data URL 图片）", async () => {
    const saved = await savePublishSelection({
      ownerId: OWNER_A,
      customerId: CUSTOMER,
      topicId: "topic-1",
      title: "超龄员工工伤保险",
      cover: {
        selectedId: "cover-2",
        candidates: [
          { id: "cover-1", title: "办公室背景", keywords: ["超龄", "赔偿"], prompt: "提示词1", image: { url: "https://cdn.test/1.png" } },
          { id: "cover-2", title: "车间背景", keywords: ["用工"], prompt: "提示词2", image: { dataUrl: "data:image/png;base64,AAAA" } },
        ],
        titleStyle: { fontFamily: "思源黑体", color: "#ffffff", position: "bottom" },
      },
      publishCopy: {
        items: [
          { kind: "punchline", label: "金句", source: "agent", options: ["金句一", "金句二"] },
          { kind: "title", label: "标题", source: "reuse", options: ["原选题标题"] },
        ],
        selected: ["金句一", "原选题标题"],
      },
      topicTags: {
        groups: [
          { key: "subcategory", label: "小类", quota: 2, tags: ["超龄用工", "工伤"] },
          { key: "audience", label: "目标用户", quota: 1, tags: ["中小企业主"] },
        ],
        selected: ["劳动法", "超龄用工"],
        missing: ["脚本核心内容 0/2"],
      },
    });

    assert.equal(saved.topicId, "topic-1");
    assert.equal(saved.cover.selectedId, "cover-2");
    assert.equal(saved.cover.candidates.length, 2);
    // 图片两种存法都要活下来（生成图常是 data URL，参考图常是 URL）。
    assert.equal(saved.cover.candidates[0].image.url, "https://cdn.test/1.png");
    assert.match(saved.cover.candidates[1].image.dataUrl, /^data:image\/png;base64,/);
    assert.equal(saved.cover.titleStyle.fontFamily, "思源黑体");
    assert.deepEqual(saved.publishCopy.selected, ["金句一", "原选题标题"]);
    assert.deepEqual(saved.topicTags.selected, ["劳动法", "超龄用工"]);
    // ★ 缺额要如实留着 —— 前端据此提示「这一类没生成够」，不能静默少一块。
    assert.deepEqual(saved.topicTags.missing, ["脚本核心内容 0/2"]);
  });

  await t.test("选题选择：同 topicId 重复保存是 upsert；不同 topicId 各自一份", async () => {
    await savePublishSelection({
      ownerId: OWNER_A,
      customerId: CUSTOMER,
      topicId: "topic-1",
      title: "改过的标题",
      cover: { selectedId: "cover-9", candidates: [] },
    });
    assert.equal(await db.collection("publish_selections").countDocuments({ customerId: CUSTOMER, topicId: "topic-1" }), 1);

    await savePublishSelection({ ownerId: OWNER_A, customerId: CUSTOMER, topicId: "topic-2", title: "第二条" });
    const list = await listPublishSelections({ ownerId: OWNER_A, customerId: CUSTOMER });
    assert.equal(list.length, 2, "两条选题各自一份");
    const first = list.find(item => item.topicId === "topic-1");
    assert.equal(first.title, "改过的标题");
    assert.equal(first.cover.selectedId, "cover-9");
  });

  await t.test("★ 选题选择按用户隔离：B 的列表里没有 A 的选题", async () => {
    const listA = await listPublishSelections({ ownerId: OWNER_A, customerId: CUSTOMER });
    const listB = await listPublishSelections({ ownerId: OWNER_B, customerId: CUSTOMER });
    assert.equal(listA.length, 2);
    assert.equal(listB.length, 0, "B 看不到 A 的发布选择");
  });

  await t.test("清空/删除：删单条与清整批都要生效", async () => {
    const deleted = await deletePublishSelection({ ownerId: OWNER_A, customerId: CUSTOMER, topicId: "topic-2" });
    assert.equal(deleted.deleted, true);
    assert.equal((await listPublishSelections({ ownerId: OWNER_A, customerId: CUSTOMER })).length, 1);

    const cleared = await clearPublishSelections({ ownerId: OWNER_A, customerId: CUSTOMER });
    assert.equal(cleared.deleted, 1);
    assert.equal((await listPublishSelections({ ownerId: OWNER_A, customerId: CUSTOMER })).length, 0);
  });

  await t.test("超大图片引用被截断，不会把几百 MB 写进一个文档", async () => {
    // ⚠️ 用 ~4MB 的边界量级而不是 5MB 的巨型串：这条测的是**截断逻辑生效**，
    //    不是「网络能传多大」。写一个远超上限的巨大 base64 到远程 Atlas，实测会把
    //    这个用例拖到几分钟（字符串化 + 传输 + 远端解析），进而把整个 `npm test` 挂死。
    const limit = 4_000_000;
    const huge = `data:image/png;base64,${"A".repeat(limit + 100_000)}`;
    const saved = await savePublishSelection({
      ownerId: OWNER_A,
      customerId: CUSTOMER,
      topicId: "topic-huge",
      cover: { candidates: [{ id: "c1", image: { dataUrl: huge } }] },
    });
    const stored = saved.cover.candidates[0].image.dataUrl;
    assert.ok(stored.length <= limit, `必须截断到 ${limit} 以内（实际 ${stored.length}）`);
    assert.ok(stored.length > 0, "截断后仍要有内容，不能变成空串");
  });
});
