import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import { App } from './App'
import { Applications } from './pages/Applications'
import { AppDetail } from './pages/AppDetail'
import { Placeholder } from './pages/Placeholder'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Applications /> },
      { path: 'apps/:appId', element: <AppDetail /> },
      { path: 'workflows', element: <Placeholder title="Workflows" /> },
      { path: 'actors', element: <Placeholder title="Actors" /> },
      { path: 'subscriptions', element: <Placeholder title="Subscriptions" /> },
      { path: 'components', element: <Placeholder title="Components" /> },
      { path: 'configurations', element: <Placeholder title="Configurations" /> },
      { path: 'logs', element: <Placeholder title="Logs" /> },
    ],
  },
]

export const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
})
