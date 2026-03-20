import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

function ProtectedRoute({ currentUser, authLoading, children }) {
  const location = useLocation();

  if (authLoading) {
    return (
      <div className="app-loading-screen">
        <div className="loading-orb" />
        <div className="app-loading-title">正在验证登录状态</div>
        <div className="app-loading-subtitle">请稍候，正在为你准备工作台</div>
      </div>
    );
  }

  if (!currentUser) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}

export default ProtectedRoute;
