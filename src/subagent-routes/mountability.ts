/**
 * The mount-admissibility gate a route write must pass before it touches a file.
 *
 * A valid YAML block and a valid catalog model prove nothing about whether the
 * saved route will actually mount. `capabilityRejection` is the install path's
 * single authority for that question, so it is reused here rather than
 * restated: a card that wrote a route the mount pass would refuse would look
 * successful and silently remove the delegation tool at the next Session.
 *
 * Three outcomes, and the middle one is not a yes:
 * - `no` — the transport positively cannot carry the route (or this definition
 *   is not editable from this card at all).
 * - `unknown` — the transport has registered no provider in this host yet, so
 *   nothing proves the route mounts. Treated as a refusal on write.
 * - `yes` — the present preflight passes.
 *
 * @module dsh-project-context/subagent-routes/mountability
 */

import { capabilityRejection } from '../config-mapping.ts'
import type { ProviderCapabilityView } from '../config-mapping.ts'
import type { LlmRoute, ResolvedAgent } from '../types.ts'

/** Whether a route may be written for this definition, as far as the host can tell. */
export type Mountability = 'yes' | 'no' | 'unknown'

/** One mountability verdict, with the reason the card renders verbatim. */
export interface MountabilityVerdict {
  readonly mountable: Mountability
  readonly reason?: string
}

/** Why a global-layer definition can never be written from this card. */
export const GLOBAL_LAYER_REASON = 'this definition comes from the global agents directory, not from '
  + '<root>/.dsh/agents, so this card can neither attribute nor edit it'

/**
 * Reuse the install path's own rejection predicate against a candidate route.
 * @param agent - the definition with the candidate `llm` route already applied.
 * @param provider - the registered transport provider, or undefined when absent.
 * @returns the verdict, with the rejection reason when it is not a yes.
 */
function verdictFor(
  agent: ResolvedAgent,
  provider: ProviderCapabilityView | undefined,
): MountabilityVerdict {
  if (provider === undefined) {
    return {
      mountable: 'unknown',
      reason: `transport "${agent.transport}" has registered no provider in this host yet, `
        + 'so a saved route cannot be proven mountable',
    }
  }
  const rejection = capabilityRejection(agent, provider)
  return rejection === undefined ? { mountable: 'yes' } : { mountable: 'no', reason: rejection }
}

/**
 * Judge the route a definition ALREADY declares.
 * @param agent - one resolved project or global definition.
 * @param provider - the registered transport provider, or undefined when absent.
 * @returns the verdict for the listing.
 */
export function mountabilityOf(
  agent: ResolvedAgent,
  provider: ProviderCapabilityView | undefined,
): MountabilityVerdict {
  if (agent.layer !== 'project') return { mountable: 'no', reason: GLOBAL_LAYER_REASON }
  // A definition with no `llm` is admissible on any transport, so there is
  // nothing for the capability gate to reject.
  if (agent.llm === undefined) return { mountable: 'yes' }
  return verdictFor(agent, provider)
}

/**
 * Judge a CANDIDATE route before it is written.
 * @param agent - one resolved project definition, as the install path sees it.
 * @param next - the route the operator selected.
 * @param provider - the registered transport provider, or undefined when absent.
 * @returns the verdict; anything but `yes` must refuse the write.
 */
export function routeMountability(
  agent: ResolvedAgent,
  next: LlmRoute,
  provider: ProviderCapabilityView | undefined,
): MountabilityVerdict {
  if (agent.layer !== 'project') return { mountable: 'no', reason: GLOBAL_LAYER_REASON }
  return verdictFor({ ...agent, llm: next }, provider)
}
