import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import {
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  FileStack,
  Hourglass,
  Info,
  Layers3,
  LibraryBig,
  ListChecks,
  MessageSquareText,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { BenchmarkClassificationStage } from "./BenchmarkClassificationStage";import { GoldThreeSecondsStage } from "./GoldThreeSecondsStage";
import { EndingHooksStage } from "./EndingHooksStage";
import { BenchmarkProfileStage } from "./BenchmarkProfileStage";
import { AccountPlanStage } from "./AccountPlanStage";
import { TopicLibraryStage } from "./TopicLibraryStage";
import type { SavedBenchmarkReport } from "./benchmarkAnalysis";
import { useStageDraft } from "./stageDraft";
import {
  ACCOUNT_PLAN_MODULE_ID,
  BENCHMARK_ANALYSIS_MODULE_ID,
  POSITIONING_MODULES,
  TOPIC_LIBRARY_MODULE_ID,
  findModule,
  findStep,
  stepProgress,
  type ModuleId,
  type StepId,
} from "./accountPositioningModules";

// 账号定位是「三个模块、两层」，不是一个一个独立功能，也不是一条平级的阶段直线：
// 模块 1/2（对标账号分析、账号规划）复用模块 3（选题库构建）的产出，而 2.1/2.2/2.3
// 是模块 3 的内部子步骤。结构定义统一在 accountPositioningModules.ts。
//
// 图标留在页面这一层，免得那个纯数据的定义文件被 ManagerHomePage 引用时也拖进 lucide。
const MODULE_ICONS: Record<ModuleId, ComponentType<{ className?: string }>> = {
  "benchmark-analysis": UsersRound,
  "account-plan": ListChecks,
  "topic-library": Layers3,
};

const STEP_ICONS: Record<StepId, ComponentType<{ className?: string }>> = {
  classification: Clapperboard,
  gold: Sparkles,
  ending: MessageSquareText,
  library: LibraryBig,
};

const moduleStatus = (module: (typeof POSITIONING_MODULES)[number], completedIds: string[]) => {
  if (!module.available) return { label: "待实现", className: "bg-amber-100 text-amber-700" };
  const { done, total } = stepProgress(module, completedIds);
  // 单体模块（模块 1/2 没有子步骤）的完成度只能看它自己的 id。
  // 少了这一支，模块 1 保存成功后永远停在「可进入」，用户会以为没生效。
  if (total === 0) {
    return completedIds.includes(module.id)
      ? { label: "已完成", className: "bg-emerald-100 text-emerald-700" }
      : { label: "可进入", className: "bg-slate-100 text-slate-600" };
  }
  if (done === total) return { label: "已完成", className: "bg-emerald-100 text-emerald-700" };
  if (done > 0) return { label: `进行中 ${done}/${total}`, className: "bg-blue-100 text-blue-700" };
  return { label: "可进入", className: "bg-slate-100 text-slate-600" };
};

const stepStatus = (step: { available: boolean }, isActive: boolean, isCompleted: boolean) => {
  if (isActive) return { label: "当前步骤", className: "bg-blue-600 text-white" };
  if (isCompleted) return { label: "已完成", className: "bg-emerald-100 text-emerald-700" };
  if (step.available) return { label: "可进入", className: "bg-slate-100 text-slate-600" };
  return { label: "待实现", className: "bg-amber-100 text-amber-700" };
};

/**
 * 前置依赖 —— 只提示，不拦截。
 *
 * 这条流程本来就有业务顺序（2.1 出报告 → 2.2/2.3/2.4 才有输入；1.2 复用模块 3 的
 * 产出；1.3 要 1.2 的报告），但界面上只有一个中性的「可进入」，用户点进去才发现
 * 没东西可选，只能自己猜顺序。
 *
 * 这里如实把「还差哪一步」写出来。**不做禁用**：报告也可能通过 handoff 直接从上一步
 * 带过来，硬拦会挡住本来能跑的通路。
 */
const PREREQUISITES: Record<string, Array<{ id: string; label: string }>> = {
  gold: [{ id: "classification", label: "2.1 对标账号分类分析" }],
  ending: [{ id: "classification", label: "2.1 对标账号分类分析" }],
  library: [{ id: "classification", label: "2.1 对标账号分类分析" }],
  [BENCHMARK_ANALYSIS_MODULE_ID]: [{ id: "classification", label: "2.1 对标账号分类分析" }],
  [ACCOUNT_PLAN_MODULE_ID]: [{ id: BENCHMARK_ANALYSIS_MODULE_ID, label: "1.2 对标账号分析" }],
};

/** 返回还没完成的前置步骤名；全部满足时返回空数组。 */
const pendingPrerequisites = (id: string, completedIds: string[]) =>
  (PREREQUISITES[id] || []).filter(item => !completedIds.includes(item.id)).map(item => item.label);

type PanelContent = {
  code: string;
  title: string;
  summary: string;
  inputs: string[];
  outputs: string[];
};

/** 未实现模块 / 子步骤的占位面板：把「要读什么、要产出什么」如实列出来。 */
function NotImplementedPanel({ code, title, summary, inputs, outputs, hint }: PanelContent & { hint: string }) {
  return (
    <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-10 sm:px-10">
      <div className="mx-auto max-w-2xl text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-50 text-amber-600"><Hourglass className="h-5 w-5" /></span>
        <h2 className="mt-4 text-xl font-semibold text-slate-900">{code}　{title}</h2>
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">待实现</span>
        <p className="mt-4 text-sm leading-6 text-slate-600">{summary}</p>
      </div>
      <div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-500"><ArrowRight className="h-3.5 w-3.5" />需要读取的输入</div>
          <ul className="mt-3 space-y-2">{inputs.map(item => <li key={item} className="flex items-start gap-2 text-xs leading-5 text-slate-600"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />{item}</li>)}</ul>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
          <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-500"><CheckCircle2 className="h-3.5 w-3.5" />计划产出的结果</div>
          <ul className="mt-3 space-y-2">{outputs.map(item => <li key={item} className="flex items-start gap-2 text-xs leading-5 text-slate-600"><span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />{item}</li>)}</ul>
        </div>
      </div>
      <p className="mx-auto mt-6 max-w-2xl text-center text-xs leading-5 text-slate-400">{hint}</p>
    </section>
  );
}

export default function AccountPositioningPage() {
  const navigate = useNavigate();
  const [activeModuleId, setActiveModuleId] = useStageDraft<ModuleId>("pipeline.activeModuleId", TOPIC_LIBRARY_MODULE_ID);
  const [activeStepId, setActiveStepId] = useStageDraft<StepId>("pipeline.activeStepId", "classification");
  // 沿用原来的 key，这样已经标过「已完成」的步骤不会因为这次改版被清掉。
  const [completedIds, setCompletedIds] = useStageDraft<string[]>("pipeline.completedStageIds", []);
  // 分类阶段保存成功后把报告（含完整正文）直接交接给三秒阶段：
  // 用户不必再手动挑一次，第二步也不必再回数据库取一遍正文。
  const [handoffReport, setHandoffReport] = useState<SavedBenchmarkReport | null>(null);

  const activeModule = findModule(activeModuleId);
  const isTopicLibrary = activeModule.id === TOPIC_LIBRARY_MODULE_ID;
  // 子步骤只在模块 3 里有意义；不在模块 3 时一律为 null，避免拿旧值去渲染。
  const activeStep = isTopicLibrary ? findStep(activeModule.steps, activeStepId) : null;

  const markCompleted = (id: string) => {
    setCompletedIds(previous => (previous.includes(id) ? previous : [...previous, id]));
  };

  // 库被删掉 / 清空时必须撤掉「2.4 已完成」标记，否则徽章会撒谎。
  const unmarkCompleted = (id: string) => {
    setCompletedIds(previous => previous.filter(item => item !== id));
  };

  const openStep = (stepId: StepId) => {
    setActiveModuleId(TOPIC_LIBRARY_MODULE_ID);
    setActiveStepId(stepId);
  };

  const handleClassificationSaved = (item: SavedBenchmarkReport) => {
    setHandoffReport(item);
    markCompleted("classification");
    openStep("gold");
  };

  const renderBody = () => {
    if (isTopicLibrary && activeStep) {
      if (activeStep.id === "classification" && activeStep.available) {
        return <BenchmarkClassificationStage embedded onSavedReport={handleClassificationSaved} />;
      }
      if (activeStep.id === "gold" && activeStep.available) {
        return (
          <GoldThreeSecondsStage
            embedded
            preselectedReport={handoffReport}
            onGoToClassification={() => openStep("classification")}
            onSaved={() => markCompleted("gold")}
          />
        );
      }
      if (activeStep.id === "ending" && activeStep.available) {
        return (
          <EndingHooksStage
            embedded
            preselectedReport={handoffReport}
            onGoToClassification={() => openStep("classification")}
            onSaved={() => markCompleted("ending")}
          />
        );
      }
      if (activeStep.id === "library" && activeStep.available) {
        // 2.4 是模块 3 的产出落地：把分类报告纳入客户的正式选题库，
        // 再用库内的大类/小类给近期新更新的视频打标签。
        return (
          <TopicLibraryStage
            embedded
            preselectedReport={handoffReport}
            onSaved={() => markCompleted("library")}
            onCleared={() => unmarkCompleted("library")}
            onGoToClassification={() => openStep("classification")}
          />
        );
      }
      return (
        <NotImplementedPanel
          {...activeStep}
          hint="这个步骤还没有实现。它会沿用黄金三秒同样的结构（独立 Agent、独立报告、独立存储），完成后直接出现在这条流程里。"
        />
      );
    }
    // 模块 1「对标账号分析」是**单体模块**（没有子步骤）：它复用模块 3 的产出，
    // 自己只跑「点赞前 20 条」的三秒/结尾简化分析，再综合成商业定位/用户画像/
    // 内容定位/高频标签/运营策略。保存成功后用它自己的模块 id 标记完成。
    if (activeModule.id === BENCHMARK_ANALYSIS_MODULE_ID) {
      return (
        <BenchmarkProfileStage
          embedded
          preselectedReport={handoffReport}
          onSaved={() => markCompleted(BENCHMARK_ANALYSIS_MODULE_ID)}
        />
      );
    }
    // 模块 2「账号规划」(1.3) 同样是**单体模块**：两份输入（客户 IP 档案 + 1.2 报告）都是现成的，
    // 一次调用出报告，没有子步骤。保存成功后用它自己的模块 id 标记完成。
    if (activeModule.id === ACCOUNT_PLAN_MODULE_ID) {
      return (
        <AccountPlanStage
          embedded
          onSaved={() => markCompleted(ACCOUNT_PLAN_MODULE_ID)}
        />
      );
    }
    return (
      <NotImplementedPanel
        {...activeModule}
        hint="这个模块还没有实现。它会复用「选题库构建」的产出，沿用同样的结构（独立 Agent、独立报告、独立存储），完成后直接出现在这里。"
      />
    );
  };

  return (
    <div>
      {/* 与「任务 / 客户档案 / 团队成员」同一套页头：大标题 + 灰色副标题。
          原来这里有一行蓝紫大写英文（ACCOUNT POSITIONING）压在标题上方，
          经理端内部两种页头混用，看着像两个系统，故去掉。 */}
      <div className="page-header">
        <div>
          <h1 className="page-title">账号定位</h1>
          <div className="page-subtitle max-w-3xl">从客户 IP 档案出发的一条完整流程：先用对标账号产出选题库，再综合成账号定位规划。各阶段各自保存报告，按顺序往下走即可。</div>
        </div>
      </div>

        <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500"><FileStack className="h-4 w-4" /></span>
            <div>
              <div className="text-sm font-semibold text-slate-900">流程起点：客户 IP 档案</div>
              <p className="mt-1 text-xs leading-5 text-slate-500">这条流程以客户已确认的 IP 档案为起点。档案在「客户与 IP 档案」里维护，本流程直接沿用，不需要在这里重复填写。</p>
            </div>
          </div>
          <button type="button" onClick={() => navigate("/manager/customers")} className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-300 hover:text-blue-700 sm:self-auto"><CheckCircle2 className="h-3.5 w-3.5" />管理客户档案<ArrowRight className="h-3.5 w-3.5" /></button>
        </section>

        <nav aria-label="账号定位模块" className="mt-6">
          <div className="grid gap-3 sm:grid-cols-3">
            {POSITIONING_MODULES.map(module => {
              const isActive = module.id === activeModule.id;
              const chip = moduleStatus(module, completedIds);
              const Icon = MODULE_ICONS[module.id];
              const pending = pendingPrerequisites(module.id, completedIds);
              return (
                <button
                  key={module.id}
                  type="button"
                  onClick={() => setActiveModuleId(module.id)}
                  aria-current={isActive ? "step" : undefined}
                  className={`flex flex-col rounded-2xl border p-4 text-left transition ${isActive ? "border-blue-300 bg-blue-50/80 shadow-sm" : module.available ? "border-slate-200 bg-white hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-sm" : "border-dashed border-slate-300 bg-white/70 hover:border-slate-400"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${isActive ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"}`}>{module.code}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.className}`}>{chip.label}</span>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <Icon className={`h-4 w-4 shrink-0 ${isActive ? "text-blue-600" : module.available ? "text-slate-500" : "text-slate-400"}`} />
                    <span className="text-sm font-semibold text-slate-900">{module.title}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">{module.summary}</p>
                  {module.reuses && <p className="mt-2 text-[11px] leading-4 text-slate-400">{module.reuses}</p>}
                  {pending.length > 0 && (
                    <p className="mt-2 inline-flex items-start gap-1 text-[11px] leading-4 text-amber-600"><Info className="mt-0.5 h-3 w-3 shrink-0" />建议先完成：{pending.join("、")}</p>
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        {/* 模块 3 的子步骤轨道。左侧描边 + 缩进表示它是上一层的内部步骤，而不是又一个
            平级模块 —— 按「界面保持清爽」的要求，这里不加页面级小标题。 */}
        {isTopicLibrary && (
          <nav aria-label="选题库构建的子步骤" className="mt-3 border-l-2 border-slate-200 pl-3 sm:ml-4">
            {/* 2.4（正式选题库与更新筛选）是模块 3 的产出落地步骤，渲染成整行的第二排，
                免得把 2.1～2.3 三个步骤挤窄。步骤清单同样来自 accountPositioningModules.ts。 */}
            <div className="grid gap-3 sm:grid-cols-3">
              {activeModule.steps.map(step => {
                const isActive = step.id === activeStep?.id;
                const isCompleted = completedIds.includes(step.id);
                const chip = stepStatus(step, isActive, isCompleted);
                const Icon = STEP_ICONS[step.id];
                const pending = pendingPrerequisites(step.id, completedIds);
                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => openStep(step.id)}
                    aria-current={isActive ? "step" : undefined}
                    className={`flex flex-col rounded-xl border p-3.5 text-left transition ${step.id === "library" ? "sm:col-span-3" : ""} ${isActive ? "border-blue-300 bg-blue-50/80 shadow-sm" : step.available ? "border-slate-200 bg-white hover:border-blue-200" : "border-dashed border-slate-300 bg-white/70 hover:border-slate-400"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${isActive ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"}`}>{step.code}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.className}`}>{isCompleted && !isActive ? "✓ " : ""}{chip.label}</span>
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-blue-600" : step.available ? "text-slate-500" : "text-slate-400"}`} />
                      <span className="text-xs font-semibold text-slate-900">{step.title}</span>
                    </div>
                    {step.id === "library" && <p className="mt-2 text-xs leading-5 text-slate-500">{step.summary}</p>}
                    {pending.length > 0 && (
                      <p className="mt-2 inline-flex items-start gap-1 text-[11px] leading-4 text-amber-600"><Info className="mt-0.5 h-3 w-3 shrink-0" />建议先完成：{pending.join("、")}</p>
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
        )}

        <div className="mt-7">{renderBody()}</div>
    </div>
  );
}
