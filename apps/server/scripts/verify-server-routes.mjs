/**
 * server/index.js 路由冒烟测试 —— 手动跑，需要 MongoDB。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * `node --check` 只查语法，`npm test` 完全不覆盖 `server/index.js`（那里要真实 MongoDB，
 * 加进单测会让没有数据库的环境挂掉，见 HANDOFF §6.5㉕）。于是「路由体里引用了未声明的
 * 变量」这种错**两边都拦不住**：
 *
 *   2026-09-18 给 1.2 加粉丝画像时，`/api/agent/benchmark-profile` 的
 *   `const warnings = []` 被顺手删掉，Express 版一跑到分析就
 *   `warnings is not defined` → 500；而 Vercel 版是好的。
 *   更糟的是它**掩盖了真正的错误**：Agent 调用失败时本该优雅降级成规则兜底报告，
 *   结果 catch 里那句 `warnings.push` 自己先炸了。
 *
 * 所以这个脚本真的把服务起起来、真的发 HTTP 请求，专打「失败降级」这类只有运行时
 * 才会走到的分支。**改 server/index.js 之后跑一次。**
 *
 * 用法：
 *   node scripts/verify-server-routes.mjs
 *
 * 安全性：全程只用一个**临时库**（跑完 dropDatabase），DeepSeek 用假 key 让它必失败
 * —— 不碰真实数据，也不消耗真实额度。
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

// ⚠️ 临时库名**每次运行都不同**，不要写死。
//
// 写死过一次，代价是半小时的误诊：我在排查问题时反复跑这个脚本，而另一个进程
// （子代理）也在跑同一个脚本 —— 两个进程共用同一个库，各自的 `dropDatabase()`
// 会把对方**运行中途**种下的邀请码/用户清掉。症状极具迷惑性：
//   · 邀请码文档明明存在且未使用，`bcrypt.compare` 也返回 true，却报「邀请码无效或已失效」
//   · 或者用户被清掉 → 401「登录已失效」→ 后面所有断言连锁失败
// 因为**共享状态**被第三方清空，看起来完全不像环境问题。
// 加上 pid + 时间戳后缀后，并发运行天然互不干扰。
// ⚠️ MongoDB 的库名上限是 **38 字节** —— 拼太长会直接报
// `Database name ... is too long`（踩过一次）。所以这里用短前缀 + 36 进制。
const TEMP_DB = `xmverify_${process.pid.toString(36)}${Date.now().toString(36)}`;
// ⚠️ 端口**随机取**，不要写死。
// 连续跑两次时，上一轮的 server 可能还没完全退出、端口仍被占用，
// 新进程绑定失败后崩溃，而 `/health` 是**旧进程**应答的 —— 于是紧接着的 fetch
// 报一句没有信息量的 `fetch failed`（2026-09-18 撞到多次）。
// 随机端口让两次运行天然错开；下面的存活检查保证我们测的确实是本次起的进程。
const PORT = Number(process.env.VERIFY_PORT || (8800 + Math.floor(Math.random() * 900)));
const INVITE_CODE = "verifycode123";
// 本脚本种下的数据的标记：用来定向清理，避免为了干净而删库。
const SEED_TAG = "__verify_seed__";
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (condition, label, detail = "") => {
  if (condition) { pass += 1; console.log(`  ✓ ${label}`); return; }
  fail += 1;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── 准备临时库：塞一个可用的邀请码，才能注册出项目经理 ──────────────────────
const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
if (!mongoUri) { console.error("缺少 MONGODB_URI"); process.exit(1); }
const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(TEMP_DB);
// ⚠️ 这里**刻意不 dropDatabase()**。
//
// 上一轮的 server 可能刚被杀掉、连接还没完全释放；在别人连着的当口把整个库删掉再重建，
// server 那边的连接会读到「库刚被删掉」的中间态 —— 表现为邀请码查不到 → **注册 403**。
// 2026-09-18 撞到过两次，同一份代码重跑就正常，很难查。
// 改成只清掉本脚本自己种的那几条数据，不碰别人的连接。
await db.collection("invitecodes").deleteMany({ note: SEED_TAG });
await db.collection("customers").deleteMany({ notes: SEED_TAG });
await db.collection("invitecodes").insertOne({
  type: "manager",
  status: "active",
  codeHash: await bcrypt.hash(INVITE_CODE, 10),
  maxUses: 1,
  usedCount: 0,
  note: SEED_TAG,
  createdAt: new Date(),
});
// 临时库里没有客户名册，而 `/api/customers` 就是读它 —— 不塞一条的话
// 下面那几条断言只会验到「空数组返回 200」，等于没验。
// 形状照抄真实库（`ipProfile` 刻意只填一部分，好让「档案稀疏」这条路径也被走到）。
const seededCustomer = await db.collection("customers").insertOne({
  name: "冒烟客户",
  occupation: "资产规划",
  contact: "13800000000",
  ipPositioning: "以家庭全球资产规划专家视角，帮助高净值人群识别风险并落地配置动作",
  contentNeeds: "视频号/抖音创作 · 高净值人群全球资产配置",
  notes: SEED_TAG,
  benchmarkAccounts: "https://www.douyin.com/user/smoke-benchmark",
  ipProfile: {
    schemaVersion: 1,
    status: "confirmed",
    profileVersion: 1,
    interview: { rawNotes: "一、人物 IP 总览……（冒烟用访谈原文）", source: "client_interview", completedAt: "" },
    identity: { name: "冒烟客户", age: "", mbti: "", personaContrast: "", occupation: "资产规划师", yearsExperience: "", keyCases: "服务过若干高净值家庭" },
    product: { businessModel: "提供全球资产配置咨询", productType: "咨询 + 年度陪跑", priceRange: "", coreAdvantages: "宏观研判与合规落地" },
    userProfile: { gender: "", age: "", occupationIndustry: "", incomeLevel: "", consumptionHabits: "", consumptionScenarios: "", painPoints: "", goalsNeeds: "希望资产保值增值并合规出海" },
    updatedAt: "", confirmedAt: "",
  },
  createdAt: new Date(),
});
// 第二个客户：选题库是**客户级**的，要验证「A 客户的库不是 B 客户的库」就必须有两个客户。
const seededCustomerB = await db.collection("customers").insertOne({
  name: "冒烟客户B",
  occupation: "服装零售",
  contact: "13900000000",
  notes: SEED_TAG,
  createdAt: new Date(),
});
const SMOKE_CUSTOMER_ID = String(seededCustomer.insertedId);
const SMOKE_CUSTOMER_B_ID = String(seededCustomerB.insertedId);
// 员工账号在真实库里由运维/项目经理创建 —— **没有注册端点**（`registerManager` 只认
// `type: "manager"` 的邀请码）。而「临时分析」是**员工私有**数据，要验隔离就必须有
// 两个员工：一个员工的记录 id 不能成为另一个员工的读取/删除入口。
const employeePasswordHash = await bcrypt.hash("verify123", 10);
await db.collection("employees").insertMany([
  { name: "冒烟员工A", account: "smoke-employee-a", email: "smoke-employee-a@example.com", passwordHash: employeePasswordHash, status: "active", department: "", createdAt: new Date() },
  { name: "冒烟员工B", account: "smoke-employee-b", email: "smoke-employee-b@example.com", passwordHash: employeePasswordHash, status: "active", department: "", createdAt: new Date() },
]);
console.log(`临时库 ${TEMP_DB} 已准备（邀请码 + 2 个客户 + 2 个员工）`);

// ── 起服务：假 DeepSeek key + 关掉重试，让 Agent 必然快速失败 ─────────────────
const child = spawn(process.execPath, ["src/index.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MONGODB_DB_NAME: TEMP_DB,
    // 让 Agent 一定失败 —— 我们要验的正是「失败之后怎么走」。
    DEEPSEEK_API_KEY: "invalid-key-for-smoke-test",
    AGENT_RETRY_ATTEMPTS: "0",
    AGENT_RETRY_BUDGET_MS: "3000",
    DEEPSEEK_REQUEST_TIMEOUT_MS: "5000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", chunk => { serverLog += String(chunk); });
child.stderr.on("data", chunk => { serverLog += String(chunk); });

const cleanup = async () => {
  child.kill("SIGKILL");
  await sleep(200);
  await db.dropDatabase().catch(() => {});
  await client.close().catch(() => {});
};

try {
  // 等服务起来。
  // ⚠️ 这里要等久一点：`/health` 是不碰数据库的，它先就绪；但紧接着的注册请求要连
  // MongoDB（实测首次连接可能 4~5 秒，网络差时更久）。等太短会看到「注册失败」这类
  // **假失败** —— 偶发的测试比没有测试更糟，会让人不再相信它。
  let up = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    try { const r = await fetch(`${BASE}/health`); if (r.ok) { up = true; break; } } catch { /* 还没起来 */ }
  }
  if (!up) throw new Error(`服务未启动。日志：\n${serverLog.slice(0, 800)}`);
  // 确认应答的**就是我们刚起的这个进程**：它可能因为端口被占等原因已经崩了，
  // 而端口上另有其人（旧进程）在应答。
  if (child.exitCode !== null) {
    throw new Error(`服务进程已退出（exitCode=${child.exitCode}）。日志：\n${serverLog.slice(0, 800)}`);
  }
  // 给数据库连接留出预热时间，避免第一条写操作撞上冷连接。
  await sleep(1500);
  console.log(`服务已启动于 ${BASE}\n`);

  // ── 注册一个临时项目经理 ────────────────────────────────────────────────
  const email = `verify-${Date.now()}@example.com`;
  // ⚠️ 注册**带重试**，这不是在掩盖 bug。
  //
  // 邀请码是脚本用自己的连接刚写进临时库的，而 server 用**另一个连接**读它。
  // 实测偶发读不到（`{"error":"邀请码无效或已失效"}` 403），而同一份代码重跑就好 ——
  // 典型的「一个连接刚写、另一个连接立刻读」的可见性竞态（副本集从节点读延迟也会这样）。
  // 这一步的目的是拿到登录态，不是在测邀请码语义，所以重试是合理的工程处理。
  let registerRes = null;
  let registerBody = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    registerRes = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "冒烟验证", email: `${attempt}-${email}`, password: "verify123", inviteCode: INVITE_CODE }),
    });
    registerBody = await registerRes.json().catch(() => null);
    if (registerRes.status === 201) break;
    await sleep(1200);
  }
  const cookie = String(registerRes.headers.get("set-cookie") || "").split(";")[0];
  // 把响应正文带进失败信息：只看到 403 是没法定位的（邀请码无效？字段缺？服务没连上库？）
  check(registerRes.status === 201 && cookie, `注册临时项目经理（HTTP ${registerRes.status}）`,
    `响应：${JSON.stringify(registerBody)}\n      服务日志：${serverLog.slice(-500)}`);

  const post = async (path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, json };
  };

  // ── 1. 粉丝画像：旧报告没有 sec_user_id 时必须优雅返回，而不是 500 ──────────
  const portrait = await post("/api/tikhub/fans-portrait", { secUserId: "" });
  check(portrait.status === 200, `/api/tikhub/fans-portrait 空 secUserId → 200（实际 ${portrait.status}）`);
  check(portrait.json?.portrait?.reason === "missing_sec_user_id", "  且如实给出 missing_sec_user_id");

  // ── 2. ★ 本次回归的主角：Agent 失败时必须降级成规则兜底报告，而不是 500 ────
  const classificationReport = {
    version: "1.0",
    reportType: "benchmark_classification",
    contentStyle: "spoken",
    contentStyleLabel: "口播类选题",
    account: { name: "冒烟账号", url: "https://www.douyin.com/user/smoke", platform: "douyin", platformLabel: "抖音", signature: "", followerCount: 0, secUserId: "" },
    analyzedCount: 1,
    fetchMode: "latest",
    sampleWindow: "最新作品（最多 60 条）",
    summary: "冒烟",
    categories: [],
    videos: [{
      id: "smoke-1", title: "冒烟标题", link: "https://www.douyin.com/video/smoke-1",
      authorName: "冒烟", publishDate: "2026-09-10", sourceText: "冒烟文案 #测试", platform: "douyin",
      stats: { likes: 1, comments: 0, shares: 0, bookmarks: 0 },
    }],
    analysisSource: "agent",
    warnings: [],
    analyzedAt: new Date().toISOString(),
  };
  const analyze = await post("/api/agent/benchmark-profile", { classificationReport, phase: "analyze" });
  check(
    analyze.status !== 500,
    `/api/agent/benchmark-profile Agent 失败时不返回 500（实际 ${analyze.status}）`,
    analyze.json?.error ? `后端错误：${analyze.json.error}` : serverLog.slice(-400),
  );
  check(analyze.status === 200 && analyze.json?.success === true, "  返回 200 + success");
  check(analyze.json?.report?.analysisSource === "heuristic", "  降级为规则兜底报告（analysisSource=heuristic）");
  check(
    Array.isArray(analyze.json?.report?.warnings) && analyze.json.report.warnings.length > 0,
    "  并把真实错误放进 warnings（用户能看到为什么降级）",
    JSON.stringify(analyze.json?.report?.warnings || []).slice(0, 200),
  );
  check(Boolean(analyze.json?.report?.userProfile), "  报告结构完整（userProfile 存在）");

  // ── 3. 报告存储的三个路由至少能应答（不写脏数据，只验鉴权与形态） ──────────
  const list0 = await fetch(`${BASE}/api/benchmark-profile-reports`, { headers: { Cookie: cookie } });
  check(list0.status === 200, `/api/benchmark-profile-reports 列表 → 200（实际 ${list0.status}）`);

  // ── 4. ★ 1.2 报告的「存 → 读回」全链路 ────────────────────────────────────
  // 模块 2（1.3 账号规划）要读 1.2 的产出，所以「保存后再读回来内容完整」是硬需求。
  // 只测列表能应答是不够的 —— 那证明不了正文真的落库了。
  const profileReport = {
    version: "1.0",
    reportType: "benchmark_profile",
    account: { name: "冒烟账号", url: "https://www.douyin.com/user/smoke", platform: "douyin", platformLabel: "抖音", signature: "简介原文", followerCount: 1234, secUserId: "sec-smoke" },
    contentStyle: "spoken",
    contentStyleLabel: "口播类选题",
    sampleWindow: { classificationSampleCount: 1, profileSampleCount: 1 },
    businessPositioning: { persona: { text: "人设", basis: ["简介原文"], level: "evidence", levelLabel: "输入证据" }, corePain: { text: "", basis: [], level: "manual", levelLabel: "待人工补充" }, summary: "概括" },
    userProfile: { demographics: [{ key: "gender", label: "性别", text: "男性居多", basis: [], level: "evidence", levelLabel: "输入证据", source: "fans_portrait" }] },
    contentPositioning: { classification: { source: "本次运行中先跑了一次分类分析（未落库）" }, threeSeconds: {}, endingHooks: {} },
    frequentTags: [{ tag: "劳动仲裁", count: 1, percentage: 100 }],
    operationStrategy: { monetization: { products: [], path: [] } },
    dataCoverage: { profileSampleCount: 1 },
    analysisSource: "agent",
    warnings: [],
    analyzedAt: new Date().toISOString(),
  };

  const saved = await post("/api/benchmark-profile-reports", { report: profileReport });
  check(saved.status === 201 && saved.json?.item?.id, `保存 1.2 报告 → 201 + id（实际 ${saved.status}）`);
  const reportId = saved.json?.item?.id;

  if (reportId) {
    const list = await (await fetch(`${BASE}/api/benchmark-profile-reports`, { headers: { Cookie: cookie } })).json();
    const summary = (list?.items || []).find(item => item.id === reportId);
    check(Boolean(summary), "列表里能查到刚保存的报告");
    // 契约：列表只给元数据，**不带正文**（正文约几十 KB，列表拉 12 份会很慢）。
    check(summary && summary.report === undefined, "列表只返回元数据（不含 report 正文）");

    const got = await (await fetch(`${BASE}/api/benchmark-profile-reports?id=${reportId}`, { headers: { Cookie: cookie } })).json();
    const body = got?.item?.report;
    check(Boolean(body), "按 id 取回完整报告");
    // 1.3 要用的正是这几个字段 —— 逐个确认没在落库/序列化里丢掉。
    check(body?.businessPositioning?.persona?.text === "人设", "  · 商业定位正文完整");
    check(body?.userProfile?.demographics?.[0]?.level === "evidence", "  · 用户画像证据等级完整");
    check(body?.userProfile?.demographics?.[0]?.source === "fans_portrait", "  · 粉丝画像来源标记完整");
    check(body?.frequentTags?.[0]?.tag === "劳动仲裁", "  · 高频标签完整");
    check(body?.account?.secUserId === "sec-smoke", "  · account.secUserId 完整");

    // 幂等：同样的内容重复提交（双击/刷新重提）不应产生第二条。
    const again = await post("/api/benchmark-profile-reports", { report: profileReport });
    check(again.json?.item?.id === reportId, "重复保存是幂等的（返回同一条）");

    const del = await fetch(`${BASE}/api/benchmark-profile-reports?id=${reportId}`, { method: "DELETE", headers: { Cookie: cookie } });
    check(del.status === 200, `删除报告 → 200（实际 ${del.status}）`);
    const gone = await fetch(`${BASE}/api/benchmark-profile-reports?id=${reportId}`, { headers: { Cookie: cookie } });
    check(gone.status === 404, "删掉之后按 id 取 → 404");
  }

  // ── 4b. ★ 1.3 报告的「存 → 读回」── 之前只验了 1.2 的保存，这是个盲区 ──────
  // 1.3 的报告结构比 1.2 复杂得多（6 节 + 分类透传），必须单独验一遍。
  const planReport = {
    version: "1.0", reportType: "account_plan", batch: 2, batchLabel: "六节",
    sections: [{ key: "ipPositioning", label: "一、IP定位" }],
    customer: { id: "c1", name: "冒烟客户" },
    ipPositioning: { businessPositioning: { targetAudience: { text: "老板", level: "inference", levelLabel: "Agent 推断" } } },
    accountSetup: {}, topicLibrary: {}, contentFramework: {}, production: {}, operations: {},
    missingInputs: [], analysisSource: "heuristic", warnings: [], analyzedAt: new Date().toISOString(),
  };
  const planSaved = await post("/api/account-plan-reports", { report: planReport });
  check(planSaved.status === 201 && planSaved.json?.item?.id, `保存 1.3 报告 → 201 + id（实际 ${planSaved.status}）`,
    `响应：${JSON.stringify(planSaved.json)?.slice(0, 300)}`);
  const planId = planSaved.json?.item?.id;
  if (planId) {
    const planGot = await (await fetch(`${BASE}/api/account-plan-reports?id=${planId}`, { headers: { Cookie: cookie } })).json();
    check(planGot?.item?.report?.reportType === "account_plan", "按 id 取回 1.3 完整报告");
    check(planGot?.item?.report?.ipPositioning?.businessPositioning?.targetAudience?.text === "老板", "  · 正文内容完整");
    const planAgain = await post("/api/account-plan-reports", { report: planReport });
    check(planAgain.json?.item?.id === planId, "  重复保存幂等");
    const planDel = await fetch(`${BASE}/api/account-plan-reports?id=${planId}`, { method: "DELETE", headers: { Cookie: cookie } });
    check(planDel.status === 200, `删除 1.3 报告 → 200（实际 ${planDel.status}）`);
  }

  // ── 5. 模块 2（1.3）的新端点 ──────────────────────────────────────────────
  // 客户名册 + 账号定位 Agent。注意 `customers` **不按 managerId 过滤**（公司共用名册），
  // 所以这里只验「能不能读」，不验隔离。
  const customersRes = await fetch(`${BASE}/api/customers`, { headers: { Cookie: cookie } });
  const customers = await customersRes.json().catch(() => null);
  check(customersRes.status === 200, `/api/customers 列表 → 200（实际 ${customersRes.status}）`);
  check(Array.isArray(customers?.items), "  返回 items 数组");
  const firstCustomer = (customers?.items || [])[0];
  check(Boolean(firstCustomer?.id && firstCustomer?.name), "  每项有 id 与 name");
  check(typeof firstCustomer?.hasProfile === "boolean", "  带 hasProfile 标记（界面据此提示「未录入档案」）");

  if (firstCustomer) {
    const detailRes = await fetch(`${BASE}/api/customers?id=${firstCustomer.id}`, { headers: { Cookie: cookie } });
    const detail = await detailRes.json().catch(() => null);
    check(detailRes.status === 200 && detail?.item?.ipProfile, `按 id 取客户详情 → 200 + ipProfile（实际 ${detailRes.status}）`);
    // 档案字段必须是字符串：界面直接渲染，undefined 会显示成空白或 undefined
    const profileValues = Object.values(detail?.item?.ipProfile?.identity || {});
    check(profileValues.length > 0 && profileValues.every(v => typeof v === "string"), "  ipProfile 字段全是字符串（无 undefined）");

    // ★ 与 warnings 那个 bug 同类：Agent 必失败时应当降级成规则兜底报告，而不是 500。
    // ⚠️ 必须带上 1.2 报告 —— 1.3 的「内容定位」直接透传它，缺了会（正确地）返回 400。
    // 这里传正文而不是 id，好在同一段里独立验证「有报告」这条正常路径。
    const plan = await post("/api/agent/account-plan", {
      customerId: firstCustomer.id,
      benchmarkProfileReport: profileReport,
    });
    check(plan.status !== 500, `/api/agent/account-plan Agent 失败时不返回 500（实际 ${plan.status}）`,
      plan.json?.error ? `后端错误：${plan.json.error}` : serverLog.slice(-300));
    check(plan.status === 200 && plan.json?.report?.analysisSource === "heuristic", "  降级为规则兜底报告");
    check(Array.isArray(plan.json?.report?.missingInputs), "  带 missingInputs（如实说明缺哪些输入）");
    check(Boolean(plan.json?.report?.topicLibrary), "  报告结构完整（topicLibrary 存在）");
    // 缺 1.2 报告时必须明确报错，而不是出一份没有内容定位的报告
    const planNoBenchmark = await post("/api/agent/account-plan", { customerId: firstCustomer.id });
    check(planNoBenchmark.status === 400, "  缺 1.2 报告时返回 400（而不是硬出一份残缺报告）");
  }

  // ── 6. 员工「临时分析」：不关联客户的第二入口 + **员工私有**隔离 ──────────────
  //
  // 这是本项目里唯一**员工私有**的数据（报告类按 managerId 隔离、`customers` 反而不隔离），
  // 所以必须真的用两个员工验隔离 —— 一个员工的记录 id 不能成为另一个员工的读取/删除入口
  // （与 HANDOFF §6.2⑥ 同一条原则，只是主体从 manager 换成了 employee）。
  const loginAs = async (login) => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, password: "verify123" }),
    });
    return {
      status: res.status,
      cookie: String(res.headers.get("set-cookie") || "").split(";")[0],
      json: await res.json().catch(() => null),
    };
  };

  const employeeA = await loginAs("smoke-employee-a");
  const employeeB = await loginAs("smoke-employee-b");
  check(employeeA.status === 200 && employeeA.cookie, `员工 A 登录 → 200（实际 ${employeeA.status}）`,
    `响应：${JSON.stringify(employeeA.json)?.slice(0, 200)}`);
  check(employeeB.status === 200 && employeeB.cookie, `员工 B 登录 → 200（实际 ${employeeB.status}）`);

  const empGet = async (path, who) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Cookie: who.cookie } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const empPost = async (path, body, who) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: who.cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  if (employeeA.cookie && employeeB.cookie) {
    // 经理也可使用内容生产，但只能看到自己的临时分析。
    const managerPeek = await fetch(`${BASE}/api/adhoc-analyses`, { headers: { Cookie: cookie } });
    const managerItems = await managerPeek.json();
    check(managerPeek.status === 200 && managerItems.items?.length === 0, `/api/adhoc-analyses 经理获得自己的空列表（实际 ${managerPeek.status}）`);

    const empty = await empGet("/api/adhoc-analyses", employeeA);
    check(
      empty.status === 200 && Array.isArray(empty.json?.items) && empty.json.items.length === 0,
      `  员工 A 初始列表 → 200 + 空数组（实际 ${empty.status}）`,
    );

    // 空输入必须被挡掉，而不是落一条抓不到任何东西的空记录。
    const invalid = await empPost("/api/adhoc-analyses", { benchmarkAccounts: "   " }, employeeA);
    check(invalid.status === 400, `  空对标账号 → 400（实际 ${invalid.status}）`);
    check(
      typeof invalid.json?.error === "string" && invalid.json.error.length > 0,
      "  且给出可读原因（不是 500）",
      `响应：${JSON.stringify(invalid.json)?.slice(0, 200)}`,
    );

    const created = await empPost("/api/adhoc-analyses", {
      title: "临时调研",
      benchmarkAccounts: "https://www.douyin.com/user/adhoc-a\nhttps://www.douyin.com/user/adhoc-b",
      platform: "douyin",
    }, employeeA);
    check(created.status === 201 && created.json?.item?.id, `  创建临时分析 → 201 + id（实际 ${created.status}）`,
      `响应：${JSON.stringify(created.json)?.slice(0, 200)}`);
    check(created.json?.item?.platformLabel === "抖音", "  带回 platformLabel（前端直接渲染，不用再映射一次）");
    // ★ 多行链接必须原样保留换行 —— 它会被预填进 /topics 的抓取框，那边按行解析。
    check(
      String(created.json?.item?.benchmarkAccounts || "").includes("\n"),
      "  多行链接保留换行（预填抓取框要按行拆）",
    );

    const adhocId = created.json?.item?.id;
    if (adhocId) {
      const listA = await empGet("/api/adhoc-analyses", employeeA);
      check((listA.json?.items || []).some(item => item.id === adhocId), "  员工 A 能在自己的列表里看到它");

      // ★ 隔离一：B 看不到 A 的记录。
      const listB = await empGet("/api/adhoc-analyses", employeeB);
      check(
        listB.status === 200 && !(listB.json?.items || []).some(item => item.id === adhocId),
        "★ 员工 B 看不到 A 的临时分析",
      );

      // ★ 隔离二：B 拿 A 的 id 删不掉（否则 id 就是跨员工删除的入口）。
      const crossDelete = await fetch(`${BASE}/api/adhoc-analyses?id=${adhocId}`, {
        method: "DELETE",
        headers: { Cookie: employeeB.cookie },
      });
      check(crossDelete.status === 404, `★ 员工 B 用 A 的 id 删除 → 404（实际 ${crossDelete.status}）`);
      const stillThere = await empGet("/api/adhoc-analyses", employeeA);
      check((stillThere.json?.items || []).some(item => item.id === adhocId), "★ 且 A 的记录确实还在（没被跨员工删掉）");

      const ownDelete = await fetch(`${BASE}/api/adhoc-analyses?id=${adhocId}`, {
        method: "DELETE",
        headers: { Cookie: employeeA.cookie },
      });
      check(ownDelete.status === 200, `  员工 A 删自己的 → 200（实际 ${ownDelete.status}）`);
      const afterDelete = await empGet("/api/adhoc-analyses", employeeA);
      check(!(afterDelete.json?.items || []).some(item => item.id === adhocId), "  删完就查不到了");
    }
  }

  // ── 正式选题库（客户级，每客户一份，可纳入多个对标账号）────────────────────
  //
  // ★ 这几条专打「只有运行时才会走到」的分支：upsert 建库、多账号并存而不合并、
  //   移除单个账号、跨客户隔离、以及「客户不存在」必须给可读错误而不是 500。
  const libGet = async customerId => {
    const res = await fetch(`${BASE}/api/topic-libraries?customerId=${customerId}`, { headers: { Cookie: cookie } });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, json };
  };
  const makeClassification = (id, accountName, categoryName) => ({
    version: "1.0",
    reportType: "benchmark_classification",
    contentStyle: "spoken",
    contentStyleLabel: "口播类选题",
    account: { name: accountName, url: `https://www.douyin.com/user/${id}`, platform: "douyin", platformLabel: "抖音" },
    analyzedCount: 2,
    fetchMode: "latest",
    sampleWindow: "最新作品（最多 60 条）",
    summary: "冒烟",
    methodology: "",
    categories: [{
      id: "cat-1",
      name: categoryName,
      count: 2,
      percentage: 100,
      coreFunction: "冒烟核心功能",
      keywords: ["冒烟关键词"],
      subcategories: [{ id: "sub-1", name: "冒烟小类", description: "冒烟小类说明", topics: [] }],
      topics: [],
    }],
    videos: [],
    analysisSource: "agent",
    warnings: [],
    analyzedAt: new Date().toISOString(),
  });

  const noCustomer = await post("/api/topic-libraries", { report: makeClassification("x", "X", "X类") });
  check(noCustomer.status === 400, `选题库缺 customerId → 400（实际 ${noCustomer.status}）`);

  const ghostCustomer = await post("/api/topic-libraries", {
    customerId: "000000000000000000000000",
    report: makeClassification("x", "X", "X类"),
  });
  check(ghostCustomer.status === 404, `选题库指向不存在的客户 → 404（实际 ${ghostCustomer.status}）`);

  const badReport = await post("/api/topic-libraries", { customerId: SMOKE_CUSTOMER_ID, report: { reportType: "其他" } });
  check(badReport.status === 400, `选题库只接受分类报告 → 400（实际 ${badReport.status}）`);

  const firstSave = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: makeClassification("smoke-a", "冒烟账号A", "风险防御"),
  });
  check(firstSave.status === 201, `建库（首份报告入库）→ 201（实际 ${firstSave.status}）`,
    firstSave.json?.error ? `后端错误：${firstSave.json.error}` : serverLog.slice(-300));
  check(firstSave.json?.item?.customerName === "冒烟客户", "  库里记下了客户名（便于人工核对归属）");
  check(firstSave.json?.item?.accountCount === 1, "  库里有 1 个对标账号");
  // ★ 库条目要存**三份分析**（用户 2026-09-21 要求：不只纳入 2.1，还要 2.2/2.3）。
  //   冒烟里只存了分类报告，所以 2.2/2.3 必须如实标 missing，而不是假装有。
  const savedAnalyses = firstSave.json?.item?.accounts?.[0]?.analyses;
  check(
    savedAnalyses && ["classification", "goldThreeSeconds", "endingHooks"].every(k => k in savedAnalyses),
    "  ★ 库条目带三份分析（classification / goldThreeSeconds / endingHooks）",
  );
  check(savedAnalyses?.classification?.status === "included", "  2.1 分类标 included");
  check(savedAnalyses?.goldThreeSeconds?.status === "missing", "  ★ 没跑过的 2.2 如实标 missing（不假装有）");
  check(savedAnalyses?.endingHooks?.status === "missing", "  ★ 没跑过的 2.3 如实标 missing");
  check(
    (savedAnalyses?.classification?.categories || []).length > 0,
    "  ★ 分类树挂在 analyses.classification.categories 下",
  );
  // 判断依据必须一起落库，不能只存分类名（HANDOFF §0.1 第 3 条）。
  check(
    firstSave.json?.item?.accounts?.[0]?.categories?.[0]?.coreFunction === "冒烟核心功能",
    "  大类带核心功能（判断依据不能丢）",
  );
  check(
    Array.isArray(firstSave.json?.item?.accounts?.[0]?.categories?.[0]?.keywords)
      && firstSave.json.item.accounts[0].categories[0].keywords.length === 1,
    "  大类带判断关键词",
  );
  const firstAccountKey = firstSave.json?.item?.accounts?.[0]?.accountKey;
  check(Boolean(firstAccountKey), "  账号条目带回 accountKey（移除时要按它定位）");

  // 列表只给元数据：账号与分类树不随列表返回，正文按 customerId 单取。
  const libList = await (await fetch(`${BASE}/api/topic-libraries`, { headers: { Cookie: cookie } })).json();
  const libSummary = (libList?.items || []).find(item => item.customerId === SMOKE_CUSTOMER_ID);
  check(Boolean(libSummary), "选题库列表里能查到刚建的库");
  check(libSummary?.accounts === undefined, "列表不带 accounts 正文（分类树按 customerId 单取）");
  check(libSummary?.accountCount === 1, "  但带回 accountCount，列表能显示规模");

  // 幂等：同一份报告重复入库不该出现第二个账号。
  const secondSave = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: makeClassification("smoke-a", "冒烟账号A", "风险防御"),
  });
  check(secondSave.status === 201 && secondSave.json?.item?.accountCount === 1, "重复纳入同一份报告是幂等的（仍 1 个账号）");

  // 多账号：分类各自独立保留，**不合并**。
  const thirdSave = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: makeClassification("smoke-b", "冒烟账号B", "风险防御"),
  });
  check(thirdSave.json?.item?.accountCount === 2, "再纳入一个账号 → 库里 2 个账号");
  const accounts = thirdSave.json?.item?.accounts || [];
  check(
    accounts.length === 2 && accounts[0].categories[0].id !== accounts[1].categories[0].id,
    "★ 两个账号的同名大类 id 不同（各自独立、没有自动合并）",
  );

  const libDetail = await libGet(SMOKE_CUSTOMER_ID);
  check(libDetail.status === 200 && libDetail.json?.item?.accounts?.length === 2, "按 customerId 取回完整库 → 200 + 2 个账号");
  check(
    Array.isArray(libDetail.json?.item?.tagDictionary) && libDetail.json.item.tagDictionary.length === 2,
    "  并返回跨账号标签词典（新视频打标签的词典来源）",
  );
  check(
    libDetail.json?.item?.tagDictionary?.[0]?.label?.includes(" · "),
    "  多账号时标签带账号名前缀（同名分类能分辨归属）",
  );

  // 客户级隔离：B 客户没有库，不能读到 A 的。
  const otherCustomer = await libGet(SMOKE_CUSTOMER_B_ID);
  check(otherCustomer.status === 404, `★ 另一个客户还没有库 → 404（实际 ${otherCustomer.status}）`);

  // 移除单个账号：移掉一个后库还在，另一个账号不受影响。
  check(firstSave.json?.item?.accountCount === 1 && thirdSave.json?.item?.accountCount === 2,
    "  （前置）库里此刻应有 2 个账号");
  const removed = await post("/api/topic-libraries?action=remove-account", {
    customerId: SMOKE_CUSTOMER_ID,
    accountKey: firstAccountKey,
  });
  check(removed.status === 200 && removed.json?.removedAccount === true, `移除单个对标账号 → 200（实际 ${removed.status}）`);
  const afterRemove = await libGet(SMOKE_CUSTOMER_ID);
  check(afterRemove.json?.item?.accountCount === 1, "  移掉一个后剩下 1 个账号");
  // ★ 必须验「剩下的是哪一个」：忽略 accountKey、单纯丢掉最后一个元素的实现也能通过上面那条。
  const survivor = afterRemove.json?.item?.accounts?.[0];
  check(survivor?.accountName === "冒烟账号B", `★ 活下来的是被指定的另一个账号（实际 ${survivor?.accountName}）`);
  check(survivor?.accountKey?.startsWith("url-") === true || survivor?.sourceReportId === "smoke-b",
    "  且确实是 smoke-b 那份报告");
  check(
    (afterRemove.json?.item?.tagDictionary || []).every(entry => !String(entry.id).includes(firstAccountKey)),
    "★ 标签词典里不再有被移除账号的分类",
  );

  const missingKey = await post("/api/topic-libraries?action=remove-account", { customerId: SMOKE_CUSTOMER_ID });
  check(missingKey.status === 400, `移除时不带 accountKey → 400（实际 ${missingKey.status}）`);

  // ★ 用一个不存在的 accountKey：库存在、但没删到东西，不能谎报成功
  //   （早先的实现无论 key 匹不匹配都回 200 + removedAccount:true，那个 404 分支是死代码）。
  const bogusKey = await post("/api/topic-libraries?action=remove-account", {
    customerId: SMOKE_CUSTOMER_ID,
    accountKey: "url-https://www.douyin.com/user/does-not-exist",
  });
  check(bogusKey.status === 404, `★ 用不存在的 accountKey 移除 → 404（实际 ${bogusKey.status}）`,
    JSON.stringify(bogusKey.json));
  const stillTwo = await libGet(SMOKE_CUSTOMER_ID);
  check(stillTwo.json?.item?.accountCount === 1, "  且库内容没被动过（不会假成功）");

  // ★ 移掉最后一个账号：空壳库要一起删掉，否则「已建库」的状态会撒谎。
  const lastKey = (stillTwo.json?.item?.accounts || [])[0]?.accountKey;
  const removeLast = await post("/api/topic-libraries?action=remove-account", {
    customerId: SMOKE_CUSTOMER_ID,
    accountKey: lastKey,
  });
  check(removeLast.status === 200 && removeLast.json?.libraryDeleted === true,
    `★ 移掉最后一个账号会连空壳库一起删（实际 ${removeLast.status} / libraryDeleted=${removeLast.json?.libraryDeleted}）`);
  const afterEmpty = await libGet(SMOKE_CUSTOMER_ID);
  check(afterEmpty.status === 404, "  空壳库确实没了（404），不用手工再删一次");

  // ── 400 路径：只有跑到才看得见的入参校验 ────────────────────────────────
  const malformedCustomer = await post("/api/topic-libraries", {
    customerId: "abc",
    report: makeClassification("smoke-x", "X", "X类"),
  });
  // ★ 这条踩过坑：`getCustomer` 抛的是 `Invalid customer id`（首字母大写+空格），
  //   而老实现用 /invalid|customerId/ 去猜状态码 → 漏掉 → 本该 400 却返回 500。
  check(malformedCustomer.status === 400, `★ 非法 customerId 格式 → 400（实际 ${malformedCustomer.status}）`,
    JSON.stringify(malformedCustomer.json));

  const noReport = await post("/api/topic-libraries", { customerId: SMOKE_CUSTOMER_ID });
  check(noReport.status === 400, `POST 不带 report → 400（实际 ${noReport.status}）`);

  const emptyCategories = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: { ...makeClassification("smoke-empty", "空分类账号", "空类"), categories: [] },
  });
  check(emptyCategories.status === 400, `★ 没有可用大类/小类的报告 → 400（实际 ${emptyCategories.status}）`,
    JSON.stringify(emptyCategories.json));

  const deleteNoCustomer = await fetch(`${BASE}/api/topic-libraries`, { method: "DELETE", headers: { Cookie: cookie } });
  check(deleteNoCustomer.status === 400, `DELETE 不带 customerId → 400（实际 ${deleteNoCustomer.status}）`);

  // ★ 一个客户一份库：删掉之后重建，列表里该客户只能有一条（不是两条）。
  const rebuild = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: makeClassification("smoke-a", "冒烟账号A", "风险防御"),
  });
  check(rebuild.status === 201 && rebuild.json?.item?.accountCount === 1, "重建库 → 201 + 1 个账号");
  const finalList = await (await fetch(`${BASE}/api/topic-libraries`, { headers: { Cookie: cookie } })).json();
  const duplicates = (finalList?.items || []).filter(item => item.customerId === SMOKE_CUSTOMER_ID);
  check(duplicates.length === 1, `★ 一个客户只有一份库（实际 ${duplicates.length} 条）`);
  check(duplicates[0]?.accountCount === 1, "  且列表带 accountCount（列表不带 accounts 正文）");

  const libDelete = await fetch(`${BASE}/api/topic-libraries?customerId=${SMOKE_CUSTOMER_ID}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  check(libDelete.status === 200, `删除整个选题库 → 200（实际 ${libDelete.status}）`);
  const afterLibDelete = await libGet(SMOKE_CUSTOMER_ID);
  check(afterLibDelete.status === 404, "  删完就查不到了（404）");

  // ── 二创适配：库里的「大类 → 配比」能不能被正确取到 ──────────────────────
  //
  // ★ 这一节钉的是「配比数据真的存进库、并且能从库里取出来」这半条链。
  //   另半条（按配比给 agent 分 10 个槽位）是纯函数，在
  //   tests/topic-creative-adaptation.test.mjs 里钉着。
  //
  // ⚠️ 必须给分类报告带上 `videos`：`findAccountAnalyses` 是**按采样视频集合**关联
  //   2.2/2.3 报告的（按账号名或报告 id 关联是被明令禁止的做法，见 HANDOFF §0.1）。
  //   视频集合为空时它直接返回 null —— 库条目会如实标 missing，这里就测不到配比。
  const adapterVideoId = "smoke-adapt-video-1";
  const makeClassificationWithVideos = (id, accountName, categoryName) => {
    const base = makeClassification(id, accountName, categoryName);
    return {
      ...base,
      videos: [{ id: adapterVideoId, title: "冒烟样本", link: "https://www.douyin.com/video/smoke-adapt-1", stats: { likes: 500 } }],
    };
  };
  const makeGoldThreeSeconds = () => ({
    version: "1.0",
    reportType: "gold_three_seconds",
    account: { name: "冒烟账号A", platform: "douyin", platformLabel: "抖音" },
    contentStyle: "spoken",
    analyzedCount: 1,
    sourceVideoCount: 1,
    sampleRule: "冒烟",
    items: [{ id: adapterVideoId, type: "knowledge", openingSource: "transcript" }],
    typeDistribution: [
      { type: "knowledge", typeLabel: "求知欲", count: 1, percentage: 100 },
    ],
    // ★ 这个字段就是二创适配要吃的配比：大类 → [类型, 配比, 原因]。
    categoryBreakdown: [{
      categoryName: "风险防御",
      count: 1,
      percentage: 100,
      coreFunction: "冒烟核心功能",
      keywords: ["冒烟关键词"],
      dimensions: [
        { type: "knowledge", typeLabel: "求知欲", count: 4, ratio: 40, reason: "冒烟原因" },
        { type: "fear", typeLabel: "恐惧", count: 3, ratio: 30, reason: "冒烟原因" },
        { type: "anger", typeLabel: "愤怒", count: 2, ratio: 20, reason: "冒烟原因" },
        { type: "contrast", typeLabel: "反差", count: 1, ratio: 10, reason: "冒烟原因" },
      ],
      reviewCount: 0,
    }],
    topTypes: [{ type: "knowledge", typeLabel: "求知欲", count: 1, percentage: 100, reason: "冒烟" }],
    analysisSource: "agent",
    warnings: [],
    analyzedAt: new Date().toISOString(),
  });

  const goldSave = await post("/api/gold-three-second-reports", { report: makeGoldThreeSeconds() });
  check(goldSave.status === 201, `（前置）保存 2.2 报告 → 201（实际 ${goldSave.status}）`);

  const libWithGold = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: makeClassificationWithVideos("smoke-adapt", "冒烟账号A", "风险防御"),
  });
  check(libWithGold.status === 201, `（前置）建库并纳入 2.2 → 201（实际 ${libWithGold.status}）`);
  // ★ 采样视频集合一致 → 2.2 必须真的被纳入（这是二创配比的数据来源）。
  check(
    libWithGold.json?.item?.accounts?.[0]?.analyses?.goldThreeSeconds?.status === "included",
    "★★ 采样一致时 2.2 被纳入库（二创适配的配比来源）",
  );
  check(
    (libWithGold.json?.item?.accounts?.[0]?.analyses?.goldThreeSeconds?.report?.categoryBreakdown || []).length > 0,
    "★★ 且报告正文里的 categoryBreakdown 一起进库（配比就存在这里）",
  );

  // ★ 直接按库文档断言：二创适配的投影必须能取到配比。
  //   这一条覆盖的是「投影写错了 → 配比静默取不到 → 永远退回全局配比」这个故障，
  //   它不会报错，只会让用户拿到的候选与本该用的大类配比不一致。
  const adaptationProjection = await db.collection("topic_libraries").findOne(
    { customerId: SMOKE_CUSTOMER_ID },
    {
      projection: {
        "accounts.analyses.goldThreeSeconds.report": 1,
        "accounts.analyses.endingHooks.report": 1,
      },
    },
  );
  const projectedGold = adaptationProjection?.accounts?.[0]?.analyses?.goldThreeSeconds?.report;
  check(Boolean(projectedGold), "★ 投影能取到 2.2 报告正文（否则配比永远取不到）");
  check(
    (projectedGold?.categoryBreakdown?.[0]?.dimensions || []).length === 4,
    "★★ 取到的配比含 4 个类型（求知欲/恐惧/愤怒/反差）",
  );
  check(
    (projectedGold?.categoryBreakdown?.[0]?.dimensions || []).every(item => Number.isFinite(item.ratio)),
    "  ★ 每个类型都带 ratio（后端实算的百分比，不是模型填的）",
  );

  // ★★ 真正调用 `getTopicLibraryCreativeAdaptation` —— 上面那两条是手写投影，
  //    只能证明「数据在库里」；这一条才证明**读库函数本身**取得到配比。
  //    它不经过 HTTP（没有对应端点），所以只能在这里直接调共享层
  //    （store 的 `getDb()` 是懒读 env 的，这里补上库名即可指向临时库）。
  process.env.MONGODB_DB_NAME = TEMP_DB;
  const { getTopicLibraryCreativeAdaptation } = await import("../api/_lib/topicLibraryStore.js");
  const adaptationLibrary = await getTopicLibraryCreativeAdaptation({ customerId: SMOKE_CUSTOMER_ID });
  check(Boolean(adaptationLibrary), "★★ 二创适配读库函数能取到库");
  const adaptationAccount = adaptationLibrary?.accounts?.[0];
  check(Boolean(adaptationAccount?.goldThreeSeconds), "★★ 且带出 2.2 报告（配比的来源）");
  check(
    (adaptationAccount?.goldThreeSeconds?.categoryBreakdown?.[0]?.dimensions || []).length === 4,
    "★★ 读库函数取到的配比完整（4 个类型）",
  );
  // 收窄边界：员工侧只读口径，不能把 managerId / 分类树正文一起漏出去。
  check(adaptationAccount?.managerId === undefined, "  ★ 读库函数不返回 managerId");
  check(
    adaptationAccount?.goldThreeSeconds?.categories === undefined,
    "  ★ 读库函数不返回分类树（二创只要大类配比）",
  );

  // ── 员工侧权限（2026-09-21 用户拍板放宽）────────────────────────────────
  // 员工要跑「新视频筛选打标签」，就得能把客户库里的分类当词典读。
  // 所以 **读** 开放、**写** 仍然 manager-only。员工侧还得是收窄过的视图。
  const rebuildForEmployee = await post("/api/topic-libraries", {
    customerId: SMOKE_CUSTOMER_ID,
    report: makeClassification("smoke-emp", "员工视角账号", "员工视角大类"),
  });
  check(rebuildForEmployee.status === 201, "（前置）重新建库，供员工侧断言使用");

  const empList = await fetch(`${BASE}/api/topic-libraries`, { headers: { Cookie: employeeA.cookie } });
  const empListJson = await empList.json().catch(() => null);
  check(empList.status === 200, `★ 员工可以读选题库列表 → 200（实际 ${empList.status}）`);
  check(
    Array.isArray(empListJson?.items) && empListJson.items.some(item => item.customerId === SMOKE_CUSTOMER_ID),
    "  ★ 员工能看到有库的客户（绑定客户的下拉就靠它）",
  );
  // ★ 收窄：员工侧不返回 managerId、也不返回客户 IP 档案之类的东西。
  check(
    (empListJson?.items || []).every(item => item.managerId === undefined),
    "★ 员工侧列表不含 managerId（不暴露库的属主身份）",
  );
  check(
    (empListJson?.items || []).every(item => item.ipProfile === undefined && item.interview === undefined),
    "★ 员工侧不含客户 IP 档案 / 访谈原文",
  );

  const empDetail = await fetch(`${BASE}/api/topic-libraries?customerId=${SMOKE_CUSTOMER_ID}`, {
    headers: { Cookie: employeeA.cookie },
  });
  const empDetailJson = await empDetail.json().catch(() => null);
  check(empDetail.status === 200, `★ 员工按客户读库 → 200（实际 ${empDetail.status}）`);
  check(Array.isArray(empDetailJson?.item?.tagDictionary) && empDetailJson.item.tagDictionary.length > 0,
    "  ★ 带回 tagDictionary（打标签的词典来源）");
  check(empDetailJson?.item?.managerId === undefined, "  ★ 且不含 managerId");

  // ★ 轻量视图（`?view=categories`）：员工端「按库内分类打标签」只该读这一支。
  //   完整库正文挂着每账号三份报告快照（单份分类报告约 148 KB），打标签只用得到大类/小类，
  //   把报告一起拖回来纯属让用户白等（2026-09-21 用户反馈「读库等待时间特别长」）。
  const empDict = await fetch(`${BASE}/api/topic-libraries?customerId=${SMOKE_CUSTOMER_ID}&view=categories`, {
    headers: { Cookie: employeeA.cookie },
  });
  const empDictJson = await empDict.json().catch(() => null);
  check(empDict.status === 200, `★ 员工读轻量词典 → 200（实际 ${empDict.status}）`);
  check(Array.isArray(empDictJson?.item?.tagDictionary) && empDictJson.item.tagDictionary.length > 0,
    "  ★ 轻量视图同样带回 tagDictionary");
  check(empDictJson?.item?.accounts === undefined,
    "  ★★ 但**不含 accounts**（三份报告快照不出库）");
  check(JSON.stringify(empDictJson || {}).length < JSON.stringify(empDetailJson || {}).length / 2,
    "  ★★ 响应体积明显小于完整库（投影生效）",
    `轻量 ${JSON.stringify(empDictJson || {}).length} vs 完整 ${JSON.stringify(empDetailJson || {}).length}`);
  check(empDictJson?.item?.managerId === undefined, "  轻量视图同样不含 managerId");
  // 经理那一条也要能用（同一段代码两个角色分支，别只修员工侧）。
  const mgrDict = await fetch(`${BASE}/api/topic-libraries?customerId=${SMOKE_CUSTOMER_ID}&view=categories`, {
    headers: { Cookie: cookie },
  });
  const mgrDictJson = await mgrDict.json().catch(() => null);
  check(mgrDict.status === 200 && Array.isArray(mgrDictJson?.item?.tagDictionary),
    `  项目经理读轻量词典 → 200 + tagDictionary（实际 ${mgrDict.status}）`);
  check(mgrDictJson?.item?.accounts === undefined, "  项目经理侧也不含 accounts");

  // ★ 词典必须**带小类**：后端 normalizeTopicLibrary 会把没有小类的大类整个丢掉，
  //   且只有大类+小类都命中才算有效标签 —— 轻量视图不能图省事只回大类。
  check(
    (empDictJson?.item?.tagDictionary || []).every(category => Array.isArray(category.subcategories) && category.subcategories.length > 0),
    "★★ 轻量词典里每个大类都带小类（否则打标签会全落「待人工复核」）",
  );

  // ★ 写操作对员工必须全部挡掉。
  const empWriteAsEmployee = await fetch(`${BASE}/api/topic-libraries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: employeeA.cookie },
    body: JSON.stringify({ customerId: SMOKE_CUSTOMER_ID, report: makeClassification("x", "X", "X类") }),
  });
  check(empWriteAsEmployee.status === 403, `★ 员工建库/追加账号 → 403（实际 ${empWriteAsEmployee.status}）`);
  const empDelete = await fetch(`${BASE}/api/topic-libraries?customerId=${SMOKE_CUSTOMER_ID}`, {
    method: "DELETE",
    headers: { Cookie: employeeA.cookie },
  });
  check(empDelete.status === 403, `★ 员工删库 → 403（实际 ${empDelete.status}）`);
  const empRemoveAccount = await fetch(`${BASE}/api/topic-libraries?action=remove-account`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: employeeA.cookie },
    body: JSON.stringify({ customerId: SMOKE_CUSTOMER_ID, accountKey: "anything" }),
  });
  check(empRemoveAccount.status === 403, `★ 员工移除账号 → 403（实际 ${empRemoveAccount.status}）`);

  // ★ 员工**读**不到客户名册与分类报告列表 —— 这两条钉的是一个真实踩过的坑，
  //   不是凑数：它们都是 manager-only，而员工只读视图（`/topics?view=newVideos`）
  //   曾经**无条件**调它们（`TopicLibraryStage` 里那对 `listCustomers` / `listBenchmarkReports`）。
  //   症状是员工一进页面，顶部就渲染一条红色错误条「该功能仅供项目经理使用」——
  //   员工看到一句与自己无关的报错，以为功能坏了。前端已加 `readOnly` 守卫，
  //   这里把「后端确实不给」钉住：哪天有人把这两个接口放开，症状会换一副面孔再回来。
  const empCustomers = await fetch(`${BASE}/api/customers`, { headers: { Cookie: employeeA.cookie } });
  check(empCustomers.status === 403, `★ 员工读客户名册 → 403（实际 ${empCustomers.status}）`);
  const empReports = await fetch(`${BASE}/api/benchmark-reports`, { headers: { Cookie: employeeA.cookie } });
  check(empReports.status === 403, `★ 员工读分类报告列表 → 403（实际 ${empReports.status}）`);
  // 经理那两条**必须照旧能用** —— 2.4 的两个下拉就靠它们（早前已有 200 断言，
  // 这里再确认一次「收紧员工没把经理弄坏」）。
  const mgrCustomers = await fetch(`${BASE}/api/customers`, { headers: { Cookie: cookie } });
  check(mgrCustomers.status === 200, `  项目经理读客户名册仍 → 200（实际 ${mgrCustomers.status}）`);
  const mgrReports = await fetch(`${BASE}/api/benchmark-reports`, { headers: { Cookie: cookie } });
  check(mgrReports.status === 200, `  项目经理读分类报告列表仍 → 200（实际 ${mgrReports.status}）`);

  // ── 临时任务的「绑定客户」──────────────────────────────────────────────
  // ⚠️ `/api/adhoc-analyses` 只认**员工**身份，而 `post()` 带的是经理 cookie，
  //    所以这两条必须显式带上员工 cookie。
  const empCreateAdhoc = async (path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: employeeA.cookie },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, json };
  };

  // 绑一个没有选题库的客户必须被拒 —— 否则员工绑完才发现打不了标签。
  const bindGhost = await empCreateAdhoc("/api/adhoc-analyses", {
    title: "绑定空客户",
    benchmarkAccounts: "https://www.douyin.com/user/bind-ghost",
    customerId: SMOKE_CUSTOMER_B_ID,
  });
  check(bindGhost.status === 400, `★ 绑定没有选题库的客户 → 400（实际 ${bindGhost.status}）`,
    JSON.stringify(bindGhost.json));

  // ── 员工也能用「脚本提取 + 标签判定」────────────────────────────────────
  // 用户 2026-09-21 明确要求这两件事**不再只给项目经理**：员工端「今日选题」要用它。
  // 这条钉住鉴权，避免以后又被改回 requireManager（症状是界面上一句
  // 「脚本 / 标签分析失败：该功能仅供项目经理使用」）。
  const empRefreshBody = {
    phase: "analyze",
    recentDays: 7,
    minLikes: 100,
    videos: [{
      id: "smoke-emp-1", title: "员工打标签用的视频", link: "https://www.douyin.com/video/smoke-emp-1",
      authorName: "冒烟", publishDate: "2026-09-20", sourceText: "冒烟文案", platform: "douyin",
      stats: { likes: 500, comments: 1, shares: 1, bookmarks: 1 },
    }],
    categories: [{ id: "cat-1", name: "冒烟大类", coreFunction: "f", keywords: ["冒烟"], subcategories: [{ id: "sub-1", name: "冒烟小类" }] }],
  };
  const empRefresh = await empCreateAdhoc("/api/agent/benchmark-topic-refresh", empRefreshBody);
  check(empRefresh.status === 200, `★ 员工可调用脚本/标签分析 → 200（实际 ${empRefresh.status}）`,
    JSON.stringify(empRefresh.json).slice(0, 220));
  check(empRefresh.json?.success === true, "  返回 success");
  // ★ 放开成"登录即可"之后，项目经理那条路必须**照旧能用**（2.4 里也要调它）。
  const mgrRefresh = await post("/api/agent/benchmark-topic-refresh", empRefreshBody);
  check(mgrRefresh.status === 200, `★ 项目经理仍可调用脚本/标签分析 → 200（实际 ${mgrRefresh.status}）`,
    JSON.stringify(mgrRefresh.json).slice(0, 220));

  // 未登录必须挡住（放开的是"登录用户"，不是"所有人"）。
  const anonRefresh = await fetch(`${BASE}/api/agent/benchmark-topic-refresh`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(empRefreshBody),
  });
  check(anonRefresh.status === 401, `★ 未登录调用脚本/标签分析 → 401（实际 ${anonRefresh.status}）`);

  // ── 处理进度（会话）：刷新/离开再回来能续上（2026-09-21 用户拍板 B2）────────
  // 打标签要几十秒到几分钟，中间结果只放前端内存的话，刷新一下这段时间与花的钱全丢。
  const smokeVideos = [{
    id: "session-v1", title: "进度验证视频", link: "https://www.douyin.com/video/session-v1",
    authorName: "冒烟", publishDate: "2026-09-20", sourceText: "冒烟文案", platform: "douyin",
    stats: { likes: 500, comments: 1, shares: 1, bookmarks: 1 },
  }];
  const saveSession = await empCreateAdhoc("/api/topic-refresh-sessions", {
    customerId: SMOKE_CUSTOMER_ID,
    accountUrl: "https://www.douyin.com/user/session-smoke",
    recentDays: 7,
    minLikes: 100,
    videos: smokeVideos,
  });
  check(saveSession.status === 200, `★ 员工可保存处理进度 → 200（实际 ${saveSession.status}）`,
    JSON.stringify(saveSession.json).slice(0, 200));

  const readSession = await empGet(`/api/topic-refresh-sessions?customerId=${SMOKE_CUSTOMER_ID}`, employeeA);
  check(readSession.status === 200 && readSession.json?.item?.videos?.length === 1,
    "★ 读回进度：候选还在", JSON.stringify(readSession.json).slice(0, 200));
  check((readSession.json?.item?.items || []).length === 0, "  新保存时标签是空的（不会带上一批的脏标签）");

  // 打一批标签 → 条目应当**自动落进会话**（这是「离开再回来还在」的关键）
  await empCreateAdhoc("/api/agent/benchmark-topic-refresh", {
    ...empRefreshBody,
    phase: "analyze",
    videos: smokeVideos,
    customerId: SMOKE_CUSTOMER_ID,
  });
  const afterTag = await empGet(`/api/topic-refresh-sessions?customerId=${SMOKE_CUSTOMER_ID}`, employeeA);
  check((afterTag.json?.item?.items || []).length === 1,
    "★★ 打完标签后条目自动落进进度（刷新后可续上）", JSON.stringify(afterTag.json).slice(0, 260));
  check(afterTag.json?.item?.items?.[0]?.video?.id === "session-v1", "  条目挂在对的视频上");
  check(Boolean(afterTag.json?.item?.items?.[0]?.category?.name), "  条目带分类名（恢复后界面能直接渲染）");

  // ★ 进度是**每个用户自己的**：换个员工看同一个客户，必须是空的。
  const otherSession = await empGet(`/api/topic-refresh-sessions?customerId=${SMOKE_CUSTOMER_ID}`, employeeB);
  check(otherSession.status === 200 && otherSession.json?.item === null,
    "★★ 员工 B 看不到员工 A 的处理进度（按 user 隔离）",
    JSON.stringify(otherSession.json).slice(0, 200));

  const clearSession = await fetch(`${BASE}/api/topic-refresh-sessions?customerId=${SMOKE_CUSTOMER_ID}`, {
    method: "DELETE", headers: { Cookie: employeeA.cookie },
  });
  check(clearSession.status === 200, `  「重新开始」清进度 → 200（实际 ${clearSession.status}）`);
  const afterClear = await empGet(`/api/topic-refresh-sessions?customerId=${SMOKE_CUSTOMER_ID}`, employeeA);
  check(afterClear.json?.item === null, "  清完确实读不到了");

  const bindOk = await empCreateAdhoc("/api/adhoc-analyses", {
    title: "绑定有库的客户",
    benchmarkAccounts: "https://www.douyin.com/user/bind-ok",
    customerId: SMOKE_CUSTOMER_ID,
  });
  check(bindOk.status === 201, `绑定有库的客户 → 201（实际 ${bindOk.status}）`, JSON.stringify(bindOk.json));
  check(bindOk.json?.item?.customerId === SMOKE_CUSTOMER_ID, "  ★ 记录里带回了 customerId");
  check(bindOk.json?.item?.customerName === "冒烟客户", "  ★ customerName 由后端从库里取（不接受前端传值）");

  // 不绑客户也照样能建（旧行为不能因为新字段而坏掉）。
  const noBind = await empCreateAdhoc("/api/adhoc-analyses", {
    title: "不绑客户",
    benchmarkAccounts: "https://www.douyin.com/user/no-bind",
  });
  check(noBind.status === 201, `不绑客户仍可创建 → 201（实际 ${noBind.status}）`);
  check(noBind.json?.item?.customerId === "", "  customerId 为空串（旧记录同形状）");

  // ── 发布仓（2026-09-21 第七轮，见 HANDOFF §0.3）──────────────────────────
  // ★ 这一段钉的是**发布仓的持久化与阶段校验**。
  //   三个 Agent 的真实产出要真模型（属于「必须真实验收」的范围），
  //   这里只验「阶段清单、鉴权、入参校验、保存/读回、按用户隔离」这些
  //   **只有跑起来才会走到**的分支 —— DeepSeek 是假 key，所以 Agent 阶段必然失败，
  //   正好用来验「失败时报的错可读、不是 500」。
  const empPublish = (path, init = {}) => fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Cookie: employeeA.cookie, ...(init.headers || {}) },
  });

  // 未登录必须 401（发布仓在员工端，但没登录一样不行）。
  const anonPublish = await fetch(`${BASE}/api/publish-warehouse?customerId=${SMOKE_CUSTOMER_ID}`);
  check(anonPublish.status === 401, `★ 未登录读发布仓 → 401（实际 ${anonPublish.status}）`);

  // 客户 id 必填：漏了必须 400 而不是拿一个空查询去全表扫。
  const noCustomerPublish = await empPublish("/api/publish-warehouse");
  check(noCustomerPublish.status === 400, `★ 发布仓缺 customerId → 400（实际 ${noCustomerPublish.status}）`);

  // 全新客户下应该是空列表（不是 404，也不是报错）。
  const emptySelections = await empPublish(`/api/publish-warehouse?customerId=${SMOKE_CUSTOMER_ID}`);
  const emptySelectionsJson = await emptySelections.json().catch(() => null);
  check(emptySelections.status === 200 && Array.isArray(emptySelectionsJson?.items) && emptySelectionsJson.items.length === 0,
    `★ 全新客户下发布仓为空列表 → 200（实际 ${emptySelections.status}）`);

  // ★ 保存一条选题的发布选择（封面 + 文案 + 标签），再读回。
  const onePixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const saveSelection = await empPublish("/api/publish-warehouse", {
    method: "POST",
    body: JSON.stringify({
      customerId: SMOKE_CUSTOMER_ID,
      topicId: "smoke-topic-1",
      title: "超龄员工工伤保险",
      cover: {
        selectedId: "cover-1",
        candidates: [{ id: "cover-1", title: "办公室", keywords: ["超龄"], prompt: "提示词", image: { dataUrl: onePixel } }],
        titleStyle: { fontFamily: "思源黑体", color: "#fff", position: "bottom" },
      },
      publishCopy: { items: [{ kind: "punchline", label: "金句", source: "agent", options: ["金句一"] }], selected: ["金句一"] },
      topicTags: { groups: [{ key: "subcategory", label: "小类", quota: 2, tags: ["超龄用工"] }], selected: ["劳动法"], missing: ["脚本核心内容 0/2"] },
    }),
  });
  const saveSelectionJson = await saveSelection.json().catch(() => null);
  check(saveSelection.status === 200, `★ 保存发布仓选择 → 200（实际 ${saveSelection.status}）`, JSON.stringify(saveSelectionJson).slice(0, 200));
  check(saveSelectionJson?.item?.cover?.selectedId === "cover-1", "  ★ 封面选中项存下来了");
  check(saveSelectionJson?.item?.cover?.candidates?.[0]?.image?.dataUrl?.startsWith("data:image/png"), "  ★ 生成图（data URL）随候选一起存下来");
  check(saveSelectionJson?.item?.publishCopy?.selected?.[0] === "金句一", "  ★ 文案勾选存下来了");
  check(saveSelectionJson?.item?.topicTags?.missing?.[0] === "脚本核心内容 0/2", "  ★ 标签缺额如实保留（前端据此提示，不静默少一块）");

  // 缺 topicId 必须 400（否则会存出无法归属的脏数据）。
  const noTopicId = await empPublish("/api/publish-warehouse", {
    method: "POST",
    body: JSON.stringify({ customerId: SMOKE_CUSTOMER_ID }),
  });
  check(noTopicId.status === 400, `★ 发布仓缺 topicId → 400（实际 ${noTopicId.status}）`);

  // ★ 账号标签库：保存候选 + 人工确认，读回时候选必须还在（用户要能改选）。
  const saveAccountTags = await empPublish("/api/publish-warehouse?resource=account-tags", {
    method: "POST",
    body: JSON.stringify({
      customerId: SMOKE_CUSTOMER_ID,
      customerName: "冒烟客户",
      angleGroups: [
        { key: "track", label: "细分赛道", candidates: ["劳动法", "用工合规"] },
        { key: "painPoint", label: "用户核心痛点", candidates: ["怕赔钱", "不懂新规"] },
        { key: "positioning", label: "内容核心定位", candidates: ["用工风险", "老板必看"] },
      ],
      confirmed: { track: "劳动法", painPoint: "怕赔钱", positioning: "用工风险" },
    }),
  });
  const saveAccountTagsJson = await saveAccountTags.json().catch(() => null);
  check(saveAccountTags.status === 200, `★ 保存账号标签库 → 200（实际 ${saveAccountTags.status}）`);
  check(saveAccountTagsJson?.item?.confirmed?.track === "劳动法", "  ★ 人工确认的标签存下来了");

  const readAccountTags = await empPublish(`/api/publish-warehouse?resource=account-tags&customerId=${SMOKE_CUSTOMER_ID}`);
  const readAccountTagsJson = await readAccountTags.json().catch(() => null);
  check(readAccountTagsJson?.item?.angles?.length === 3, "★★ 读回时三个角度的候选都还在（否则用户没法改选）");
  check(readAccountTagsJson?.item?.angles?.[0]?.candidates?.length === 2, "  每个角度保留 2 个候选（文档口径）");

  // ★ 按用户隔离：员工 B 看不到员工 A 的发布仓。
  const listAsB = await fetch(`${BASE}/api/publish-warehouse?customerId=${SMOKE_CUSTOMER_ID}`, { headers: { Cookie: employeeB.cookie } });
  const listAsBJson = await listAsB.json().catch(() => null);
  check(listAsB.status === 200 && (listAsBJson?.items || []).length === 0, "★★ 员工 B 看不到员工 A 的发布仓（按用户隔离）");
  const tagsAsB = await fetch(`${BASE}/api/publish-warehouse?resource=account-tags&customerId=${SMOKE_CUSTOMER_ID}`, { headers: { Cookie: employeeB.cookie } });
  const tagsAsBJson = await tagsAsB.json().catch(() => null);
  check(tagsAsBJson?.item === null, "★★ 员工 B 也看不到 A 的账号标签库");

  // ★ 不支持的 resource 必须 400（别静默当成 selections 处理）。
  const badResource = await empPublish(`/api/publish-warehouse?resource=whatever&customerId=${SMOKE_CUSTOMER_ID}`);
  check(badResource.status === 400, `★ 不支持的 resource → 400（实际 ${badResource.status}）`);

  // ── 发布仓 Agent：阶段校验（假 DeepSeek key，真模型阶段必然失败）────────────
  const badPhase = await empPublish("/api/agent/publish", { method: "POST", body: JSON.stringify({ phase: "不存在的阶段" }) });
  const badPhaseJson = await badPhase.json().catch(() => null);
  check(badPhase.status === 400, `★ 发布 Agent 未知 phase → 400（实际 ${badPhase.status}）`);
  // 错误信息要带上可用阶段，便于排查拼错 —— 不能只回一句「参数错误」。
  check(String(badPhaseJson?.error || "").includes("cover-plan"), "  错误信息列出可用 phase（便于排查拼错）");
  check(badPhaseJson?.code === "PUBLISH_PHASE_INVALID", "  带可机读的 code");

  const noPhase = await empPublish("/api/agent/publish", { method: "POST", body: JSON.stringify({}) });
  check(noPhase.status === 400, `★ 发布 Agent 缺 phase → 400（实际 ${noPhase.status}）`);

  // 出图阶段没配密钥时必须回**可读的 501**，而不是 500 —— 前端据此提示「配好密钥即可出图」。
  const coverImageNoKey = await empPublish("/api/agent/publish", {
    method: "POST",
    body: JSON.stringify({ phase: "cover-image", prompt: "一张测试封面" }),
  });
  const coverImageJson = await coverImageNoKey.json().catch(() => null);
  check([501, 200].includes(coverImageNoKey.status), `★ 出图阶段缺密钥 → 501 或已配置下 200（实际 ${coverImageNoKey.status}）`);
  if (coverImageNoKey.status === 501) {
    check(String(coverImageJson?.error || "").includes("XXCAPI_API_KEY"), "  错误信息点明缺哪个配置项");
  } else {
    check(Boolean(coverImageJson?.images?.length) || Boolean(coverImageJson?.error), "  已配置时要么出图、要么回可读错误");
  }

  // 缺提示词必须 400（出图很贵，不能拿空提示词去打网关）。
  const coverImageNoPrompt = await empPublish("/api/agent/publish", { method: "POST", body: JSON.stringify({ phase: "cover-image" }) });
  check(coverImageNoPrompt.status === 400, `★ 出图缺提示词 → 400（实际 ${coverImageNoPrompt.status}）`);

  // ── 3.3 账号标签的权限边界（2026-09-21 用户拍板「直接开放权限」）────────────
  //
  // ★ 用户要求开放，但**边界是「按客户」而不是「按所有人」**：
  //   - 带 customerId 的读 → 员工可读（3.3 三个角度的主来源）
  //   - 按 id 取单份 / 列全部 → **仍然 manager-only**（否则拿到 id 就能读任意经理的报告）
  //   - POST / DELETE → **仍然 manager-only**，一条都没放开
  //   - 没登录 → 401
  const anonPlan = await fetch(`${BASE}/api/account-plan-reports?customerId=${SMOKE_CUSTOMER_ID}`);
  check(anonPlan.status === 401, `★ 未登录读账号规划 → 401（实际 ${anonPlan.status}）`);

  // 先用 store 种一份**真实形状**的 1.3 报告（冒烟里的 DeepSeek 是假 key、跑不出真报告，
  // 所以直接按 `accountPlan.js` 的真实顶层结构造一份），这样员工读回来的是真数据，
  // 「权限开了 + 数据流得通 + 字段提取对」三件事一起验到。
  const { saveAccountPlanReport } = await import("../api/_lib/accountPlanStore.js");
  const { pickAccountPlanFields } = await import("../api/_lib/publishAgentRunner.js");
  const managerId = String(registerBody?.user?.id || "");
  check(Boolean(managerId), "（前置）拿到临时项目经理 id");
  const seededPlan = await saveAccountPlanReport({
    ownerId: managerId,
    report: {
      version: "1.0",
      reportType: "account_plan",
      batch: 2,
      // ⚠️ 真实报告里 `sections` 是**键名数组**，正文在顶层各节。
      sections: ["ipPositioning", "accountSetup", "topicLibrary", "contentFramework", "production", "operations"],
      customer: { id: SMOKE_CUSTOMER_ID, name: "冒烟客户", occupation: "劳动法律师", ipPositioning: "老板用工风险" },
      ipPositioning: {
        businessPositioning: { targetAudience: { text: "中小企业主" }, corePain: { text: "怕赔钱" } },
        contentPositioning: { core: { text: "政策解读与环境洞察" }, frequentTags: ["劳动法", "用工合规"] },
        personaPositioning: { role: { text: "严谨专业的劳动法律师" } },
      },
      topicLibrary: { topicTotal: 12 },
    },
  });
  check(Boolean(seededPlan?.id), "（前置）种下一份该客户的 1.3 报告");

  const empPlanByCustomer = await fetch(`${BASE}/api/account-plan-reports?customerId=${SMOKE_CUSTOMER_ID}`, { headers: { Cookie: employeeA.cookie } });
  const empPlanByCustomerJson = await empPlanByCustomer.json().catch(() => null);
  check(empPlanByCustomer.status === 200, `★★ 员工按客户读账号规划 → 200（实际 ${empPlanByCustomer.status}）`, serverLog.slice(-200));
  check((empPlanByCustomerJson?.items || []).length === 1, "  ★ 拿到该客户的那一份（列表只给元数据）");
  check(empPlanByCustomerJson?.items?.[0]?.report === undefined, "  ★ 列表不带报告正文（与其它 store 同一契约）");
  check(empPlanByCustomerJson?.items?.[0]?.managerId === undefined, "  ★ 列表不含 managerId（属主身份不外泄）");

  const empPlanLatest = await fetch(`${BASE}/api/account-plan-reports?customerId=${SMOKE_CUSTOMER_ID}&latest=1`, { headers: { Cookie: employeeA.cookie } });
  const empPlanLatestJson = await empPlanLatest.json().catch(() => null);
  check(empPlanLatest.status === 200, `★★ 员工读该客户最新账号规划正文 → 200（实际 ${empPlanLatest.status}）`);
  check(empPlanLatestJson?.item?.report?.ipPositioning?.contentPositioning?.core?.text === "政策解读与环境洞察",
    "  ★★ 正文真的回来了（3.3 三个角度的主来源）");

  // ★★ 关键衔接：拿回来的正文必须能被 3.3 用上 —— 字段提取走**真实路径**。
  const picked = pickAccountPlanFields(empPlanLatestJson?.item?.report);
  check(String(picked?.商业定位 || "").includes("怕赔钱"), "★★ 提取到「用户核心痛点」来源（businessPositioning.corePain）");
  check(String(picked?.高频标签 || "").includes("劳动法"), "★★ 提取到「内容核心定位」来源（frequentTags）");
  check(String(picked?.人设定位 || "").includes("劳动法律师"), "  提取到人设定位");

  // 查不到数据时如实 404，而不是拿权限问题搪塞。
  const noPlanCustomer = await fetch(`${BASE}/api/account-plan-reports?customerId=000000000000000000000000&latest=1`, { headers: { Cookie: employeeA.cookie } });
  const noPlanJson = await noPlanCustomer.json().catch(() => null);
  check(noPlanCustomer.status === 404 && String(noPlanJson?.error || "").includes("还没有"),
    `  ★ 没有报告的客户 → 404 且说明「还没有」（实际 ${noPlanCustomer.status}）`);

  // ★★ 不带 customerId 的按 id 读，员工必须被挡（否则是个越权读的口子）。
  const empPlanById = await fetch(`${BASE}/api/account-plan-reports?id=000000000000000000000000`, { headers: { Cookie: employeeA.cookie } });
  check(empPlanById.status === 403, `★★ 员工按 id 读账号规划 → 403（不开放，实际 ${empPlanById.status}）`);

  // ★★ 不带 customerId 的列全部，员工同样被挡。
  const empPlanList = await fetch(`${BASE}/api/account-plan-reports`, { headers: { Cookie: employeeA.cookie } });
  check(empPlanList.status === 403, `★★ 员工列全部账号规划 → 403（不开放，实际 ${empPlanList.status}）`);

  // ★★ 写操作一条都没放开。
  const empPlanPost = await fetch(`${BASE}/api/account-plan-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: employeeA.cookie },
    body: JSON.stringify({ report: { reportType: "account_plan" } }),
  });
  check(empPlanPost.status === 403, `★★ 员工保存账号规划 → 403（写操作不开放，实际 ${empPlanPost.status}）`);
  const empPlanDelete = await fetch(`${BASE}/api/account-plan-reports?id=000000000000000000000000`, {
    method: "DELETE",
    headers: { Cookie: employeeA.cookie },
  });
  check(empPlanDelete.status === 403, `★★ 员工删除账号规划 → 403（写操作不开放，实际 ${empPlanDelete.status}）`);

  // 项目经理那两条仍要能用（放开员工不能把经理那条弄坏）。
  const mgrPlanList = await fetch(`${BASE}/api/account-plan-reports`, { headers: { Cookie: cookie } });
  check(mgrPlanList.status === 200, `  项目经理列全部账号规划仍 → 200（实际 ${mgrPlanList.status}）`);

  // 删除与清空
  const deleteOne = await empPublish(`/api/publish-warehouse?customerId=${SMOKE_CUSTOMER_ID}&topicId=smoke-topic-1`, { method: "DELETE" });
  check(deleteOne.status === 200, `★ 删单条发布选择 → 200（实际 ${deleteOne.status}）`);
  const afterDelete = await empPublish(`/api/publish-warehouse?customerId=${SMOKE_CUSTOMER_ID}`);
  const afterDeleteJson = await afterDelete.json().catch(() => null);
  check((afterDeleteJson?.items || []).length === 0, "  删完就查不到了");

  const clearAll = await empPublish(`/api/publish-warehouse?customerId=${SMOKE_CUSTOMER_ID}`, { method: "DELETE" });
  check(clearAll.status === 200, `  清空整批 → 200（实际 ${clearAll.status}）`);

  // ── 经理端 API（/api/management/*）──────────────────────────────────────────
  //
  // ★ 这一段补的是**合并后最大的覆盖缺口**（2026-09-22 code review 问题 3）：
  //   194 条断言原本全部打在员工侧与账号定位侧，经理端（本轮合并进来的代码、
  //   Mongoose→原生驱动重写）**一条都没有**。这里把权限边界与增删改查钉住。
  //
  // ⚠️ 经理端路由挂在 `/api/management` 下（不是 `/api/customers`），
  //   前缀变了是合并时的刻意设计（前端 `services/api.js` 的 baseURL 与之对应）。
  const mgmt = async (path, init = {}) => {
    const res = await fetch(`${BASE}/api/management${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    });
    let json = null;
    try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, json };
  };
  const mgmtAs = async (path, asCookie, init = {}) => {
    const res = await fetch(`${BASE}/api/management${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: asCookie, ...(init.headers || {}) },
    });
    return { status: res.status };
  };

  // ① 未登录 → 401（不能泄露任何经理端数据）
  const mgmtAnon = await fetch(`${BASE}/api/management/customers`);
  check(mgmtAnon.status === 401, `★ 未登录访问经理端 → 401（实际 ${mgmtAnon.status}）`);

  // ② ★ 员工 → 403（这是经理端唯一的安全边界，必须钉死）
  for (const path of ["/customers", "/tasks", "/employees", "/projects"]) {
    const res = await mgmtAs(path, employeeA.cookie);
    check(res.status === 403, `★★ 员工访问经理端 ${path} → 403（实际 ${res.status}）`);
  }
  // 写操作同样挡住员工。
  const empMgmtWrite = await mgmtAs("/customers", employeeA.cookie, {
    method: "POST", body: JSON.stringify({ name: "员工不该能建" }),
  });
  check(empMgmtWrite.status === 403, `★★ 员工在经理端建客户 → 403（实际 ${empMgmtWrite.status}）`);

  // ③ 经理端客户：建 → 列表能查到 → 改 → 删
  const mgCust = await mgmt("/customers", {
    method: "POST",
    body: JSON.stringify({ name: "合并冒烟客户", occupation: "劳动法律师", ipPositioning: "老板用工风险", contentNeeds: "讲清新规" }),
  });
  check(mgCust.status === 201, `★ 经理端建客户 → 201（实际 ${mgCust.status}）`, JSON.stringify(mgCust.json).slice(0, 200));
  const mgCustId = String(mgCust.json?._id || "");
  check(Boolean(mgCustId), "  返回了客户 id");

  const mgCustList = await mgmt("/customers");
  check(Array.isArray(mgCustList.json) && mgCustList.json.some(item => String(item._id) === mgCustId),
    "★ 建完能在经理端列表里查到（原生驱动查询正确）");

  const mgCustGet = await mgmt(`/customers/${mgCustId}`);
  check(mgCustGet.status === 200 && mgCustGet.json?.name === "合并冒烟客户", "  按 id 取单条 → 200 且名称正确");

  const mgCustPut = await mgmt(`/customers/${mgCustId}`, {
    method: "PUT", body: JSON.stringify({ name: "合并冒烟客户（改名）" }),
  });
  check(mgCustPut.status === 200 && mgCustPut.json?.name === "合并冒烟客户（改名）", `  改名 → 200（实际 ${mgCustPut.status}）`);

  // ④ 经理端员工：account 唯一性冲突 → 409（改写时容易丢的校验，这里钉住）
  const mgEmpDup = await mgmt("/employees", {
    method: "POST",
    body: JSON.stringify({ name: "重复账号", account: "smoke-employee-a", password: "another123" }),
  });
  check(mgEmpDup.status === 409, `★★ 经理端员工账号重复 → 409（唯一性校验没丢，实际 ${mgEmpDup.status}）`);

  const mgEmpBadPass = await mgmt("/employees", {
    method: "POST", body: JSON.stringify({ name: "短密码", account: "smoke-short-pass", password: "123" }),
  });
  check(mgEmpBadPass.status === 400, `  密码过短 → 400（实际 ${mgEmpBadPass.status}）`);

  const mgEmpCreate = await mgmt("/employees", {
    method: "POST", body: JSON.stringify({ name: "合并冒烟员工", account: "smoke-merged-emp", password: "verify123456", email: "merged@example.com" }),
  });
  check(mgEmpCreate.status === 201, `★ 经理端建员工 → 201（实际 ${mgEmpCreate.status}）`, JSON.stringify(mgEmpCreate.json).slice(0, 200));
  const mgEmpId = String(mgEmpCreate.json?._id || "");
  check(mgEmpCreate.json?.passwordHash === undefined && mgEmpCreate.json?.password === undefined,
    "★★ 返回体不含任何密码字段（安全投影 safeEmployeeProjection 生效）");

  const mgEmpList = await mgmt("/employees");
  check(Array.isArray(mgEmpList.json) && mgEmpList.json.every(item => item.password === undefined && item.passwordHash === undefined),
    "★★ 员工列表同样不外泄密码字段");

  const mgEmpOptions = await mgmt("/employees/options");
  check(mgEmpOptions.status === 200 && Array.isArray(mgEmpOptions.json), `  负责人下拉选项 → 200（实际 ${mgEmpOptions.status}）`);
  check((mgEmpOptions.json || []).some(item => item.role === "employee") && (mgEmpOptions.json || []).some(item => item.role === "manager"),
    "  下拉同时含员工与项目经理（合并了两张表）");

  // ★ 改员工密码后，明文 password 字段必须被清掉（合并时刻意加的 $unset）
  const mgEmpPut = await mgmt(`/employees/${mgEmpId}`, {
    method: "PUT", body: JSON.stringify({ name: "合并冒烟员工（改名）", password: "verify1234567" }),
  });
  check(mgEmpPut.status === 200, `  改员工（带新密码）→ 200（实际 ${mgEmpPut.status}）`);
  const empDoc = await db.collection("employees").findOne({ account: "smoke-merged-emp" });
  check(empDoc?.password === undefined, "★★ 改密码后明文 password 字段被清掉（$unset 生效）");
  check(/^\$2[aby]\$/.test(String(empDoc?.passwordHash || "")), "  且 passwordHash 是 bcrypt 格式");

  // ⑤ 经理端任务：建 → 查 → 批建 → 改 → 删
  const period = { start: "2026-09-01", end: "2026-10-01" };
  const mgTask = await mgmt("/tasks", {
    method: "POST",
    body: JSON.stringify({
      customerId: mgCustId, customerName: "合并冒烟客户", platformName: "抖音",
      ownerId: mgEmpId, collaborationPeriod: period, contentRequirements: ["口播"],
    }),
  });
  check(mgTask.status === 201, `★ 经理端建任务 → 201（实际 ${mgTask.status}）`, JSON.stringify(mgTask.json).slice(0, 250));
  const mgTaskId = String(mgTask.json?._id || "");
  check(Boolean(mgTaskId), "  返回了任务 id");

  const mgTaskList = await mgmt("/tasks");
  check(Array.isArray(mgTaskList.json) && mgTaskList.json.some(item => String(item._id) === mgTaskId),
    "★ 建完能在任务列表里查到（$lookup 聚合正确）");

  // 任务必填校验：缺平台 → 400（不是 500）
  const mgTaskBad = await mgmt("/tasks", {
    method: "POST", body: JSON.stringify({ customerName: "合并冒烟客户", ownerId: mgEmpId, collaborationPeriod: period }),
  });
  check(mgTaskBad.status === 400, `  任务缺平台名 → 400（实际 ${mgTaskBad.status}）`);

  // 负责人不存在 → 400
  const mgTaskBadOwner = await mgmt("/tasks", {
    method: "POST",
    body: JSON.stringify({
      customerName: "合并冒烟客户", platformName: "抖音",
      ownerId: "000000000000000000000000", collaborationPeriod: period,
    }),
  });
  check(mgTaskBadOwner.status === 400, `  负责人不存在 → 400（实际 ${mgTaskBadOwner.status}）`);

  const mgTaskBatch = await mgmt("/tasks/batch", {
    method: "POST",
    body: JSON.stringify({ tasks: [
      { customerName: "合并冒烟客户", platformName: "抖音", ownerId: mgEmpId, collaborationPeriod: period },
      { customerName: "合并冒烟客户", platformName: "视频号", ownerId: mgEmpId, collaborationPeriod: period },
    ] }),
  });
  check(mgTaskBatch.status === 201 && Array.isArray(mgTaskBatch.json) && mgTaskBatch.json.length === 2,
    `★ 批量建任务 → 201 且 2 条（实际 ${mgTaskBatch.status}）`);

  // ⑥ 员工有关联任务时不许删（数据完整性守卫）
  const mgEmpDelBlocked = await mgmt(`/employees/${mgEmpId}`, { method: "DELETE" });
  check(mgEmpDelBlocked.status === 409, `★★ 员工仍有关联任务 → 删除 409（实际 ${mgEmpDelBlocked.status}）`);

  // ⑦ 客户 IP 档案读写（合并时保留的 capability）
  const mgProfile = await mgmt(`/customers/${mgCustId}/ip-profile`);
  check(mgProfile.status === 200, `  读客户 IP 档案 → 200（实际 ${mgProfile.status}）`);
  const mgProfilePut = await mgmt(`/customers/${mgCustId}/ip-profile`, {
    method: "PUT",
    body: JSON.stringify({ profile: { identity: { name: "冒烟", occupation: "律师" } }, markConfirmed: false }),
  });
  check([200, 201].includes(mgProfilePut.status), `  写客户 IP 档案 → 200/201（实际 ${mgProfilePut.status}）`, JSON.stringify(mgProfilePut.json).slice(0, 200));

  // ⑧ ★★ 合并点名的关键链路：经理建任务 → 员工在「今日选题」读到 → 带上 customerId
  //
  // 为什么单独钉这一条（docs/MERGE-PROGRESS.md 的「必须闭环」里点过名）：
  //   员工的「今日选题」要按**这个客户**的选题库给视频打标签，而 `customerId` 必须
  //   从经理端建的任务一路传到员工端的读接口。合并时 `normalizeTask` 一度会把它丢掉，
  //   症状是「员工只知道客户名、查不到库、标签全落待人工复核」——**不报错**。
  //   所以这里把「建 → 读 → customerId 在」端到端钉住。
  const smokeEmp = await db.collection("employees").findOne({ account: "smoke-employee-a" });
  const smokeEmpId = String(smokeEmp?._id || "");
  check(Boolean(smokeEmpId), "（前置）取到冒烟员工 A 的 id");

  // 合作期必须**覆盖今天**，否则 /api/tasks/today 的窗口条件匹配不到（这是刻意设计的可见性规则）。
  const today = new Date();
  const day = 24 * 60 * 60 * 1000;
  const windowPeriod = {
    start: new Date(today.getTime() - 3 * day).toISOString().slice(0, 10),
    end: new Date(today.getTime() + 3 * day).toISOString().slice(0, 10),
  };

  const chainCustomer = await mgmt("/customers", {
    method: "POST",
    body: JSON.stringify({ name: "链路冒烟客户", occupation: "劳动法律师", contentNeeds: "讲清新规" }),
  });
  const chainCustomerId = String(chainCustomer.json?._id || "");
  check(chainCustomer.status === 201 && Boolean(chainCustomerId), "（前置）经理端建「链路冒烟客户」");

  const chainTask = await mgmt("/tasks", {
    method: "POST",
    body: JSON.stringify({
      customerId: chainCustomerId,
      customerName: "链路冒烟客户",
      platformName: "抖音",
      ownerId: smokeEmpId,
      collaborationPeriod: windowPeriod,
      contentRequirements: ["口播"],
    }),
  });
  check(chainTask.status === 201, `★★ 经理给该员工建任务（合作期覆盖今天）→ 201（实际 ${chainTask.status}）`,
    JSON.stringify(chainTask.json).slice(0, 250));

  // ★ 用员工身份读「今日任务」——这是前端拿 customerId 的唯一入口
  const todayRes = await empGet("/api/tasks/today", employeeA);
  const todayJson = todayRes.json ?? todayRes;
  const todayTasks = Array.isArray(todayJson?.data) ? todayJson.data : [];
  const chainSeen = todayTasks.find(item => String(item?._id) === String(chainTask.json?._id));
  check(Boolean(chainSeen), "★★ 员工在「今日任务」里读到了这条任务（经理→员工链路通）",
    `员工看到 ${todayTasks.length} 条；状态 ${todayRes.status ?? "?"}`);

  // ★★ 最关键的一条：customerId 必须活着传到员工端（少了它 → 标签全靠猜）
  check(Boolean(chainSeen?.customerId),
    "★★★ 任务带着 customerId 传到员工端（少了它，员工无法读取该客户的选题库，标签会静默失效）",
    `实际 customerId=${JSON.stringify(chainSeen?.customerId)}`);
  check(String(chainSeen?.customerId) === chainCustomerId,
    "  且 customerId 与经理端建的那个客户一致（没串到别的客户）");
  check(chainSeen?.customerName === "链路冒烟客户", "  客户名也一并带过来了");

  // ★ 员工能拿这个 customerId 读到选题库（标签链路的下一跳）
  const libRes = await empGet(`/api/topic-libraries?customerId=${chainCustomerId}&view=categories`, employeeA);
  check([200, 404].includes(libRes.status ?? 200),
    `  员工用该 customerId 请求选题库词典 → 200/404（无库时 404 属正常，实际 ${libRes.status}）`);

  // 清理这条链路造的数据
  await mgmt(`/tasks/${chainTask.json?._id}`, { method: "DELETE" });
  await mgmt(`/customers/${chainCustomerId}`, { method: "DELETE" });

  // ⑧ 清理：删任务 → 删员工 → 删客户（顺带验证删除链是通的）
  for (const id of [mgTaskId, ...(mgTaskBatch.json || []).map(item => String(item._id))]) {
    if (id) await mgmt(`/tasks/${id}`, { method: "DELETE" });
  }
  const mgEmpDel = await mgmt(`/employees/${mgEmpId}`, { method: "DELETE" });
  check(mgEmpDel.status === 200, `★ 清掉任务后员工可删 → 200（实际 ${mgEmpDel.status}）`);
  const mgCustDel = await mgmt(`/customers/${mgCustId}`, { method: "DELETE" });
  check([200, 204].includes(mgCustDel.status), `  删客户 → 200/204（实际 ${mgCustDel.status}）`);

} catch (error) {
  fail += 1;
  console.log(`\n✗ 脚本异常：${error instanceof Error ? error.message : error}`);
} finally {
  await cleanup();
}

console.log(`\n结果: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
