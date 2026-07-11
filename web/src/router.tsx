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
import { RouteError } from './components/RouteError'
import { getCapabilities } from './lib/capabilities'

const caps = getCapabilities()

const gatedChildren: RouteObject[] = [
  { index: true, element: <Applications />, handle: { rumView: 'Applications' } },
  { path: 'apps/:appId', element: <AppDetail />, handle: { rumView: 'AppDetail' } },
  ...(caps.workflows
    ? [
        { path: 'workflows', element: <Workflows />, handle: { rumView: 'Workflows' } },
        { path: 'workflows/:appId/:instanceId', element: <WorkflowDetail />, handle: { rumView: 'WorkflowDetail' } },
      ]
    : []),
  { path: 'actors', element: <Actors />, handle: { rumView: 'Actors' } },
  { path: 'subscriptions', element: <Subscriptions />, handle: { rumView: 'Subscriptions' } },
  { path: 'components/new', element: <ComponentBuilder />, handle: { rumView: 'ComponentBuilder' } },
  { path: 'components', element: <ResourceList kind="component" />, handle: { rumView: 'Components' } },
  { path: 'components/:name', element: <ResourceList kind="component" />, handle: { rumView: 'Components' } },
  { path: 'configurations', element: <ResourceList kind="configuration" />, handle: { rumView: 'Configurations' } },
  { path: 'configurations/:name', element: <ResourceList kind="configuration" />, handle: { rumView: 'Configurations' } },
  { path: 'resiliency', element: <Resiliency />, handle: { rumView: 'Resiliency' } },
  { path: 'resiliency/new', element: <ResiliencyBuilder />, handle: { rumView: 'ResiliencyBuilder' } },
  ...(caps.controlPlane
    ? [{ path: 'control-plane', element: <ControlPlane />, handle: { rumView: 'ControlPlane' } }]
    : []),
  ...(caps.logs ? [{ path: 'logs', element: <Logs />, handle: { rumView: 'Logs' } }] : []),
]

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    // Fallback if the App shell itself fails to render: standalone error page.
    errorElement: <RouteError />,
    children: [
      {
        // Pathless layout route: page render errors are caught here, so the
        // error renders inside the App shell (TopNav/sidebar stay usable).
        errorElement: <RouteError />,
        children: gatedChildren,
      },
    ],
  },
]

export const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
  future: { v7_relativeSplatPath: true },
})
