import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import { App } from './App'
import { Applications } from './pages/Applications'
import { AppDetail } from './pages/AppDetail'
import { Logs } from './pages/Logs'
import { Workflows } from './pages/Workflows'
import { WorkflowDetail } from './pages/WorkflowDetail'
import { Actors } from './pages/Actors'
import { Subscriptions } from './pages/Subscriptions'
import { ResourceList } from './pages/ResourceList'
import { ComponentBuilder } from './pages/component-builder/ComponentBuilder'
import { Resiliency } from './pages/Resiliency'
import { ResiliencyBuilder } from './pages/resiliency-builder/ResiliencyBuilder'
import { ControlPlane } from './pages/ControlPlane'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Applications /> },
      { path: 'apps/:appId', element: <AppDetail /> },
      { path: 'workflows', element: <Workflows /> },
      { path: 'workflows/:appId/:instanceId', element: <WorkflowDetail /> },
      { path: 'actors', element: <Actors /> },
      { path: 'subscriptions', element: <Subscriptions /> },
      { path: 'components/new', element: <ComponentBuilder /> },
      { path: 'components', element: <ResourceList kind="component" /> },
      { path: 'components/:name', element: <ResourceList kind="component" /> },
      { path: 'configurations', element: <ResourceList kind="configuration" /> },
      { path: 'configurations/:name', element: <ResourceList kind="configuration" /> },
      { path: 'resiliency', element: <Resiliency /> },
      { path: 'resiliency/new', element: <ResiliencyBuilder /> },
      { path: 'control-plane', element: <ControlPlane /> },
      { path: 'logs', element: <Logs /> },
    ],
  },
]

export const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
  future: { v7_relativeSplatPath: true },
})
