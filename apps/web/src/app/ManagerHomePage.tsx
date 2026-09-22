import { ArrowUpRight, BriefcaseBusiness, ExternalLink, LogOut, UsersRound } from "lucide-react";
import { useNavigate } from "react-router";
import { useAuth } from "./auth";
import { POSITIONING_MODULES } from "./accountPositioningModules";

const managerAppUrl = String(import.meta.env.VITE_MANAGER_APP_URL || "").trim();

// 账号定位只暴露一个入口，这里列出它的三个模块。模块清单从 accountPositioningModules.ts
// 读，不再在这里另写一份平级列表 —— 之前两处各写一遍，2.3 上线时要记得同时改两处。
// 这个页面读不到账号定位页的阶段草稿，所以只按清单里的 available 报「能不能跑」，
// 不谎报「已完成」。
const moduleReadiness = (module: (typeof POSITIONING_MODULES)[number]) => {
  if (!module.available) return "待实现";
  if (module.steps.length === 0) return "可执行";
  const ready = module.steps.filter(step => step.available).length;
  return ready === module.steps.length ? "可执行" : `${ready}/${module.steps.length} 可执行`;
};

export default function ManagerHomePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:py-12">
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div><div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600"><span className="h-2 w-2 rounded-full bg-blue-600" /> MANAGER WORKSPACE</div><h1 className="text-4xl font-semibold tracking-tight text-slate-950">项目经理工作台</h1><p className="mt-2 text-sm text-slate-500">欢迎回来，{user?.name || user?.email || "项目经理"}。管理端与员工端现在使用同一套账号认证。</p></div>
          <button type="button" onClick={handleLogout} className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900 sm:self-auto"><LogOut className="h-4 w-4" />退出登录</button>
        </header>

        <section className="mt-8 overflow-hidden rounded-3xl border border-blue-200 bg-white shadow-sm">
          <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-center">
            <div>
              <div className="text-xs font-semibold tracking-[0.18em] text-blue-600">ACCOUNT POSITIONING</div>
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">账号定位</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">从对标账号链接到账号定位规划的一条完整流程。每个阶段各自保存报告，但共用同一个入口，按顺序往下走即可，不需要在不同功能之间来回切换。</p>
              <button type="button" onClick={() => navigate("/manager/account-positioning")} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700">进入账号定位流程<ArrowUpRight className="h-4 w-4" /></button>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="px-1 text-xs font-semibold tracking-wide text-slate-400">流程模块</div>
              <ol className="mt-3 space-y-2">
                {POSITIONING_MODULES.map(module => {
                  const readiness = moduleReadiness(module);
                  const ready = readiness !== "待实现";
                  return (
                    <li key={module.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">{module.code}</span>
                        <span className="truncate text-sm font-medium text-slate-800">{module.title}</span>
                        <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ready ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{readiness}</span>
                      </div>
                      {/* 2.1～2.3 是模块 3 的内部子步骤，不是平级模块，所以嵌在它下面显示。 */}
                      {module.steps.length > 0 && (
                        <ul className="mt-2 space-y-1 border-l-2 border-slate-200 pl-3">
                          {module.steps.map(step => (
                            <li key={step.id} className="flex items-center gap-2">
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{step.code}</span>
                              <span className="truncate text-xs text-slate-600">{step.title}</span>
                              <span className={`ml-auto shrink-0 text-[10px] font-medium ${step.available ? "text-emerald-600" : "text-amber-600"}`}>{step.available ? "可执行" : "待实现"}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><BriefcaseBusiness className="h-6 w-6 text-blue-600" /><h2 className="mt-5 text-lg font-semibold">客户与 IP 档案</h2><p className="mt-2 text-sm leading-6 text-slate-500">维护客户信息和已确认的 1.1 IP 账号规划资料。这是账号定位流程的起点数据。</p></div>
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><UsersRound className="h-6 w-6 text-violet-600" /><h2 className="mt-5 text-lg font-semibold">团队与任务分配</h2><p className="mt-2 text-sm leading-6 text-slate-500">为员工创建账号、分配任务，员工登录后只看到自己的今日任务。</p></div>
        </section>

        <section className="mt-6 flex flex-wrap gap-3">
          {[['/manager/customers', '客户档案'], ['/manager/tasks', '任务管理'], ['/manager/employees', '团队成员'], ['/workbench', '进入内容生产']].map(([path, label]) => <button key={path} onClick={() => navigate(path)} className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700">{label}</button>)}
        </section>
      </div>
    </main>
  );
}
