import { load } from 'js-yaml'
import applicationsRaw from '../content/cli/applications.yaml?raw'
import appDetailRaw from '../content/cli/app-detail.yaml?raw'
import workflowsRaw from '../content/cli/workflows.yaml?raw'
import workflowDetailRaw from '../content/cli/workflow-detail.yaml?raw'
import actorsRaw from '../content/cli/actors.yaml?raw'
import subscriptionsRaw from '../content/cli/subscriptions.yaml?raw'

export interface CliCommandDef {
  title: string
  command: string
  docs?: string
}

export interface CliTool {
  label: string
  commands: CliCommandDef[]
}

export interface CliContent {
  context: string
  tools: Record<string, CliTool>
}

const rawByContext: Record<string, string> = {
  Applications: applicationsRaw,
  AppDetail: appDetailRaw,
  Workflows: workflowsRaw,
  WorkflowDetail: workflowDetailRaw,
  Actors: actorsRaw,
  Subscriptions: subscriptionsRaw,
}

const contentByContext: Record<string, CliContent> = Object.fromEntries(
  Object.entries(rawByContext).map(([ctx, raw]) => [ctx, load(raw) as CliContent]),
)

/** Returns drawer content for a route context (rumView), or undefined if none. */
export function getCliContent(context: string | undefined): CliContent | undefined {
  if (!context) return undefined
  return contentByContext[context]
}

/** camelCase token -> kebab-case literal placeholder, e.g. appId -> <app-id>. */
function tokenToLiteral(token: string): string {
  return `<${token.replace(/([A-Z])/g, '-$1').toLowerCase()}>`
}

/**
 * Substitutes {{token}} placeholders from `values`. Missing/empty values fall
 * back to a readable <kebab-token> literal so the command stays copyable.
 * Literal <...> placeholders in the source command are left untouched.
 */
export function resolvePlaceholders(
  command: string,
  values: Record<string, string | undefined>,
): string {
  return command.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const value = values[token]
    return value != null && value !== '' ? value : tokenToLiteral(token)
  })
}
