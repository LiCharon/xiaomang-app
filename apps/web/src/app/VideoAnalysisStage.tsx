import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudUpload, FileSpreadsheet, Info, LoaderCircle, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  analyzeVideoReview,
  deleteVideoReview,
  listReviewCustomers,
  listVideoReviewsForCustomer,
  parseReviewWorkbook,
  saveVideoReview,
  type ParsedWorkbook,
  type ReviewPlatform,
  type SavedVideoReviewSummary,
  type VideoAnalysisReport,
} from "./reviewApi";

/**
 * 模块 4「复盘分析」的 4.1 单条视频数据分析。
 *
 * 🔴 这一页与账号定位其它阶段最大的不同：**输入是人家的 Excel**。
 *
 *   分析对象是**客户自己发布的视频**，不是选题库里那些对标视频 ——
 *   所以系统抓不到、也不能自动补，只能由人工从平台后台导出后上传。
 *
 *   于是流程被拆成两段，中间**必须有人工确认**：
 *
 *     ① 上传 Excel → 后端解析 → **用户确认每一列是什么**
 *     ② 用确认后的映射跑分析 → 出报告 → 用户看过再保存
 *
 *   为什么要确认列映射：Excel 的百分比列可能是 `0.32`、`32`、`"32%"`，
 *   而且表头各家写各家的。猜错一列的口径，整份报告的结论会全错，
 *   而用户从界面上**看不出来**。所以自动识别只给建议，最终由人拍板。
 *
 * ⚠️ 结构标签（选题类型 / 3s / 标题 / 结尾钩子）可以留空让 Agent 从文案判 ——
 *    人工填了的**优先**，Agent 只补空的那几项。
 */

const PLATFORMS: Array<{ key: ReviewPlatform; label: string }> = [
  { key: "douyin", label: "抖音" },
  { key: "wechat_channels", label: "视频号" },
];

/** 判定等级的配色。与 `reviewMetrics.js` 的 VERDICT_LEVELS 一一对应。 */
const VERDICT_TONE: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-700",
  watch: "bg-slate-100 text-slate-600",
  bad: "bg-rose-100 text-rose-700",
  missing: "bg-amber-100 text-amber-700",
  suspicious: "bg-rose-100 text-rose-700",
};

const STRUCTURE_TONE: Record<string, string> = {
  reuse: "bg-emerald-100 text-emerald-700",
  optimize: "bg-rose-100 text-rose-700",
  watch: "bg-slate-100 text-slate-600",
  missing: "bg-amber-100 text-amber-700",
};

/** 文案列不是「指标」，它是单独一列用途，所以在映射下拉里单独给一个选项。 */
const SCRIPT_COLUMN = "__script__";

