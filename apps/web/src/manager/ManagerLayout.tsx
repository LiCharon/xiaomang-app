import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useAuth } from '../app/auth';
import './manager.css';

const navigation = [
  ['/manager', '工作台'], ['/manager/tasks', '任务'], ['/manager/tasks/new', '新建任务'],
  ['/manager/customers', '客户档案'], ['/manager/employees', '团队成员'],
  ['/manager/account-positioning', '账号定位'], ['/workbench', '内容生产'],
];

export default function ManagerLayout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return <div className="manager-workspace min-h-screen bg-slate-50 text-slate-900">
    <header className="border-b border-slate-200 bg-white px-5 py-4 sm:px-8">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-5">
        <NavLink to="/manager" className="text-lg font-semibold tracking-tight">小芒 AI</NavLink>
        <nav aria-label="项目经理导航" className="flex flex-1 flex-wrap gap-1">
          {navigation.map(([to, label]) => <NavLink key={to} to={to} end className={({ isActive }) => `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</NavLink>)}
        </nav>
        <span className="text-sm text-slate-500">{user?.name}</span>
        <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={async () => { await logout(); navigate('/login'); }}>退出</button>
      </div>
    </header>
    <main className="mx-auto max-w-[1440px] px-5 py-8 sm:px-8">{children}</main>
  </div>;
}
