import "./styles/index.css";

import { lazy, Suspense } from "react";
import ManagerLayout from "./manager/ManagerLayout";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from "react-router";
import App from "./app/App.tsx";
import AccountPositioningPage from "./app/AccountPositioningPage.tsx";
import AuthPage from "./app/AuthPage.tsx";
import ContentPage from "./app/ContentPage.tsx";
import FinalEditorPage from "./app/FinalEditorPage.tsx";
import ManagerHomePage from "./app/ManagerHomePage.tsx";
import PublishWarehousePage from "./app/PublishWarehousePage.tsx";
import TodayTasksPage from "./app/TodayTasksPage.tsx";
import { TopicLibraryStage } from "./app/TopicLibraryStage.tsx";
import { AuthProvider, PublicOnly, RequireAuth, RequireRole, useAuth } from "./app/auth.tsx";
import { ErrorBoundary } from "./app/ErrorBoundary.tsx";

const TaskList = lazy(() => import('./manager/pages/TaskList.jsx'));
const TaskForm = lazy(() => import('./manager/pages/TaskForm.jsx'));
const CustomerList = lazy(() => import('./manager/pages/CustomerList.jsx'));
const EmployeeList = lazy(() => import('./manager/pages/EmployeeList.jsx'));
const IpProfileForm = lazy(() => import('./manager/pages/IpProfileForm.jsx'));
const managed = (page: React.ReactNode) => <RequireRole role="manager"><ManagerLayout><Suspense fallback={<p className="p-6 text-slate-500">正在加载…</p>}>{page}</Suspense></ManagerLayout></RequireRole>;

function HomePage() {
  const { user } = useAuth();
  return user?.role === "manager" ? <ManagerHomePage /> : <TodayTasksPage />;
}

/**
 * 员工端的「新更新视频筛选与打标签」（模块 3 的 2.4 **只读视图**）。
 *
 * `/topics` 是员工路由，而 2.4 原本只挂在经理端的 `/manager/account-positioning` 下，
 * 员工进不去。这里复用同一个组件给员工开一扇门：`readOnly` 藏掉建库/改库入口，
 * 客户由 `?customerId=` 锁定 —— 值来自临时任务的「绑定客户」。
 *
 * ⚠️ 分支放在**路由元素这一层**，不要塞进 `App` 里提前 return：
 *    `App` 有几十个 hook，条件式提前 return 会让 hook 顺序随 query 变化而改变。
 */
function TopicsRoute() {
  const [params] = useSearchParams();
  if (params.get("view") === "newVideos") {
    return (
      <main className="min-h-screen bg-[#f5f7fb] text-slate-900">
        <div className="mx-auto max-w-[1500px] px-5 py-6 sm:px-8 lg:px-10 lg:py-9">
          <TopicLibraryStage embedded readOnly lockedCustomerId={params.get("customerId") || ""} />
        </div>
      </main>
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    {/* 兜住所有渲染期异常，避免任何一处报错都变成整页白屏。 */}
    <ErrorBoundary>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<PublicOnly><AuthPage /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><AuthPage mode="register" /></PublicOnly>} />
          <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
          <Route path="/manager" element={<RequireRole role="manager"><ManagerHomePage /></RequireRole>} />
          <Route path="/workbench" element={<RequireAuth><TodayTasksPage /></RequireAuth>} />
          <Route path="/manager/tasks" element={managed(<TaskList />)} />
          <Route path="/manager/tasks/new" element={managed(<TaskForm />)} />
          <Route path="/manager/customers" element={managed(<CustomerList />)} />
          <Route path="/manager/customers/ip-profile/new" element={managed(<IpProfileForm />)} />
          <Route path="/manager/customers/:id/ip-profile" element={managed(<IpProfileForm />)} />
          <Route path="/manager/employees" element={managed(<EmployeeList />)} />
          <Route path="/manager/account-positioning" element={<RequireRole role="manager"><AccountPositioningPage /></RequireRole>} />
          {/* 账号定位已经收敛成单一入口；旧路径保留重定向，避免已有书签或外链失效。 */}
          <Route path="/manager/benchmark-analysis" element={<Navigate to="/manager/account-positioning" replace />} />
          <Route path="/manager/gold-three-seconds" element={<Navigate to="/manager/account-positioning" replace />} />
          <Route path="/topics" element={<RequireAuth><TopicsRoute /></RequireAuth>} />
          <Route path="/content" element={<RequireAuth><ContentPage /></RequireAuth>} />
          {/* 发布仓：内容生成页之后、最终文案编辑页之前（2026-09-21 第七轮，HANDOFF §0.3）。 */}
          <Route path="/publish-warehouse" element={<RequireAuth><PublishWarehousePage /></RequireAuth>} />
          <Route path="/final-editor" element={<RequireAuth><FinalEditorPage /></RequireAuth>} />
          <Route path="*" element={<RequireAuth><HomePage /></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </ErrorBoundary>
  </BrowserRouter>
);
