import test from "node:test";
import assert from "node:assert/strict";

import {
  TOPIC_MIN_LIKES,
  TRANSCRIPT_MAX_DAYS,
  attachContent,
  filterByLikes,
  shouldExtractTranscripts,
  transcribableVideos,
} from "../../web/src/app/topicContentRules.ts";

/**
 * 「今日选题」的点赞门槛、脚本提取范围、以及「脚本要跟着勾选走到二创」的契约。
 *
 * 用户 2026-09-21 口径：
 *   · 列表只保留**严格 `likes > 100`**（100 不达标）；
 *   · **近 7 天**才语音提取完整脚本，15 天及以上只筛点赞 + 打标签；
 *   · 脚本要能在下一步二创直接复用，不必再提取。
 */

const topic = (id, likes) => ({ id, title: `标题 ${id}`, stats: { likes } });

const content = extra => ({
  script: "真实口播脚本", scriptSource: "transcript",
  categoryName: "风险防御", subcategoryName: "合同实操", categoryId: "c1", confidence: "high", basis: "",
  ...extra,
});

test("点赞门槛是严格大于：100 不达标、101 达标", () => {
  assert.equal(TOPIC_MIN_LIKES, 100);
  assert.deepEqual(
    filterByLikes([topic("a", 100), topic("b", 101), topic("c", 99)]).map(t => t.id),
    ["b"],
  );
});

test("点赞缺失按 0 处理，不算达标", () => {
  assert.deepEqual(
    filterByLikes([{ id: "a", stats: {} }, { id: "b", stats: { likes: "abc" } }, { id: "c" }, topic("d", 500)]).map(t => t.id),
    ["d"],
  );
});

test("只有近 7 天（含）才提取完整脚本", () => {
  assert.equal(TRANSCRIPT_MAX_DAYS, 7);
  for (const d of [1, 3, 7]) assert.equal(shouldExtractTranscripts(d), true, `${d} 天应提取`);
  for (const d of [8, 15, 30, 90, 365]) assert.equal(shouldExtractTranscripts(d), false, `${d} 天不应提取`);
});

test("★ 脚本与标签挂到 topic 上，才能跟着勾选进 sessionStorage 交给二创", () => {
  const topics = [topic("a", 500), topic("b", 600)];
  const attached = attachContent(topics, { a: content({}) });

  assert.equal(attached[0].content.script, "真实口播脚本");
  assert.equal(attached[0].content.categoryName, "风险防御");
  // 没有分析结果的条目保持原样，不硬塞空 content。
  assert.equal("content" in attached[1], false);
  // 原对象不能被改（React state 里还有别的引用）。
  assert.equal("content" in topics[0], false);
});

test("★ 序列化再反序列化后脚本与标签仍在（二创不用重新提取）", () => {
  const attached = attachContent([topic("a", 500)], { a: content({}) });
  const roundTripped = JSON.parse(JSON.stringify(attached));
  assert.equal(roundTripped[0].content.script, "真实口播脚本");
  assert.equal(roundTripped[0].content.subcategoryName, "合同实操");
});

test("转写只送有 id + 链接 + 标题的条目", () => {
  const videos = transcribableVideos([
    { id: "a", title: "有链接", link: "https://d/1", stats: { likes: 500 } },
    { id: "b", title: "没链接", link: "", stats: { likes: 500 } },
    { id: "c", title: "", link: "https://d/3", stats: { likes: 500 } },
  ]);
  assert.deepEqual(videos.map(v => v.id), ["a"]);
  assert.equal(videos[0].stats.likes, 500);
});
