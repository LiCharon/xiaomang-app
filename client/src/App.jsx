import React, { useEffect, useState } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  NavLink,
  Navigate,
  Outlet,
  useLocation
} from 'react-router-dom';
import TaskList from './pages/TaskList.jsx';
import TaskForm from './pages/TaskForm.jsx';
import EmployeeList from './pages/EmployeeList.jsx';
import Login from './pages/Login.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { authAPI, clearStoredToken, getStoredToken, storeToken } from './services/api';
import './App.css';

const NAV_ITEMS = [
  { to: '/', label: '任务' },
  { to: '/tasks/new', label: '新建任务' },
  { to: '/employees', label: '员工' }
];

const PAGE_TITLES = {
  '/': { title: '任务总览', sub: '集中查看和推进所有任务事项' },
  '/tasks/new': { title: '创建任务', sub: '为团队新增一项清晰可执行的任务' },
  '/employees': { title: '团队成员', sub: '经理入口：管理员工账号信息' }
};

function AppLoadingScreen() {
  return (
    <div className="app-loading-screen">
      <div className="loading-orb" />
      <div className="app-loading-title">AI 项目助手</div>
      <div className="app-loading-subtitle">正在加载你的工作空间</div>
    </div>
  );
}

function PublicOnlyRoute({ currentUser, authLoading, children }) {
  if (authLoading) return <AppLoadingScreen />;
  if (currentUser) return <Navigate to="/" replace />;
  return children;
}

function ShellHeader({ currentUser, onLogout }) {
  const location = useLocation();
  const info = PAGE_TITLES[location.pathname] || { title: 'AI 项目助手', sub: '项目与协作管理' };

  return (
    <>
      <div className="shell-header-wrap">
        <div className="shell-header">
          <div className="shell-brand">
            <div className="shell-brand-mark">A</div>
            <div>
              <div className="shell-brand-title">AI Project Assistant</div>
              <div className="shell-brand-subtitle">Clear work. Calm interface.</div>
            </div>
          </div>

          <nav className="shell-nav">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `shell-nav-link${isActive ? ' active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="shell-user">
            <div className="shell-user-meta">
              <div className="shell-user-name">{currentUser?.name || '用户'}</div>
              <div className="shell-user-email">{currentUser?.email || ''}</div>
            </div>
            <div className="shell-user-avatar">
              {currentUser?.name?.[0] || 'U'}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={onLogout}>
              退出
            </button>
          </div>
        </div>
      </div>

      <div className="shell-hero">
        <div className="shell-hero-label">Workspace</div>
        <div className="shell-hero-title">{info.title}</div>
        <div className="shell-hero-subtitle">{info.sub}</div>
      </div>
    </>
  );
}

function AppShell({ currentUser, onLogout }) {
  return (
    <div className="site-shell">
      <ShellHeader currentUser={currentUser} onLogout={onLogout} />
      <main className="shell-main">
        <div className="shell-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const restoreAuth = async () => {
      const token = getStoredToken();
      if (!token) {
        setAuthLoading(false);
        return;
      }

      try {
        const response = await authAPI.me();
        setCurrentUser(response.data.user);
      } catch (error) {
        clearStoredToken();
        setCurrentUser(null);
      } finally {
        setAuthLoading(false);
      }
    };

    restoreAuth();
  }, []);

  useEffect(() => {
    const handleRemoteLogout = () => setCurrentUser(null);
    window.addEventListener('auth:logout', handleRemoteLogout);
    return () => window.removeEventListener('auth:logout', handleRemoteLogout);
  }, []);

  const handleAuthSuccess = ({ token, user }) => {
    storeToken(token);
    setCurrentUser(user);
  };

  const handleLogout = () => {
    clearStoredToken();
    setCurrentUser(null);
  };

  return (
    <Router>
      <Routes>
        <Route
          path="/login"
          element={(
            <PublicOnlyRoute currentUser={currentUser} authLoading={authLoading}>
              <Login onAuthSuccess={handleAuthSuccess} />
            </PublicOnlyRoute>
          )}
        />
        <Route
          path="/"
          element={(
            <ProtectedRoute currentUser={currentUser} authLoading={authLoading}>
              <AppShell currentUser={currentUser} onLogout={handleLogout} />
            </ProtectedRoute>
          )}
        >
          <Route index element={<TaskList />} />
          <Route path="tasks/new" element={<TaskForm />} />
          <Route path="employees" element={<EmployeeList />} />
        </Route>
        <Route
          path="*"
          element={<Navigate to={currentUser ? '/' : '/login'} replace />}
        />
      </Routes>
    </Router>
  );
}

export default App;
