import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import {
  clearPublishSelections,
  deleteAccountTags,
  deletePublishSelection,
  getAccountTags,
  listPublishSelections,
  saveAccountTags,
  savePublishSelection,
} from "../_lib/publishWarehouseStore.js";

/**
 * 发布仓的持久化端点（2026-09-21 第七轮，见 HANDOFF §0.3）。
 *
 * **两个资源合用一个端点**，靠 `?resource=` 区分（默认 `selections`）：
 *
 *   `?resource=selections`（默认）—— 每条选题的发布选择（封面/文案/标签）
 *     GET    /api/publish-warehouse?customerId=            → 该客户下当前用户的全部选择
 *     POST   /api/publish-warehouse  { customerId, topicId, cover, publishCopy, topicTags }
 *     DELETE /api/publish-warehouse?customerId=&topicId=   → 删单条
 *     DELETE /api/publish-warehouse?customerId=            → 清整批
 *
 *   `?resource=account-tags` —— 账号恒定标签库（人工确认后长期复用）
 *     GET    /api/publish-warehouse?resource=account-tags&customerId=
 *     POST   /api/publish-warehouse?resource=account-tags  { customerId, angleGroups, confirmed, referenceTags }
 *     DELETE /api/publish-warehouse?resource=account-tags&customerId=
 *
 * 合用一个端点是刻意的：两者**生命周期都是「某个用户在某客户下的发布仓」**，
 * 分开会多出两套路由与两份 `vercel.json` 条目，而它们永远一起被改。
 *
 * 鉴权：`requireAuth`（员工也要用）。数据按**当前用户**隔离，员工之间互不可见。
 */

export const config = { maxDuration: 30 };

const asText = (value: unknown) => String(value ?? "").trim();

export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const resource = asText(req.query?.resource) || "selections";
  if (!["selections", "account-tags"].includes(resource)) {
    return json(res, 400, { success: false, error: `不支持的 resource：${resource}（可用：selections / account-tags）` });
  }

  try {
    if (resource === "account-tags") {
      if (req.method === "GET") {
        const customerId = asText(req.query?.customerId);
        if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
        const item = await getAccountTags({ ownerId: user.id, customerId });
        return json(res, 200, { success: true, item });
      }
      if (req.method === "POST") {
        const body = readBody(req);
        const item = await saveAccountTags({
          ownerId: user.id,
          customerId: body?.customerId,
          customerName: body?.customerName,
          angleGroups: body?.angleGroups,
          confirmed: body?.confirmed,
          referenceTags: body?.referenceTags,
          summary: body?.summary,
        });
        return json(res, 200, { success: true, item });
      }
      if (req.method === "DELETE") {
        const customerId = asText(req.query?.customerId || readBody(req)?.customerId);
        if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
        return json(res, 200, { success: true, ...(await deleteAccountTags({ ownerId: user.id, customerId })) });
      }
      return json(res, 405, { success: false, error: "Method not allowed" });
    }

    if (req.method === "GET") {
      const customerId = asText(req.query?.customerId);
      if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
      const items = await listPublishSelections({ ownerId: user.id, customerId });
      return json(res, 200, { success: true, items });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const item = await savePublishSelection({
        ownerId: user.id,
        customerId: body?.customerId,
        topicId: body?.topicId,
        title: body?.title,
        cover: body?.cover,
        publishCopy: body?.publishCopy,
        topicTags: body?.topicTags,
      });
      return json(res, 200, { success: true, item });
    }

    if (req.method === "DELETE") {
      const customerId = asText(req.query?.customerId || readBody(req)?.customerId);
      const topicId = asText(req.query?.topicId);
      if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
      // 带 topicId 删单条；不带就清整批（界面上分别是「重跑这条」与「重新开始」）。
      const result = topicId
        ? await deletePublishSelection({ ownerId: user.id, customerId, topicId })
        : await clearPublishSelections({ ownerId: user.id, customerId });
      return json(res, 200, { success: true, ...result });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error: any) {
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "Publish warehouse request failed",
      code: error?.code,
    });
  }
}