export function VideoAnalysisStage({ embedded = false, onSaved }: { embedded?: boolean; onSaved?: () => void }) {
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [customerId, setCustomerId] = useState("");
  const [platform, setPlatform] = useState<ReviewPlatform>("douyin");

  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [rowIndex, setRowIndex] = useState(0);
  const [scriptColumn, setScriptColumn] = useState("");
  const [script, setScript] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [videoLink, setVideoLink] = useState("");

  const [report, setReport] = useState<VideoAnalysisReport | null>(null);
  const [history, setHistory] = useState<SavedVideoReviewSummary[]>([]);
  const [parsing, setParsing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listReviewCustomers()
      .then(items => { if (!cancelled) setCustomers(items); })
      .catch(() => { if (!cancelled) setCustomers([]); });
    return () => { cancelled = true; };
  }, []);

  // 换客户要清掉上一家的分析结果 —— 否则用户会拿着 A 客户的报告以为是 B 客户的。
  useEffect(() => {
    setReport(null);
    setError("");
    setMessage("");
    if (!customerId) return undefined;
    let cancelled = false;
    listVideoReviewsForCustomer(customerId)
      .then(items => { if (!cancelled) setHistory(items); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [customerId]);

  const metricOptions = workbook?.metricOptions || [];

  /** 反查：指标 key → 选了它的那一列。用于提示「还缺哪个指标」。 */
  const columnOfMetric = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [header, key] of Object.entries(mapping)) {
      if (key && key !== SCRIPT_COLUMN) map[key] = header;
    }
    return map;
  }, [mapping]);

  const missingMetrics = useMemo(
    () => metricOptions.filter(item => !item.optional && !columnOfMetric[item.key]),
    [metricOptions, columnOfMetric],
  );

  const currentRow = workbook?.records?.[rowIndex] || null;

  /** 把当前行按映射读成指标对象。**原样传字符串**，归一化交给后端（唯一口径）。 */
  const metricsFromRow = useMemo(() => {
    if (!currentRow) return {};
    const result: Record<string, string> = {};
    for (const [header, key] of Object.entries(mapping)) {
      if (!key || key === SCRIPT_COLUMN) continue;
      result[key] = currentRow[header] ?? "";
    }
    return result;
  }, [currentRow, mapping]);

  const pickFile = async (file: File | null) => {
    if (!file) return;
    setParsing(true);
    setError("");
    setMessage("");
    setReport(null);
    try {
      const parsed = await parseReviewWorkbook(file, { platform });
      setWorkbook(parsed);
      setMapping({ ...parsed.suggestedMapping });
      setRowIndex(0);
      setScriptColumn("");
      setScript("");
      setVideoTitle("");
      setVideoLink("");
      const unknown = parsed.unmatchedHeaders.length;
      setMessage(
        `已解析「${parsed.sheetName}」：${parsed.rows.length} 行数据。`
        + `自动认出 ${Object.keys(parsed.suggestedMapping).length} 列`
        + (unknown > 0 ? `，还有 ${unknown} 列没认出（用不上的列可以留空）` : "")
        + "。请确认下面的列对应关系。",
      );
    } catch (e) {
      setWorkbook(null);
      setError(e instanceof Error ? e.message : "Excel 解析失败");
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const runAnalysis = async () => {
    if (!customerId) { setError("请先选择客户"); return; }
    if (!workbook) { setError("请先上传这个视频的数据 Excel"); return; }
    setAnalyzing(true);
    setError("");
    setMessage("");
    try {
      const result = await analyzeVideoReview({
        customerId,
        platform,
        metrics: metricsFromRow,
        script,
        video: { title: videoTitle || String(currentRow?.[workbook.headers[0]] || ""), link: videoLink },
      });
      setReport(result);
      setMessage(
        result.analysisSource === "agent"
          ? "分析完成。请核对下面的判定与建议，确认无误后保存。"
          : "分析完成（AI 建议这次没跑成功，已给出纯数据结论，建议文字需人工补充）。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析失败");
    } finally {
      setAnalyzing(false);
    }
  };

  const save = async () => {
    if (!report || !customerId) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveVideoReview({
        customerId,
        customerName: customers.find(item => item.id === customerId)?.name || "",
        report,
      });
      setMessage(`已保存（${saved.videoTitle || "未命名视频"}）。`);
      setHistory(await listVideoReviewsForCustomer(customerId));
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const removeHistory = async (id: string) => {
    try {
      await deleteVideoReview(id);
      if (customerId) setHistory(await listVideoReviewsForCustomer(customerId));
      setMessage("已删除。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const body = (
    <div className="space-y-5">
      {error && <div className="whitespace-pre-wrap rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-700">{error}</div>}
      {message && <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-700">{message}</div>}

      {/* ── 第一步：客户 / 平台 / 上传 ─────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle className="text-base">第一步　选择客户并上传数据</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                这里分析的是<strong>你自己账号已发布的视频</strong>，数据要在平台后台导出成 Excel 再上传 ——
                系统看不到这些数据，也不会去抓。请用<strong>.xlsx</strong>格式（老式 .xls 请先在 Excel 里「另存为」）。
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600">客户</span>
              <select
                value={customerId}
                onChange={event => setCustomerId(event.target.value)}
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500"
              >
                <option value="">请选择客户</option>
                {customers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <span className="mt-1 block text-[11px] leading-4 text-slate-400">复盘要用该客户的选题库来判断「选题大类 / 小类」。</span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600">平台</span>
              <select
                value={platform}
                onChange={event => { setPlatform(event.target.value as ReviewPlatform); setWorkbook(null); setReport(null); }}
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500"
              >
                {PLATFORMS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
              <span className="mt-1 block text-[11px] leading-4 text-slate-400">两个平台的指标与标准值不同（视频号看「3 秒以上播放率」）。</span>
            </label>
          </div>

          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xlsm"
              onChange={event => pickFile(event.target.files?.[0] || null)}
              className="hidden"
              id="review-workbook-input"
            />
            <label
              htmlFor="review-workbook-input"
              className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-sm text-slate-600 transition hover:border-blue-300 hover:bg-blue-50/40"
            >
              {parsing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
              {parsing ? "正在解析…" : workbook ? `已选择：${workbook.fileName}（点击可换一个）` : "点击选择 Excel 文件"}
            </label>
          </div>
        </CardContent>
      </Card>

      {/* ── 第二步：确认列映射 ─────────────────────────────────────────── */}
      {workbook && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-4 w-4 text-slate-500" />
              第二步　确认每一列是什么
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs leading-5 text-slate-500">
              下面是自动识别的结果，<strong>请逐列核对</strong>。识别错一列（尤其是百分比列）会让整份报告的结论全错，
              所以这一屏就是要你拍板的地方。用不上的列选「（不使用）」。
            </p>

            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Excel 列名</th>
                    <th className="px-3 py-2 text-left font-medium">样例值</th>
                    <th className="px-3 py-2 text-left font-medium">它是什么</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {workbook.headers.map((header, index) => (
                    <tr key={`${header}-${index}`}>
                      <td className="px-3 py-2 font-medium text-slate-800">{header || `（第 ${index + 1} 列，无表头）`}</td>
                      <td className="max-w-[180px] truncate px-3 py-2 text-slate-500">{currentRow?.[header] ?? ""}</td>
                      <td className="px-3 py-2">
                        <select
                          value={mapping[header] || ""}
                          onChange={event => setMapping(previous => ({ ...previous, [header]: event.target.value }))}
                          className="h-8 w-full min-w-[190px] rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-500"
                        >
                          <option value="">（不使用）</option>
                          <option value={SCRIPT_COLUMN}>视频文案（用于判断结构类型）</option>
                          <optgroup label="互动数据">
                            {metricOptions.filter(item => item.group === "engagement").map(item => (
                              <option key={item.key} value={item.key}>{item.label}　—　{item.meaning}</option>
                            ))}
                          </optgroup>
                          <optgroup label="专业数据（平台后台）">
                            {metricOptions.filter(item => item.group === "professional").map(item => (
                              <option key={item.key} value={item.key}>{item.label}　—　{item.meaning}</option>
                            ))}
                          </optgroup>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 文案列：选了就从那一列取，没选就手填 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-medium text-slate-600">视频文案从哪来</span>
                <select
                  value={scriptColumn}
                  onChange={event => {
                    const value = event.target.value;
                    setScriptColumn(value);
                    if (value && value !== SCRIPT_COLUMN) setScript(String(currentRow?.[value] ?? ""));
                  }}
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-500"
                >
                  <option value="">手动填写</option>
                  {workbook.headers.filter(Boolean).map(header => <option key={header} value={header}>{header}</option>)}
                </select>
                <span className="text-[11px] text-slate-400">文案是判断「3 秒 / 标题 / 结尾钩子」类型的依据；不填就只能人工指定或落「待人工复核」。</span>
              </div>
            </div>

            {missingMetrics.length > 0 && (
              <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    还有这些指标没有对应到列：<strong>{missingMetrics.map(item => item.label).join("、")}</strong>。
                    缺了它们，对应的结构判定会显示「数据缺失」而不是给结论 —— <strong>这是如实反映，不是故障</strong>。
                  </div>
                </div>
              </div>
            )}

            {workbook.rows.length > 1 && (
              <div>
                <div className="mb-2 text-xs font-medium text-slate-600">这个文件里有 {workbook.rows.length} 行，选要分析的那一条</div>
                <div className="max-h-52 overflow-auto rounded-xl border border-slate-200">
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-100">
                      {workbook.rows.slice(0, 200).map((row, index) => (
                        <tr key={index} className={index === rowIndex ? "bg-blue-50" : ""}>
                          <td className="w-10 px-3 py-2">
                            <input
                              type="radio"
                              checked={index === rowIndex}
                              onChange={() => { setRowIndex(index); if (scriptColumn) setScript(String(row[scriptColumn] ?? "")); }}
                              aria-label={`选择第 ${index + 1} 行`}
                            />
                          </td>
                          <td className="px-3 py-2 text-slate-700">{row[0] || `第 ${index + 1} 行`}</td>
                          <td className="px-3 py-2 text-right text-slate-400">播放量 {columnOfMetric.plays ? (row[columnOfMetric.plays] || "—") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {workbook.truncated && (
              <p className="text-[11px] text-amber-600">文件行数较多，只显示了前 500 行。</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 第三步：文案与元信息 ───────────────────────────────────────── */}
      {workbook && (
        <Card>
          <CardHeader><CardTitle className="text-base">第三步　补充文案与视频信息</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-xs font-medium text-slate-600">视频标题</span>
                <input
                  value={videoTitle}
                  onChange={event => setVideoTitle(event.target.value)}
                  placeholder="留空则取 Excel 第一列"
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-slate-600">视频链接（可选）</span>
                <input
                  value={videoLink}
                  onChange={event => setVideoLink(event.target.value)}
                  placeholder="https://…"
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-600">视频文案</span>
              <textarea
                value={script}
                onChange={event => setScript(event.target.value)}
                rows={5}
                placeholder="把这条视频的口播文案粘在这里（或在上一步选择文案列）。Agent 会用它在 8 个三秒类型、8 个标题类型、5 个结尾钩子类型里判断。"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs leading-6 outline-none focus:border-blue-500"
              />
            </label>
            <div className="flex items-center gap-3">
              <Button type="button" onClick={runAnalysis} disabled={analyzing || !workbook}>
                {analyzing ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                {analyzing ? "正在分析…" : "开始分析"}
              </Button>
              <span className="text-[11px] text-slate-400">判定结论由后端按平台标准值实算，AI 只负责解释与给建议。</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 报告 ──────────────────────────────────────────────────────── */}
      {report && <ReviewReportView report={report} onSave={save} saving={saving} />}

      {/* ── 历史 ──────────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">这个客户的复盘记录</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y divide-slate-100">
              {history.map(item => (
                <li key={item.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-800">{item.videoTitle || "（无标题）"}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                      <span>{item.platformLabel}</span>
                      {item.playBucketLabel && <span>· {item.playBucketLabel}</span>}
                      {item.categoryName && <span>· {item.categoryName}</span>}
                      {item.optimizeCount > 0 && <span className="text-rose-500">· {item.optimizeCount} 项待优化</span>}
                      <span>· {String(item.createdAt || "").slice(0, 10)}</span>
                    </div>
                  </div>
                  <button type="button" onClick={() => removeHistory(item.id)} className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" aria-label="删除这条复盘">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );

  if (embedded) return body;
  return (
    <main className="min-h-screen bg-[#f5f7fb] px-5 py-6 text-slate-900 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-[1200px]">
        <h1 className="text-xl font-semibold tracking-tight text-slate-950">复盘分析 · 视频数据分析</h1>
        <p className="mt-1 text-sm text-slate-500">上传一条视频的真实数据与文案，得到数据分析报告与优化建议。</p>
        <div className="mt-6">{body}</div>
      </div>
    </main>
  );
}

/** 报告视图：判定表 + 四大结构 + 建议。抽出来是为了让主流程读起来还是「三步」。 */
function ReviewReportView({ report, onSave, saving }: { report: VideoAnalysisReport; onSave: () => void; saving: boolean }) {
  return (
    <div className="space-y-5">
      {report.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
          <div className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="h-3.5 w-3.5" />需要你知道的 {report.warnings.length} 件事</div>
          <ul className="ml-5 list-disc space-y-0.5">
            {report.warnings.map((text, index) => <li key={index}>{text}</li>)}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            数据分析报告
            <Badge variant="secondary">{report.platformLabel}</Badge>
            {report.playBucket?.label && <Badge variant="secondary">{report.playBucket.label}</Badge>}
            <Badge variant={report.analysisSource === "agent" ? "default" : "secondary"}>
              {report.analysisSource === "agent" ? "AI 已参与" : "规则兜底（建议待人工补充）"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 指标读数：把「这个数字代表什么」直接标在旁边（用户要求） */}
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { title: "直观数据", items: report.metricReadout.engagement },
              { title: "专业数据", items: report.metricReadout.professional },
            ].map(group => (
              <div key={group.title} className="rounded-xl border border-slate-200 p-4">
                <div className="mb-2 text-xs font-semibold text-slate-500">{group.title}</div>
                <ul className="space-y-1.5">
                  {group.items.map(item => (
                    <li key={item.key} className="flex items-baseline gap-2 text-xs">
                      <span className="w-24 shrink-0 text-slate-500">
                        {item.label}
                        {item.weightRank ? <span className="ml-1 text-[10px] text-slate-400">权重{item.weightRank}</span> : null}
                      </span>
                      <span className="w-16 shrink-0 font-semibold text-slate-900">{item.display}</span>
                      <span className="min-w-0 flex-1 text-[11px] leading-4 text-slate-400">{item.meaning}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* 判定：哪个高于/低于标准值 */}
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">指标</th>
                  <th className="px-3 py-2 text-left font-medium">实测</th>
                  <th className="px-3 py-2 text-left font-medium">标准</th>
                  <th className="px-3 py-2 text-left font-medium">判定</th>
                  <th className="px-3 py-2 text-left font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.judgments.map(item => {
                  const rule = report.rules.find(entry => entry.metric === item.metric);
                  return (
                    <tr key={item.metric}>
                      <td className="px-3 py-2 font-medium text-slate-800">{item.label}</td>
                      <td className="px-3 py-2 text-slate-700">
                        {item.value === null ? "—" : (item.metric.endsWith("Rate") || item.metric === "interactionRate" || item.metric === "avgPlayRate"
                          ? `${Math.round(item.value * 1000) / 10}%`
                          : `${Math.round(item.value * 10) / 10}`)}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{rule?.threshold || "—"}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_TONE[item.level] || "bg-slate-100 text-slate-600"}`}>{item.levelLabel}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{item.conclusion}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">优化建议方案</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {report.suggestions.summary && (
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-700">{report.suggestions.summary}</p>
          )}
          {!report.suggestions.summary && report.analysisSource === "heuristic" && (
            <p className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
              AI 这次没能给出建议文字。下面只保留<strong>能从数据直接核对的部分</strong>（判定结论与依据），
              建议文字需要人工补充 —— 我们没有用套话凑数。
            </p>
          )}

          <div className="space-y-3">
            {report.suggestions.items.map(item => (
              <div key={item.key} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{item.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STRUCTURE_TONE[item.verdict] || "bg-slate-100 text-slate-600"}`}>{item.verdictLabel}</span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-slate-400">{item.hint}</p>

                {item.reasons.length > 0 && (
                  <ul className="mt-2 ml-4 list-disc space-y-0.5 text-[11px] leading-5 text-slate-500">
                    {item.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                  </ul>
                )}

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-[11px] font-medium text-slate-500">为什么</div>
                    <div className="mt-0.5 text-xs leading-5 text-slate-700">{item.why || <span className="text-slate-400">待人工补充</span>}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-[11px] font-medium text-slate-500">怎么调</div>
                    <div className="mt-0.5 text-xs leading-5 text-slate-700">{item.how || <span className="text-slate-400">待人工补充</span>}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">这条视频的结构标签</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="text-[11px] text-slate-400">
            来源：{report.structureTags.source === "agent" ? "Agent 从文案判断（人工填过的项以人工为准）" : "人工指定"}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { label: "选题大类", value: report.structureTags.categoryName, reason: "" },
              { label: "选题小类", value: report.structureTags.subcategoryName, reason: "" },
              { label: "黄金 3 秒", value: report.structureTags.goldThreeSecondsLabel, reason: report.structureTags.goldThreeSecondsReason },
              { label: "标题", value: report.structureTags.titleLabel, reason: report.structureTags.titleReason },
              { label: "结尾钩子", value: report.structureTags.endingHookLabel, reason: report.structureTags.endingHookReason },
            ].map(row => (
              <div key={row.label} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="text-[11px] text-slate-500">{row.label}</div>
                <div className="mt-0.5 font-medium text-slate-800">{row.value || <span className="text-slate-400">待人工补充</span>}</div>
                {row.reason && <div className="mt-0.5 text-[11px] leading-4 text-slate-400">{row.reason}</div>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
          {saving ? "保存中…" : "保存这份复盘"}
        </Button>
        <span className="text-[11px] text-slate-400">保存后可以在下面的记录里回看，也会成为下一轮配比调整的依据。</span>
      </div>
    </div>
  );
}
