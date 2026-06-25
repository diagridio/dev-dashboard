import { createBrowserRouter } from 'react-router-dom'
import App from './App'
import { Placeholder } from './pages/Placeholder'

export const routes = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Placeholder title="Applications" /> },
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
  basename: import.meta.env.BASE_URL,
})
