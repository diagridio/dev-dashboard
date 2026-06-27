import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
      },
    },
  })
}

// Singleton for production use
const queryClient = makeQueryClient()

/** Wrap the app with TanStack Query's provider. */
export function QueryProvider({
  children,
  client,
}: {
  children: React.ReactNode
  client?: QueryClient
}) {
  return <QueryClientProvider client={client ?? queryClient}>{children}</QueryClientProvider>
}
